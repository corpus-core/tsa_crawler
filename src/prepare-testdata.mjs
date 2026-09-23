#!/usr/bin/env node
// Build {txhash}_sim.json and {txhash}_prompt.json from stored collector traces.
// _prompt.json is an array: simple (explainer default) + detailed system prompt.
// If Sourcify has no source, write {txhash}_prompt.nosrc so later runs skip it.
// STEPS=1,2a,2b (default). 2a = one prompt per unprocessed bucket; 2b = the rest.
// STEPS=2 still runs 2a then 2b. INTERVAL_S>0 repeats. SKIP_EXPLAINER_BUILD=1 uses dist.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sloadsToAccessList, collectTraceSlots } from './proxy_accesslist.mjs';
import { traceToSimulation, txParamsFromMeta, extractRevertData } from './sim-from-trace.mjs';
import { listTraceFiles } from './bucket_paths.mjs';
import { backfillLatestExamples, latestLimit, recordLatestExample } from './latest_examples.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IN = process.env.IN || './test_data';
const RPC = process.env.RPC || 'https://mainnet1.colibri-proof.tech/execution';
const CHAIN_ID = parseInt(process.env.CHAIN_ID || '1', 10);
const STEPS = (process.env.STEPS || '1,2a,2b').split(',').map((s) => s.trim()).filter(Boolean);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '4', 10);
const FORCE = process.env.FORCE === '1';
const PROGRESS_EVERY = parseInt(process.env.PROGRESS_EVERY || '100', 10);
const INTERVAL_S = parseInt(process.env.INTERVAL_S || '0', 10);
const SKIP_EXPLAINER_BUILD = process.env.SKIP_EXPLAINER_BUILD === '1';
const EXPLAINER_DIR = process.env.EXPLAINER_DIR
    || path.resolve(__dirname, '../../colibri-stateless/bindings/emscripten/packages/explainer');
const PROM_FILE = process.env.PROM_FILE || '';
const CHAIN = process.env.CHAIN || 'mainnet';
if (!process.env.C4_STATE_DIR) process.env.C4_STATE_DIR = '.';

// --------------------------- Prometheus-Metriken ---------------------------
// Same textfile_collector pattern as fetch_traces.mjs: complete exposition file,
// write to .tmp and rename. Process counters reset on restart; gauges
// reflect the current IN directory. Separate PROM_FILE from the collector.
let simWrittenTotal = 0;
let promptWrittenTotal = 0;
let nosrcWrittenTotal = 0;
let errorsTotal = 0;
let lastRunTs = 0;
let lastCounts = { traces: 0, sim: 0, prompt: 0, nosrc: 0 };

