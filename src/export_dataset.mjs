#!/usr/bin/env node
// Build a SFT dataset from paired `_prompt.json` / `_response.json` files.
// One JSONL row per (prompt file × style) with an OpenAI-style `messages`
// array, ready for TRL SFTTrainer, Unsloth, Axolotl, etc.
//
// The train/val split is deterministic and codehash-cohesive: every tx
// under the same codehash lands in the same split so the validation set
// never leaks contract-specific idioms from training.
//
//   DATA_DIR=./dedup OUT=./train_data/sft node src/export_dataset.mjs
//   DATA_DIR=./dedup node src/export_dataset.mjs --dry-run

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { walkBuckets } from './bucket_paths.mjs';
import { PROMPT_FILE_RE, readValidation } from './query.mjs';
import {
    DEFAULT_STYLES,
    promptSha256,
    readExistingResponse,
    responsePathForPrompt,
} from './gen_responses.mjs';

export const DEFAULT_VAL_RATIO = 0.05;
export const DEFAULT_SEED = '1';
export const MANIFEST_NAME = 'manifest.json';
export const TRAIN_NAME = 'train.jsonl';
export const VAL_NAME = 'val.jsonl';

const BUCKET_KEY_RE = /^([0-9a-f]{64})_([0-9a-f]{8}|fallback)$/;
const TX_STEM_RE = /^(0x[0-9a-f]{64})_prompt\.json$/;

export const SKIP_REASONS = Object.freeze({
    NO_RESPONSE_FILE: 'no-response-file',
    NO_STYLE_ENTRY: 'no-style-entry',
    STALE_HASH: 'stale-hash',
    BAD_FINISH: 'bad-finish',
    EMPTY_CONTENT: 'empty-content',
    BAD_PROMPT: 'bad-prompt',
    UNREADABLE: 'unreadable',
    NO_VALIDATION: 'no-validation',
    STALE_VALIDATION: 'stale-validation',
    LOW_GROUNDING: 'low-grounding',
    LOW_JUDGE: 'low-judge',
    JUDGE_NOT_GOOD: 'judge-not-good',
    TOO_LONG: 'too-long',
});

export const HELP = `Usage: DATA_DIR=<dir> OUT=<dir> node src/export_dataset.mjs [options]

Pair every _prompt.json under DATA_DIR with the matching sibling
_response.json and emit an SFT dataset (${TRAIN_NAME} + ${VAL_NAME}).
Rows whose promptSha256 does not match the current prompt, whose
finish_reason is not "stop", or whose content is empty are skipped.

Optional quality gates read the sibling _validation.json written by
validate_responses. All gates are off by default; a stale validation
(contentSha256 mismatch) is treated as missing.

Options:
  --out <dir>     Output root (overrides OUT)
  --dry-run       Count rows and skips; do not write files
  -h, --help      Show this help

Env:
  DATA_DIR              Prompt tree root (required)
  OUT                   Output directory (required unless --dry-run)
  STYLES                Comma list of styles to export (default ${DEFAULT_STYLES.join(',')})
  VAL_RATIO             Fraction of codehashes for val.jsonl (default ${DEFAULT_VAL_RATIO})
  SEED                  Split salt (default ${DEFAULT_SEED})
  TEACHER_SYSTEM_SUFFIX Same suffix used at generation time (default empty)
  REQUIRE_VALIDATION    1 = skip rows without a fresh validation check (no-validation)
  MIN_GROUNDING_RATIO   Skip rows whose number-grounding ratio is below this
                        (0..1; default 0 = off) -> low-grounding
  MIN_JUDGE_SCORE       Skip rows whose judge score is below this (1..5;
                        default 0 = off; rows without a judge pass) -> low-judge
  REQUIRE_JUDGE_PASS    1 = keep only rows whose judge verdict is "good"
                        (rows without a judge are skipped) -> judge-not-good
  MAX_USER_CHARS        Skip rows whose userPrompt is longer than this many
                        characters (default 0 = off) -> too-long. Rows are
                        dropped, never truncated: the prompt must stay
                        identical to what the explainer builds at inference.
  PROGRESS_EVERY        Log every N processed prompts (default 500; 0=off)
`;

