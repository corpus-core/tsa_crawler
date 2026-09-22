#!/usr/bin/env node
// One idempotent pass from the prompt tree to an SFT dataset:
//   dedup (sticky, resolved-only) → gen-responses → validate-responses
//   → regenerate answers that failed grounding or were judged wrong
//   → export-dataset with the quality gates on.
//
// Each stage only does missing work, so re-running after a manual
// `query -R` regenerates just the reset transactions.
//
//   DATA_DIR=./traces node src/build_dataset.mjs --dry-run
//   DATA_DIR=./traces DEEPSEEK_API_KEY=sk-... node src/build_dataset.mjs

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { main as dedupMain } from './dedup.mjs';
import { main as genMain, DEFAULT_STYLES } from './gen_responses.mjs';
import { main as validateMain, sha256Hex } from './validate_responses.mjs';
import { main as exportMain } from './export_dataset.mjs';
import { readValidation, tracePathForPrompt, unlinkResponseFiles } from './query.mjs';
import { collectPairs } from './validate_responses.mjs';

export const DEFAULT_STAGES = Object.freeze(['dedup', 'gen', 'validate', 'export']);
export const DEFAULT_REGEN_ROUNDS = 1;
export const DEFAULT_REQUIRE_RESOLVED = 'tx,events';
export const DEFAULT_MIN_GROUNDING_RATIO = '0.7';

const STAGE_SET = new Set(DEFAULT_STAGES);

export const HELP = `Usage: DATA_DIR=<dir> [DEEPSEEK_API_KEY=<key>] node src/build_dataset.mjs [options]

Run the training-data build in one idempotent pass. dedup reads DATA_DIR and
writes the keep-set to TRAIN_DIR; gen, validate, and export then work only on
TRAIN_DIR. Re-runs skip answers that are already fresh.

Options:
  --dry-run       Forward --dry-run to every stage; no copies, no API, no writes
  -h, --help      Show this help

Env:
  DATA_DIR              Prompt tree from prepare (required)
  TRAIN_DIR             Dedup keep-set (default <DATA_DIR>/train)
  DATASET_OUT           Export directory (default <TRAIN_DIR>/dataset)
  STAGES                Comma list, subset of ${DEFAULT_STAGES.join(',')}
                        (default all, in that order)
  REGEN_ROUNDS          How often to redo fail/wrong answers (default ${DEFAULT_REGEN_ROUNDS}; 0 = off)
  REQUIRE_RESOLVED      Passed to dedup (default ${DEFAULT_REQUIRE_RESOLVED}; empty = off)
  STICKY                Passed to dedup (default 1)
  MIN_GROUNDING_RATIO   Export gate (default ${DEFAULT_MIN_GROUNDING_RATIO})
  REQUIRE_VALIDATION    Export gate (default 1)
  CAP, STYLES, JUDGE_SAMPLE_PCT, LIMIT, DEEPSEEK_*, FORCE, ...
                        Forwarded to the stage that reads them
`;

/**
 * @param {string[]} argv
 * @return {{ dryRun: boolean, help: boolean }}
 */
export function parseArgs(argv) {
    const flags = { dryRun: false, help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-h' || a === '--help') { flags.help = true; continue; }
        if (a === '--dry-run') { flags.dryRun = true; continue; }
        throw new Error(`unknown flag: ${a}`);
    }
    return flags;
}

/**
 * Stage list in canonical order. Unknown names and an empty list throw.
 *
 * @param {string} [raw]
 * @return {string[]}
 */
export function parseStages(raw) {
    if (raw === undefined || String(raw).trim() === '') return [...DEFAULT_STAGES];
    const wanted = new Set(String(raw).split(',').map((s) => s.trim()).filter(Boolean));
    if (!wanted.size) throw new Error('STAGES is empty');
    for (const name of wanted) {
        if (!STAGE_SET.has(name)) throw new Error(`unknown stage: ${name} (${DEFAULT_STAGES.join(',')})`);
    }
    return DEFAULT_STAGES.filter((name) => wanted.has(name));
}

function parseStyles(raw) {
    if (raw === undefined || raw === '') return [...DEFAULT_STYLES];
    const parts = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
    return parts.length ? parts : [...DEFAULT_STYLES];
}

function parseRegenRounds(raw) {
    if (raw === undefined || raw === '') return DEFAULT_REGEN_ROUNDS;
    if (!/^\d+$/.test(String(raw))) throw new Error(`REGEN_ROUNDS must be a non-negative integer (got ${raw})`);
    return Number(raw);
}

