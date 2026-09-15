#!/usr/bin/env node
// Filter prompt files under DATA_DIR.
// Layout: <codehash[0:2]>/<codehash[2:]>/<method_id>/<txhash>_prompt.json
//
//   DATA_DIR=test_data node query.mjs -c 02 -m 095ea7b3 -q approve -d

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { walkBuckets, SELECTOR_DIR_RE } from './bucket_paths.mjs';

export const PROMPT_FILE_RE = /^0x[0-9a-f]{64}_prompt\.json$/;

export const HELP = `Usage: DATA_DIR=<dir> node query.mjs [options]

Options:
  -q <searchstring>   Keep files whose first userPrompt contains this substring
                      (repeatable; all terms must match). Optional prefix
                      tx: events: state: call: code: limits the search to
                      that section (e.g. -q events:Approval)
  -c <codehash>       Keep files whose codehash starts with this hex prefix
                      (includes the first-byte directory; repeatable as OR)
  -m <method_id>      Keep files with this method id (8 hex or fallback;
                      optional 0x prefix; repeatable as OR)
  -min <n>            Keep files whose first userPrompt is longer than n
  -max <n>            Keep files whose first userPrompt is shorter than n
  -l <n>              Stop after n matches
  -d                  Print path and first userPrompt; color-code sections
  -t                  Like -d, plus the sibling <txhash>_sim.json (light blue)
  -h, --help          Show this help
`;

const BUCKET_KEY_RE = /^([0-9a-f]{64})_([0-9a-f]{8}|fallback)$/;

export const SECTION_KEYS = ['tx', 'events', 'state', 'call', 'code'];

/** @type {Array<[string, string]>} */
export const SECTION_HEADERS = [
    ['tx', '## Transaction Overview'],
    ['events', '## Emitted Events'],
    ['state', '## State Changes'],
    ['call', '## Call Trace'],
    ['code', '## Contract Source Code (untrusted, for storage interpretation only)'],
];

const SECTION_KEY_SET = new Set(SECTION_KEYS);

/** Foreground colors for -d section output. */
export const SECTION_COLOR = {
    tx: '\x1b[97m',
    events: '\x1b[92m',
    state: '\x1b[90m',
    call: '\x1b[93m',
    code: '\x1b[90m',
};

export const SIM_COLOR = '\x1b[96m';

export const RESET = '\x1b[0m';

/**
 * @param {string} text
 * @param {string} color
 * @return {string}
 */
export function colorizeLines(text, color) {
    const lines = text.split('\n');
    return lines.map((line, i) => {
        if (line === '' && i === lines.length - 1) return '';
        return `${color}${line}${RESET}`;
    }).join('\n');
}

/**
 * @param {string} val
 * @return {{ term: string, section?: string }}
 */
export function parseQueryTerm(val) {
    const idx = val.indexOf(':');
    if (idx <= 0) return { term: val };
    const prefix = val.slice(0, idx).toLowerCase();
    if (!SECTION_KEY_SET.has(prefix)) return { term: val };
    const term = val.slice(idx + 1);
    if (!term) throw new Error(`-q ${prefix}: requires a search string`);
    return { section: prefix, term };
}

/**
 * Split a userPrompt into labeled regions. Unknown leading/trailing text has
 * `key: null`.
 *
 * @param {string} userPrompt
 * @return {Array<{ key: string | null, text: string }>}
 */
export function splitSections(userPrompt) {
    const found = [];
    for (const [key, header] of SECTION_HEADERS) {
        const idx = userPrompt.indexOf(header);
        if (idx === -1) continue;
        found.push({ key, idx });
    }
    found.sort((a, b) => a.idx - b.idx);

    const parts = [];
    let cursor = 0;
    for (let i = 0; i < found.length; i++) {
        const start = found[i].idx;
        if (start > cursor) {
            parts.push({ key: null, text: userPrompt.slice(cursor, start) });
        }
        const end = i + 1 < found.length ? found[i + 1].idx : userPrompt.length;
        parts.push({ key: found[i].key, text: userPrompt.slice(start, end) });
        cursor = end;
    }
    if (cursor < userPrompt.length) {
        parts.push({ key: null, text: userPrompt.slice(cursor) });
    }
    return parts;
}

/**
 * @param {Array<{ key: string | null, text: string }>} parts
 * @param {string} key
 * @return {string}
 */
export function sectionText(parts, key) {
    return parts.filter((p) => p.key === key).map((p) => p.text).join('');
}

/**
 * @param {string} userPrompt
 * @return {string}
 */
