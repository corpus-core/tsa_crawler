#!/usr/bin/env node
// Generate teacher responses for `_prompt.json` files using the DeepSeek API.
// The teacher sees exactly the same system + user prompt as the student SLM
// will see at inference time. Output is a sibling `<txhash>_response.json`
// containing one entry per requested style (default: `simple`). Existing
// entries are preserved unless `FORCE=1` is set. Responses whose
// `finish_reason` is not `stop` are treated as failures and never written.
//
//   DATA_DIR=./dedup DEEPSEEK_API_KEY=sk-... node src/gen_responses.mjs
//   DATA_DIR=./dedup node src/gen_responses.mjs --dry-run

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { walkBuckets } from './bucket_paths.mjs';
import { escapeLabel, writePromSection } from './prom_file.mjs';
import { PROMPT_FILE_RE, responsePathForPrompt } from './query.mjs';

// Canonical path helper lives in query.mjs (shared with the read-only tools).
export { responsePathForPrompt };

export const DEFAULT_MODEL = 'deepseek-v4-pro';
export const DEFAULT_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_MAX_RETRIES = 5;
export const DEFAULT_TIMEOUT_MS = 600_000;
export const DEFAULT_MAX_TOKENS = 16_384;
export const DEFAULT_REASONING_EFFORT = 'high';
export const DEFAULT_THINKING = 'enabled';
export const DEFAULT_STYLES = ['simple'];
export const RESPONSE_VERSION = 1;

const BUCKET_KEY_RE = /^([0-9a-f]{64})_([0-9a-f]{8}|fallback)$/;
const TX_STEM_RE = /^(0x[0-9a-f]{64})_prompt\.json$/;
const RESPONSE_SUFFIX = '_response.json';
const NOSRC_SUFFIX = '_prompt.nosrc';
const RETRIABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export const HELP = `Usage: DATA_DIR=<dir> DEEPSEEK_API_KEY=<key> node src/gen_responses.mjs [options]

Walk DATA_DIR, send every ${PROMPT_FILE_RE.source} first-entry prompt to the
DeepSeek Chat Completions API, and write a sibling <txhash>${RESPONSE_SUFFIX}.
Existing entries for the requested styles are kept unless FORCE=1.

Options:
  --dry-run       Count prompts + estimate input tokens; no API calls
  --limit <n>     Stop after N new API calls (LIMIT env has the same effect)
  -h, --help      Show this help

Env:
  DATA_DIR              Prompt tree root (required)
  DEEPSEEK_API_KEY      DeepSeek API key (required unless --dry-run)
  DEEPSEEK_BASE_URL     Default ${DEFAULT_BASE_URL}
  MODEL                 Default ${DEFAULT_MODEL}
  STYLES                Comma list of styles to generate (default ${DEFAULT_STYLES.join(',')})
  THINKING              enabled|disabled (default ${DEFAULT_THINKING})
  REASONING_EFFORT      low|high|max (default ${DEFAULT_REASONING_EFFORT})
  MAX_TOKENS            Response cap incl. reasoning (default ${DEFAULT_MAX_TOKENS})
  CONCURRENCY           Parallel API calls (default ${DEFAULT_CONCURRENCY})
  MAX_RETRIES           Backoff attempts on 429/5xx/network (default ${DEFAULT_MAX_RETRIES})
  TIMEOUT_MS            Per-request timeout (default ${DEFAULT_TIMEOUT_MS})
  TEACHER_SYSTEM_SUFFIX Appended to the student system prompt (default empty)
  KEEP_REASONING        0 to drop reasoning_content (default keep)
  FORCE                 1 to overwrite existing response entries
  LIMIT                 Same as --limit
  PROGRESS_EVERY        Log every N processed prompts (default 25; 0=off)
`;

/**
 * @param {string[]} argv
 * @return {{ dryRun: boolean, help: boolean, limit?: number }}
 */
