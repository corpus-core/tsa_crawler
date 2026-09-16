import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    missingPrompts,
    missingPromptsOnePerNewBucket,
} from '../prepare-testdata.mjs';

const HASH_A = 'aa'.repeat(32);
const HASH_B = 'bb'.repeat(32);
const HASH_C = 'cc'.repeat(32);
const SEL = '095ea7b3';

function txhash(n) {
    return '0x' + n.toString(16).padStart(64, '0');
}

function bucketDir(root, hash) {
    return path.join(root, hash.slice(0, 2), hash.slice(2), SEL);
}

function writeTrace(dir, n, extras = {}) {
    const hash = txhash(n);
    const trace = path.join(dir, `${hash}.json`);
    fs.writeFileSync(trace, '{}');
    if (extras.sim !== false) fs.writeFileSync(path.join(dir, `${hash}_sim.json`), '{}');
    if (extras.prompt) fs.writeFileSync(path.join(dir, `${hash}_prompt.json`), '[]');
    if (extras.nosrc) fs.writeFileSync(path.join(dir, `${hash}_prompt.nosrc`), '{}\n');
    return trace;
}

function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-testdata-'));
    const dirA = bucketDir(root, HASH_A);
    const dirB = bucketDir(root, HASH_B);
    const dirC = bucketDir(root, HASH_C);
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    fs.mkdirSync(dirC, { recursive: true });
    // A: unprocessed, 3 txs with sim
    const a1 = writeTrace(dirA, 1);
    const a2 = writeTrace(dirA, 2);
    const a3 = writeTrace(dirA, 3);
    // B: already has a prompt; 2 more txs still pending
    const b1 = writeTrace(dirB, 11, { prompt: true });
    const b2 = writeTrace(dirB, 12);
    const b3 = writeTrace(dirB, 13);
    // C: already has a nosrc marker; 1 more tx pending
    const c1 = writeTrace(dirC, 21, { nosrc: true });
    const c2 = writeTrace(dirC, 22);
    return { root, a1, a2, a3, b1, b2, b3, c1, c2 };
}

describe('missingPromptsOnePerNewBucket (step 2a)', () => {
    it('picks one tx per unprocessed bucket and skips buckets with prompt/nosrc', () => {
        const { a1, a2, a3, b1, b2, b3, c1, c2 } = setup();
        const withSim = [a1, a2, a3, b1, b2, b3, c1, c2];
        assert.deepEqual(
            missingPromptsOnePerNewBucket(withSim, { force: false }),
            [a1],
        );
    });

    it('never queues two txs from the same bucket', () => {
        const { a1, a2, a3 } = setup();
        const picked = missingPromptsOnePerNewBucket([a2, a3, a1], { force: false });
        assert.equal(picked.length, 1);
        assert.equal(path.dirname(picked[0]), path.dirname(a1));
    });

    it('with force still caps at one tx per bucket', () => {
        const { a1, a2, a3, b1, b2, b3, c1, c2 } = setup();
        assert.deepEqual(
            missingPromptsOnePerNewBucket([a1, a2, a3, b1, b2, b3, c1, c2], { force: true }),
            [a1, b1, c1],
        );
    });
});

describe('missingPrompts (step 2b rest)', () => {
    it('returns every tx that still lacks prompt/nosrc', () => {
        const { a1, a2, a3, b1, b2, b3, c1, c2 } = setup();
        assert.deepEqual(
            missingPrompts([a1, a2, a3, b1, b2, b3, c1, c2], { force: false }),
            [a1, a2, a3, b2, b3, c2],
        );
    });

    it('step 2b after 2a is the remainder, including extra txs in processed buckets', () => {
        const { a1, a2, a3, b1, b2, b3, c1, c2 } = setup();
        const withSim = [a1, a2, a3, b1, b2, b3, c1, c2];
        const step2a = missingPromptsOnePerNewBucket(withSim, { force: false });
        const skip = new Set(step2a);
        const step2b = missingPrompts(withSim, { force: false }).filter((f) => !skip.has(f));
        assert.deepEqual(step2a, [a1]);
        assert.deepEqual(step2b, [a2, a3, b2, b3, c2]);
    });
});