/**
 * Resolve paths and the pipeline-only defaults. An explicitly empty env
 * value disables the corresponding default (`REQUIRE_RESOLVED=` keeps every
 * candidate; `STICKY=0` ranks by score only).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ dryRun?: boolean }} [flags]
 * @return {object}
 */
export function resolveConfig(env = process.env, flags = {}) {
    const dataDir = env.DATA_DIR || '';
    const trainDir = env.TRAIN_DIR || (dataDir ? path.join(dataDir, 'train') : '');
    const datasetOut = env.DATASET_OUT || (trainDir ? path.join(trainDir, 'dataset') : '');
    return {
        dryRun: !!flags.dryRun,
        stages: parseStages(env.STAGES),
        dataDir,
        trainDir,
        datasetOut,
        styles: parseStyles(env.STYLES),
        regenRounds: parseRegenRounds(env.REGEN_ROUNDS),
        requireResolved: env.REQUIRE_RESOLVED === undefined ? DEFAULT_REQUIRE_RESOLVED : String(env.REQUIRE_RESOLVED),
        sticky: env.STICKY === undefined ? '1' : String(env.STICKY),
        minGroundingRatio: env.MIN_GROUNDING_RATIO === undefined ? DEFAULT_MIN_GROUNDING_RATIO : String(env.MIN_GROUNDING_RATIO),
        requireValidation: env.REQUIRE_VALIDATION === undefined ? '1' : String(env.REQUIRE_VALIDATION),
    };
}

/**
 * A fresh check is redone when grounding failed or the judge said `wrong`.
 * `warn` and `flawed` stay; a stale check (content hash mismatch) is ignored
 * because the validate stage recomputes it before this is consulted.
 *
 * @param {object | null | undefined} check
 * @param {string} content
 * @return {boolean}
 */
export function isRegenTarget(check, content) {
    if (!check || typeof check !== 'object') return false;
    if (check.contentSha256 && check.contentSha256 !== sha256Hex(content)) return false;
    if (check.deterministic?.verdict === 'fail') return true;
    const judge = check.judge;
    return !!(judge && typeof judge === 'object' && judge.verdict === 'wrong');
}

/**
 * Prompt paths whose response should be deleted and generated again.
 * One path per tx, even when several styles failed.
 *
 * @param {string} root
 * @param {string[]} styles
 * @return {string[]}
 */
export function selectRegenTargets(root, styles) {
    const out = [];
    const seen = new Set();
    for (const pair of collectPairs(root, styles)) {
        if (seen.has(pair.absPath)) continue;
        const check = readValidation(pair.absPath)?.checks?.[pair.style];
        if (!isRegenTarget(check, pair.response.content)) continue;
        seen.add(pair.absPath);
        out.push(pair.absPath);
    }
    return out;
}