/**
 * @param {string[]} argv
 * @return {{ dryRun: boolean, help: boolean, out?: string }}
 */
export function parseArgs(argv) {
    const flags = { dryRun: false, help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-h' || a === '--help') { flags.help = true; continue; }
        if (a === '--dry-run') { flags.dryRun = true; continue; }
        if (a === '--out') {
            const val = argv[++i];
            if (val === undefined || val.startsWith('-')) {
                throw new Error('--out requires a value');
            }
            flags.out = val;
            continue;
        }
        throw new Error(`unknown flag: ${a}`);
    }
    return flags;
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @return {{ styles: string[], valRatio: number, seed: string, teacherSystemSuffix: string, progressEvery: number, requireValidation: boolean, minGroundingRatio: number, minJudgeScore: number, requireJudgePass: boolean, maxUserChars: number }}
 */
export function resolveConfig(env = process.env) {
    return {
        styles: parseStyles(env.STYLES),
        valRatio: parseValRatio(env.VAL_RATIO),
        seed: env.SEED === undefined || env.SEED === '' ? DEFAULT_SEED : String(env.SEED),
        teacherSystemSuffix: env.TEACHER_SYSTEM_SUFFIX || '',
        progressEvery: env.PROGRESS_EVERY === undefined || env.PROGRESS_EVERY === ''
            ? 500
            : parseNonNegInt(env.PROGRESS_EVERY, 500, 'PROGRESS_EVERY'),
        requireValidation: env.REQUIRE_VALIDATION === '1',
        minGroundingRatio: parseUnitRange(env.MIN_GROUNDING_RATIO, 0, 1, 'MIN_GROUNDING_RATIO'),
        minJudgeScore: parseUnitRange(env.MIN_JUDGE_SCORE, 0, 5, 'MIN_JUDGE_SCORE'),
        requireJudgePass: env.REQUIRE_JUDGE_PASS === '1',
        maxUserChars: parseNonNegInt(env.MAX_USER_CHARS, 0, 'MAX_USER_CHARS'),
    };
}

function parseUnitRange(raw, lo, hi, name) {
    if (raw === undefined || raw === '') return 0;
    const v = Number(raw);
    if (!Number.isFinite(v) || v < lo || v > hi) {
        throw new Error(`${name} must be a number in [${lo}, ${hi}] (got ${raw})`);
    }
    return v;
}

/**
 * Apply the validation gates to one (prompt × style) pair. Returns a
 * `SKIP_REASONS` value or `null` when the row passes.
 *
 * A check whose `contentSha256` does not match the response content is
 * stale and treated as missing. Judge gates only bite when a judge result
 * exists, except `requireJudgePass`, which also rejects unjudged rows.
 *
 * @param {object | null} check  `validation.checks[style]` or null
 * @param {string} contentSha  SHA-256 of the response content
 * @param {{ requireValidation: boolean, minGroundingRatio: number, minJudgeScore: number, requireJudgePass: boolean }} cfg
 * @return {string | null}
 */
export function validationGate(check, contentSha, cfg) {
    const anyGate = cfg.requireValidation || cfg.minGroundingRatio > 0 || cfg.minJudgeScore > 0 || cfg.requireJudgePass;
    if (!anyGate) return null;
    if (!check || typeof check !== 'object') {
        if (cfg.requireValidation || cfg.requireJudgePass) return SKIP_REASONS.NO_VALIDATION;
        return null;
    }
    if (check.contentSha256 && check.contentSha256 !== contentSha) {
        if (cfg.requireValidation || cfg.requireJudgePass) return SKIP_REASONS.STALE_VALIDATION;
        return null;
    }
    const ratio = check.deterministic?.numbers?.ratio;
    if (cfg.minGroundingRatio > 0 && typeof ratio === 'number' && ratio < cfg.minGroundingRatio) {
        return SKIP_REASONS.LOW_GROUNDING;
    }
    const judge = check.judge && typeof check.judge === 'object' ? check.judge : null;
    if (cfg.requireJudgePass && (!judge || judge.verdict !== 'good')) {
        return SKIP_REASONS.JUDGE_NOT_GOOD;
    }
    if (cfg.minJudgeScore > 0 && judge && typeof judge.score === 'number' && judge.score < cfg.minJudgeScore) {
        return SKIP_REASONS.LOW_JUDGE;
    }
    return null;
}

/**
 * @param {string} text
 * @return {string}
 */
function sha256Hex(text) {
    return crypto.createHash('sha256').update(text ?? '').digest('hex');
}

function parseStyles(raw) {
    if (raw === undefined || raw === '') return [...DEFAULT_STYLES];
    const parts = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
    return parts.length ? parts : [...DEFAULT_STYLES];
}

function parseValRatio(raw) {
    if (raw === undefined || raw === '') return DEFAULT_VAL_RATIO;
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0 || v >= 1) {
        throw new Error(`VAL_RATIO must be a finite number in [0, 1) (got ${raw})`);
    }
    return v;
}

