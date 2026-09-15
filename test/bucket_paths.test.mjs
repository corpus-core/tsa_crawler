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
    LEGACY_BUCKET_RE,
    shardedHashParts,
} from '../bucket_paths.mjs';

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

    it('matches legacy directory names', () => {
        const name = 'a'.repeat(64) + '_ac9650d8';
        assert.match(name, LEGACY_BUCKET_RE);
        assert.equal(name.match(LEGACY_BUCKET_RE)[2], 'ac9650d8');
    });

    it('lists sharded, two-level, and legacy traces', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buckets-'));
        const hash = '11'.repeat(32);
        const tx = '0x' + '22'.repeat(32);
        fs.mkdirSync(path.join(root, hash.slice(0, 2), hash.slice(2), 'ac9650d8'), { recursive: true });
        fs.writeFileSync(path.join(root, hash.slice(0, 2), hash.slice(2), 'ac9650d8', `${tx}.json`), '{}');
        fs.writeFileSync(path.join(root, hash.slice(0, 2), hash.slice(2), 'ac9650d8', `${tx}_sim.json`), '{}');

        const twoLevelHash = 'aa'.repeat(32);
        fs.mkdirSync(path.join(root, twoLevelHash, 'deadbeef'), { recursive: true });
        fs.writeFileSync(path.join(root, twoLevelHash, 'deadbeef', `${tx}.json`), '{}');

        const legacy = path.join(root, '33'.repeat(32) + '_cafebabe');
        fs.mkdirSync(legacy);
        fs.writeFileSync(path.join(legacy, `${tx}.json`), '{}');

        const files = listTraceFiles(root);
        assert.equal(files.length, 3);
        const counts = countBuckets(root);
        assert.equal(counts.get(`${hash}_ac9650d8`), 1);
        assert.equal(counts.get(`${twoLevelHash}_deadbeef`), 1);
        assert.equal(counts.get(`${'33'.repeat(32)}_cafebabe`), 1);
        fs.rmSync(root, { recursive: true, force: true });
    });
});