function dirExists(p) {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * @param {string} name
 * @param {() => Promise<void> | void} fn
 * @param {{ log: Function, error: Function }} io
 * @return {Promise<number>}
 */
async function runStage(name, fn, io) {
    io.log(`build-dataset: === ${name} ===`);
    process.exitCode = undefined;
    await fn();
    const code = process.exitCode || 0;
    process.exitCode = undefined;
    if (code) io.error(`build-dataset: stage ${name} failed (exit ${code})`);
    return code;
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} argv
 * @param {{ log: (m: string) => void, error: (m: string) => void }} io
 * @param {{ fetch?: typeof fetch, sleep?: (ms: number) => Promise<void>, rng?: () => number, now?: () => number }} [deps]
 * @return {Promise<void>}
 */
export async function main(env = process.env, argv = process.argv.slice(2), io = console, deps = {}) {
    let flags;
    try { flags = parseArgs(argv); } catch (e) {
        io.error(e.message); io.error(HELP); process.exitCode = 1; return;
    }
    if (flags.help) { io.log(HELP); return; }

    let cfg;
    try { cfg = resolveConfig(env, flags); } catch (e) {
        io.error(e.message); process.exitCode = 1; return;
    }
    if (!cfg.dataDir) { io.error('DATA_DIR is not set'); process.exitCode = 1; return; }
    if (!dirExists(cfg.dataDir)) {
        io.error(`DATA_DIR is not a directory: ${cfg.dataDir}`); process.exitCode = 1; return;
    }

    const judgePct = env.JUDGE_SAMPLE_PCT === undefined || env.JUDGE_SAMPLE_PCT === ''
        ? 5 : Number(env.JUDGE_SAMPLE_PCT);
    const wantsGen = cfg.stages.includes('gen');
    const wantsJudge = cfg.stages.includes('validate') && judgePct > 0;
    if (!cfg.dryRun && (wantsGen || wantsJudge) && !env.DEEPSEEK_API_KEY) {
        io.error('DEEPSEEK_API_KEY is not set');
        process.exitCode = 1; return;
    }
    if (!cfg.stages.includes('dedup') && !dirExists(cfg.trainDir)) {
        io.error(`TRAIN_DIR is not a directory: ${cfg.trainDir} (dedup creates it)`);
        process.exitCode = 1; return;
    }

    io.log(`build-dataset: stages=${cfg.stages.join(',')} train=${cfg.trainDir} out=${cfg.datasetOut}${cfg.dryRun ? ' dry-run' : ''}`);
    const stageArgv = cfg.dryRun ? ['--dry-run'] : [];
    const dedupEnv = {
        ...env,
        DATA_DIR: cfg.dataDir,
        OUT: cfg.trainDir,
        REQUIRE_RESOLVED: cfg.requireResolved,
        STICKY: cfg.sticky,
    };
    const trainEnv = { ...env, DATA_DIR: cfg.trainDir };
    const exportEnv = {
        ...trainEnv,
        OUT: cfg.datasetOut,
        MIN_GROUNDING_RATIO: cfg.minGroundingRatio,
        REQUIRE_VALIDATION: cfg.requireValidation,
    };

    let failed = false;
    const fatal = async (name, fn) => {
        const code = await runStage(name, fn, io);
        if (code) { failed = true; return false; }
        return true;
    };
    const soft = async (name, fn) => {
        const code = await runStage(name, fn, io);
        if (code) failed = true;
    };

    if (cfg.stages.includes('dedup')) {
        if (!await fatal('dedup', () => dedupMain(dedupEnv, stageArgv, io))) {
            process.exitCode = 1; return;
        }
    }
    // A dry-run dedup does not create TRAIN_DIR. Later stages would then fail
    // their own directory check; report that and stop instead.
    const later = cfg.stages.filter((s) => s !== 'dedup');
    if (later.length && !dirExists(cfg.trainDir)) {
        if (cfg.dryRun) {
            io.log(`build-dataset: ${cfg.trainDir} does not exist yet; skipping ${later.join(',')}`);
            io.log('build-dataset: done regenerated=0 dry-run');
            return;
        }
        io.error(`TRAIN_DIR is not a directory: ${cfg.trainDir}`);
        process.exitCode = 1; return;
    }
    if (cfg.stages.includes('gen')) await soft('gen', () => genMain(trainEnv, stageArgv, io, deps));
    if (cfg.stages.includes('validate')) await soft('validate', () => validateMain(trainEnv, stageArgv, io, deps));

    let regenerated = 0;
    if (cfg.stages.includes('gen') && cfg.stages.includes('validate') && cfg.regenRounds > 0) {
        for (let round = 1; round <= cfg.regenRounds; round++) {
            const targets = selectRegenTargets(cfg.trainDir, cfg.styles);
            if (!targets.length) {
                io.log(`build-dataset: regen round ${round}: nothing to redo`);
                break;
            }
            io.log(`build-dataset: regen round ${round}: ${targets.length} tx${targets.length === 1 ? '' : 's'}`);
            if (cfg.dryRun) break;
            for (const abs of targets) unlinkResponseFiles(tracePathForPrompt(abs));
            regenerated += targets.length;
            await soft('gen', () => genMain(trainEnv, stageArgv, io, deps));
            await soft('validate', () => validateMain(trainEnv, stageArgv, io, deps));
        }
    }

    if (cfg.stages.includes('export')) {
        if (!await fatal('export', () => exportMain(exportEnv, stageArgv, io))) {
            process.exitCode = 1; return;
        }
    }

    io.log(`build-dataset: done regenerated=${regenerated}${cfg.dryRun ? ' dry-run' : ''}`);
    if (failed) process.exitCode = 1;
}

const isMain = process.argv[1]
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
    main().catch((e) => {
        console.error(e && e.stack ? e.stack : String(e));
        process.exit(1);
    });
}