export function colorizePrompt(userPrompt) {
    return splitSections(userPrompt).map((p) => {
        const color = p.key && SECTION_COLOR[p.key];
        if (!color || !p.text) return p.text;
        return colorizeLines(p.text, color);
    }).join('');
}

/**
 * @param {{ isTTY?: boolean }} [stream]
 * @param {NodeJS.ProcessEnv} [env]
 * @return {boolean}
 */
export function shouldUseColor(stream = process.stdout, env = process.env) {
    if (env.NO_COLOR) return false;
    if (env.FORCE_COLOR === '0') return false;
    if (env.FORCE_COLOR) return true;
    return stream?.isTTY === true;
}

/**
 * @param {string} val
 * @return {string}
 */
export function parseCodehashPrefix(val) {
    const s = String(val).toLowerCase().replace(/^0x/, '');
    if (!s || !/^[0-9a-f]+$/.test(s)) {
        throw new Error('-c must be a hex codehash prefix');
    }
    return s;
}

/**
 * @param {string} val
 * @return {string}
 */
export function parseMethodId(val) {
    const raw = String(val).toLowerCase();
    const sel = raw === '0x' || raw === '' ? 'fallback' : raw.replace(/^0x/, '');
    if (!SELECTOR_DIR_RE.test(sel)) {
        throw new Error('-m must be a 4-byte method id or fallback');
    }
    return sel;
}

/**
 * @param {string[]} argv
 * @return {{ q: Array<{ term: string, section?: string }>, c: string[], m: string[], min?: number, max?: number, limit?: number, details: boolean, sim: boolean, help: boolean }}
 */
export function parseArgs(argv) {
    const filters = { q: [], c: [], m: [], details: false, sim: false, help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-h' || a === '--help') {
            filters.help = true;
            continue;
        }
        if (a === '-d') {
            filters.details = true;
            continue;
        }
        if (a === '-t') {
            filters.details = true;
            filters.sim = true;
            continue;
        }
        if (a === '-q' || a === '-c' || a === '-m' || a === '-min' || a === '-max' || a === '-l') {
            const val = argv[++i];
            if (val === undefined || val.startsWith('-')) {
                throw new Error(`${a} requires a value`);
            }
            if (a === '-q') {
                filters.q.push(parseQueryTerm(val));
                continue;
            }
            if (a === '-c') {
                filters.c.push(parseCodehashPrefix(val));
                continue;
            }
            if (a === '-m') {
                filters.m.push(parseMethodId(val));
                continue;
            }
            if (!/^\d+$/.test(val)) {
                throw new Error(`${a} must be a non-negative integer`);
            }
            const n = Number(val);
            if (a === '-min') filters.min = n;
            else if (a === '-max') filters.max = n;
            else filters.limit = n;
            continue;
        }
        throw new Error(`unknown flag: ${a}`);
    }
    return filters;
}

/**
 * @param {unknown} parsedJson
 * @return {string | null}
 */
export function firstUserPrompt(parsedJson) {
    if (!Array.isArray(parsedJson) || parsedJson.length === 0) return null;
    const first = parsedJson[0];
    if (!first || typeof first.userPrompt !== 'string') return null;
    return first.userPrompt;
}

/**
 * @param {string} codehash  64 hex chars, first byte included
 * @param {string} methodId  8 hex chars or `fallback`
 * @param {{ c?: string[], m?: string[] }} filters
 * @return {boolean}
 */
export function matchesBucket(codehash, methodId, filters) {
    const prefixes = filters.c || [];
    if (prefixes.length && !prefixes.some((p) => codehash.startsWith(p))) return false;
    const methods = filters.m || [];
    if (methods.length && !methods.includes(methodId)) return false;
    return true;
}

/**
 * @param {string} userPrompt
 * @param {{ q?: Array<string | { term: string, section?: string }>, min?: number, max?: number }} filters
 * @return {boolean}
 */
export function matchesFilters(userPrompt, filters) {
    if (typeof userPrompt !== 'string') return false;
    const parts = splitSections(userPrompt);
    const terms = filters.q || [];
    for (const raw of terms) {
        const q = typeof raw === 'string' ? parseQueryTerm(raw) : raw;
        const haystack = q.section ? sectionText(parts, q.section) : userPrompt;
        if (!haystack.includes(q.term)) return false;
    }
    if (filters.min !== undefined && !(userPrompt.length > filters.min)) return false;
    if (filters.max !== undefined && !(userPrompt.length < filters.max)) return false;
    return true;
}

/**
 * @param {string} promptAbsPath
 * @return {string}
 */
