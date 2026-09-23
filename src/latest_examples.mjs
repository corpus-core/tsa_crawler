// Rolling list of recently prepared transactions, written at the IN root
// (`latest.json` by default) so a static server can offer them as playground
// examples. `walkBuckets` ignores a non-hex file at the root, so this is not
// a trace and the collector does not sample it.

import fs from 'node:fs';
import path from 'node:path';

const TXHASH_RE = /^0x[0-9a-fA-F]{64}$/;
const FUNCTION_RE = /^- Function: ([A-Za-z_][A-Za-z0-9_]*)/m;
const SELECTOR_RE = /^- Function selector: (0x[0-9a-fA-F]{8})/m;
const CONTRACT_RE = /\b(?:abstract\s+)?contract\s+([A-Za-z_][A-Za-z0-9_]*)\b/;
const VENDOR_RE = /openzeppelin|node_modules|solmate|forge-std/i;

let writeChain = Promise.resolve();

/**
 * Cap for the rolling list. `LATEST_LIMIT=0` turns recording off.
 *
 * @param {string|number|undefined} [raw]
 * @return {number}
 */
export function latestLimit(raw = process.env.LATEST_LIMIT) {
    if (raw == null || raw === '') return 200;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return 200;
    return Math.floor(n);
}

/**
 * Absolute path of the rolling list. A relative `LATEST_FILE` sits under `root`.
 *
 * @param {string} root
 * @param {string} [name]
 * @return {string}
 */
export function latestPath(root, name = process.env.LATEST_FILE || 'latest.json') {
    return path.isAbsolute(name) ? name : path.join(root, name);
}

/**
 * POSIX path of the sibling `_sim.json`, relative to the trace root.
 *
 * @param {string} root
 * @param {string} traceFile
 * @return {string}
 */
export function simRelPath(root, traceFile) {
    const sim = traceFile.replace(/\.json$/, '_sim.json');
    return path.relative(root, sim).split(path.sep).join('/');
}

/**
 * Transaction hash from collector `meta.txHash`, otherwise the trace filename.
 *
 * @param {object|undefined} meta
 * @param {string} traceFile
 * @return {string}
 */
export function txhashOf(meta, traceFile) {
    const fromMeta = meta && meta.txHash;
    if (typeof fromMeta === 'string' && TXHASH_RE.test(fromMeta)) return fromMeta;
    const base = path.basename(traceFile, '.json');
    return TXHASH_RE.test(base) ? base : '';
}

/**
 * Decoded function name from the simple prompt's transaction section.
 *
 * The explainer writes `- Function: name(...)` when the call decodes, and
 * `- Function selector: 0x........` otherwise. The name is the identifier
 * before `(`. A selector is returned only when no name is present.
 *
 * @param {string} userPrompt
 * @return {string}
 */
export function functionNameFromPrompt(userPrompt) {
    const section = txSection(userPrompt);
    const named = section.match(FUNCTION_RE);
    if (named) return named[1];
    const selector = section.match(SELECTOR_RE);
    return selector ? selector[1] : '';
}

/**
 * Contract name for `address` from the explainer context.
 *
 * `contractName` is used when the metadata still carries it. The current
 * explainer drops that field when it builds `ContractMetadata`, so the
 * fallback is the first `contract` declaration in a non-vendor source file
 * of that address.
 *
 * @param {Map<string, object>|undefined} contracts
 * @param {string|undefined} address
 * @return {string}
 */
export function contractNameForAddress(contracts, address) {
    if (!contracts || typeof contracts.get !== 'function' || !address) return '';
    const meta = contracts.get(String(address).toLowerCase());
    if (!meta || typeof meta !== 'object') return '';
    if (typeof meta.contractName === 'string' && meta.contractName) return meta.contractName;
    return contractNameFromSources(meta.sources);
}

/**
 * First `contract` declaration, preferring files outside vendor trees.
 *
 * @param {object|undefined} sources filename → `{ content }`
 * @return {string}
 */
export function contractNameFromSources(sources) {
    if (!sources || typeof sources !== 'object') return '';
    const names = Object.keys(sources);
    const ordered = [
        ...names.filter((name) => !VENDOR_RE.test(name)),
        ...names.filter((name) => VENDOR_RE.test(name)),
    ];
    for (const name of ordered) {
        const content = sources[name] && sources[name].content;
        if (typeof content !== 'string') continue;
        const match = content.match(CONTRACT_RE);
        if (match) return match[1];
    }
    return '';
}

/**
 * Append one example and drop the oldest entries past `limit`.
 *
 * An existing row with the same `txhash` is removed first, so a rebuilt
 * prompt moves to the end instead of appearing twice. Index 0 is the oldest.
 *
 * @param {object[]|undefined} entries
 * @param {object} entry
 * @param {number} limit
 * @return {object[]}
 */
export function pushLatest(entries, entry, limit) {
    const list = Array.isArray(entries)
        ? entries.filter((row) => row && row.txhash !== entry.txhash)
        : [];
    list.push(entry);
    const cap = limit > 0 ? limit : 0;
    while (cap >= 0 && list.length > cap) list.shift();
    return list;
}

/**
 * One playground example. `meta` is only the collector fields the playground
 * needs to rebuild a transaction; the rest of the trace file stays on disk.
 *
 * @param {object} args
 * @param {string} args.txhash
 * @param {string} args.userPrompt
 * @param {string} args.contract
 * @param {object|undefined} args.meta
 * @param {string} args.simRelPath
 * @return {{txhash:string, function:string, contract:string, meta:{from:string,to:string,input:string,value:string}, path:string}}
 */
