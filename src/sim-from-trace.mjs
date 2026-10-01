// Convert a stored collector trace into the JSON shape of
// colibri_simulateTransaction (ETH_SIMULATION_RESULT / SSZ dump).

import { pad32, stripAccessListForSim } from './proxy_accesslist.mjs';

const KNOWN_CALL_TYPES = new Set(['CALL', 'DELEGATECALL', 'CALLCODE', 'STATICCALL', 'CREATE', 'CREATE2']);
const ZERO_WORD = '0x' + '0'.repeat(64);

const KNOWN_EVENTS = [
    {
        hash: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
        name: 'Transfer', expectedTopics: 3,
        params: [
            { name: 'from', type: 'address', indexed: true },
            { name: 'to', type: 'address', indexed: true },
            { name: 'value', type: 'uint256', indexed: false },
        ],
    },
    {
        hash: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
        name: 'Transfer', expectedTopics: 4,
        params: [
            { name: 'from', type: 'address', indexed: true },
            { name: 'to', type: 'address', indexed: true },
            { name: 'tokenId', type: 'uint256', indexed: true },
        ],
    },
    {
        hash: '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925',
        name: 'Approval', expectedTopics: 3,
        params: [
            { name: 'owner', type: 'address', indexed: true },
            { name: 'spender', type: 'address', indexed: true },
            { name: 'value', type: 'uint256', indexed: false },
        ],
    },
    {
        hash: '0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f',
        name: 'Mint', expectedTopics: 2,
        params: [
            { name: 'sender', type: 'address', indexed: true },
            { name: 'amount0', type: 'uint256', indexed: false },
            { name: 'amount1', type: 'uint256', indexed: false },
        ],
    },
    {
        hash: '0xdccd412f0b1252819cb1fd330b93224ca42612892bb3f4f789976e6d81936496',
        name: 'Burn', expectedTopics: 3,
        params: [
            { name: 'sender', type: 'address', indexed: true },
            { name: 'amount0', type: 'uint256', indexed: false },
            { name: 'amount1', type: 'uint256', indexed: false },
            { name: 'to', type: 'address', indexed: true },
        ],
    },
    {
        hash: '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
        name: 'Swap', expectedTopics: 3,
        params: [
            { name: 'sender', type: 'address', indexed: true },
            { name: 'amount0In', type: 'uint256', indexed: false },
            { name: 'amount1In', type: 'uint256', indexed: false },
            { name: 'amount0Out', type: 'uint256', indexed: false },
            { name: 'amount1Out', type: 'uint256', indexed: false },
            { name: 'to', type: 'address', indexed: true },
        ],
    },
    {
        hash: '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1',
        name: 'Sync', expectedTopics: 1,
        params: [
            { name: 'reserve0', type: 'uint112', indexed: false },
            { name: 'reserve1', type: 'uint112', indexed: false },
        ],
    },
    {
        hash: '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c',
        name: 'Deposit', expectedTopics: 2,
        params: [
            { name: 'dst', type: 'address', indexed: true },
            { name: 'wad', type: 'uint256', indexed: false },
        ],
    },
    {
        hash: '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65',
        name: 'Withdrawal', expectedTopics: 2,
        params: [
            { name: 'src', type: 'address', indexed: true },
            { name: 'wad', type: 'uint256', indexed: false },
        ],
    },
];

/**
 * Strip leading zeros from a hex quantity (`0x%u` SSZ dump style).
 *
 * @param {string|number|null|undefined} hex
 * @return {string}
 */
export function toQuantity(hex) {
    if (hex == null || hex === '' || hex === '0x') return '0x0';
    if (typeof hex === 'number') return '0x' + hex.toString(16);
    const h = String(hex).startsWith('0x') ? String(hex).slice(2) : String(hex);
    const stripped = h.replace(/^0+/, '');
    return '0x' + (stripped || '0');
}

/**
 * Pull revert bytes out of a JSON-RPC error object.
 *
 * @param {object|string|null|undefined} err
 * @return {string|null}
 */