export function parseArgs(argv) {
    const flags = { dryRun: false, help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-h' || a === '--help') { flags.help = true; continue; }
        if (a === '--dry-run') { flags.dryRun = true; continue; }
        if (a === '--limit') {
            const val = argv[++i];
            if (val === undefined || val.startsWith('-')) {
                throw new Error('--limit requires a value');
            }
            if (!/^[1-9]\d*$/.test(val)) {
                throw new Error('--limit must be a positive integer');
            }
            flags.limit = Number(val);
            continue;
        }
        throw new Error(`unknown flag: ${a}`);
    }
    return flags;
}

/**
 * Resolve the runtime configuration from env + argv flags.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{ limit?: number }} [flags]
 * @return {{ model: string, baseUrl: string, apiKey: string | undefined, styles: string[], thinking: string, reasoningEffort: string, maxTokens: number, concurrency: number, maxRetries: number, timeoutMs: number, teacherSystemSuffix: string, keepReasoning: boolean, force: boolean, limit: number | undefined, progressEvery: number }}
 */
export function resolveConfig(env = process.env, flags = {}) {
    return {
        model: env.MODEL || DEFAULT_MODEL,
        baseUrl: (env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
        apiKey: env.DEEPSEEK_API_KEY,
        styles: parseStyles(env.STYLES),
        thinking: parseThinking(env.THINKING),
        reasoningEffort: env.REASONING_EFFORT || DEFAULT_REASONING_EFFORT,
        maxTokens: parsePositiveInt(env.MAX_TOKENS, DEFAULT_MAX_TOKENS, 'MAX_TOKENS'),
        concurrency: parsePositiveInt(env.CONCURRENCY, DEFAULT_CONCURRENCY, 'CONCURRENCY'),
        maxRetries: parseNonNegativeInt(env.MAX_RETRIES, DEFAULT_MAX_RETRIES, 'MAX_RETRIES'),
        timeoutMs: parsePositiveInt(env.TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 'TIMEOUT_MS'),
        teacherSystemSuffix: env.TEACHER_SYSTEM_SUFFIX || '',
        keepReasoning: env.KEEP_REASONING !== '0',
        force: env.FORCE === '1',
        limit: flags.limit !== undefined
            ? flags.limit
            : (env.LIMIT ? parsePositiveInt(env.LIMIT, undefined, 'LIMIT') : undefined),
        progressEvery: env.PROGRESS_EVERY === undefined || env.PROGRESS_EVERY === ''
            ? 25
            : parseNonNegativeInt(env.PROGRESS_EVERY, 25, 'PROGRESS_EVERY'),
    };
}

function parseStyles(raw) {
    if (raw === undefined || raw === '') return [...DEFAULT_STYLES];
    const parts = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return [...DEFAULT_STYLES];
    return parts;
}

function parseThinking(raw) {
    if (raw === undefined || raw === '') return DEFAULT_THINKING;
    const v = String(raw).toLowerCase();
    if (v !== 'enabled' && v !== 'disabled') {
        throw new Error(`THINKING must be enabled or disabled (got ${raw})`);
    }
    return v;
}

function parsePositiveInt(raw, fallback, name) {
    if (raw === undefined || raw === '') return fallback;
    if (!/^[1-9]\d*$/.test(String(raw))) {
        throw new Error(`${name} must be a positive integer (got ${raw})`);
    }
    return Number(raw);
}

function parseNonNegativeInt(raw, fallback, name) {
    if (raw === undefined || raw === '') return fallback;
    if (!/^\d+$/.test(String(raw))) {
        throw new Error(`${name} must be a non-negative integer (got ${raw})`);
    }
    return Number(raw);
}

/**
 * Deterministic hash used to detect prompt drift between generation runs.
 *
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @return {string} lowercase hex SHA-256
 */
export function promptSha256(systemPrompt, userPrompt) {
    const h = crypto.createHash('sha256');
    h.update('SYS\n');
    h.update(systemPrompt ?? '');
    h.update('\nUSR\n');
    h.update(userPrompt ?? '');
    return h.digest('hex');
}

/**
 * Rough token estimate for dry-run only (~4 chars per token).
 *
 * @param {string} text
 * @return {number}
 */
export function estimateTokens(text) {
    if (typeof text !== 'string' || text.length === 0) return 0;
    return Math.ceil(text.length / 4);
}

/**
 * Walk DATA_DIR and yield one job per (prompt file × requested style).
 *
 * @param {string} root
 * @param {string[]} styles
 * @return {Array<{ absPath: string, relPath: string, txHash: string, codehash: string, methodId: string, style: string, systemPrompt: string, userPrompt: string }>}
 */
export function collectPromptJobs(root, styles) {
    const wanted = new Set(styles);
    const jobs = [];
    walkBuckets(root, (dir, key) => {
        const m = key.match(BUCKET_KEY_RE);
        if (!m) return;
        const codehash = m[1];
        const methodId = m[2];
        let names;
        try { names = fs.readdirSync(dir); } catch { return; }
        for (const name of names) {
            const tx = name.match(TX_STEM_RE);
            if (!tx) continue;
            const absPath = path.join(dir, name);
            let parsed;
            try { parsed = JSON.parse(fs.readFileSync(absPath, 'utf8')); } catch { continue; }
            if (!Array.isArray(parsed)) continue;
            for (const entry of parsed) {
                if (!entry || typeof entry !== 'object') continue;
                if (!wanted.has(entry.style)) continue;
                if (typeof entry.systemPrompt !== 'string' || typeof entry.userPrompt !== 'string') continue;
                if (!entry.systemPrompt || !entry.userPrompt) continue;
                jobs.push({
                    absPath,
                    relPath: path.relative(root, absPath),
                    txHash: tx[1],
                    codehash,
                    methodId,
                    style: entry.style,
                    systemPrompt: entry.systemPrompt,
                    userPrompt: entry.userPrompt,
                });
            }
        }
    });
    // Deterministic order for reproducibility.
    jobs.sort((a, b) => {
        if (a.relPath !== b.relPath) return a.relPath < b.relPath ? -1 : 1;
        return a.style < b.style ? -1 : a.style > b.style ? 1 : 0;
    });
    return jobs;
}

/**
 * Read an existing sibling `_response.json` if present. Returns null when
 * the file is missing or unreadable.
 *
 * @param {string} promptAbsPath
 * @return {object | null}
 */
export function readExistingResponse(promptAbsPath) {
    const p = responsePathForPrompt(promptAbsPath);
    try {
        const raw = fs.readFileSync(p, 'utf8');
        const j = JSON.parse(raw);
        if (!j || typeof j !== 'object' || !j.responses || typeof j.responses !== 'object') return null;
        return j;
    } catch {
        return null;
    }
}

/**
 * True when the existing response file already has a matching entry for the
 * given style and prompt hash. `force` disables the cache.
 *
 * @param {object | null} existing
 * @param {string} style
 * @param {string} sha
 * @param {boolean} force
 * @return {boolean}
 */
export function hasFreshEntry(existing, style, sha, force) {
    if (force || !existing) return false;
    const entry = existing.responses?.[style];
    if (!entry || typeof entry !== 'object') return false;
    if (entry.finishReason !== 'stop') return false;
    if (typeof entry.content !== 'string' || entry.content.length === 0) return false;
    return entry.promptSha256 === sha;
}

/**
 * Build the DeepSeek Chat Completions request body.
 *
 * @param {{ systemPrompt: string, userPrompt: string }} job
 * @param {{ model: string, thinking: string, reasoningEffort: string, maxTokens: number, teacherSystemSuffix: string }} cfg
 * @return {object}
 */
export function buildRequestBody(job, cfg) {
    const system = cfg.teacherSystemSuffix
        ? `${job.systemPrompt}\n\n${cfg.teacherSystemSuffix}`
        : job.systemPrompt;
    const body = {
        model: cfg.model,
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: job.userPrompt },
        ],
        max_tokens: cfg.maxTokens,
        stream: false,
        thinking: { type: cfg.thinking },
    };
    if (cfg.thinking === 'enabled' && cfg.reasoningEffort) {
        body.reasoning_effort = cfg.reasoningEffort;
    }
    return body;
}