export function exampleEntry({ txhash, userPrompt, contract, meta, simRelPath: simPath }) {
    const src = meta && typeof meta === 'object' ? meta : {};
    return {
        txhash,
        function: functionNameFromPrompt(userPrompt),
        contract: contract || '',
        meta: {
            from: typeof src.from === 'string' ? src.from : '',
            to: typeof src.to === 'string' ? src.to : '',
            input: typeof src.input === 'string' ? src.input : '',
            value: src.value == null ? '' : String(src.value),
        },
        path: simPath,
    };
}

/**
 * Record a successfully prepared transaction in the rolling list.
 *
 * Writes are serialized in-process. A missing or unreadable file starts a
 * new list. `limit <= 0` does nothing. Failures are the caller's to log;
 * this function throws on I/O errors after the prompt file is already in place.
 *
 * @param {object} args
 * @param {string} args.root trace root (`IN`)
 * @param {string} args.traceFile absolute collector trace path
 * @param {string} args.userPrompt simple-style user prompt
 * @param {Map<string, object>|undefined} args.contracts explainer context map
 * @param {object|undefined} args.meta collector `meta`
 * @param {number} [args.limit]
 * @param {string} [args.fileName]
 * @return {Promise<string|null>} written path, or null when skipped
 */
export function recordLatestExample(args) {
    const limit = args.limit == null ? latestLimit() : args.limit;
    if (limit <= 0) return Promise.resolve(null);
    const txhash = txhashOf(args.meta, args.traceFile);
    if (!txhash) return Promise.resolve(null);
    const file = latestPath(args.root, args.fileName);
    const entry = exampleEntry({
        txhash,
        userPrompt: args.userPrompt,
        contract: contractNameForAddress(args.contracts, args.meta && args.meta.to)
            || contractNameFromPrompt(args.userPrompt),
        meta: args.meta,
        simRelPath: simRelPath(args.root, args.traceFile),
    });
    return enqueue(() => {
        const next = pushLatest(readLatest(file), entry, limit);
        writeAtomic(file, next);
        return file;
    });
}

/**
 * First non-vendor `contract` declaration embedded in a user prompt.
 *
 * Used when the explainer context is no longer available (backfill from
 * `_prompt.json` already on disk). Live prepares prefer `contractName` and
 * the context sources.
 *
 * @param {string} userPrompt
 * @return {string}
 */
export function contractNameFromPrompt(userPrompt) {
    const text = String(userPrompt || '');
    const blocks = text.split('<<<C4_UNTRUSTED_SOURCE');
    for (const block of blocks.slice(1)) {
        const filename = block.match(/filename="([^"]*)"/);
        if (filename && VENDOR_RE.test(filename[1])) continue;
        const decl = block.match(CONTRACT_RE);
        if (decl) return decl[1];
    }
    return '';
}

/**
 * Fill `latest.json` from prompts already on disk until it reaches `limit`.
 *
 * Prepare skips traces that already have `_prompt.json`, so a newly deployed
 * index would stay empty. This reads the newest prompt files (by mtime),
 * oldest of that window first, and does nothing once the file is full.
 *
 * @param {string} root
 * @param {string[]} traces collector trace paths
 * @param {number} [limit]
 * @return {string|null} written path, or null when nothing was added
 */
export function backfillLatestExamples(root, traces, limit = latestLimit()) {
    if (limit <= 0) return null;
    const file = latestPath(root);
    const current = readLatest(file);
    if (current.length >= limit) return null;
    const found = [];
    for (const trace of traces) {
        const promptFile = trace.replace(/\.json$/, '_prompt.json');
        let st;
        try { st = fs.statSync(promptFile); } catch { continue; }
        found.push({ trace, promptFile, mtime: st.mtimeMs });
    }
    found.sort((a, b) => a.mtime - b.mtime);
    const have = new Set(current.map((row) => row && row.txhash));
    let list = current.slice();
    let added = 0;
    for (const item of found.slice(-limit)) {
        const meta = readTraceMeta(item.trace);
        const txhash = txhashOf(meta, item.trace);
        if (!txhash || have.has(txhash)) continue;
        const userPrompt = readSimpleUserPrompt(item.promptFile);
        list = pushLatest(list, exampleEntry({
            txhash,
            userPrompt,
            contract: contractNameFromPrompt(userPrompt),
            meta,
            simRelPath: simRelPath(root, item.trace),
        }), limit);
        have.add(txhash);
        added++;
    }
    if (!added) return null;
    writeAtomic(file, list);
    return file;
}

function readTraceMeta(traceFile) {
    try {
        const parsed = JSON.parse(fs.readFileSync(traceFile, 'utf8'));
        return parsed && typeof parsed.meta === 'object' ? parsed.meta : {};
    } catch {
        return {};
    }
}

function readSimpleUserPrompt(promptFile) {
    try {
        const parsed = JSON.parse(fs.readFileSync(promptFile, 'utf8'));
        if (!Array.isArray(parsed)) return '';
        const simple = parsed.find((row) => row && row.style === 'simple') || parsed[0];
        return simple && typeof simple.userPrompt === 'string' ? simple.userPrompt : '';
    } catch {
        return '';
    }
}

function txSection(userPrompt) {
    const text = String(userPrompt || '');
    const match = text.match(/## Transaction Overview\n([\s\S]*?)(?:\n## |$)/);
    return match ? match[1] : '';
}

function readLatest(file) {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        if (e && e.code === 'ENOENT') return [];
        return [];
    }
}

function writeAtomic(file, obj) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
    fs.renameSync(tmp, file);
}

function enqueue(task) {
    const run = writeChain.then(task, task);
    writeChain = run.then(() => { }, () => { });
    return run;
}
