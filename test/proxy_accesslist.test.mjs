import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    sloadsToAccessList,
    pad32,
    collectTraceSlots,
    stripAccessListForSim,
    detectMinimalProxy,
    EMPTY_CODE_HASH,
} from '../src/proxy_accesslist.mjs';

const ERC1967_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const PROXY = '0x1111111111111111111111111111111111111111';
const IMPL = '0x2222222222222222222222222222222222222222';
const PROXY_HASH = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const IMPL_HASH = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SAFE_HASH = '0xb89c1b3bdf2cf8827818646bce9a8f6e372885f8c55e5c07acbd307cb133b000';
const MINIMAL_PROXY_CODE =
    '0x363d3d373d3d3d363d73' + IMPL.slice(2) + '5af43d82803e903d91602b57fd5bf3';

function mockRpc(handlers) {
    const calls = [];
    const rpc = async (method, params) => {
        calls.push({ method, params });
        const key = method + ':' + JSON.stringify(params);
        if (typeof handlers[key] === 'function') return handlers[key](params);
        if (handlers[key] !== undefined) return handlers[key];
        if (typeof handlers[method] === 'function') return handlers[method](params);
        if (handlers[method] !== undefined) return handlers[method];
        throw new Error('unexpected rpc ' + method + ' ' + JSON.stringify(params));
    };
    rpc.calls = calls;
    return rpc;
}

describe('pad32', () => {
    it('pads a quantity and rejects garbage', () => {
        assert.equal(pad32('0x1'), '0x' + '0'.repeat(63) + '1');
        assert.equal(pad32(null), null);
        assert.equal(pad32(''), null);
        assert.equal(pad32('not-hex'), null);
    });
});

describe('sloadsToAccessList', () => {
    it('resolves an ERC-1967 implementation from the observed slot', async () => {
        const rpc = mockRpc({
            eth_getProof: (params) => {
                const addr = params[0];
                if (addr === PROXY) return { codeHash: PROXY_HASH.toUpperCase() };
                if (addr === IMPL) return { codeHash: IMPL_HASH };
                throw new Error('unexpected addr ' + addr);
            },
        });
        const list = await sloadsToAccessList([
            { addr: PROXY, slot: ERC1967_SLOT, value: pad32(IMPL) },
        ], { rpc, blockTag: '0x10', fetchCode: true });

        const proxy = list.find((e) => e.address === PROXY);
        const impl = list.find((e) => e.address === IMPL);
        assert.ok(proxy);
        assert.equal(proxy.codeHash, PROXY_HASH);
        assert.equal(proxy.implementation, IMPL);
        assert.equal(proxy.proxyKind, 'slot');
        assert.ok(proxy.storageKeys.includes(ERC1967_SLOT));
        assert.ok(impl);
        assert.equal(impl.codeHash, IMPL_HASH);
    });

    it('resolves a Safe proxy via known codeHash and slot 0', async () => {
        const rpc = mockRpc({
            eth_getProof: (params) => {
                const [addr, slots] = params;
                if (addr === PROXY && slots.length === 0) return { codeHash: SAFE_HASH };
                if (addr === PROXY && slots[0] === pad32('0x0')) {
                    return { storageProof: [{ value: IMPL }] };
                }
                if (addr === IMPL) return { codeHash: IMPL_HASH };
                throw new Error('unexpected ' + JSON.stringify(params));
            },
        });
        const list = await sloadsToAccessList([
            { addr: PROXY, slot: '0x1', value: pad32('0x0') },
        ], { rpc, blockTag: '0x10' });

        const proxy = list.find((e) => e.address === PROXY);
        assert.equal(proxy.proxyKind, 'codehash');
        assert.equal(proxy.implementation, IMPL);
        assert.ok(proxy.storageKeys.includes(pad32('0x0')));
    });

    it('resolves an EIP-1167 clone from bytecode', async () => {
        const cloneHash = '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
        const rpc = mockRpc({
            eth_getProof: (params) => {
                if (params[0] === PROXY) return { codeHash: cloneHash };
                if (params[0] === IMPL) return { codeHash: IMPL_HASH };
                throw new Error('unexpected addr');
            },
            eth_getCode: (params) => {
                if (params[0] === PROXY) return MINIMAL_PROXY_CODE;
                return '0x';
            },
        });
        const list = await sloadsToAccessList([
            { addr: PROXY, slot: '0x0', value: pad32('0x1') },
        ], { rpc, blockTag: '0x10', fetchCode: true });

        const proxy = list.find((e) => e.address === PROXY);
        assert.equal(proxy.proxyKind, 'eip1167');
        assert.equal(proxy.implementation, IMPL);
        assert.deepEqual(detectMinimalProxy(MINIMAL_PROXY_CODE), { kind: 'eip1167', target: IMPL });
        assert.equal(detectMinimalProxy('0x6080604052'), null);
    });

    it('caches a proxy hit, not raw bytecode', async () => {
        const cloneHash = '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
        const codeCache = new Map();
        const rpc = mockRpc({
            eth_getProof: (params) => {
                if (params[0] === PROXY) return { codeHash: cloneHash };
                if (params[0] === IMPL) return { codeHash: IMPL_HASH };
                throw new Error('unexpected addr');
            },
            eth_getCode: MINIMAL_PROXY_CODE,
        });
        await sloadsToAccessList(
            [{ addr: PROXY, slot: '0x0', value: pad32('0x1') }],
            { rpc, blockTag: '0x10', fetchCode: true, codeCache },
        );
        assert.deepEqual(codeCache.get(cloneHash), { kind: 'eip1167', target: IMPL });
    });

    it('includes extra addresses without inventing a storage key', async () => {
        const rpc = mockRpc({
            eth_getProof: (params) => {
                if (params[0] === PROXY) return { codeHash: PROXY_HASH };
                throw new Error('unexpected ' + params[0]);
            },
        });
        const list = await sloadsToAccessList([], {
            rpc, blockTag: '0x10', addresses: [PROXY],
        });
        assert.equal(list.length, 1);
        assert.equal(list[0].address, PROXY);
        assert.deepEqual(list[0].storageKeys, []);
        assert.equal(list[0].codeHash, PROXY_HASH);
    });

    it('reuses the codeHash cache and does not overwrite a prior sload value', async () => {
        const cache = new Map([[PROXY, PROXY_HASH]]);
        const rpc = mockRpc({
            eth_getProof: (params) => {
                if (params[0] === IMPL) return { codeHash: IMPL_HASH };
                throw new Error('proxy must come from cache');
            },
        });
        const slots = collectTraceSlots(
            [{ addr: PROXY, slot: ERC1967_SLOT, value: pad32(IMPL) }],
            [{ addr: PROXY, slot: ERC1967_SLOT, value: pad32('0x3333333333333333333333333333333333333333') }],
        );
        const list = await sloadsToAccessList(slots, { rpc, blockTag: '0x10', codeHashCache: cache });
        const proxy = list.find((e) => e.address === PROXY);
        assert.equal(proxy.implementation, IMPL);
        assert.equal(rpc.calls.filter((c) => c.params[0] === PROXY).length, 0);
    });
});

describe('stripAccessListForSim', () => {
    it('drops implementation and proxyKind', () => {
        const stripped = stripAccessListForSim([
            { address: PROXY, storageKeys: [ERC1967_SLOT], codeHash: PROXY_HASH, implementation: IMPL, proxyKind: 'slot' },
        ]);
        assert.deepEqual(stripped, [
            { address: PROXY, storageKeys: [ERC1967_SLOT], codeHash: PROXY_HASH },
        ]);
        assert.equal(stripAccessListForSim([]), undefined);
    });
});