export function extractRevertData(err) {
    if (!err) return null;
    let data = typeof err === 'string' ? err : err.data;
    if (typeof data === 'object' && data !== null) {
        data = data.data || data.result;
    }
    if (typeof data === 'string' && data.startsWith('0x') && data.length > 2) return data;
    return null;
}

function hexBytes(hex) {
    if (!hex) return '';
    return hex.startsWith('0x') ? hex.slice(2) : hex;
}

function topicToAddress(topic) {
    const h = hexBytes(topic).padStart(64, '0');
    return '0x' + h.slice(-40).toLowerCase();
}

function wordToQuantity(wordHex) {
    return toQuantity('0x' + hexBytes(wordHex).padStart(64, '0'));
}

function formatParamValue(type, wordHex) {
    const h = hexBytes(wordHex).padStart(64, '0');
    if (type === 'bool') return parseInt(h.slice(-2), 16) ? 'true' : 'false';
    if (type === 'address') return topicToAddress(h);
    if (type.startsWith('bytes') && type.length > 5 && type[5] >= '1' && type[5] <= '9') {
        const n = Math.min(32, parseInt(type.slice(5), 10) || 0);
        return '0x' + h.slice(0, n * 2);
    }
    return wordToQuantity(h);
}

function decodeLog(log) {
    const address = (log.address || log.raw?.address || '').toLowerCase();
    const data = log.data || log.raw?.data || '0x';
    const topics = log.topics || log.raw?.topics || [];
    const raw = { address, data, topics };
    if (!topics.length) return { raw };

    const topic0 = String(topics[0]).toLowerCase();
    const event = KNOWN_EVENTS.find((e) => e.hash === topic0 && e.expectedTopics === topics.length);
    if (!event) return { raw };

    const dataHex = hexBytes(data);
    let topicIdx = 1;
    let dataOffset = 0;
    const inputs = [];
    for (const param of event.params) {
        let word;
        if (param.indexed) {
            word = topics[topicIdx++];
        } else {
            word = dataHex.slice(dataOffset, dataOffset + 64);
            dataOffset += 64;
            if (word.length < 64) return { raw };
            word = '0x' + word;
        }
        if (word == null) return { raw };
        inputs.push({ name: param.name, type: param.type, value: formatParamValue(param.type, word) });
    }
    return { name: event.name, inputs, raw };
}

function findSlotSource(keccak, slot, addr) {
    const want = (slot || '').toLowerCase();
    const matches = (keccak || []).filter((k) => k.hash && String(k.hash).toLowerCase() === want);
    const preferred = matches.find((k) => k.addr && k.addr.toLowerCase() === addr) || matches[0];
    if (!preferred || !preferred.input) return undefined;
    const bytes = hexBytes(preferred.input).length / 2;
    if (bytes > 1024) return undefined;
    return preferred.input;
}

/**
 * Index SLOAD values (first-seen pre-state wins) and SSTORE slot keys
 * (lowercase `addr:slot`). The explainer intentionally shows written slots
 * only in `stateChanges`, so writes are collected only to subtract them from
 * reads.
 *
 * @param {Array<{addr:string, slot:string, value?:string}>} sload
 * @param {Array<{addr:string, slot:string, value?:string}>} sstore
 * @return {{firstSload: Map<string,string>, written: Set<string>}}
 */
function indexSloadReads(sload, sstore) {
    const firstSload = new Map();
    for (const s of sload || []) {
        if (!s || !s.addr || s.slot == null || s.value == null) continue;
        const slot = pad32(s.slot);
        const value = pad32(s.value);
        if (!slot || !value) continue;
        const key = s.addr.toLowerCase() + ':' + slot;
        if (!firstSload.has(key)) firstSload.set(key, value);
    }
    const written = new Set();
    for (const s of sstore || []) {
        if (!s || !s.addr || s.slot == null) continue;
        const slot = pad32(s.slot);
        if (!slot) continue;
        written.add(s.addr.toLowerCase() + ':' + slot);
    }
    return { firstSload, written };
}