function escapeLabel(v) {
    return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
const LABELS = `{chain="${escapeLabel(CHAIN)}"}`;

function snapshotCounts(traces) {
    let sim = 0, prompt = 0, nosrc = 0;
    for (const f of traces) {
        if (fs.existsSync(simPath(f))) sim++;
        if (fs.existsSync(promptPath(f))) prompt++;
        else if (fs.existsSync(promptSkipPath(f))) nosrc++;
    }
    lastCounts = { traces: traces.length, sim, prompt, nosrc };
}

function writeMetrics() {
    if (!PROM_FILE) return;
    const pendingSim = Math.max(0, lastCounts.traces - lastCounts.sim);
    const pendingPrompt = Math.max(0, lastCounts.sim - lastCounts.prompt - lastCounts.nosrc);
    const lines = [
        '# HELP trace_prepare_sim_files_total Simulation files written since process start.',
        '# TYPE trace_prepare_sim_files_total counter',
        `trace_prepare_sim_files_total${LABELS} ${simWrittenTotal}`,
        '# HELP trace_prepare_prompt_files_total Prompt files written since process start.',
        '# TYPE trace_prepare_prompt_files_total counter',
        `trace_prepare_prompt_files_total${LABELS} ${promptWrittenTotal}`,
        '# HELP trace_prepare_nosrc_total Sourcify-miss markers written since process start.',
        '# TYPE trace_prepare_nosrc_total counter',
        `trace_prepare_nosrc_total${LABELS} ${nosrcWrittenTotal}`,
        '# HELP trace_prepare_errors_total Failed prepare steps since process start.',
        '# TYPE trace_prepare_errors_total counter',
        `trace_prepare_errors_total${LABELS} ${errorsTotal}`,
        '# HELP trace_prepare_traces Trace files currently found under IN.',
        '# TYPE trace_prepare_traces gauge',
        `trace_prepare_traces${LABELS} ${lastCounts.traces}`,
        '# HELP trace_prepare_sim_files Simulation files currently on disk.',
        '# TYPE trace_prepare_sim_files gauge',
        `trace_prepare_sim_files${LABELS} ${lastCounts.sim}`,
        '# HELP trace_prepare_prompt_files Prompt files currently on disk.',
        '# TYPE trace_prepare_prompt_files gauge',
        `trace_prepare_prompt_files${LABELS} ${lastCounts.prompt}`,
        '# HELP trace_prepare_nosrc_files Sourcify-miss markers currently on disk.',
        '# TYPE trace_prepare_nosrc_files gauge',
        `trace_prepare_nosrc_files${LABELS} ${lastCounts.nosrc}`,
        '# HELP trace_prepare_pending_sim Traces still missing a _sim.json.',
        '# TYPE trace_prepare_pending_sim gauge',
        `trace_prepare_pending_sim${LABELS} ${pendingSim}`,
        '# HELP trace_prepare_pending_prompt Sims still missing _prompt.json or _prompt.nosrc.',
        '# TYPE trace_prepare_pending_prompt gauge',
        `trace_prepare_pending_prompt${LABELS} ${pendingPrompt}`,
        '# HELP trace_prepare_last_run_timestamp Unix time of the last completed prepare pass.',
        '# TYPE trace_prepare_last_run_timestamp gauge',
        `trace_prepare_last_run_timestamp${LABELS} ${lastRunTs}`,
        '',
    ];
    try {
        const tmp = PROM_FILE + '.tmp';
        fs.writeFileSync(tmp, lines.join('\n'));
        fs.renameSync(tmp, PROM_FILE);
    } catch (e) {
        console.warn('metrics-error:', e.message);
    }
}

/** System prompt for a technical walkthrough (replaces the explainer default). */
const DETAILED_SYSTEM_PROMPT = `You are a senior Ethereum protocol engineer. Explain \
what this transaction does in technical detail for an experienced developer.

Rules:
- Walk through the decoded function call, events, storage-slot changes, and internal calls.
- Name Solidity functions and storage variables when source or layout is available.
- If the transaction reverts, explain the revert path and the decoded error.
- Call out risks (unlimited approvals, proxy/admin changes, unverified callees).
- Do not speculate about information not present in the metadata.
- Do not include raw hex values unless no decoded form is available.
- Be precise; length is fine when the transaction is complex.`;

const codeHashCache = new Map();
const codeCache = new Map();

let rpcId = 0;
async function rpc(method, params) {
    const res = await fetch(RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    });
    const j = await res.json();
    if (j.error) {
        const err = new Error(`${method}: ${JSON.stringify(j.error)}`);
        console.warn('rpc-error:', err.message);
        err.rpcError = j.error;
        throw err;
    }
    return j.result;
}

function writeAtomic(file, obj, pretty = false) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, (pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj)) + '\n');
    fs.renameSync(tmp, file);
}

function missingOutput(traces, destFn) {
    if (FORCE) return traces;
    return traces.filter((f) => !fs.existsSync(destFn(f)));
}

async function mapLimit(items, limit, fn) {
    let i = 0;
    const n = Math.max(1, Math.min(limit, items.length || 1));
    const workers = Array.from({ length: n }, async () => {
        while (i < items.length) {
            const idx = i++;
            await fn(items[idx], idx);
        }
    });
    await Promise.all(workers);
}

async function resolveAccessList(file) {
    if (Array.isArray(file.accessList) && file.accessList.length) return file.accessList;
    const slots = collectTraceSlots(file.trace?.sload, file.trace?.sstore);
    // Historical proofs need an archive node. codeHash is stable enough to
    // resolve against `latest` on a full node.
    return sloadsToAccessList(slots, {
        rpc,
        blockTag: 'latest',
        codeHashCache,
        codeCache,
        fetchCode: true,
        addresses: file.meta?.to ? [file.meta.to] : [],
    });
}

async function resolveReturnValue(file) {
    if (file.trace && file.trace.output != null) return file.trace.output;
    if (!file.receipt || file.receipt.status === '0x1') return '0x';
    const meta = file.meta || {};
    // Replay against `latest` so a non-archive RPC works. State may differ
    // from the original block, so the revert payload can be wrong or missing.
    try {
        await rpc('eth_call', [{
            from: meta.from,
            to: meta.to,
            data: meta.input || '0x',
            value: meta.value || '0x0',
        }, 'latest']);
        return '0x';
    } catch (e) {
        console.error('warn : resolveReturnValue error', path.basename(file.name), e.message);
        return extractRevertData(e.rpcError) || '0x';
    }
}

function simPath(traceFile) {
    return traceFile.replace(/\.json$/, '_sim.json');
}
function promptPath(traceFile) {
    return traceFile.replace(/\.json$/, '_prompt.json');
}
function promptSkipPath(traceFile) {
    return traceFile.replace(/\.json$/, '_prompt.nosrc');
}

function promptOutputName(name) {
    return name.endsWith('_prompt.json') || name.endsWith('_prompt.nosrc');
}

