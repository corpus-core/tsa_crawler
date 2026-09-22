#!/usr/bin/env node
// Cluster `_prompt.json` files by (method_id × Solidity interface) and copy a
// CAP-sized keep-set to OUT (`_prompt.json` + sibling `_sim.json`). DATA_DIR is read-only.
//
//   DATA_DIR=test_data OUT=./train_data CAP=5 node src/dedup.mjs
//   DATA_DIR=test_data node src/dedup.mjs --dry-run

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { walkBuckets } from './bucket_paths.mjs';
import {
    PROMPT_FILE_RE,
    firstUserPrompt,
    splitSections,
    sectionText,
    simPathForPrompt,
    isSectionResolved,
    parseSectionList,
    readResponse,
} from './query.mjs';

export const DEFAULT_CAP = 5;
export const DEFAULT_PROGRESS_EVERY = 5000;
export const MANIFEST_NAME = '.dedup-manifest.json';

const BUCKET_KEY_RE = /^([0-9a-f]{64})_([0-9a-f]{8}|fallback)$/;
const SOURCE_BEGIN = '<<<C4_UNTRUSTED_SOURCE';
const SOURCE_END = '<<<C4_END_UNTRUSTED_SOURCE>>>';
const SIM_FILE_RE = /^0x[0-9a-f]{64}_sim\.json$/;
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const TYPE_NAME_RE = /^(u?int\d*|bytes\d*|address|bool|string|bytes|byte|fixed|ufixed)$/;
const VISIBILITY_PRIVATE_RE = /\b(internal|private)\b/;
const TRIVIA_RE = /\b(indexed|memory|calldata|storage|payable)\b/g;
const KEYWORD_RE = /\b(function|event|constructor|fallback|receive)\b/g;

export const HELP = `Usage: DATA_DIR=<dir> [OUT=<dir>] [CAP=<n>] node src/dedup.mjs [options]

Cluster first-entry userPrompts by (path method_id × public Solidity interface)
and copy at most CAP files per cluster to OUT. Prompts without a code section
or C4 source body are skipped. DATA_DIR is never modified.

Options:
  --out <dir>     Keep-set root (overrides OUT). Same sharding as DATA_DIR
  --keep <n>      Max prompts per cluster (overrides CAP; default ${DEFAULT_CAP})
  --dry-run       Print stats only; do not copy
  -h, --help      Show this help

Env:
  REQUIRE_RESOLVED  Comma list of sections (tx,events,state,call,code) that
                    must be resolved; others are skipped (default: off)
  STICKY            1 = keepers that already have a _response.json under OUT
                    win their cluster slot before the quality score
`;

/**
 * Prefer richer traces: more gas, events, calls, and storage writes.
 *
 * `score = gasUsed/1e5 + eventCount/3 + callCount/5 + stateChangeCount/10`
 *
 * @param {{ relPath?: string, absPath?: string, userPrompt?: string, methodId?: string, codeSection?: string }} hit
 * @return {number}
 */
export function qualityScore(hit) {
    const userPrompt = hit?.userPrompt;
    if (typeof userPrompt !== 'string') return 0;
    const parts = splitSections(userPrompt);
    const gas = parseGasUsed(sectionText(parts, 'tx'));
    const events = countNumberedItems(sectionText(parts, 'events'));
    const calls = countCallTraces(sectionText(parts, 'call'));
    const state = countBulletItems(sectionText(parts, 'state'));
    return gas / 100000 + events / 3 + calls / 5 + state / 10;
}

/**
 * @param {string[]} argv
 * @return {{ dryRun: boolean, help: boolean, out?: string, keep?: number }}
 */
export function parseArgs(argv) {
    const flags = { dryRun: false, help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-h' || a === '--help') {
            flags.help = true;
            continue;
        }
        if (a === '--dry-run') {
            flags.dryRun = true;
            continue;
        }
        if (a === '--out' || a === '--keep') {
            const val = argv[++i];
            if (val === undefined || val.startsWith('-')) {
                throw new Error(`${a} requires a value`);
            }
            if (a === '--out') {
                flags.out = val;
                continue;
            }
            if (!/^[1-9]\d*$/.test(val)) {
                throw new Error('--keep must be a positive integer');
            }
            flags.keep = Number(val);
            continue;
        }
        throw new Error(`unknown flag: ${a}`);
    }
    return flags;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ keep?: number }} [flags]
 * @return {number}
 */