/**
 * Attach `storage` reads (`{ slot, value, slotSource? }`) to each access-list
 * entry. Slots that were also written stay out — those are already in
 * `stateChanges`, and the explainer's `resolveAllReads` would discard them.
 * The `storage` order follows `storageKeys`.
 *
 * @param {Array<object>|undefined} accessList  stripped list, mutated in place
 * @param {Array<object>|undefined} sload
 * @param {Array<object>|undefined} sstore
 * @param {Array<object>|undefined} keccak
 */
function attachAccessReads(accessList, sload, sstore, keccak) {
    if (!accessList || !accessList.length) return;
    const { firstSload, written } = indexSloadReads(sload, sstore);
    if (!firstSload.size) return;
    for (const entry of accessList) {
        const addr = (entry && entry.address ? String(entry.address) : '').toLowerCase();
        if (!addr) continue;
        const storage = [];
        for (const slot of entry.storageKeys || []) {
            const key = addr + ':' + slot;
            if (written.has(key)) continue;
            const value = firstSload.get(key);
            if (!value) continue;
            const read = { slot, value };
            const src = findSlotSource(keccak, slot, addr);
            if (src) read.slotSource = src;
            storage.push(read);
        }
        if (storage.length) entry.storage = storage;
    }
}

/**
 * Build `SimulationResult.positions` from the collector's `jumpdest` entries.
 * PCs are deduplicated per address, sorted ascending, and rendered as hex
 * quantities (`0x1a`). Entries without PCs are dropped.
 *
 * @param {Array<{addr:string, pcs:Array<number|string>}>|undefined} jumpdest
 * @return {Array<{address:string, pcs:string[]}>|undefined}
 */
function buildPositions(jumpdest) {
    if (!Array.isArray(jumpdest) || !jumpdest.length) return undefined;
    const out = [];
    for (const entry of jumpdest) {
        if (!entry || !entry.addr || !Array.isArray(entry.pcs)) continue;
        const seen = new Set();
        const pcs = [];
        for (const raw of entry.pcs) {
            let n;
            if (typeof raw === 'number' && Number.isFinite(raw)) n = raw;
            else if (typeof raw === 'string' && raw.length > 0) {
                const trimmed = raw.trim();
                n = trimmed.startsWith('0x') || trimmed.startsWith('0X')
                    ? Number.parseInt(trimmed.slice(2), 16)
                    : Number.parseInt(trimmed, 10);
            } else continue;
            if (!Number.isFinite(n) || n < 0 || seen.has(n)) continue;
            seen.add(n);
            pcs.push(n);
        }
        if (!pcs.length) continue;
        pcs.sort((a, b) => a - b);
        out.push({
            address: String(entry.addr).toLowerCase(),
            pcs: pcs.map((n) => '0x' + n.toString(16)),
        });
    }
    return out.length ? out : undefined;
}

function buildStateChanges(sload, sstore, keccak) {
    const firstSload = new Map();
    for (const s of sload || []) {
        if (!s || !s.addr || s.slot == null || s.value == null) continue;
        const slot = pad32(s.slot);
        const value = pad32(s.value);
        if (!slot || !value) continue;
        const key = s.addr.toLowerCase() + ':' + slot;
        if (!firstSload.has(key)) firstSload.set(key, value);
    }

    const lastSstore = new Map();
    for (const s of sstore || []) {
        if (!s || !s.addr || s.slot == null) continue;
        const slot = pad32(s.slot);
        const value = pad32(s.value);
        if (!slot || !value) continue;
        lastSstore.set(s.addr.toLowerCase() + ':' + slot, {
            addr: s.addr.toLowerCase(),
            slot,
            value,
        });
    }

    const byAddr = new Map();
    for (const { addr, slot, value } of lastSstore.values()) {
        if (!byAddr.has(addr)) byAddr.set(addr, []);
        const entry = {
            slot,
            previousValue: firstSload.get(addr + ':' + slot) || ZERO_WORD,
            newValue: value,
        };
        const src = findSlotSource(keccak, slot, addr);
        if (src) entry.slotSource = src;
        byAddr.get(addr).push(entry);
    }

    if (!byAddr.size) return undefined;
    return [...byAddr.entries()].map(([address, storage]) => ({ address, storage }));
}

