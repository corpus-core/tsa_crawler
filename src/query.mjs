#!/usr/bin/env node
// Filter prompt files under DATA_DIR.
// Layout: <codehash[0:2]>/<codehash[2:]>/<method_id>/<txhash>_prompt.json
//
//   DATA_DIR=test_data node src/query.mjs -c 02 -m 095ea7b3 -q approve -d

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { walkBuckets, SELECTOR_DIR_RE, TRACE_FILE_RE } from './bucket_paths.mjs';

export const PROMPT_FILE_RE = /^0x[0-9a-f]{64}_prompt\.json$/;

export const HELP = `Usage: DATA_DIR=<dir> node src/query.mjs [options]

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
  -r                  Shuffle matches after filters (before -o / -l)
  -o <n>              Skip the first n matches (after shuffle, before -l)
  -l <n>              Stop after n matches
  -d                  Print path and first userPrompt; color-code sections
  -s                  Like -d, plus the sibling <txhash>_sim.json (light blue)
  -t <0|1>            Keep txs whose collector {txhash}.json has (.trace.call)
                      (1) or does not (0)
  -e <sections>       Keep files whose listed sections are resolved
                      (comma-separated: tx,events,state,call,code)
  -E <sections>       Keep files whose listed sections are not resolved
  -S                  Print hit count, dataset count, and percentage
                      (no path listing unless -d / -s / -x)
  -x                  Delete matching {txhash}.json files
  -X                  Like -x, plus _sim.json, _prompt.json, _prompt.nosrc,
                      _sim.nosrc; prune empty parent dirs
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

/** Raw numbered slot (`: slot 5:` / `: slot 0[addr]:`). */
export const STATE_SLOT_RE = /: slot [0-9]+/;
/** Storage key is still a hex hash instead of a variable name. */
export const STATE_HEX_KEY_RE = /^-\s+.+:\s+0x[0-9a-fA-F.]+:/;
/** Call function is a 4-byte selector (after stripping `[CALL]` / `(value)`). */
export const CALL_METHOD_ID_RE = /0x[0-9a-f]{8}\s*$/i;
/** At least one Solidity file in a C4 source fence. */
export const CODE_SOL_RE = /<<<C4_UNTRUSTED_SOURCE[^>\n]*\.sol"/i;
export const TX_SELECTOR_MARK = 'Function selector: ';
export const UNKNOWN_EVENT_MARK = 'Unknown event';

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
 * @param {string} val
 * @param {string} flag
 * @return {string[]}
 */
export function parseSectionList(val, flag) {
    const keys = String(val).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!keys.length) throw new Error(`${flag} requires a comma-separated list of sections`);
    for (const key of keys) {
        if (!SECTION_KEY_SET.has(key)) {
            throw new Error(`${flag} unknown section: ${key} (tx,events,state,call,code)`);
        }
    }
    return keys;
}

/**
 * @param {string[]} argv
 * @return {{ q: Array<{ term: string, section?: string }>, c: string[], m: string[], e: string[], E: string[], min?: number, max?: number, limit?: number, offset?: number, random: boolean, details: boolean, sim: boolean, stats: boolean, hasCall?: boolean, deleteTrace: boolean, deleteSiblings: boolean, help: boolean }}
 */
export function parseArgs(argv) {
    const filters = {
        q: [], c: [], m: [], e: [], E: [],
        details: false, sim: false, random: false, stats: false,
        deleteTrace: false, deleteSiblings: false, help: false,
    };
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
        if (a === '-s') {
            filters.details = true;
            filters.sim = true;
            continue;
        }
        if (a === '-r') {
            filters.random = true;
            continue;
        }
        if (a === '-S') {
            filters.stats = true;
            continue;
        }
        if (a === '-x') {
            filters.deleteTrace = true;
            continue;
        }
        if (a === '-X') {
            filters.deleteTrace = true;
            filters.deleteSiblings = true;
            continue;
        }
        if (a === '-t') {
            const val = argv[++i];
            if (val !== '0' && val !== '1') {
                throw new Error('-t requires 0 or 1');
            }
            filters.hasCall = val === '1';
            continue;
        }
        if (a === '-e' || a === '-E') {
            const val = argv[++i];
            if (val === undefined || val.startsWith('-')) {
                throw new Error(`${a} requires a value`);
            }
            const dest = a === '-e' ? filters.e : filters.E;
            dest.push(...parseSectionList(val, a));
            continue;
        }
        if (a === '-q' || a === '-c' || a === '-m' || a === '-min' || a === '-max' || a === '-l' || a === '-o') {
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
            else if (a === '-o') filters.offset = n;
            else filters.limit = n;
            continue;
        }
        throw new Error(`unknown flag: ${a}`);
    }
    filters.e = uniqueSections(filters.e);
    filters.E = uniqueSections(filters.E);
    const overlap = filters.e.filter((k) => filters.E.includes(k));
    if (overlap.length) {
        throw new Error(`cannot use the same section in -e and -E: ${overlap.join(',')}`);
    }
    return filters;
}

/**
 * @param {string[]} keys
 * @return {string[]}
 */
function uniqueSections(keys) {
    return [...new Set(keys)];
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
 * @param {{ q?: Array<string | { term: string, section?: string }>, min?: number, max?: number, e?: string[], E?: string[] }} filters
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
    for (const key of filters.e || []) {
        if (!isSectionResolved(parts, key)) return false;
    }
    for (const key of filters.E || []) {
        if (isSectionResolved(parts, key)) return false;
    }
    return true;
}

/**
 * @param {string} text
 * @param {RegExp} re
 * @return {string[]}
 */
function itemLines(text, re) {
    return text.split('\n').filter((line) => re.test(line));
}

/**
 * Strict majority: more than half of `items` must not be unresolved.
 * An empty list is not resolved.
 *
 * @param {string[]} items
 * @param {(line: string) => boolean} isUnresolved
 * @return {boolean}
 */
function majorityResolved(items, isUnresolved) {
    if (items.length === 0) return false;
    let resolved = 0;
    for (const line of items) {
        if (!isUnresolved(line)) resolved++;
    }
    return resolved * 2 > items.length;
}

/**
 * @param {string} line
 * @return {boolean}
 */
export function isUnresolvedStateChange(line) {
    return STATE_SLOT_RE.test(line) || STATE_HEX_KEY_RE.test(line);
}

/**
 * @param {string} line
 * @return {boolean}
 */
export function isUnresolvedCall(line) {
    const stripped = line
        .replace(/\s*\[(?:CALL|DELEGATECALL|STATICCALL|CREATE2?|CALLCODE)\]\s*$/i, '')
        .replace(/\s*\([^)]*\)\s*$/, '');
    return CALL_METHOD_ID_RE.test(stripped);
}

/**
 * `tx` is resolved when the function name is decoded (no `Function selector: `).
 * `events` / `state` / `call` need a strict majority of decoded items.
 * `code` is resolved when at least one C4 fence is a `.sol` file.
 *
 * @param {string | Array<{ key: string | null, text: string }>} userPromptOrParts
 * @param {string} key
 * @return {boolean}
 */
export function isSectionResolved(userPromptOrParts, key) {
    const parts = typeof userPromptOrParts === 'string'
        ? splitSections(userPromptOrParts)
        : userPromptOrParts;
    const text = sectionText(parts, key);
    switch (key) {
        case 'tx':
            return text.length > 0 && !text.includes(TX_SELECTOR_MARK);
        case 'events':
            return majorityResolved(itemLines(text, /^\d+\.\s/), (line) => line.includes(UNKNOWN_EVENT_MARK));
        case 'state':
            return majorityResolved(itemLines(text, /^-\s+\S/), isUnresolvedStateChange);
        case 'call':
            return majorityResolved(itemLines(text, /^\d+\.\s/), isUnresolvedCall);
        case 'code':
            return CODE_SOL_RE.test(text);
        default:
            return false;
    }
}

/**
 * @param {string} promptAbsPath
 * @return {string}
 */
export function simPathForPrompt(promptAbsPath) {
    return promptAbsPath.replace(/_prompt\.json$/, '_sim.json');
}

/**
 * Collector trace sibling of a `_prompt.json` path.
 *
 * @param {string} promptAbsPath
 * @return {string}
 */
export function tracePathForPrompt(promptAbsPath) {
    return promptAbsPath.replace(/_prompt\.json$/, '.json');
}

/**
 * True when the collector trace has a `.trace.call` property that is not null.
 *
 * @param {unknown} parsed
 * @return {boolean}
 */
export function hasTraceCall(parsed) {
    return parsed != null
        && typeof parsed === 'object'
        && parsed.trace != null
        && typeof parsed.trace === 'object'
        && parsed.trace.call != null;
}

/**
 * @param {object} filters
 * @return {boolean}
 */
function needsUserPrompt(filters) {
    return (filters.q && filters.q.length > 0)
        || (filters.e && filters.e.length > 0)
        || (filters.E && filters.E.length > 0)
        || filters.min !== undefined
        || filters.max !== undefined
        || filters.details
        || filters.sim;
}

/**
 * @param {string} dir
 * @return {Map<string, { trace?: string, prompt?: string }>}
 */
function indexBucketFiles(dir) {
    const byTx = new Map();
    let names;
    try {
        names = fs.readdirSync(dir);
    } catch {
        return byTx;
    }
    for (const name of names) {
        if (TRACE_FILE_RE.test(name)) {
            const tx = name.slice(0, -'.json'.length);
            const slot = byTx.get(tx) || {};
            slot.trace = name;
            byTx.set(tx, slot);
        } else if (PROMPT_FILE_RE.test(name)) {
            const tx = name.slice(0, -'_prompt.json'.length);
            const slot = byTx.get(tx) || {};
            slot.prompt = name;
            byTx.set(tx, slot);
        }
    }
    return byTx;
}

/**
 * Unlink existing siblings. Missing files are ignored.
 *
 * @param {string} traceAbsPath
 * @param {boolean} siblings
 * @return {string[]} paths actually removed
 */
export function unlinkTxFiles(traceAbsPath, siblings) {
    const stem = traceAbsPath.replace(/\.json$/, '');
    const names = [traceAbsPath];
    if (siblings) {
        names.push(
            `${stem}_sim.json`,
            `${stem}_prompt.json`,
            `${stem}_prompt.nosrc`,
            `${stem}_sim.nosrc`,
        );
    }
    const removed = [];
    for (const p of names) {
        try {
            fs.unlinkSync(p);
            removed.push(p);
        } catch (e) {
            if (e.code !== 'ENOENT') throw e;
        }
    }
    return removed;
}

/**
 * Remove `dir` and empty parents up to (but not including) `root`.
 *
 * @param {string} dir
 * @param {string} root
 * @return {string[]} directories removed
 */
export function pruneEmptyDirs(dir, root) {
    const rootAbs = path.resolve(root);
    let current = path.resolve(dir);
    const removed = [];
    while (true) {
        const rel = path.relative(rootAbs, current);
        if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) break;
        let names;
        try {
            names = fs.readdirSync(current);
        } catch {
            break;
        }
        if (names.length > 0) break;
        fs.rmdirSync(current);
        removed.push(current);
        current = path.dirname(current);
    }
    return removed;
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
    if (!details || typeof userPrompt !== 'string') return relPath;
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
 * Fisher-Yates. `rng` must return a float in [0, 1).
 *
 * @param {unknown[]} arr
 * @param {() => number} [rng]
 * @return {unknown[]}
 */
export function shuffleInPlace(arr, rng = Math.random) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
    }
    return arr;
}

/**
 * Shuffle (optional), then offset, then limit.
 *
 * @param {unknown[]} hits
 * @param {{ random?: boolean, offset?: number, limit?: number, rng?: () => number }} [opts]
 * @return {unknown[]}
 */
/**
 * `hits / total (pct%)`. `total === 0` is `0.00%`.
 *
 * @param {number} hits
 * @param {number} total
 * @return {string}
 */
export function formatStats(hits, total) {
    const pct = total === 0 ? 0 : (hits * 100) / total;
    return `${hits} / ${total} (${pct.toFixed(2)}%)`;
}

export function pageHits(hits, { random = false, offset = 0, limit, rng = Math.random } = {}) {
    const out = random ? shuffleInPlace(hits.slice(), rng) : hits;
    const start = offset || 0;
    if (limit === 0) return [];
    if (limit === undefined) return start ? out.slice(start) : (random ? out : hits);
    return out.slice(start, start + limit);
}

/**
 * Walk every bucket. `scanned` is every prompt (or every tx when `-t` is set),
 * including buckets that fail `-c` / `-m`. `matched` is the filter keep-set.
 *
 * @param {string} root
 * @param {object} filters
 * @param {(hit: { relPath: string, absPath: string, userPrompt: string }) => void} onHit
 * @param {(msg: string) => void} [onWarn]
 * @return {{ scanned: number, matched: number }}
 */
function forEachMatching(root, filters, onHit, onWarn) {
    const wantCall = filters.hasCall;
    const requirePrompt = needsUserPrompt(filters) || wantCall === undefined;
    let scanned = 0;
    let matched = 0;
    walkBuckets(root, (dir, key) => {
        const bucket = key.match(BUCKET_KEY_RE);
        if (!bucket) return;
        const bucketOk = matchesBucket(bucket[1], bucket[2], filters);
        const byTx = indexBucketFiles(dir);
        for (const [, files] of byTx) {
            if (wantCall === undefined) {
                if (!files.prompt) continue;
            } else if (!files.prompt && !files.trace) {
                continue;
            }
            scanned++;
            if (!bucketOk) continue;

            const promptAbs = files.prompt ? path.join(dir, files.prompt) : null;
            const traceAbs = files.trace
                ? path.join(dir, files.trace)
                : (promptAbs ? tracePathForPrompt(promptAbs) : null);

            if (wantCall !== undefined) {
                let parsed = null;
                if (files.trace) {
                    try {
                        parsed = JSON.parse(fs.readFileSync(traceAbs, 'utf8'));
                    } catch (e) {
                        onWarn?.(`warn: skip ${traceAbs}: ${e.message}`);
                        parsed = null;
                    }
                }
                if (hasTraceCall(parsed) !== wantCall) continue;
            }

            let userPrompt = null;
            if (requirePrompt) {
                if (!promptAbs) continue;
                let parsedPrompt;
                try {
                    parsedPrompt = JSON.parse(fs.readFileSync(promptAbs, 'utf8'));
                } catch (e) {
                    onWarn?.(`warn: skip ${promptAbs}: ${e.message}`);
                    continue;
                }
                userPrompt = firstUserPrompt(parsedPrompt);
                if (userPrompt === null) {
                    onWarn?.(`warn: skip ${promptAbs}: missing userPrompt`);
                    continue;
                }
                if (!matchesFilters(userPrompt, filters)) continue;
            }

            const absPath = promptAbs || traceAbs;
            matched++;
            onHit({
                relPath: path.relative(root, absPath),
                absPath,
                traceAbsPath: traceAbs,
                userPrompt,
            });
        }
    });
    return { scanned, matched };
}

/**
 * Stream matching prompt files. `-r` collects the full filtered set, shuffles,
 * then applies `-o` and `-l`. Without `-r`, offset/limit stream in walk order.
 *
 * @param {string} root
 * @param {{ q?: Array<string | { term: string, section?: string }>, c?: string[], m?: string[], min?: number, max?: number, limit?: number, offset?: number, random?: boolean, rng?: () => number }} filters
 * @param {(hit: { relPath: string, absPath: string, userPrompt: string }) => void} onMatch
 * @param {(msg: string) => void} [onWarn]
 * @return {{ scanned: number, matched: number }}
 */
export function visitMatchingPrompts(root, filters, onMatch, onWarn) {
    const limit = filters.limit;
    const offset = filters.offset || 0;
    const rng = filters.rng || Math.random;
    const emitHits = !filters.stats || filters.details || filters.sim || filters.deleteTrace;
    if (limit === 0 && !filters.stats) return { scanned: 0, matched: 0 };

    if (filters.random || filters.stats) {
        const hits = [];
        const onHit = emitHits ? (hit) => hits.push(hit) : () => { };
        const counts = forEachMatching(root, filters, onHit, onWarn);
        if (emitHits && limit !== 0) {
            for (const hit of pageHits(hits, { random: !!filters.random, offset, limit, rng })) {
                onMatch(hit);
            }
        }
        return counts;
    }

    let skipped = 0;
    let emitted = 0;
    try {
        return forEachMatching(root, filters, (hit) => {
            if (skipped < offset) {
                skipped++;
                return;
            }
            onMatch(hit);
            emitted++;
            if (limit !== undefined && emitted >= limit) throw STOP;
        }, onWarn);
    } catch (e) {
        if (e !== STOP) throw e;
        return { scanned: 0, matched: 0 };
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
    const progressEvery = parseInt(env.PROGRESS_EVERY || '100', 10) || 100;
    const emitHits = !filters.stats || filters.details || filters.sim || filters.deleteTrace;
    let deletedTxs = 0;
    let deletedFiles = 0;
    let deletedDirs = 0;
    const counts = visitMatchingPrompts(
        dataDir,
        filters,
        ({ relPath, absPath, traceAbsPath, userPrompt }) => {
            if (emitHits) {
                const simText = filters.sim ? loadSimText(absPath, (msg) => io.error(msg)) : null;
                io.log(formatMatch(relPath, userPrompt, filters.details, color, simText));
            }
            if (!filters.deleteTrace || !traceAbsPath) return;
            const removed = unlinkTxFiles(traceAbsPath, filters.deleteSiblings);
            deletedFiles += removed.length;
            const dirs = pruneEmptyDirs(path.dirname(traceAbsPath), dataDir);
            deletedDirs += dirs.length;
            deletedTxs++;
            if (deletedTxs % progressEvery === 0) {
                io.error(`delete: ${deletedTxs} txs (${deletedFiles} files, ${deletedDirs} dirs)`);
            }
        },
        (msg) => io.error(msg),
    );
    if (filters.stats) {
        io.log(formatStats(counts.matched, counts.scanned));
    }
    if (filters.deleteTrace) {
        io.error(`delete: done ${deletedTxs} txs, ${deletedFiles} files, ${deletedDirs} dirs`);
    }
}

const isMain = process.argv[1]
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) main();