function parseNonNegInt(raw, fallback, name) {
    if (raw === undefined || raw === '') return fallback;
    if (!/^\d+$/.test(String(raw))) {
        throw new Error(`${name} must be a non-negative integer (got ${raw})`);
    }
    return Number(raw);
}

/**
 * Deterministic bucket assignment: hash the codehash with a seed and map to
 * `[0, 1)`. All txs sharing a codehash land in the same split.
 *
 * @param {string} codehash
 * @param {string} seed
 * @return {number}
 */
export function splitFraction(codehash, seed) {
    const h = crypto.createHash('sha256');
    h.update(String(seed));
    h.update('\x00');
    h.update(String(codehash).toLowerCase());
    const buf = h.digest();
    // Use the first 6 bytes (48 bits) — well below Number precision.
    const hi = buf.readUInt32BE(0);
    const lo = buf.readUInt16BE(4);
    const n = hi * 0x1_0000 + lo;
    return n / 0x1_0000_0000_0000;
}

/**
 * `true` when the codehash falls into the val split under the given ratio.
 *
 * @param {string} codehash
 * @param {number} valRatio
 * @param {string} seed
 * @return {boolean}
 */
export function isValCodehash(codehash, valRatio, seed) {
    if (valRatio <= 0) return false;
    return splitFraction(codehash, seed) < valRatio;
}

/**
 * Build one JSONL row from a paired prompt + response entry.
 *
 * @param {{ txHash: string, codehash: string, methodId: string, style: string, systemPrompt: string, userPrompt: string, relPath: string }} job
 * @param {{ model?: string, content: string, usage?: object }} entry
 * @param {string} systemPromptForModel  The system prompt actually sent to the teacher (with suffix).
 * @param {object | null} [check]  Fresh `validation.checks[style]`, if any
 * @return {object}
 */
export function buildDatasetRow(job, entry, systemPromptForModel, check = null) {
    const usage = entry.usage || {};
    const row = {
        messages: [
            { role: 'system', content: systemPromptForModel },
            { role: 'user', content: job.userPrompt },
            { role: 'assistant', content: entry.content },
        ],
        meta: {
            tx: job.txHash,
            codehash: job.codehash,
            method_id: job.methodId,
            style: job.style,
            model: entry.model || null,
            prompt_tokens: numOr0(usage.prompt_tokens),
            completion_tokens: numOr0(usage.completion_tokens),
            rel_path: job.relPath,
        },
    };
    if (check && typeof check === 'object') {
        const det = check.deterministic || {};
        const judge = check.judge && typeof check.judge === 'object' ? check.judge : null;
        row.meta.validation = {
            grounding_ratio: typeof det.numbers?.ratio === 'number' ? det.numbers.ratio : null,
            grounding_verdict: det.verdict || null,
            judge_score: judge && typeof judge.score === 'number' ? judge.score : null,
            judge_verdict: judge ? judge.verdict || null : null,
        };
    }
    return row;
}