/**
 * Extract the assistant answer from a Chat Completions response.
 * Throws a descriptive Error when the payload is unusable (missing content,
 * non-stop finish reason, ...).
 *
 * @param {object} data
 * @return {{ content: string, reasoningContent: string, finishReason: string, requestId: string, usage: object }}
 */
export function extractAssistantMessage(data) {
    if (!data || typeof data !== 'object') throw new Error('empty response body');
    const choice = data.choices?.[0];
    if (!choice) throw new Error('no choices in response');
    const finishReason = choice.finish_reason;
    if (finishReason !== 'stop') {
        throw new Error(`finish_reason=${finishReason ?? 'null'}`);
    }
    const msg = choice.message;
    if (!msg || typeof msg !== 'object') throw new Error('choices[0].message missing');
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (!content.trim()) throw new Error('empty content');
    return {
        content,
        reasoningContent: typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '',
        finishReason,
        requestId: typeof data.id === 'string' ? data.id : '',
        usage: data.usage && typeof data.usage === 'object' ? data.usage : {},
    };
}

/**
 * @param {number | undefined} status
 * @return {boolean}
 */
export function isRetriableStatus(status) {
    if (status === undefined || status === null) return true; // network / abort / parse
    return RETRIABLE_STATUS.has(status);
}

