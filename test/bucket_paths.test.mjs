import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    bucketKey,
    bucketRelPath,
    listTraceFiles,
    countBuckets,
    shardedHashParts,
} from '../src/bucket_paths.mjs';

describe('bucket paths', () => {
    it('shards by first codehash byte, then rest, then selector', () => {
        const hash = 'ab'.repeat(32);
        assert.deepEqual(shardedHashParts('0x' + hash), {
            prefix: 'ab',
            rest: hash.slice(2),
            hash,
        });
        assert.equal(
            bucketKey('0xAABB'.padEnd(66, '0'), '0xac9650d8'),
            'aabb'.padEnd(64, '0') + '_ac9650d8',
        );
        assert.equal(
            bucketRelPath('0x' + hash, '0xac9650d8'),
            path.join('ab', hash.slice(2), 'ac9650d8'),
        );
        assert.equal(
            bucketRelPath('0x' + 'cd'.repeat(32), '0x'),
            path.join('cd', 'cd'.repeat(32).slice(2), 'fallback'),
        );
    });

    it('lists sharded traces and ignores _sim siblings', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buckets-'));
        const hash = '11'.repeat(32);
        const tx = '0x' + '22'.repeat(32);
        const dir = path.join(root, hash.slice(0, 2), hash.slice(2), 'ac9650d8');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${tx}.json`), '{}');
        fs.writeFileSync(path.join(dir, `${tx}_sim.json`), '{}');

        const files = listTraceFiles(root);
        assert.deepEqual(files, [path.join(dir, `${tx}.json`)]);
        const counts = countBuckets(root);
        assert.equal(counts.get(`${hash}_ac9650d8`), 1);
        fs.rmSync(root, { recursive: true, force: true });
    });
});
