// Converts observed SLOAD/SSTORE slots into an access list, attaches each
// account's codeHash, and appends a separate entry for a resolved proxy
// implementation when one can be identified.

export const EMPTY_CODE_HASH = '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470';
const ZERO_HASH = '0x0000000000000000000000000000000000000000000000000000000000000000';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// Slot -> role. 'admin' is a proxy signal but never the implementation.
const WELL_KNOWN_SLOTS = {
    '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc': 'impl',   // ERC-1967
    '0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7': 'impl',   // EIP-1822 keccak("PROXIABLE")
    '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3': 'impl',   // ZeppelinOS legacy
    '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50': 'beacon', // ERC-1967 beacon
    '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103': 'admin',  // ERC-1967 admin
};

// codeHash -> slot that holds the implementation. '$SELF' = pad32(address(this)).
const PROXY_CODE_HASHES = {
    '0x9999daa94896b1dc51734d94c68aec28587d45e0584a50b319cb99b1f335d99b': ZERO_HASH, // Safe Proxy 1.0.0
    '0xaea7d4252f6245f301e540cfbee27d3a88de543af8e49c5c62405d5499fab7e5': ZERO_HASH, // Safe Proxy 1.1.1
    '0x958a485acd4eff0908ba6c67238d33eedec70bc99115074ad38ae14d1017f9db': ZERO_HASH, // Safe Proxy 1.2.0
    '0xb89c1b3bdf2cf8827818646bce9a8f6e372885f8c55e5c07acbd307cb133b000': ZERO_HASH, // GnosisSafeProxy 1.3.0
    '0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c': ZERO_HASH, // SafeProxy 1.4.1
    '0xaaa52c8cc8a0e3fd27ce756cc6b4e70c51423e9b597b11f32d3e49f8b1fc890d':            // Solady ERC1967 clone
        '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
    '0x771e1ad5fc284d0da3ced60ad4292363de1684603e73431c5ba697eb60ec27c6': '$SELF',   // Sequence v1 Wallet
};

/**
 * Normalize a hex quantity or 32-byte word to `0x` + 64 hex chars.
 *
 * @param {string|number|bigint|null|undefined} h
 * @return {string|null}
 */
export function pad32(h) {
    if (h == null || h === '') return null;
    const s = typeof h === 'string' ? h : String(h);
    if (s === '0x') return '0x' + '0'.repeat(64);
    try {
        return '0x' + BigInt(s).toString(16).padStart(64, '0');
    } catch {
        return null;
    }
}

/**
 * Merge sload + sstore into one slot list. First seen value wins so a later
 * SSTORE (e.g. a same-tx proxy upgrade) does not rewrite the implementation
 * used during execution.
 *
 * @param {Array<{addr:string, slot:string, value?:string}>} sload
 * @param {Array<{addr:string, slot:string, value?:string}>} sstore
 * @return {Array<{addr:string, slot:string, value?:string}>}
 */
export function collectTraceSlots(sload, sstore) {
    return [...(sload || []), ...(sstore || [])];
}

/**
 * Drop collector-only fields so the entry matches ETH_SIMULATION_ACCESS_ENTRY.
 *
 * @param {Array<object>|null|undefined} list
 * @return {Array<{address:string, storageKeys:string[], codeHash?:string}>|undefined}
 */
export function stripAccessListForSim(list) {
    if (!list || !list.length) return undefined;
    return list.map((e) => {
        const out = {
            address: e.address,
            storageKeys: e.storageKeys || [],
        };
        if (e.codeHash) out.codeHash = e.codeHash;
        return out;
    });
}

/**
 * @param {Array<{addr:string, slot:string, value?:string}>} sloads
 * @param {object} opts
 * @param {(method:string, params:any[]) => Promise<any>} opts.rpc
 * @param {string|number} [opts.blockTag]            Block used for proofs (default 'latest')
 * @param {Map<string,string>} [opts.codeHashCache]  addr -> codeHash, survives calls
 * @param {Map<string,object|null>} [opts.codeCache] codeHash -> minimal-proxy hit (never raw bytecode)
 * @param {boolean} [opts.fetchCode]                 eth_getCode for EIP-1167/7702
 * @param {number} [opts.maxDepth]                   Proxy chain depth (default 3)
 * @param {string[]} [opts.addresses]                extra accounts to include (no invented slots)
 */