/**
 * Full-jitter exponential backoff.
 *
 * @param {number} attempt  0-based retry index (0 = first retry)
 * @param {() => number} [rng]
 * @return {number} milliseconds to sleep
 */
export function backoffDelayMs(attempt, rng = Math.random) {
    const base = Math.min(30_000, 1_000 * Math.pow(2, attempt));
    return Math.floor(base * (0.5 + rng() * 0.5));
}

/**
 * One HTTP call with retries. Throws on unrecoverable errors.
 *
 * @param {object} body
 * @param {{ baseUrl: string, apiKey: string, timeoutMs: number, maxRetries: number }} cfg
 * @param {{ fetch?: typeof fetch, sleep?: (ms: number) => Promise<void>, rng?: () => number, onRetry?: (info: { attempt: number, wait: number, status?: number, message: string }) => void }} [deps]
 * @return {Promise<object>} parsed JSON
 */
export async function callDeepSeek(body, cfg, deps = {}) {
    const f = deps.fetch || globalThis.fetch;
    const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const rng = deps.rng || Math.random;
    if (typeof f !== 'function') throw new Error('fetch is not available');
    const url = `${cfg.baseUrl}/chat/completions`;
    const headers = {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
        accept: 'application/json',
    };
    const payload = JSON.stringify(body);
    let lastError;
    for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error('timeout')), cfg.timeoutMs);
        let status;
        try {
            const res = await f(url, { method: 'POST', headers, body: payload, signal: controller.signal });
            status = res.status;
            if (res.ok) {
                const data = await res.json();
                return data;
            }
            const text = await safeReadText(res);
            const err = new Error(`HTTP ${status}: ${truncate(text, 500)}`);
            err.status = status;
            throw err;
        } catch (e) {
            lastError = e;
            const retriable = isRetriableStatus(status ?? e.status);
            if (!retriable || attempt >= cfg.maxRetries) throw e;
            const wait = backoffDelayMs(attempt, rng);
            deps.onRetry?.({ attempt, wait, status: status ?? e.status, message: e.message });
            await sleep(wait);
        } finally {
            clearTimeout(timer);
        }
    }
    throw lastError || new Error('unknown fetch error');
}

async function safeReadText(res) {
    try { return await res.text(); } catch { return ''; }
}

function truncate(s, n) {
    if (typeof s !== 'string') return '';
    return s.length > n ? s.slice(0, n) + '...' : s;
}

/**
 * Merge one style entry into the sibling `_response.json` and rewrite it
 * atomically. Preserves existing entries for other styles. The per-entry
 * `model` is authoritative for the export step; the top-level `model` field
 * only reflects the most recent write.
 *
 * @param {string} promptAbsPath
 * @param {{ txHash: string, codehash: string, methodId: string, model: string }} meta
 * @param {string} style
 * @param {object} entry
 */
export function writeResponseEntry(promptAbsPath, meta, style, entry) {
    const dest = responsePathForPrompt(promptAbsPath);
    const existing = readExistingResponse(promptAbsPath) || {};
    const entryWithModel = { model: meta.model, ...entry };
    const merged = {
        version: RESPONSE_VERSION,
        txHash: meta.txHash,
        codehash: meta.codehash,
        methodId: meta.methodId,
        model: meta.model,
        responses: { ...(existing.responses || {}), [style]: entryWithModel },
    };
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n');
    fs.renameSync(tmp, dest);
}