function numOr0(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Iterate over all `_prompt.json` files, decide split, filter by response
 * quality, and invoke callbacks for rows and skips. Returns aggregate stats.
 *
 * @param {string} root
 * @param {{ styles: string[], valRatio: number, seed: string, teacherSystemSuffix: string, progressEvery?: number }} cfg
 * @param {(row: object, split: 'train' | 'val') => void} onRow
 * @param {(reason: string, relPath: string, style: string) => void} [onSkip]
 * @param {(msg: string) => void} [onProgress]
 * @return {{ scanned: number, kept: { train: number, val: number }, skipped: Record<string, number>, promptLengths: number[], answerLengths: number[], tokens: { prompt: number, completion: number }, models: Record<string, number>, codehashes: { train: Set<string>, val: Set<string> }, validation: { validated: number, judged: number, ratios: number[], judgeScores: Record<string, number> } }}
 */
export function processAll(root, cfg, onRow, onSkip, onProgress) {
    const wanted = new Set(cfg.styles);
    const gateCfg = {
        requireValidation: !!cfg.requireValidation,
        minGroundingRatio: cfg.minGroundingRatio || 0,
        minJudgeScore: cfg.minJudgeScore || 0,
        requireJudgePass: !!cfg.requireJudgePass,
    };
    const stats = {
        scanned: 0,
        kept: { train: 0, val: 0 },
        skipped: Object.fromEntries(Object.values(SKIP_REASONS).map((k) => [k, 0])),
        promptLengths: [],
        answerLengths: [],
        tokens: { prompt: 0, completion: 0 },
        models: {},
        codehashes: { train: new Set(), val: new Set() },
        validation: { validated: 0, judged: 0, ratios: [], judgeScores: {} },
    };
    const progressEvery = cfg.progressEvery || 0;
    const maxUserChars = cfg.maxUserChars || 0;
    const recordSkip = (reason, relPath, style) => {
        stats.skipped[reason] = (stats.skipped[reason] || 0) + 1;
        onSkip?.(reason, relPath, style);
    };

    walkBuckets(root, (dir, key) => {
        const m = key.match(BUCKET_KEY_RE);
        if (!m) return;
        const codehash = m[1];
        const methodId = m[2];
        const split = isValCodehash(codehash, cfg.valRatio, cfg.seed) ? 'val' : 'train';
        let names;
        try { names = fs.readdirSync(dir); } catch { return; }
        for (const name of names) {
            const tx = name.match(TX_STEM_RE);
            if (!tx) continue;
            const absPath = path.join(dir, name);
            const relPath = path.relative(root, absPath);
            stats.scanned++;
            if (progressEvery > 0 && stats.scanned % progressEvery === 0) {
                onProgress?.(`export: scanned ${stats.scanned} ...`);
            }
            let prompts;
            try { prompts = JSON.parse(fs.readFileSync(absPath, 'utf8')); } catch {
                for (const style of cfg.styles) recordSkip(SKIP_REASONS.UNREADABLE, relPath, style);
                continue;
            }
            if (!Array.isArray(prompts)) {
                for (const style of cfg.styles) recordSkip(SKIP_REASONS.BAD_PROMPT, relPath, style);
                continue;
            }
            const byStyle = new Map();
            for (const p of prompts) {
                if (p && wanted.has(p.style) && typeof p.systemPrompt === 'string' && typeof p.userPrompt === 'string') {
                    byStyle.set(p.style, p);
                }
            }
            const responseFile = readExistingResponse(absPath);
            const validationFile = responseFile ? readValidation(absPath) : null;
            for (const style of cfg.styles) {
                const promptEntry = byStyle.get(style);
                if (!promptEntry) { recordSkip(SKIP_REASONS.BAD_PROMPT, relPath, style); continue; }
                // Length gate first: it does not depend on the response and
                // keeps the "no-response-file" count meaningful for gen.
                if (maxUserChars > 0 && promptEntry.userPrompt.length > maxUserChars) {
                    recordSkip(SKIP_REASONS.TOO_LONG, relPath, style); continue;
                }
                if (!responseFile) { recordSkip(SKIP_REASONS.NO_RESPONSE_FILE, relPath, style); continue; }
                const entry = responseFile.responses?.[style];
                if (!entry || typeof entry !== 'object') { recordSkip(SKIP_REASONS.NO_STYLE_ENTRY, relPath, style); continue; }
                const system = cfg.teacherSystemSuffix
                    ? `${promptEntry.systemPrompt}\n\n${cfg.teacherSystemSuffix}`
                    : promptEntry.systemPrompt;
                const sha = promptSha256(system, promptEntry.userPrompt);
                if (entry.promptSha256 !== sha) { recordSkip(SKIP_REASONS.STALE_HASH, relPath, style); continue; }
                if (entry.finishReason !== 'stop') { recordSkip(SKIP_REASONS.BAD_FINISH, relPath, style); continue; }
                if (typeof entry.content !== 'string' || !entry.content.trim()) {
                    recordSkip(SKIP_REASONS.EMPTY_CONTENT, relPath, style); continue;
                }
                const contentSha = sha256Hex(entry.content);
                const rawCheck = validationFile?.checks?.[style];
                const check = rawCheck && typeof rawCheck === 'object' ? rawCheck : null;
                const gateReason = validationGate(check, contentSha, gateCfg);
                if (gateReason) { recordSkip(gateReason, relPath, style); continue; }
                const freshCheck = check && (!check.contentSha256 || check.contentSha256 === contentSha) ? check : null;
                const row = buildDatasetRow({
                    txHash: tx[1],
                    codehash,
                    methodId,
                    style,
                    systemPrompt: promptEntry.systemPrompt,
                    userPrompt: promptEntry.userPrompt,
                    relPath,
                }, entry, system, freshCheck);
                onRow(row, split);
                stats.kept[split]++;
                if (freshCheck) {
                    stats.validation.validated++;
                    const ratio = freshCheck.deterministic?.numbers?.ratio;
                    if (typeof ratio === 'number') stats.validation.ratios.push(ratio);
                    const judge = freshCheck.judge;
                    if (judge && typeof judge === 'object') {
                        stats.validation.judged++;
                        const bucket = typeof judge.score === 'number' ? String(judge.score) : 'unparseable';
                        stats.validation.judgeScores[bucket] = (stats.validation.judgeScores[bucket] || 0) + 1;
                    }
                }
                stats.codehashes[split].add(codehash);
                stats.promptLengths.push(promptEntry.userPrompt.length);
                stats.answerLengths.push(entry.content.length);
                stats.tokens.prompt += numOr0(entry.usage?.prompt_tokens);
                stats.tokens.completion += numOr0(entry.usage?.completion_tokens);
                const modelName = entry.model || responseFile.model || 'unknown';
                stats.models[modelName] = (stats.models[modelName] || 0) + 1;
            }
        }
    });
    return stats;
}

/**
 * Percentile helper for a numeric array. `p` is `[0,1]`. Empty → 0.
 *
 * @param {number[]} arr
 * @param {number} p
 * @return {number}
 */
export function percentile(arr, p) {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1))));
    return sorted[idx];
}