export function resolveCap(env = process.env, flags = {}) {
    if (flags.keep !== undefined) return flags.keep;
    if (env.CAP === undefined || env.CAP === '') return DEFAULT_CAP;
    if (!/^[1-9]\d*$/.test(String(env.CAP))) {
        throw new Error('CAP must be a positive integer');
    }
    return Number(env.CAP);
}

/**
 * Heartbeat interval while scanning. `0` disables mid-scan logs.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @return {number}
 */
export function resolveProgressEvery(env = process.env) {
    if (env.PROGRESS_EVERY === undefined || env.PROGRESS_EVERY === '') return DEFAULT_PROGRESS_EVERY;
    if (!/^\d+$/.test(String(env.PROGRESS_EVERY))) return DEFAULT_PROGRESS_EVERY;
    return Number(env.PROGRESS_EVERY);
}

/**
 * Sections a candidate must have resolved, or `[]` when the filter is off.
 * `REQUIRE_RESOLVED=` (empty) is off; an unknown section name throws.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @return {string[]}
 */
export function resolveRequireResolved(env = process.env) {
    const raw = env.REQUIRE_RESOLVED;
    if (raw === undefined || String(raw).trim() === '') return [];
    return parseSectionList(String(raw), 'REQUIRE_RESOLVED');
}

/**
 * Source bodies inside C4 wrappers. Empty when the section has no usable source.
 *
 * @param {string} codeSection
 * @return {string[]}
 */
export function extractSourceBodies(codeSection) {
    if (!codeSection) return [];
    const bodies = [];
    let pos = 0;
    while (pos < codeSection.length) {
        const start = codeSection.indexOf(SOURCE_BEGIN, pos);
        if (start === -1) break;
        const openEnd = codeSection.indexOf('>>>', start);
        if (openEnd === -1) break;
        const contentStart = openEnd + 3;
        const end = codeSection.indexOf(SOURCE_END, contentStart);
        if (end === -1) break;
        bodies.push(codeSection.slice(contentStart, end));
        pos = end + SOURCE_END.length;
    }
    return bodies;
}

/**
 * @param {string} codeSection
 * @return {boolean}
 */
export function hasUsableSource(codeSection) {
    return extractSourceBodies(codeSection).some((b) => b.trim().length > 0);
}

/**
 * SHA-256 of the canonical public/external function + event set, or null
 * when the code section has no C4 source body.
 *
 * @param {string} codeSection
 * @return {string | null}
 */