/**
 * Simple bounded worker pool. Preserves the order in which jobs are
 * consumed but not the order of completion.
 *
 * @template T
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<void>} fn
 */
export async function runPool(items, concurrency, fn) {
    let i = 0;
    const n = Math.max(1, Math.min(concurrency, items.length || 1));
    const workers = Array.from({ length: n }, async () => {
        while (i < items.length) {
            const idx = i++;
            await fn(items[idx], idx);
        }
    });
    await Promise.all(workers);
}

/**
 * @param {{ ok: number, skipped: number, failed: number, tokensIn: number, tokensOut: number, cacheHit: number, cacheMiss: number, dryRun?: boolean, planned?: number }} stats
 * @return {string}
 */
export function formatSummary(stats) {
    const lines = [
        stats.dryRun ? 'gen-responses: dry-run summary' : 'gen-responses: summary',
        `  ok:            ${stats.ok}`,
        `  skipped:       ${stats.skipped}`,
        `  failed:        ${stats.failed}`,
    ];
    if (stats.dryRun) {
        lines.push(`  planned calls: ${stats.planned ?? 0}`);
        lines.push(`  est. input tokens: ${stats.tokensIn}`);
    } else {
        lines.push(`  prompt tokens: ${stats.tokensIn}`);
        lines.push(`  output tokens: ${stats.tokensOut}`);
        lines.push(`  cache hits:    ${stats.cacheHit}`);
        lines.push(`  cache misses:  ${stats.cacheMiss}`);
    }
    return lines.join('\n');
}

/**
 * Prometheus textfile for the last completed gen pass. Gauges, not counters:
 * the textfile collector replaces the file on every scrape.
 *
 * @param {{ ok: number, skipped: number, failed: number, tokensIn: number, tokensOut: number, cacheHit: number, cacheMiss: number, planned?: number, dryRun?: boolean, lastRunTs: number }} stats
 * @param {string} [chain]
 * @return {string}
 */
export function formatMetrics(stats, chain = 'mainnet') {
    const labels = `{chain="${escapeLabel(chain)}"}`;
    const planned = stats.dryRun ? (stats.planned ?? 0) : (stats.ok + stats.failed);
    return [
        '# HELP trace_gen_ok Teacher answers written in the last run.',
        '# TYPE trace_gen_ok gauge',
        `trace_gen_ok${labels} ${stats.ok}`,
        '# HELP trace_gen_skipped Prompt-style pairs already fresh in the last run.',
        '# TYPE trace_gen_skipped gauge',
        `trace_gen_skipped${labels} ${stats.skipped}`,
        '# HELP trace_gen_failed Teacher calls that failed after retries in the last run.',
        '# TYPE trace_gen_failed gauge',
        `trace_gen_failed${labels} ${stats.failed}`,
        '# HELP trace_gen_planned Calls that would be made (dry-run) or were attempted (live).',
        '# TYPE trace_gen_planned gauge',
        `trace_gen_planned${labels} ${planned}`,
        '# HELP trace_gen_prompt_tokens Prompt tokens reported by the API in the last run (estimated on dry-run).',
        '# TYPE trace_gen_prompt_tokens gauge',
        `trace_gen_prompt_tokens${labels} ${stats.tokensIn}`,
        '# HELP trace_gen_output_tokens Completion tokens reported by the API in the last run.',
        '# TYPE trace_gen_output_tokens gauge',
        `trace_gen_output_tokens${labels} ${stats.tokensOut}`,
        '# HELP trace_gen_cache_hit_tokens Prompt-cache hit tokens in the last run.',
        '# TYPE trace_gen_cache_hit_tokens gauge',
        `trace_gen_cache_hit_tokens${labels} ${stats.cacheHit}`,
        '# HELP trace_gen_cache_miss_tokens Prompt-cache miss tokens in the last run.',
        '# TYPE trace_gen_cache_miss_tokens gauge',
        `trace_gen_cache_miss_tokens${labels} ${stats.cacheMiss}`,
        '# HELP trace_gen_dry_run 1 if the last run was --dry-run.',
        '# TYPE trace_gen_dry_run gauge',
        `trace_gen_dry_run${labels} ${stats.dryRun ? 1 : 0}`,
        '# HELP trace_gen_last_run_timestamp Unix time of the last completed gen pass.',
        '# TYPE trace_gen_last_run_timestamp gauge',
        `trace_gen_last_run_timestamp${labels} ${stats.lastRunTs}`,
        '',
    ].join('\n');
}