/**
 * @param {ReturnType<typeof processAll>} stats
 * @param {{ styles: string[], valRatio: number, seed: string, requireValidation?: boolean, minGroundingRatio?: number, minJudgeScore?: number, requireJudgePass?: boolean }} cfg
 * @return {object}
 */
export function buildManifest(stats, cfg) {
    const v = stats.validation || { validated: 0, judged: 0, ratios: [], judgeScores: {} };
    return {
        version: 2,
        createdAt: new Date().toISOString(),
        styles: cfg.styles,
        seed: cfg.seed,
        valRatio: cfg.valRatio,
        scanned: stats.scanned,
        kept: stats.kept,
        codehashes: { train: stats.codehashes.train.size, val: stats.codehashes.val.size },
        skipped: stats.skipped,
        tokens: stats.tokens,
        models: stats.models,
        maxUserChars: cfg.maxUserChars || 0,
        validation: {
            gates: {
                requireValidation: !!cfg.requireValidation,
                minGroundingRatio: cfg.minGroundingRatio || 0,
                minJudgeScore: cfg.minJudgeScore || 0,
                requireJudgePass: !!cfg.requireJudgePass,
            },
            rowsValidated: v.validated,
            rowsJudged: v.judged,
            groundingRatio: {
                mean: v.ratios.length ? Number((v.ratios.reduce((a, b) => a + b, 0) / v.ratios.length).toFixed(4)) : null,
                p10: v.ratios.length ? percentile(v.ratios, 0.1) : null,
                p50: v.ratios.length ? percentile(v.ratios, 0.5) : null,
            },
            judgeScores: v.judgeScores,
        },
        lengths: {
            user_chars: {
                min: stats.promptLengths.length ? Math.min(...stats.promptLengths) : 0,
                p50: percentile(stats.promptLengths, 0.5),
                p90: percentile(stats.promptLengths, 0.9),
                p99: percentile(stats.promptLengths, 0.99),
                max: stats.promptLengths.length ? Math.max(...stats.promptLengths) : 0,
            },
            assistant_chars: {
                min: stats.answerLengths.length ? Math.min(...stats.answerLengths) : 0,
                p50: percentile(stats.answerLengths, 0.5),
                p90: percentile(stats.answerLengths, 0.9),
                p99: percentile(stats.answerLengths, 0.99),
                max: stats.answerLengths.length ? Math.max(...stats.answerLengths) : 0,
            },
        },
    };
}