export function interfaceFingerprint(codeSection) {
    const bodies = extractSourceBodies(codeSection).filter((b) => b.trim());
    if (!bodies.length) return null;
    const sigs = new Set();
    for (const body of bodies) {
        for (const sig of extractSignatures(body)) sigs.add(sig);
    }
    const canonical = [...sigs].sort().join('\n');
    return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * @param {string} methodId
 * @param {string} fingerprint
 * @return {string}
 */
export function clusterKey(methodId, fingerprint) {
    return `${methodId}:${fingerprint}`;
}

/**
 * Public/external functions, fallback/receive, and events as canonical strings
 * (`function:transfer(address,uint256)`, `event:Transfer(address,address,uint256)`).
 *
 * @param {string} source
 * @return {string[]}
 */
export function extractSignatures(source) {
    const text = stripSolidityTrivia(source);
    const sigs = [];
    KEYWORD_RE.lastIndex = 0;
    let m;
    while ((m = KEYWORD_RE.exec(text))) {
        const kind = m[1];
        const parsed = parseDeclaration(text, m.index + kind.length, kind);
        KEYWORD_RE.lastIndex = parsed.nextIndex;
        if (!parsed.sig) continue;
        sigs.push(parsed.sig);
    }
    return sigs;
}

/**
 * @param {string} userPrompt
 * @return {string | null}
 */
export function parseTxFunction(userPrompt) {
    const tx = sectionText(splitSections(userPrompt), 'tx');
    const named = tx.match(/^- Function: ([A-Za-z_$][A-Za-z0-9_$]*)\(/m);
    if (named) return named[1];
    const sel = tx.match(/^- Function selector: (\S+)/m);
    if (sel) return sel[1];
    return null;
}

/**
 * Stream DATA_DIR. Returned records do not keep `userPrompt`.
 *
 * @param {string} root
 * @param {{ qualityScore?: typeof qualityScore, onWarn?: (msg: string) => void, onProgress?: (msg: string) => void, progressEvery?: number }} [opts]
 * @return {{ candidates: Array<{ relPath: string, absPath: string, methodId: string, fingerprint: string, cluster: string, score: number, txFunction: string | null }>, scanned: number, skippedNocode: number, skippedBad: number }}
 */
export function collectCandidates(root, opts = {}) {
    const scoreFn = opts.qualityScore || qualityScore;
    const onWarn = opts.onWarn;
    const onProgress = opts.onProgress;
    const progressEvery = opts.progressEvery || 0;
    const requireResolved = Array.isArray(opts.requireResolved) ? opts.requireResolved : [];
    const candidates = [];
    let scanned = 0;
    let skippedNocode = 0;
    let skippedBad = 0;
    let skippedUnresolved = 0;

    walkBuckets(root, (dir, key) => {
        const bucket = key.match(BUCKET_KEY_RE);
        if (!bucket) return;
        const methodId = bucket[2];
        let names;
        try {
            names = fs.readdirSync(dir);
        } catch {
            return;
        }
        for (const name of names) {
            if (!PROMPT_FILE_RE.test(name)) continue;
            scanned++;
            if (progressEvery > 0 && scanned % progressEvery === 0) {
                onProgress?.(`dedup: scanned ${scanned} ...`);
            }
            const absPath = path.join(dir, name);
            let parsed;
            try {
                parsed = JSON.parse(fs.readFileSync(absPath, 'utf8'));
            } catch (e) {
                skippedBad++;
                onWarn?.(`warn: skip ${absPath}: ${e.message}`);
                continue;
            }
            const userPrompt = firstUserPrompt(parsed);
            if (userPrompt === null) {
                skippedBad++;
                onWarn?.(`warn: skip ${absPath}: missing userPrompt`);
                continue;
            }
            const codeSection = sectionText(splitSections(userPrompt), 'code');
            if (!hasUsableSource(codeSection)) {
                skippedNocode++;
                continue;
            }
            const fingerprint = interfaceFingerprint(codeSection);
            if (!fingerprint) {
                skippedNocode++;
                continue;
            }
            if (requireResolved.length) {
                const parts = splitSections(userPrompt);
                const unresolved = requireResolved.filter((key) => !isSectionResolved(parts, key));
                if (unresolved.length) {
                    skippedUnresolved++;
                    continue;
                }
            }
            const relPath = path.relative(root, absPath);
            const hit = { relPath, absPath, userPrompt, methodId, codeSection };
            const score = Number(scoreFn(hit));
            if (!Number.isFinite(score)) {
                skippedBad++;
                onWarn?.(`warn: skip ${absPath}: qualityScore is not finite`);
                continue;
            }
            candidates.push({
                relPath,
                absPath,
                methodId,
                fingerprint,
                cluster: clusterKey(methodId, fingerprint),
                score,
                txFunction: parseTxFunction(userPrompt),
            });
        }
    });

    return { candidates, scanned, skippedNocode, skippedBad, skippedUnresolved };
}

/**
 * Highest `score` first; `relPath` ascending on ties. Slice to `cap`.
 *
 * `opts.pinned` is a set of `relPath`s that already have a teacher response.
 * Pinned candidates take cluster slots before the score sort, so a paid
 * answer is not evicted by a newer, richer trace. Among pinned (and among
 * the rest) `compareKeep` still applies, and `cap` is never exceeded.
 * Kept entries gain `pinned: true|false`; inputs are not mutated.
 *
 * @param {Array<{ relPath: string, cluster: string, score: number }>} candidates
 * @param {number} cap
 * @param {{ pinned?: Set<string> }} [opts]
 * @return {{ kept: Array<object>, dropped: Array<object> }}
 */
export function selectByCap(candidates, cap, opts = {}) {
    const pinned = opts.pinned instanceof Set ? opts.pinned : new Set();
    const groups = new Map();
    for (const c of candidates) {
        let list = groups.get(c.cluster);
        if (!list) {
            list = [];
            groups.set(c.cluster, list);
        }
        list.push(c);
    }
    const kept = [];
    const dropped = [];
    for (const list of groups.values()) {
        list.sort((a, b) => {
            const pa = pinned.has(a.relPath) ? 1 : 0;
            const pb = pinned.has(b.relPath) ? 1 : 0;
            if (pa !== pb) return pb - pa;
            return compareKeep(a, b);
        });
        const chosen = list.slice(0, cap).map((c) => ({ ...c, pinned: pinned.has(c.relPath) }));
        const rest = list.slice(cap).map((c) => ({ ...c, pinned: pinned.has(c.relPath) }));
        kept.push(...chosen);
        dropped.push(...rest);
    }
    kept.sort((a, b) => a.relPath.localeCompare(b.relPath));
    dropped.sort((a, b) => a.relPath.localeCompare(b.relPath));
    return { kept, dropped };
}

/**
 * @param {{ score: number, relPath: string }} a
 * @param {{ score: number, relPath: string }} b
 * @return {number}
 */
export function compareKeep(a, b) {
    if (b.score !== a.score) return b.score - a.score;
    return a.relPath.localeCompare(b.relPath);
}

/**
 * @param {string} dataDir
 * @param {string} outDir
 */
export function assertSafeOutDir(dataDir, outDir) {
    const data = path.resolve(dataDir);
    const out = path.resolve(outDir);
    if (out === data) {
        throw new Error('OUT must not be DATA_DIR');
    }
    const outPrefix = out.endsWith(path.sep) ? out : out + path.sep;
    if (data === out || data.startsWith(outPrefix)) {
        throw new Error('OUT must not contain DATA_DIR');
    }
}

/**
 * Copy keepers with the same relative layout. Overwrites previous keep-set
 * `_prompt.json` and sibling `_sim.json` under OUT. Teacher `_response.json`
 * and `_validation.json` files are left in place so a sticky re-run does not
 * throw away answers that were already paid for.
 *
 * @param {string} outDir
 * @param {Array<{ relPath: string, absPath: string }>} kept
 * @return {{ prompts: number, sims: number }}
 */
export function copyKeepers(outDir, kept) {
    removeKeepTree(outDir);
    let sims = 0;
    for (const item of kept) {
        const dest = path.join(outDir, item.relPath);
        atomicCopy(item.absPath, dest);
        const simSrc = simPathForPrompt(item.absPath);
        try {
            atomicCopy(simSrc, simPathForPrompt(dest));
            sims++;
        } catch (e) {
            if (e && e.code === 'ENOENT') continue;
            throw e;
        }
    }
    return { prompts: kept.length, sims };
}

/**
 * @param {string} outDir
 * @param {object} manifest
 */
export function writeManifest(outDir, manifest) {
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, MANIFEST_NAME);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n');
    fs.renameSync(tmp, file);
}

/**
 * @param {{ scanned: number, skippedNocode: number, skippedBad: number, cap: number, candidates: Array<{ cluster: string, methodId: string }>, kept: Array<{ cluster: string }>, dropped: Array<{ cluster: string }> }} stats
 * @return {string}
 */
export function formatSummary(stats) {
    const clusterCounts = new Map();
    for (const c of stats.candidates) {
        clusterCounts.set(c.cluster, (clusterCounts.get(c.cluster) || 0) + 1);
    }
    const largest = [...clusterCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 10);
    const lines = [
        `scanned: ${stats.scanned}`,
        `skipped-nocode: ${stats.skippedNocode}`,
        `skipped-bad: ${stats.skippedBad}`,
        `skipped-unresolved: ${stats.skippedUnresolved || 0}`,
        `clusters: ${clusterCounts.size}`,
        `kept: ${stats.kept.length}`,
        `pinned: ${stats.kept.filter((k) => k.pinned).length}`,
        `dropped: ${stats.dropped.length}`,
        `cap: ${stats.cap}`,
    ];
    if (largest.length) {
        lines.push('largest:');
        for (const [cluster, n] of largest) {
            const keptN = stats.kept.filter((k) => k.cluster === cluster).length;
            lines.push(`  ${cluster} n=${n} kept=${keptN}`);
        }
    }
    return lines.join('\n');
}

/**
 * Prometheus textfile for the last completed run (node_exporter textfile_collector).
 *
 * @param {{ scanned: number, skippedNocode: number, skippedBad: number, clusters: number, kept: number, dropped: number, cap: number, copied: number, lastRunTs: number, dryRun?: boolean }} stats
 * @param {string} [chain]
 * @return {string}
 */
export function formatMetrics(stats, chain = 'mainnet') {
    const labels = `{chain="${escapeLabel(chain)}"}`;
    return [
        '# HELP trace_dedup_scanned Prompt files scanned in the last run.',
        '# TYPE trace_dedup_scanned gauge',
        `trace_dedup_scanned${labels} ${stats.scanned}`,
        '# HELP trace_dedup_skipped_nocode Prompts skipped for missing Solidity source in the last run.',
        '# TYPE trace_dedup_skipped_nocode gauge',
        `trace_dedup_skipped_nocode${labels} ${stats.skippedNocode}`,
        '# HELP trace_dedup_skipped_bad Prompts skipped as unreadable or unscorable in the last run.',
        '# TYPE trace_dedup_skipped_bad gauge',
        `trace_dedup_skipped_bad${labels} ${stats.skippedBad}`,
        '# HELP trace_dedup_skipped_unresolved Prompts skipped because a REQUIRE_RESOLVED section was not decoded.',
        '# TYPE trace_dedup_skipped_unresolved gauge',
        `trace_dedup_skipped_unresolved${labels} ${stats.skippedUnresolved || 0}`,
        '# HELP trace_dedup_clusters Distinct (method_id × interface) clusters in the last run.',
        '# TYPE trace_dedup_clusters gauge',
        `trace_dedup_clusters${labels} ${stats.clusters}`,
        '# HELP trace_dedup_kept Prompts selected for the keep-set in the last run.',
        '# TYPE trace_dedup_kept gauge',
        `trace_dedup_kept${labels} ${stats.kept}`,
        '# HELP trace_dedup_pinned Kept prompts that already had a teacher response (STICKY).',
        '# TYPE trace_dedup_pinned gauge',
        `trace_dedup_pinned${labels} ${stats.pinned || 0}`,
        '# HELP trace_dedup_dropped Prompts above CAP in the last run.',
        '# TYPE trace_dedup_dropped gauge',
        `trace_dedup_dropped${labels} ${stats.dropped}`,
        '# HELP trace_dedup_cap Max prompts kept per cluster.',
        '# TYPE trace_dedup_cap gauge',
        `trace_dedup_cap${labels} ${stats.cap}`,
        '# HELP trace_dedup_copied Prompt files written to OUT in the last run (0 on dry-run).',
        '# TYPE trace_dedup_copied gauge',
        `trace_dedup_copied${labels} ${stats.copied}`,
        '# HELP trace_dedup_copied_sim Sibling _sim.json files written to OUT in the last run (0 on dry-run).',
        '# TYPE trace_dedup_copied_sim gauge',
        `trace_dedup_copied_sim${labels} ${stats.copiedSim || 0}`,
        '# HELP trace_dedup_dry_run 1 if the last run was --dry-run.',
        '# TYPE trace_dedup_dry_run gauge',
        `trace_dedup_dry_run${labels} ${stats.dryRun ? 1 : 0}`,
        '# HELP trace_dedup_last_run_timestamp Unix time of the last completed dedup pass.',
        '# TYPE trace_dedup_last_run_timestamp gauge',
        `trace_dedup_last_run_timestamp${labels} ${stats.lastRunTs}`,
        '',
    ].join('\n');
}

/**
 * Atomically write `formatMetrics` to `promFile`. No-op when `promFile` is empty.
 *
 * @param {string} promFile
 * @param {object} stats  Last-run counts (`scanned`, `kept`, `copied`, …)
 * @param {{ chain?: string, onError?: (msg: string) => void }} [opts]
 */
export function writeMetrics(promFile, stats, opts = {}) {
    if (!promFile) return;
    try {
        const tmp = promFile + '.tmp';
        fs.writeFileSync(tmp, formatMetrics(stats, opts.chain || 'mainnet'));
        fs.renameSync(tmp, promFile);
    } catch (e) {
        opts.onError?.(`metrics-error: ${e.message}`);
    }
}

function escapeLabel(v) {
    return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

export function main(env = process.env, argv = process.argv.slice(2), io = console, opts = {}) {
    let flags;
    try {
        flags = parseArgs(argv);
    } catch (e) {
        io.error(e.message);
        io.error(HELP);
        process.exitCode = 1;
        return;
    }
    if (flags.help) {
        io.log(HELP);
        return;
    }

    const dataDir = env.DATA_DIR;
    if (!dataDir) {
        io.error('DATA_DIR is not set');
        process.exitCode = 1;
        return;
    }
    if (!dirExists(dataDir)) {
        io.error(`DATA_DIR is not a directory: ${dataDir}`);
        process.exitCode = 1;
        return;
    }

    let cap;
    let requireResolved;
    try {
        cap = resolveCap(env, flags);
        requireResolved = resolveRequireResolved(env);
    } catch (e) {
        io.error(e.message);
        process.exitCode = 1;
        return;
    }

    const outDir = flags.out || env.OUT;
    if (!flags.dryRun && !outDir) {
        io.error('OUT is not set (pass --out or OUT=)');
        process.exitCode = 1;
        return;
    }
    if (!flags.dryRun) {
        try {
            assertSafeOutDir(dataDir, outDir);
        } catch (e) {
            io.error(e.message);
            process.exitCode = 1;
            return;
        }
    }

    const sticky = env.STICKY === '1';
    io.log(`dedup: scanning ${dataDir} cap=${cap}${requireResolved.length ? ` resolved=${requireResolved.join(',')}` : ''}${sticky ? ' sticky' : ''}${flags.dryRun ? ' dry-run' : ''}`);
    const collected = collectCandidates(dataDir, {
        qualityScore: opts.qualityScore || qualityScore,
        onWarn: (msg) => io.error(msg),
        onProgress: (msg) => io.log(msg),
        progressEvery: resolveProgressEvery(env),
        requireResolved,
    });
    const clusters = new Set(collected.candidates.map((c) => c.cluster)).size;
    const pinned = sticky && outDir ? pinnedRelPaths(outDir, collected.candidates) : new Set();
    io.log(`dedup: scanned ${collected.scanned}, ${clusters} clusters, selecting cap=${cap}${pinned.size ? ` pinned=${pinned.size}` : ''}`);
    const { kept, dropped } = selectByCap(collected.candidates, cap, { pinned });

    io.log(formatSummary({
        scanned: collected.scanned,
        skippedNocode: collected.skippedNocode,
        skippedBad: collected.skippedBad,
        skippedUnresolved: collected.skippedUnresolved,
        cap,
        candidates: collected.candidates,
        kept,
        dropped,
    }));

    let copiedSim = 0;
    if (!flags.dryRun) {
        io.log(`dedup: copying ${kept.length} prompts (+ sibling _sim.json) -> ${outDir}`);
        copiedSim = copyKeepers(outDir, kept).sims;
        writeManifest(outDir, {
            cap,
            scanned: collected.scanned,
            skippedNocode: collected.skippedNocode,
            skippedBad: collected.skippedBad,
            skippedUnresolved: collected.skippedUnresolved,
            clusters,
            kept: kept.map((c) => ({
                relPath: c.relPath,
                cluster: c.cluster,
                methodId: c.methodId,
                score: c.score,
                txFunction: c.txFunction,
                pinned: !!c.pinned,
            })),
            dropped: dropped.map((c) => ({
                relPath: c.relPath,
                cluster: c.cluster,
                methodId: c.methodId,
                score: c.score,
            })),
        });
    }

    writeMetrics(env.PROM_FILE || '', {
        scanned: collected.scanned,
        skippedNocode: collected.skippedNocode,
        skippedBad: collected.skippedBad,
        skippedUnresolved: collected.skippedUnresolved,
        clusters,
        kept: kept.length,
        pinned: kept.filter((k) => k.pinned).length,
        dropped: dropped.length,
        cap,
        copied: flags.dryRun ? 0 : kept.length,
        copiedSim,
        lastRunTs: Math.floor(Date.now() / 1000),
        dryRun: flags.dryRun,
    }, {
        chain: env.CHAIN || 'mainnet',
        onError: (msg) => io.error(msg),
    });
}

/**
 * relPaths under `outDir` that already have a readable `_response.json`.
 * Missing files are not pinned; a corrupt response file is not either.
 *
 * @param {string} outDir
 * @param {Array<{ relPath: string }>} candidates
 * @return {Set<string>}
 */
function pinnedRelPaths(outDir, candidates) {
    const pinned = new Set();
    for (const c of candidates) {
        if (readResponse(path.join(outDir, c.relPath))) pinned.add(c.relPath);
    }
    return pinned;
}

function dirExists(p) {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

function atomicCopy(src, dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.tmp';
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, dest);
}

function removeKeepTree(outDir) {
    if (!fs.existsSync(outDir)) return;
    walkBuckets(outDir, (dir) => {
        let names;
        try {
            names = fs.readdirSync(dir);
        } catch {
            return;
        }
        for (const name of names) {
            if (PROMPT_FILE_RE.test(name) || SIM_FILE_RE.test(name)) {
                fs.unlinkSync(path.join(dir, name));
            }
        }
    });
}

function stripSolidityTrivia(src) {
    let out = '';
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        const n = src[i + 1];
        if (c === '"' || c === "'") {
            i = skipQuoted(src, i);
            out += '""';
            continue;
        }
        if (c === '/' && n === '/') {
            i += 2;
            while (i < src.length && src[i] !== '\n') i++;
            continue;
        }
        if (c === '/' && n === '*') {
            i += 2;
            while (i + 1 < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
            i += 2;
            out += ' ';
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

function skipQuoted(src, i) {
    const q = src[i];
    i++;
    while (i < src.length) {
        if (src[i] === '\\') {
            i += 2;
            continue;
        }
        if (src[i] === q) return i + 1;
        i++;
    }
    return i;
}

function parseDeclaration(text, afterKw, kind) {
    let i = skipWs(text, afterKw);
    if (kind === 'constructor') {
        return { sig: null, nextIndex: skipDeclTail(text, i) };
    }
    if (kind === 'receive') {
        const params = readParamList(text, i);
        if (!params) return { sig: null, nextIndex: i };
        const vis = readModifiers(text, params.end);
        if (VISIBILITY_PRIVATE_RE.test(vis.text)) {
            return { sig: null, nextIndex: vis.nextIndex };
        }
        return { sig: 'receive()', nextIndex: vis.nextIndex };
    }
    if (kind === 'fallback') {
        const params = readParamList(text, i);
        if (!params) return { sig: null, nextIndex: i };
        const vis = readModifiers(text, params.end);
        if (VISIBILITY_PRIVATE_RE.test(vis.text)) {
            return { sig: null, nextIndex: vis.nextIndex };
        }
        const types = canonicalizeParams(params.inner);
        return {
            sig: types ? `fallback(${types})` : 'fallback()',
            nextIndex: vis.nextIndex,
        };
    }
    if (kind === 'event') {
        const name = readIdent(text, i);
        if (!name) return { sig: null, nextIndex: i };
        const params = readParamList(text, name.end);
        if (!params) return { sig: null, nextIndex: name.end };
        const types = canonicalizeParams(params.inner);
        const vis = readModifiers(text, params.end);
        return {
            sig: `event:${name.value}(${types})`,
            nextIndex: vis.nextIndex,
        };
    }
    // function
    let name = 'fallback';
    if (text[i] !== '(') {
        const ident = readIdent(text, i);
        if (!ident) return { sig: null, nextIndex: i };
        name = ident.value;
        i = ident.end;
    }
    const params = readParamList(text, i);
    if (!params) return { sig: null, nextIndex: i };
    const vis = readModifiers(text, params.end);
    if (VISIBILITY_PRIVATE_RE.test(vis.text)) {
        return { sig: null, nextIndex: vis.nextIndex };
    }
    const types = canonicalizeParams(params.inner);
    const label = name === 'fallback' ? 'fallback' : `function:${name}`;
    return {
        sig: types ? `${label}(${types})` : `${label}()`,
        nextIndex: vis.nextIndex,
    };
}

function skipWs(text, i) {
    while (i < text.length && /\s/.test(text[i])) i++;
    return i;
}

function readIdent(text, i) {
    i = skipWs(text, i);
    if (i >= text.length || !/[A-Za-z_$]/.test(text[i])) return null;
    let j = i + 1;
    while (j < text.length && /[A-Za-z0-9_$]/.test(text[j])) j++;
    return { value: text.slice(i, j), end: j };
}

function readParamList(text, i) {
    i = skipWs(text, i);
    if (text[i] !== '(') return null;
    let depth = 0;
    const start = i + 1;
    for (let j = i; j < text.length; j++) {
        const c = text[j];
        if (c === '(') depth++;
        else if (c === ')') {
            depth--;
            if (depth === 0) {
                return { inner: text.slice(start, j), end: j + 1 };
            }
        }
    }
    return null;
}

function readModifiers(text, i) {
    let depth = 0;
    const start = i;
    for (let j = i; j < text.length; j++) {
        const c = text[j];
        if (c === '(') depth++;
        else if (c === ')') {
            if (depth > 0) depth--;
        } else if (depth === 0 && (c === '{' || c === ';')) {
            return { text: text.slice(start, j), nextIndex: skipDeclTail(text, j) };
        }
    }
    return { text: text.slice(start), nextIndex: text.length };
}

function skipDeclTail(text, i) {
    i = skipWs(text, i);
    if (text[i] === ';') return i + 1;
    if (text[i] !== '{') return i;
    let depth = 0;
    for (let j = i; j < text.length; j++) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') {
            depth--;
            if (depth === 0) return j + 1;
        }
    }
    return text.length;
}

function canonicalizeParams(inner) {
    const parts = splitTopLevel(inner);
    return parts.map(canonicalizeParam).filter(Boolean).join(',');
}

function splitTopLevel(inner) {
    const parts = [];
    let depth = 0;
    let cur = '';
    for (const ch of inner) {
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth--;
        if (ch === ',' && depth === 0) {
            const t = cur.trim();
            if (t) parts.push(t);
            cur = '';
        } else {
            cur += ch;
        }
    }
    const tail = cur.trim();
    if (tail) parts.push(tail);
    return parts;
}

function canonicalizeParam(raw) {
    let s = raw.replace(TRIVIA_RE, ' ');
    s = s.replace(/\buint\b/g, 'uint256');
    s = s.replace(/\bint\b/g, 'int256');
    s = s.replace(/\bbyte\b/g, 'bytes1');
    s = s.replace(/\s+/g, ' ').trim();
    s = s.replace(/\s*\[\s*/g, '[').replace(/\s*\]/g, ']');
    s = s.replace(/\s*,\s*/g, ',').replace(/\s*\(\s*/g, '(').replace(/\s*\)\s*/g, ')');
    const named = s.match(/^(.*[\]\w)])\s+([A-Za-z_$][A-Za-z0-9_$]*)$/);
    if (named && IDENT_RE.test(named[2]) && !TYPE_NAME_RE.test(named[2])) {
        s = named[1];
    }
    return s.replace(/\s+/g, '');
}

function parseGasUsed(txSection) {
    const m = txSection.match(/^- Gas used: (.+)$/m);
    if (!m) return 0;
    const n = Number(String(m[1]).replace(/,/g, '').trim());
    return Number.isFinite(n) && n >= 0 ? n : 0;
}

function countNumberedItems(section) {
    let n = 0;
    for (const line of section.split('\n')) {
        if (/^\d+\.\s/.test(line)) n++;
    }
    return n;
}

function countCallTraces(section) {
    let n = countNumberedItems(section);
    const more = section.match(/^\.\.\. and (\d+) more calls\s*$/m);
    if (more) n += Number(more[1]);
    return n;
}

function countBulletItems(section) {
    let n = 0;
    for (const line of section.split('\n')) {
        if (/^- /.test(line)) n++;
    }
    return n;
}

const isMain = process.argv[1]
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) main();
