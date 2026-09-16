// Trace layout: OUT/<hh>/<codehash[2:]>/<selector>/<txhash>.json
//   hh = first byte of the codehash (2 hex chars) → at most 256 top-level dirs
// codehash and selector are stored without a 0x prefix; selector `0x` is `fallback`.

import fs from 'node:fs';
import path from 'node:path';

export const TRACE_FILE_RE = /^0x[0-9a-f]{64}\.json$/;
const HASH_PREFIX_RE = /^[0-9a-f]{2}$/;
const HASH_REST_RE = /^[0-9a-f]{62}$/;
export const SELECTOR_DIR_RE = /^([0-9a-f]{8}|fallback)$/;

/**
 * @param {string} codehash
 * @return {string} 64 hex chars, no 0x
 */
export function codeHashDirName(codehash) {
    return String(codehash).replace(/^0x/i, '').toLowerCase();
}

/**
 * Split a 64-hex codehash into the top-level byte and the remainder.
 *
 * @param {string} codehash
 * @return {{ prefix: string, rest: string, hash: string }}
 */
export function shardedHashParts(codehash) {
    const hash = codeHashDirName(codehash);
    return { prefix: hash.slice(0, 2), rest: hash.slice(2), hash };
}

/**
 * @param {string} selector  `0x` + 8 hex, or `0x` for fallback
 * @return {string}
 */
export function selectorDirName(selector) {
    const s = String(selector || '0x').toLowerCase();
    return s === '0x' ? 'fallback' : s.replace(/^0x/, '');
}

/**
 * Stable in-memory bucket key.
 *
 * @param {string} codehash
 * @param {string} selector
 * @return {string}
 */
export function bucketKey(codehash, selector) {
    return `${codeHashDirName(codehash)}_${selectorDirName(selector)}`;
}

/**
 * Relative path under OUT for a bucket.
 *
 * @param {string} codehash
 * @param {string} selector
 * @return {string} `<hh>/<rest>/<selector>`
 */
export function bucketRelPath(codehash, selector) {
    const { prefix, rest } = shardedHashParts(codehash);
    return path.join(prefix, rest, selectorDirName(selector));
}

function traceCount(dir) {
    try {
        return fs.readdirSync(dir).filter((f) => TRACE_FILE_RE.test(f)).length;
    } catch {
        return 0;
    }
}

function listTraces(dir, out) {
    try {
        for (const f of fs.readdirSync(dir)) {
            if (TRACE_FILE_RE.test(f)) out.push(path.join(dir, f));
        }
    } catch { /* missing */ }
}

/**
 * Visit every bucket directory.
 *
 * @param {string} root
 * @param {(absDir: string, key: string) => void} fn
 */
export function walkBuckets(root, fn) {
    if (!fs.existsSync(root)) return;
    for (const name of fs.readdirSync(root)) {
        if (name.startsWith('.') || !HASH_PREFIX_RE.test(name)) continue;
        const dir = path.join(root, name);
        let st;
        try { st = fs.statSync(dir); } catch { continue; }
        if (!st.isDirectory()) continue;

        for (const rest of fs.readdirSync(dir)) {
            if (!HASH_REST_RE.test(rest)) continue;
            const restDir = path.join(dir, rest);
            let stRest;
            try { stRest = fs.statSync(restDir); } catch { continue; }
            if (!stRest.isDirectory()) continue;
            walkSelectors(restDir, name + rest, fn);
        }
    }
}

function walkSelectors(parent, hash, fn) {
    for (const sel of fs.readdirSync(parent)) {
        if (!SELECTOR_DIR_RE.test(sel)) continue;
        const nested = path.join(parent, sel);
        let stSel;
        try { stSel = fs.statSync(nested); } catch { continue; }
        if (!stSel.isDirectory()) continue;
        fn(nested, `${hash}_${sel}`);
    }
}

/**
 * Reconstruct bucket -> trace-count from the filesystem.
 *
 * @param {string} root
 * @return {Map<string, number>}
 */
export function countBuckets(root) {
    const counts = new Map();
    walkBuckets(root, (dir, key) => {
        counts.set(key, (counts.get(key) || 0) + traceCount(dir));
    });
    return counts;
}

/**
 * Absolute paths of collector trace files (not `_sim` / `_prompt`).
 *
 * @param {string} root
 * @return {string[]}
 */
export function listTraceFiles(root) {
    const out = [];
    walkBuckets(root, (dir) => listTraces(dir, out));
    return out;
}
