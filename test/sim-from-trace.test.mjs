import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { traceToSimulation, toQuantity, extractRevertData, txParamsFromMeta } from '../src/sim-from-trace.mjs';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const FROM = '0x3610bad33aac567d2c5fb03e47eec5c2172fd42a';
const TO = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';

describe('toQuantity', () => {
    it('strips leading zeros', () => {
        assert.equal(toQuantity('0x00afee'), '0xafee');
        assert.equal(toQuantity('0x0'), '0x0');
        assert.equal(toQuantity(null), '0x0');
    });
});

describe('extractRevertData', () => {
    it('unwraps geth and nested error.data', () => {
        assert.equal(extractRevertData({ data: '0x08c379a0ab' }), '0x08c379a0ab');
        assert.equal(extractRevertData({ data: { data: '0x08c379a0cd' } }), '0x08c379a0cd');
        assert.equal(extractRevertData({ message: 'reverted' }), null);
    });
});

describe('traceToSimulation', () => {
    it('decodes Transfer, maps storage + slotSource, flattens calls, strips extra accessList fields', () => {
        const slot = '0x0242ace4aee0b852ee20a6dadbb8dd2f699da3c4f840b14304b45ac861c0b6c5';
        const preimage = '0x' + FROM.slice(2).padStart(64, '0') + '3'.padStart(64, '0');
        const sim = traceToSimulation({
            meta: { from: FROM, to: TO, value: '0x16345785d8a0000', input: '0xd0e30db0' },
            receipt: {
                status: '0x1',
                gasUsed: '0xafee',
                logs: [{
                    address: TO,
                    topics: [
                        TRANSFER_TOPIC,
                        '0x0000000000000000000000003610bad33aac567d2c5fb03e47eec5c2172fd42a',
                        '0x000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
                    ],
                    data: '0x000000000000000000000000000000000000000000000000016345785d8a0000',
                }],
            },
            trace: {
                output: '0x',
                keccak: [{ addr: TO, input: preimage, hash: slot }],
                sload: [{ addr: TO, slot, value: '0x' + '0'.repeat(64) }],
                sstore: [{ addr: TO, slot, value: '0x000000000000000000000000000000000000000000000000016345785d8a0000' }],
                call: {
                    type: 'CALL', from: FROM, to: TO, gas: '0x989680', gasUsed: '0xafee',
                    input: '0xd0e30db0', output: '0x', value: '0x16345785d8a0000',
                    calls: [{
                        type: 'STATICCALL', from: TO, to: FROM, gas: '0x100', gasUsed: '0x10',
                        input: '0x', output: '0x', value: '0x0',
                    }],
                },
            },
            accessList: [{
                address: TO, storageKeys: [slot],
                codeHash: '0xd0a06b12ac47863b5c7be4185c2deaad1c61557033f56c7d4ea74429cbb25e23',
                implementation: FROM, proxyKind: 'slot',
            }],
        });

        assert.equal(sim.gasUsed, '0xafee');
        assert.equal(sim.status, '0x1');
        assert.equal(sim.returnValue, '0x');
        assert.equal(sim.logs[0].name, 'Transfer');
        assert.equal(sim.logs[0].inputs[2].value, '0x16345785d8a0000');
        assert.equal(sim.stateChanges[0].storage[0].slotSource, preimage);
        assert.equal(sim.trace.length, 2);
        assert.deepEqual(sim.trace[1].traceAddress, [0]);
        assert.equal(sim.trace[0].subtraces, '0x1');
        assert.equal(sim.accessList[0].codeHash.startsWith('0xd0a0'), true);
        assert.equal(sim.accessList[0].implementation, undefined);
        // Written slot is already covered by stateChanges; the explainer's
        // resolveAllReads skips it, so sim-from-trace must not emit it as a read.
        assert.equal(sim.accessList[0].storage, undefined);
        assert.equal(sim.positions, undefined);
    });

    it('synthesizes a top-level CALL when the tracer left no call tree', () => {
        const sim = traceToSimulation({
            meta: { from: FROM, to: TO, value: '0x0', input: '0x06fdde03' },
            receipt: { status: '0x1', gasUsed: '0x5248', logs: [] },
            trace: { keccak: [], sload: [], sstore: [], output: '0xdead' },
        });
        assert.equal(sim.returnValue, '0xdead');
        assert.equal(sim.trace[0].type, 'CALL');
        assert.equal(sim.trace[0].output, '0xdead');
        assert.deepEqual(sim.trace[0].traceAddress, []);
        assert.equal(sim.positions, undefined);
    });

    it('attaches read-only storage entries with slotSource and omits written slots', () => {
        const slotWrite = '0x0242ace4aee0b852ee20a6dadbb8dd2f699da3c4f840b14304b45ac861c0b6c5';
        const slotRead = '0xa08dc240ddc2d3b981baedd3800a57d375010fcc8b286eb8129362de427289d8';
        const preimage = '0x' + FROM.slice(2).padStart(64, '0') + '3'.padStart(64, '0');
        const readValue = '0x' + '0'.repeat(63) + '7';
        const sim = traceToSimulation({
            meta: { from: FROM, to: TO, value: '0x0', input: '0x095ea7b3' },
            receipt: { status: '0x1', gasUsed: '0x1', logs: [] },
            trace: {
                output: '0x',
                keccak: [{ addr: TO, input: preimage, hash: slotRead }],
                // First SLOAD wins for pre-state; a later SLOAD of the same slot
                // must not overwrite the recorded value.
                sload: [
                    { addr: TO, slot: slotRead, value: readValue },
                    { addr: TO, slot: slotRead, value: '0x' + '0'.repeat(63) + '9' },
                    { addr: TO, slot: slotWrite, value: '0x' + '0'.repeat(64) },
                ],
                sstore: [{ addr: TO, slot: slotWrite, value: '0x' + '0'.repeat(63) + '1' }],
            },
            // storageKeys are given in reverse order to prove the output
            // follows storageKeys, not SLOAD insertion order.
            accessList: [{
                address: TO,
                storageKeys: [slotWrite, slotRead],
                codeHash: '0xd0a06b12ac47863b5c7be4185c2deaad1c61557033f56c7d4ea74429cbb25e23',
            }],
        });

        const storage = sim.accessList[0].storage;
        assert.equal(Array.isArray(storage), true);
        assert.equal(storage.length, 1);
        assert.equal(storage[0].slot, slotRead);
        assert.equal(storage[0].value, readValue);
        assert.equal(storage[0].slotSource, preimage);
    });

    it('emits deduped, sorted positions and keeps the implementation code address', () => {
        const IMPL = '0x1111111111111111111111111111111111111111';
        const sim = traceToSimulation({
            meta: { from: FROM, to: TO, value: '0x0', input: '0x' },
            receipt: { status: '0x1', gasUsed: '0x1', logs: [] },
            trace: {
                output: '0x',
                keccak: [],
                sload: [],
                sstore: [],
                jumpdest: [
                    { addr: TO, pcs: ['0x10', '0x1', '0x1', '0xa'] },
                    { addr: IMPL, pcs: ['0x20'] },
                ],
            },
        });

        assert.deepEqual(sim.positions, [
            { address: TO.toLowerCase(), pcs: ['0x1', '0xa', '0x10'] },
            { address: IMPL.toLowerCase(), pcs: ['0x20'] },
        ]);
    });

    it('tolerates numeric PCs and drops empty jumpdest entries', () => {
        const sim = traceToSimulation({
            meta: { from: FROM, to: TO, value: '0x0', input: '0x' },
            receipt: { status: '0x1', gasUsed: '0x1', logs: [] },
            trace: {
                output: '0x',
                keccak: [],
                sload: [],
                sstore: [],
                jumpdest: [
                    { addr: TO, pcs: [5, 1, 5, 3] },
                    { addr: '0x2222222222222222222222222222222222222222', pcs: [] },
                ],
            },
        });

        assert.equal(sim.positions.length, 1);
        assert.deepEqual(sim.positions[0], { address: TO.toLowerCase(), pcs: ['0x1', '0x3', '0x5'] });
    });
});

describe('txParamsFromMeta', () => {
    it('maps collector meta onto explainer TxParams', () => {
        assert.deepEqual(txParamsFromMeta({ to: TO, from: FROM, value: '0x1', input: '0xabc' }), {
            to: TO, from: FROM, value: '0x1', data: '0xabc',
        });
    });
});