/** True if the bucket directory already has any prompt or nosrc marker. */
function bucketHasPromptOutput(dir) {
    try {
        return fs.readdirSync(dir).some(promptOutputName);
    } catch {
        return false;
    }
}

/**
 * Traces that still need a `_prompt.json` / `_prompt.nosrc`.
 *
 * @param {string[]} traces
 * @param {{ force?: boolean }} [opts]
 * @return {string[]}
 */
function missingPrompts(traces, { force = FORCE } = {}) {
    if (force) return traces;
    return traces.filter((f) => !fs.existsSync(promptPath(f)) && !fs.existsSync(promptSkipPath(f)));
}

/**
 * Step 2a: at most one trace per bucket, and only buckets with no prompt
 * output yet. Later traces from the same directory stay for step 2b.
 *
 * @param {string[]} traces traces that already have `_sim.json`
 * @param {{ force?: boolean }} [opts]
 * @return {string[]}
 */
function missingPromptsOnePerNewBucket(traces, { force = FORCE } = {}) {
    const pending = [];
    const seenDirs = new Set();
    for (const f of traces) {
        if (!force && (fs.existsSync(promptPath(f)) || fs.existsSync(promptSkipPath(f)))) continue;
        const dir = path.dirname(f);
        if (seenDirs.has(dir)) continue;
        if (!force && bucketHasPromptOutput(dir)) continue;
        seenDirs.add(dir);
        pending.push(f);
    }
    return pending;
}

async function step1(traceFile) {
    const dest = simPath(traceFile);
    if (!FORCE && fs.existsSync(dest)) return 'skip';
    const file = JSON.parse(fs.readFileSync(traceFile, 'utf8'));
    let accessList;
    try {
        accessList = await resolveAccessList(file);
    } catch (e) {
        console.error('step1 accessList-error', path.basename(traceFile), e.message);
        accessList = file.accessList;
    }
    let returnValue;
    try {
        returnValue = await resolveReturnValue(file);
    } catch (e) {
        console.error('step1 returnValue-error', path.basename(traceFile), e.message);
        returnValue = file.trace?.output || '0x';
    }
    const sim = traceToSimulation(file, { accessList, returnValue });
    writeAtomic(dest, sim);
    return 'ok';
}

function ensureExplainer() {
    const pkg = path.join(EXPLAINER_DIR, 'package.json');
    if (!fs.existsSync(pkg)) throw new Error('explainer not found at ' + EXPLAINER_DIR);
    const dist = path.join(EXPLAINER_DIR, 'dist', 'index.js');
    if (SKIP_EXPLAINER_BUILD) {
        if (!fs.existsSync(dist)) throw new Error('explainer dist missing at ' + dist);
        return dist;
    }
    if (!fs.existsSync(path.join(EXPLAINER_DIR, 'node_modules'))) {
        const r = spawnSync('npm', ['install'], { cwd: EXPLAINER_DIR, stdio: 'inherit' });
        if (r.status !== 0) throw new Error('npm install in explainer failed');
    }
    const r = spawnSync('npm', ['run', 'build'], { cwd: EXPLAINER_DIR, stdio: 'inherit' });
    if (r.status !== 0) throw new Error('explainer build failed');
    return dist;
}

async function runPromptStep(label, files, explainer) {
    if (!files.length) {
        console.log(`${label}: nichts zu tun`);
        return explainer;
    }
    if (!explainer) {
        const dist = ensureExplainer();
        explainer = await import(pathToFileURL(dist).href);
    }
    let ok = 0, skip = 0, nosrc = 0, err = 0, done = 0;
    await mapLimit(files, CONCURRENCY, async (f) => {
        try {
            const r = await step2(f, explainer);
            if (r === 'skip') skip++;
            else if (r === 'nosrc') {
                nosrc++;
                nosrcWrittenTotal++;
                lastCounts.nosrc++;
            } else if (r === 'err') {
                err++;
                errorsTotal++;
            } else {
                ok++;
                promptWrittenTotal++;
                lastCounts.prompt++;
            }
        } catch (e) {
            err++;
            errorsTotal++;
            console.error(label, path.basename(f), e.message);
        }
        done++;
        if (done % PROGRESS_EVERY === 0) {
            console.log(`${label}: ${done}/${files.length} ok=${ok} nosrc=${nosrc} err=${err}`);
            writeMetrics();
        }
    });
    console.log(`${label}: ${done}/${files.length} ok=${ok} skip=${skip} nosrc=${nosrc} err=${err}`);
    return explainer;
}