/**
 * @param {ReturnType<typeof buildManifest>} manifest
 * @return {string}
 */
export function formatSummary(manifest) {
    const lines = [
        'export-dataset: summary',
        `  scanned:        ${manifest.scanned}`,
        `  train rows:     ${manifest.kept.train}`,
        `  val rows:       ${manifest.kept.val}`,
        `  codehashes:     train=${manifest.codehashes.train} val=${manifest.codehashes.val}`,
        `  tokens:         prompt=${manifest.tokens.prompt} completion=${manifest.tokens.completion}`,
    ];
    const skipEntries = Object.entries(manifest.skipped).filter(([, v]) => v > 0);
    if (skipEntries.length) {
        lines.push('  skipped:');
        for (const [reason, n] of skipEntries.sort()) lines.push(`    ${reason}: ${n}`);
    }
    lines.push(`  user chars:     p50=${manifest.lengths.user_chars.p50} p90=${manifest.lengths.user_chars.p90} max=${manifest.lengths.user_chars.max}`);
    lines.push(`  answer chars:   p50=${manifest.lengths.assistant_chars.p50} p90=${manifest.lengths.assistant_chars.p90} max=${manifest.lengths.assistant_chars.max}`);
    const modelEntries = Object.entries(manifest.models).sort();
    if (modelEntries.length) {
        lines.push('  models:');
        for (const [m, n] of modelEntries) lines.push(`    ${m}: ${n}`);
    }
    const v = manifest.validation;
    if (v) {
        const g = v.gates || {};
        const active = [
            g.requireValidation ? 'REQUIRE_VALIDATION' : null,
            g.minGroundingRatio ? `MIN_GROUNDING_RATIO=${g.minGroundingRatio}` : null,
            g.minJudgeScore ? `MIN_JUDGE_SCORE=${g.minJudgeScore}` : null,
            g.requireJudgePass ? 'REQUIRE_JUDGE_PASS' : null,
        ].filter(Boolean);
        lines.push(`  validation:     rows=${v.rowsValidated} judged=${v.rowsJudged} gates=${active.length ? active.join(',') : 'none'}`);
        if (v.groundingRatio && v.groundingRatio.mean !== null) {
            lines.push(`  grounding:      mean=${v.groundingRatio.mean} p10=${v.groundingRatio.p10} p50=${v.groundingRatio.p50}`);
        }
        const scores = Object.entries(v.judgeScores || {}).sort();
        if (scores.length) {
            lines.push(`  judge scores:   ${scores.map(([k, n]) => `${k}=${n}`).join(' ')}`);
        }
    }
    return lines.join('\n');
}