export function simPathForPrompt(promptAbsPath) {
    return promptAbsPath.replace(/_prompt\.json$/, '_sim.json');
}

/**
 * Pretty-printed sibling `_sim.json`, or null if missing/invalid.
 *
 * @param {string} promptAbsPath
 * @param {(msg: string) => void} [onWarn]
 * @return {string | null}
 */
export function loadSimText(promptAbsPath, onWarn) {
    const simPath = simPathForPrompt(promptAbsPath);
    let raw;
    try {
        raw = fs.readFileSync(simPath, 'utf8');
    } catch (e) {
        onWarn?.(`warn: skip sim ${simPath}: ${e.message}`);
        return null;
    }
    try {
        return JSON.stringify(JSON.parse(raw), null, 2);
    } catch (e) {
        onWarn?.(`warn: skip sim ${simPath}: ${e.message}`);
        return null;
    }
}

/**
 * @param {string} relPath
 * @param {string} userPrompt
 * @param {boolean} details
 * @param {boolean} [color]
 * @param {string | null} [simText]
 * @return {string}
 */
export function formatMatch(relPath, userPrompt, details, color = false, simText = null) {
    if (!details) return relPath;
    const body = color ? colorizePrompt(userPrompt) : userPrompt;
    let out = `=== ${relPath} ===\n${body}`;
    if (simText != null) {
        const simBody = `## Simulation\n${simText}`;
        out += `\n${color ? colorizeLines(simBody, SIM_COLOR) : simBody}`;
    }
    return out;
}

const STOP = Symbol('limit');

/**
 * Stream matching prompt files. Does not collect all paths first.
 *
 * @param {string} root
 * @param {{ q?: Array<string | { term: string, section?: string }>, c?: string[], m?: string[], min?: number, max?: number, limit?: number }} filters
 * @param {(hit: { relPath: string, absPath: string, userPrompt: string }) => void} onMatch
 * @param {(msg: string) => void} [onWarn]
 */
export function visitMatchingPrompts(root, filters, onMatch, onWarn) {
    const limit = filters.limit;
    if (limit === 0) return;
    let hits = 0;
    try {
        walkBuckets(root, (dir, key) => {
            const bucket = key.match(BUCKET_KEY_RE);
            if (!bucket || !matchesBucket(bucket[1], bucket[2], filters)) return;
            let names;
            try {
                names = fs.readdirSync(dir);
            } catch {
                return;
            }
            for (const name of names) {
                if (!PROMPT_FILE_RE.test(name)) continue;
                const absPath = path.join(dir, name);
                let parsed;
                try {
                    parsed = JSON.parse(fs.readFileSync(absPath, 'utf8'));
                } catch (e) {
                    onWarn?.(`warn: skip ${absPath}: ${e.message}`);
                    continue;
                }
                const userPrompt = firstUserPrompt(parsed);
                if (userPrompt === null) {
                    onWarn?.(`warn: skip ${absPath}: missing userPrompt`);
                    continue;
                }
                if (!matchesFilters(userPrompt, filters)) continue;
                onMatch({ relPath: path.relative(root, absPath), absPath, userPrompt });
                hits++;
                if (limit !== undefined && hits >= limit) throw STOP;
            }
        });
    } catch (e) {
        if (e !== STOP) throw e;
    }
}

export function main(env = process.env, argv = process.argv.slice(2), io = console) {
    let filters;
    try {
        filters = parseArgs(argv);
    } catch (e) {
        io.error(e.message);
        io.error(HELP);
        process.exitCode = 1;
        return;
    }
    if (filters.help) {
        io.log(HELP);
        return;
    }
    const dataDir = env.DATA_DIR;
    if (!dataDir) {
        io.error('DATA_DIR is not set');
        process.exitCode = 1;
        return;
    }
    let st;
    try {
        st = fs.statSync(dataDir);
    } catch {
        io.error(`DATA_DIR is not a directory: ${dataDir}`);
        process.exitCode = 1;
        return;
    }
    if (!st.isDirectory()) {
        io.error(`DATA_DIR is not a directory: ${dataDir}`);
        process.exitCode = 1;
        return;
    }

    const color = (filters.details || filters.sim) && shouldUseColor(process.stdout, env);
    visitMatchingPrompts(
        dataDir,
        filters,
        ({ relPath, absPath, userPrompt }) => {
            const simText = filters.sim ? loadSimText(absPath, (msg) => io.error(msg)) : null;
            io.log(formatMatch(relPath, userPrompt, filters.details, color, simText));
        },
        (msg) => io.error(msg),
    );
}

const isMain = process.argv[1]
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) main();