/**
 * @param {string} promFile
 * @param {object} stats
 * @param {{ chain?: string, onError?: (msg: string) => void }} [opts]
 */
export function writeMetrics(promFile, stats, opts = {}) {
    writePromSection(promFile, formatMetrics(stats, opts.chain || 'mainnet'), 'trace_gen_', opts);
}

/**
 * Entry point. `env`, `argv`, `io`, and injectable dependencies are exposed
 * so the whole flow is testable without touching the real DeepSeek API.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} argv
 * @param {{ log: (m: string) => void, error: (m: string) => void }} io
 * @param {{ fetch?: typeof fetch, sleep?: (ms: number) => Promise<void>, rng?: () => number, now?: () => number }} [deps]
 * @return {Promise<void>}
 */
export async function main(env = process.env, argv = process.argv.slice(2), io = console, deps = {}) {
    let flags;
    try {
        flags = parseArgs(argv);
    } catch (e) {
        io.error(e.message);
        io.error(HELP);
        process.exitCode = 1;
        return;
    }
    if (flags.help) { io.log(HELP); return; }

    const dataDir = env.DATA_DIR;
    if (!dataDir) {
        io.error('DATA_DIR is not set');
        process.exitCode = 1;
        return;
    }
    let st;
    try { st = fs.statSync(dataDir); } catch {
        io.error(`DATA_DIR is not a directory: ${dataDir}`);
        process.exitCode = 1;
        return;
    }
    if (!st.isDirectory()) {
        io.error(`DATA_DIR is not a directory: ${dataDir}`);
        process.exitCode = 1;
        return;
    }

    let cfg;
    try {
        cfg = resolveConfig(env, flags);
    } catch (e) {
        io.error(e.message);
        process.exitCode = 1;
        return;
    }
    if (!flags.dryRun && !cfg.apiKey) {
        io.error('DEEPSEEK_API_KEY is not set');
        process.exitCode = 1;
        return;
    }

    io.log(`gen-responses: scanning ${dataDir} styles=${cfg.styles.join(',')} model=${cfg.model}${flags.dryRun ? ' dry-run' : ''}`);
    const jobs = collectPromptJobs(dataDir, cfg.styles);
    io.log(`gen-responses: ${jobs.length} candidate prompt-style pairs`);

    // Dry-run bookkeeping is single-threaded on purpose: everything is deterministic.
    if (flags.dryRun) {
        let planned = 0;
        let skipped = 0;
        let tokensIn = 0;
        for (const job of jobs) {
            const sha = promptSha256(
                cfg.teacherSystemSuffix
                    ? `${job.systemPrompt}\n\n${cfg.teacherSystemSuffix}`
                    : job.systemPrompt,
                job.userPrompt,
            );
            const existing = readExistingResponse(job.absPath);
            if (hasFreshEntry(existing, job.style, sha, cfg.force)) {
                skipped++;
                continue;
            }
            planned++;
            tokensIn += estimateTokens(job.systemPrompt)
                + estimateTokens(cfg.teacherSystemSuffix)
                + estimateTokens(job.userPrompt);
            if (cfg.limit !== undefined && planned >= cfg.limit) break;
        }
        const summary = {
            ok: 0, skipped, failed: 0, tokensIn, tokensOut: 0,
            cacheHit: 0, cacheMiss: 0, dryRun: true, planned,
        };
        io.log(formatSummary(summary));
        publishGenMetrics(env, io, summary);
        return;
    }

    let ok = 0, skipped = 0, failed = 0, issued = 0;
    let tokensIn = 0, tokensOut = 0, cacheHit = 0, cacheMiss = 0;
    let processed = 0;
    const now = deps.now || (() => Date.now());
    const limitReached = () => cfg.limit !== undefined && issued >= cfg.limit;

    await runPool(jobs, cfg.concurrency, async (job) => {
        if (limitReached()) return;
        processed++;
        if (cfg.progressEvery > 0 && processed % cfg.progressEvery === 0) {
            io.log(`gen-responses: processed ${processed}/${jobs.length} (ok=${ok} skipped=${skipped} failed=${failed})`);
        }
        const system = cfg.teacherSystemSuffix
            ? `${job.systemPrompt}\n\n${cfg.teacherSystemSuffix}`
            : job.systemPrompt;
        const sha = promptSha256(system, job.userPrompt);
        const existing = readExistingResponse(job.absPath);
        if (hasFreshEntry(existing, job.style, sha, cfg.force)) {
            skipped++;
            return;
        }
        if (limitReached()) return;
        issued++;
        const body = buildRequestBody(job, cfg);
        const startedAt = now();
        let data;
        try {
            data = await callDeepSeek(body, cfg, {
                fetch: deps.fetch,
                sleep: deps.sleep,
                rng: deps.rng,
                onRetry: ({ attempt, wait, status, message }) => {
                    io.error(`gen-responses: retry ${attempt + 1}/${cfg.maxRetries} ${job.relPath} [${job.style}] status=${status ?? 'net'} wait=${wait}ms: ${truncate(message, 200)}`);
                },
            });
        } catch (e) {
            failed++;
            io.error(`gen-responses: fail ${job.relPath} [${job.style}]: ${truncate(e.message, 500)}`);
            return;
        }
        let msg;
        try {
            msg = extractAssistantMessage(data);
        } catch (e) {
            failed++;
            io.error(`gen-responses: bad-response ${job.relPath} [${job.style}]: ${e.message}`);
            return;
        }
        const durationMs = Math.max(0, now() - startedAt);
        const usage = msg.usage || {};
        const entry = {
            content: msg.content,
            finishReason: msg.finishReason,
            usage: {
                prompt_tokens: numOr0(usage.prompt_tokens),
                completion_tokens: numOr0(usage.completion_tokens),
                total_tokens: numOr0(usage.total_tokens),
                prompt_cache_hit_tokens: numOr0(usage.prompt_cache_hit_tokens),
                prompt_cache_miss_tokens: numOr0(usage.prompt_cache_miss_tokens),
                reasoning_tokens: numOr0(usage.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens),
            },
            promptSha256: sha,
            requestId: msg.requestId,
            createdAt: new Date(startedAt).toISOString(),
            durationMs,
        };
        if (cfg.keepReasoning && msg.reasoningContent) entry.reasoningContent = msg.reasoningContent;
        try {
            writeResponseEntry(
                job.absPath,
                { txHash: job.txHash, codehash: job.codehash, methodId: job.methodId, model: cfg.model },
                job.style,
                entry,
            );
        } catch (e) {
            failed++;
            io.error(`gen-responses: write-fail ${job.relPath} [${job.style}]: ${e.message}`);
            return;
        }
        ok++;
        tokensIn += entry.usage.prompt_tokens;
        tokensOut += entry.usage.completion_tokens;
        cacheHit += entry.usage.prompt_cache_hit_tokens;
        cacheMiss += entry.usage.prompt_cache_miss_tokens;
    });

    const summary = { ok, skipped, failed, tokensIn, tokensOut, cacheHit, cacheMiss };
    io.log(formatSummary(summary));
    publishGenMetrics(env, io, summary);
    if (failed > 0) process.exitCode = 1;
}

function publishGenMetrics(env, io, summary) {
    writeMetrics(env.PROM_FILE || '', { ...summary, lastRunTs: Math.floor(Date.now() / 1000) }, {
        chain: env.CHAIN || 'mainnet',
        onError: (msg) => io.error(msg),
    });
}

function numOr0(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// Skip `_prompt.nosrc` markers explicitly – they never carry a prompt array.
// (Kept as a named export so tests can import it if needed.)
export function isNosrcMarker(name) {
    return name.endsWith(NOSRC_SUFFIX);
}

const isMain = process.argv[1]
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
    main().catch((e) => {
        console.error(e && e.stack ? e.stack : String(e));
        process.exit(1);
    });
}