/**
 * Atomic file writer: `dest.tmp` then `rename`.
 *
 * @param {string} dest
 * @param {string} contents
 */
export function writeAtomic(dest, contents) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.tmp';
    fs.writeFileSync(tmp, contents);
    fs.renameSync(tmp, dest);
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} argv
 * @param {{ log: (m: string) => void, error: (m: string) => void }} io
 */
export function main(env = process.env, argv = process.argv.slice(2), io = console) {
    let flags;
    try { flags = parseArgs(argv); } catch (e) {
        io.error(e.message); io.error(HELP); process.exitCode = 1; return;
    }
    if (flags.help) { io.log(HELP); return; }

    const dataDir = env.DATA_DIR;
    if (!dataDir) { io.error('DATA_DIR is not set'); process.exitCode = 1; return; }
    let st;
    try { st = fs.statSync(dataDir); } catch {
        io.error(`DATA_DIR is not a directory: ${dataDir}`); process.exitCode = 1; return;
    }
    if (!st.isDirectory()) {
        io.error(`DATA_DIR is not a directory: ${dataDir}`); process.exitCode = 1; return;
    }

    const outDir = flags.out || env.OUT;
    if (!flags.dryRun && !outDir) {
        io.error('OUT is not set (pass --out or OUT=)'); process.exitCode = 1; return;
    }

    let cfg;
    try { cfg = resolveConfig(env); } catch (e) {
        io.error(e.message); process.exitCode = 1; return;
    }

    const gates = [
        cfg.requireValidation ? 'REQUIRE_VALIDATION' : null,
        cfg.minGroundingRatio ? `MIN_GROUNDING_RATIO=${cfg.minGroundingRatio}` : null,
        cfg.minJudgeScore ? `MIN_JUDGE_SCORE=${cfg.minJudgeScore}` : null,
        cfg.requireJudgePass ? 'REQUIRE_JUDGE_PASS' : null,
        cfg.maxUserChars ? `MAX_USER_CHARS=${cfg.maxUserChars}` : null,
    ].filter(Boolean);
    io.log(`export-dataset: scanning ${dataDir} styles=${cfg.styles.join(',')} valRatio=${cfg.valRatio} seed=${cfg.seed} gates=${gates.length ? gates.join(',') : 'none'}${flags.dryRun ? ' dry-run' : ''}`);

    // Collect rows into memory; even 26k JSON rows are trivial. Bail early
    // if that ever changes (streaming would need a different manifest strategy).
    const trainLines = [];
    const valLines = [];
    const stats = processAll(dataDir, cfg,
        (row, split) => {
            const line = JSON.stringify(row);
            (split === 'val' ? valLines : trainLines).push(line);
        },
        (reason, relPath, style) => {
            // Verbose warn stream would be noisy for 2.5k files; suppress unless PROGRESS.
        },
        (msg) => io.log(msg),
    );

    const manifest = buildManifest(stats, cfg);
    io.log(formatSummary(manifest));

    if (!flags.dryRun) {
        const trainPath = path.join(outDir, TRAIN_NAME);
        const valPath = path.join(outDir, VAL_NAME);
        writeAtomic(trainPath, trainLines.length ? trainLines.join('\n') + '\n' : '');
        writeAtomic(valPath, valLines.length ? valLines.join('\n') + '\n' : '');
        writeAtomic(path.join(outDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n');
        io.log(`export-dataset: wrote ${trainPath} (${trainLines.length}) + ${valPath} (${valLines.length})`);
    }
}

// Re-export for tests / downstream tooling that inspects the tree without
// running the CLI.
export { PROMPT_FILE_RE, responsePathForPrompt };

const isMain = process.argv[1]
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) main();