export async function sloadsToAccessList(sloads, opts) {
    if (!opts || typeof opts.rpc !== 'function') throw new Error('sloadsToAccessList: opts.rpc is required');
    const rpc = opts.rpc;
    const blockTag = opts.blockTag ?? 'latest';
    const codeHashCache = opts.codeHashCache ?? new Map();
    const codeCache = opts.codeCache ?? new Map();
    const maxDepth = opts.maxDepth ?? 3;

    const entries = new Map();
    const values = new Map();

    for (const s of sloads || []) {
        if (!s || !s.addr || s.slot == null) continue;
        const addr = s.addr.toLowerCase();
        const slot = pad32(s.slot);
        if (!slot) continue;
        let e = entries.get(addr);
        if (!e) {
            e = { address: addr, storageKeys: new Set(), codeHash: null, depth: 0, via: null };
            entries.set(addr, e);
        }
        e.storageKeys.add(slot);
        const key = addr + ':' + slot;
        if (!values.has(key)) {
            const v = pad32(s.value);
            if (v) values.set(key, v);
        }
    }

    for (const extra of opts.addresses || []) {
        if (!extra) continue;
        const addr = extra.toLowerCase();
        if (!entries.has(addr)) {
            entries.set(addr, { address: addr, storageKeys: new Set(), codeHash: null, depth: 0, via: null });
        }
    }

    const queue = [...entries.keys()];

    while (queue.length) {
        const addr = queue.shift();
        const e = entries.get(addr);

        let codeHash = codeHashCache.get(addr);
        if (codeHash) codeHash = codeHash.toLowerCase();
        if (!codeHash) {
            try {
                const proof = await rpc('eth_getProof', [addr, [], blockTag]);
                const raw = proof && proof.codeHash;
                if (raw) {
                    codeHash = String(raw).toLowerCase();
                    codeHashCache.set(addr, codeHash);
                }
            } catch {
                codeHash = null;
            }
        }
        e.codeHash = codeHash || null;

        if (!codeHash || codeHash === EMPTY_CODE_HASH || codeHash === ZERO_HASH) continue;
        if (e.depth >= maxDepth) continue;

        let implSlot = null;
        let kind = null;
        let target = null;

        const knownSlot = PROXY_CODE_HASHES[codeHash];
        if (knownSlot) {
            implSlot = knownSlot === '$SELF' ? pad32(addr) : knownSlot;
            kind = 'codehash';
        }

        if (!implSlot) {
            for (const slot of e.storageKeys) {
                const role = WELL_KNOWN_SLOTS[slot];
                if (role === 'impl') { implSlot = slot; kind = 'slot'; break; }
                if (role === 'beacon') { implSlot = slot; kind = 'beacon'; }
            }
        }

        if (!implSlot && e.via === 'beacon') {
            for (const slot of e.storageKeys) {
                const v = values.get(addr + ':' + slot);
                if (v && v.slice(2, 26) === '000000000000000000000000' && v.slice(26) !== ZERO_ADDRESS.slice(2)) {
                    implSlot = slot;
                    kind = 'beacon-impl';
                    break;
                }
            }
        }

        if (!implSlot && opts.fetchCode) {
            let hit = codeCache.get(codeHash);
            if (hit === undefined) {
                try {
                    hit = detectMinimalProxy(await rpc('eth_getCode', [addr, blockTag]));
                } catch {
                    hit = null;
                }
                codeCache.set(codeHash, hit);
            }
            if (hit) {
                target = hit.target;
                kind = hit.kind;
            }
        }

        if (implSlot && !target) {
            let value = values.get(addr + ':' + implSlot);
            if (value === undefined) {
                try {
                    const proof = await rpc('eth_getProof', [addr, [implSlot], blockTag]);
                    const raw = proof && proof.storageProof && proof.storageProof[0] && proof.storageProof[0].value;
                    value = pad32(raw);
                    if (value) values.set(addr + ':' + implSlot, value);
                } catch {
                    value = null;
                }
            }
            e.storageKeys.add(implSlot);

            if (!value || value.slice(2, 26) !== '000000000000000000000000') continue;
            target = '0x' + value.slice(26);
        }

        if (!target || target === ZERO_ADDRESS) continue;
        target = target.toLowerCase();

        let t = entries.get(target);
        if (!t) {
            t = {
                address: target,
                storageKeys: new Set(),
                codeHash: null,
                depth: e.depth + 1,
                via: kind === 'beacon' ? 'beacon' : 'impl',
            };
            entries.set(target, t);
            queue.push(target);
        }
        e.implementation = target;
        e.proxyKind = kind;
    }

    return [...entries.values()].map((e) => ({
        address: e.address,
        storageKeys: [...e.storageKeys].sort(),
        codeHash: e.codeHash,
        ...(e.implementation ? { implementation: e.implementation, proxyKind: e.proxyKind } : {}),
    }));
}

/**
 * EIP-1167 / EIP-7702 only. Full bytecode is never cached — on a long-running
 * collector that would retain every unique contract in RAM.
 *
 * @param {string|null|undefined} code
 * @return {{kind:string, target:string}|null}
 */
export function detectMinimalProxy(code) {
    const c = String(code || '0x').toLowerCase();
    if (c.startsWith('0xef0100') && c.length === 2 + 46) {
        return { kind: 'eip7702', target: '0x' + c.slice(8) };
    }
    if (c.startsWith('0x363d3d373d3d3d363d73') && c.endsWith('5af43d82803e903d91602b57fd5bf3')) {
        return { kind: 'eip1167', target: '0x' + c.slice(22, 62) };
    }
    return null;
}
