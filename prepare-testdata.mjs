#!/usr/bin/env node
// Build {txhash}_sim.json and {txhash}_prompt.json from stored collector traces.
// _prompt.json is an array: simple (explainer default) + detailed system prompt.
// If Sourcify has no source, write {txhash}_prompt.nosrc so later runs skip it.
// INTERVAL_S>0 repeats the run (server). SKIP_EXPLAINER_BUILD=1 uses a prebuilt dist.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sloadsToAccessList, collectTraceSlots } from './proxy_accesslist.mjs';
import { traceToSimulation, txParamsFromMeta, extractRevertData } from './sim-from-trace.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IN = process.env.IN || './test_data';
const RPC = process.env.RPC || 'https://mainnet1.colibri-proof.tech/execution';
const CHAIN_ID = parseInt(process.env.CHAIN_ID || '1', 10);
const STEPS = (process.env.STEPS || '1,2').split(',').map((s) => s.trim()).filter(Boolean);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '4', 10);
const FORCE = process.env.FORCE === '1';
const PROGRESS_EVERY = parseInt(process.env.PROGRESS_EVERY || '100', 10);
const INTERVAL_S = parseInt(process.env.INTERVAL_S || '0', 10);
const SKIP_EXPLAINER_BUILD = process.env.SKIP_EXPLAINER_BUILD === '1';
const EXPLAINER_DIR = process.env.EXPLAINER_DIR
    || path.resolve(__dirname, '../colibri-stateless/bindings/emscripten/packages/explainer');
const TRACE_FILE_RE = /^0x[0-9a-f]{64}\.json$/;
if (!process.env.C4_STATE_DIR) process.env.C4_STATE_DIR = '.';

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
        err.rpcError = j.error;
        throw err;
    }
    return j.result;
}

function writeAtomic(file, obj) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
    fs.renameSync(tmp, file);
}

function listTraceFiles(root) {
    const out = [];
    if (!fs.existsSync(root)) return out;
    const names = fs.readdirSync(root);
    for (const name of names) {
        if (TRACE_FILE_RE.test(name)) out.push(path.join(root, name));
    }
    for (const name of names) {
        const dir = path.join(root, name);
        let st;
        try { st = fs.statSync(dir); } catch { continue; }
        if (!st.isDirectory()) continue;
        for (const f of fs.readdirSync(dir)) {
            if (TRACE_FILE_RE.test(f)) out.push(path.join(dir, f));
        }
    }
    return out;
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

function missingPrompts(traces) {
    if (FORCE) return traces;
    return traces.filter((f) => !fs.existsSync(promptPath(f)) && !fs.existsSync(promptSkipPath(f)));
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

async function step2(traceFile, explainer) {
    const dest = promptPath(traceFile);
    const skip = promptSkipPath(traceFile);
    if (!FORCE && (fs.existsSync(dest) || fs.existsSync(skip))) return 'skip';
    const simFile = simPath(traceFile);
    if (!fs.existsSync(simFile)) {
        console.error('step2 missing sim', path.basename(traceFile));
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
    writeAtomic(dest, [
        {
            style: 'simple',
            ...explainer.buildPrompt(sim, txParams, {}, context),
        },
        {
            style: 'detailed',
            ...explainer.buildPrompt(sim, txParams, { systemPrompt: DETAILED_SYSTEM_PROMPT }, context),
        },
    ]);
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

    if (STEPS.includes('1')) {
        const files = missingOutput(all, simPath);
        console.log(`step1: ${files.length} ohne _sim.json`);
        let ok = 0, skip = 0, err = 0, done = 0;
        await mapLimit(files, CONCURRENCY, async (f) => {
            try {
                const r = await step1(f);
                if (r === 'skip') skip++; else ok++;
            } catch (e) {
                err++;
                console.error('step1', path.basename(f), e.message);
            }
            done++;
            if (done % PROGRESS_EVERY === 0) {
                console.log(`step1: ${done}/${files.length} ok=${ok} err=${err}`);
            }
        });
        console.log(`step1: ${done}/${files.length} ok=${ok} skip=${skip} err=${err}`);
    }

    if (STEPS.includes('2')) {
        const withSim = all.filter((f) => fs.existsSync(simPath(f)));
        const files = missingPrompts(withSim);
        console.log(`step2: ${files.length} ohne _prompt.json/_prompt.nosrc (${withSim.length} haben _sim.json)`);
        if (!files.length) {
            console.log('step2: nichts zu tun');
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
                else if (r === 'nosrc') nosrc++;
                else if (r === 'err') err++;
                else ok++;
            } catch (e) {
                err++;
                console.error('step2', path.basename(f), e.message);
            }
            done++;
            if (done % PROGRESS_EVERY === 0) {
                console.log(`step2: ${done}/${files.length} ok=${ok} nosrc=${nosrc} err=${err}`);
            }
        });
        console.log(`step2: ${done}/${files.length} ok=${ok} skip=${skip} nosrc=${nosrc} err=${err}`);
    }
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

main().catch((e) => { console.error(e); process.exit(1); });