async function step2(traceFile, explainer) {
    const dest = promptPath(traceFile);
    const skip = promptSkipPath(traceFile);
    if (!FORCE && (fs.existsSync(dest) || fs.existsSync(skip))) return 'skip';
    const simFile = simPath(traceFile);
    if (!fs.existsSync(simFile)) {
        console.warn('step2 missing sim', path.basename(traceFile));
        return 'err';
    }
    const file = JSON.parse(fs.readFileSync(traceFile, 'utf8'));
    const sim = JSON.parse(fs.readFileSync(simFile, 'utf8'));
    const txParams = txParamsFromMeta(file.meta);
    const context = await explainer.enrichSimulation(sim, txParams, CHAIN_ID);
    if (!hasContractSource(context)) {
        writeAtomic(skip, { reason: 'nosrc' });
        return 'nosrc';
    }
    if (fs.existsSync(skip)) fs.unlinkSync(skip);
    const simple = explainer.buildPrompt(sim, txParams, {}, context);
    const detailed = explainer.buildPrompt(sim, txParams, { systemPrompt: DETAILED_SYSTEM_PROMPT, maxSourceChars: 0 }, context);
    writeAtomic(dest, [
        { style: 'simple', ...simple },
        { style: 'detailed', ...detailed },
    ], true);
    try {
        await recordLatestExample({
            root: IN,
            traceFile,
            userPrompt: simple.userPrompt,
            contracts: context?.contracts,
            meta: file.meta,
            limit: latestLimit(),
        });
    } catch (e) {
        console.warn('latest.json:', path.basename(traceFile), e.message);
    }
    return 'ok';
}

/** True if Sourcify (or cache) produced at least one source file. */
function hasContractSource(context) {
    const contracts = context?.contracts;
    if (!contracts || typeof contracts.values !== 'function') return false;
    for (const meta of contracts.values()) {
        const sources = meta?.sources;
        if (!sources || typeof sources !== 'object') continue;
        for (const file of Object.values(sources)) {
            if (file && typeof file.content === 'string' && file.content.length) return true;
        }
    }
    return false;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runOnce(explainer) {
    const all = listTraceFiles(IN);
    console.log(`prepare-testdata: ${all.length} traces in ${IN} steps=${STEPS.join(',')} rpc=${RPC}`);
    try {
        const filled = backfillLatestExamples(IN, all, latestLimit());
        if (filled) console.log(`latest.json: filled from existing prompts -> ${filled}`);
    } catch (e) {
        console.warn('latest.json backfill:', e.message);
    }
    snapshotCounts(all);
    writeMetrics();

    if (STEPS.includes('1')) {
        const files = missingOutput(all, simPath);
        console.log(`step1: ${files.length} ohne _sim.json`);
        let ok = 0, skip = 0, err = 0, done = 0;
        await mapLimit(files, CONCURRENCY, async (f) => {
            try {
                const r = await step1(f);
                if (r === 'skip') skip++;
                else {
                    ok++;
                    simWrittenTotal++;
                    lastCounts.sim++;
                }
            } catch (e) {
                err++;
                errorsTotal++;
                console.error('step1', path.basename(f), e.message);
            }
            done++;
            if (done % PROGRESS_EVERY === 0) {
                console.log(`step1: ${done}/${files.length} ok=${ok} err=${err}`);
                writeMetrics();
            }
        });
        console.log(`step1: ${done}/${files.length} ok=${ok} skip=${skip} err=${err}`);
        snapshotCounts(all);
        writeMetrics();
    }

    const want2a = STEPS.includes('2a') || STEPS.includes('2');
    const want2b = STEPS.includes('2b') || STEPS.includes('2');
    if (want2a || want2b) {
        const withSim = all.filter((f) => fs.existsSync(simPath(f)));
        let step2aFiles = [];
        if (want2a) {
            step2aFiles = missingPromptsOnePerNewBucket(withSim);
            console.log(
                `step2a: ${step2aFiles.length} unbearbeitete Buckets, je 1 Tx `
                + `(${withSim.length} haben _sim.json)`,
            );
            explainer = await runPromptStep('step2a', step2aFiles, explainer);
        }
        if (want2b) {
            const skip = new Set(step2aFiles);
            const files = missingPrompts(withSim).filter((f) => !skip.has(f));
            console.log(
                `step2b: ${files.length} restliche ohne _prompt.json/_prompt.nosrc `
                + `(${withSim.length} haben _sim.json)`,
            );
            explainer = await runPromptStep('step2b', files, explainer);
        }
    }
    lastRunTs = Math.floor(Date.now() / 1000);
    snapshotCounts(all);
    writeMetrics();
    return explainer;
}

async function main() {
    let explainer = await runOnce(null);
    while (INTERVAL_S > 0) {
        console.log(`prepare-testdata: next run in ${INTERVAL_S}s`);
        await sleep(INTERVAL_S * 1000);
        explainer = await runOnce(explainer);
    }
}

const isMain = process.argv[1]
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });

export {
    bucketHasPromptOutput,
    missingPrompts,
    missingPromptsOnePerNewBucket,
    promptPath,
    promptSkipPath,
    simPath,
};