function flattenCall(call, path, out) {
    if (!call || !KNOWN_CALL_TYPES.has(call.type)) return;
    const children = (call.calls || []).filter((c) => c && KNOWN_CALL_TYPES.has(c.type));
    const entry = {
        type: call.type,
        from: call.from && call.from.toLowerCase(),
        to: call.to && call.to.toLowerCase(),
        input: call.input || '0x',
        output: call.output || '0x',
        value: toQuantity(call.value || '0x0'),
        traceAddress: path,
        subtraces: toQuantity(children.length),
    };
    if (call.gas !== undefined) entry.gas = toQuantity(call.gas);
    if (call.gasUsed !== undefined) entry.gasUsed = toQuantity(call.gasUsed);
    out.push(entry);
    children.forEach((c, i) => flattenCall(c, path.concat(i), out));
}

function buildTrace(file, returnValue) {
    const meta = file.meta || {};
    const receipt = file.receipt || {};
    if (file.trace && file.trace.call && KNOWN_CALL_TYPES.has(file.trace.call.type)) {
        const out = [];
        flattenCall(file.trace.call, [], out);
        return out.length ? out : undefined;
    }
    if (!meta.to) return undefined;
    return [{
        type: 'CALL',
        from: meta.from && meta.from.toLowerCase(),
        to: meta.to.toLowerCase(),
        input: meta.input || '0x',
        output: returnValue || '0x',
        value: toQuantity(meta.value || '0x0'),
        gasUsed: receipt.gasUsed,
        traceAddress: [],
        subtraces: '0x0',
    }];
}

/**
 * Build a SimulationResult from a stored trace file object.
 *
 * @param {object} file  `{ meta, receipt, trace, accessList? }`
 * @param {object} [extra]
 * @param {string} [extra.returnValue]   overrides / fills `trace.output`
 * @param {Array<object>} [extra.accessList]  overrides file.accessList
 * @return {object}
 */
export function traceToSimulation(file, extra) {
    if (!file || typeof file !== 'object') throw new Error('traceToSimulation: file is required');
    const receipt = file.receipt || {};
    const trace = file.trace || {};
    const returnValue = extra?.returnValue ?? trace.output ?? '0x';
    const accessList = stripAccessListForSim(extra?.accessList || file.accessList);
    const logs = (receipt.logs || []).map(decodeLog);
    const result = {
        gasUsed: receipt.gasUsed || '0x0',
        logs,
        status: receipt.status || '0x0',
        returnValue,
    };
    const simTrace = buildTrace(file, returnValue);
    if (simTrace) result.trace = simTrace;
    const stateChanges = buildStateChanges(trace.sload, trace.sstore, trace.keccak);
    if (stateChanges) result.stateChanges = stateChanges;
    if (accessList) {
        attachAccessReads(accessList, trace.sload, trace.sstore, trace.keccak);
        result.accessList = accessList;
    }
    const positions = buildPositions(trace.jumpdest);
    if (positions) result.positions = positions;
    return result;
}

/**
 * TxParams for the explainer, taken from collector meta.
 *
 * @param {object} meta
 * @return {{to:string, from?:string, value?:string, data?:string}}
 */
export function txParamsFromMeta(meta) {
    if (!meta || !meta.to) throw new Error('txParamsFromMeta: meta.to is required');
    const params = { to: meta.to };
    if (meta.from) params.from = meta.from;
    if (meta.value != null) params.value = meta.value;
    if (meta.input != null) params.data = meta.input;
    return params;
}
