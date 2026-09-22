import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripPromPrefix, writePromSection } from '../src/prom_file.mjs';
import { formatMetrics as dedupMetrics, writeMetrics as writeDedup } from '../src/dedup.mjs';
import { formatMetrics as genMetrics, writeMetrics as writeGen } from '../src/gen_responses.mjs';

describe('writePromSection', () => {
    it('replaces one prefix and keeps the other', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prom-'));
        const prom = path.join(dir, 'm.prom');
        try {
            writeDedup(prom, {
                scanned: 10, skippedNocode: 1, skippedBad: 0, clusters: 2,
                kept: 4, dropped: 6, cap: 3, copied: 4, copiedSim: 4,
                lastRunTs: 10, dryRun: false,
            });
            writeGen(prom, {
                ok: 2, skipped: 8, failed: 0, tokensIn: 100, tokensOut: 40,
                cacheHit: 10, cacheMiss: 90, lastRunTs: 11,
            }, { chain: 'mainnet' });
            let body = fs.readFileSync(prom, 'utf8');
            assert.match(body, /trace_dedup_scanned\{chain="mainnet"\} 10/);
            assert.match(body, /trace_gen_ok\{chain="mainnet"\} 2/);
            assert.equal(fs.existsSync(prom + '.tmp'), false);

            writeDedup(prom, {
                scanned: 11, skippedNocode: 1, skippedBad: 0, clusters: 2,
                kept: 4, dropped: 7, cap: 3, copied: 4, copiedSim: 4,
                lastRunTs: 12, dryRun: false,
            });
            body = fs.readFileSync(prom, 'utf8');
            assert.match(body, /trace_dedup_scanned\{chain="mainnet"\} 11/);
            assert.equal(body.includes('trace_dedup_scanned{chain="mainnet"} 10'), false);
            assert.match(body, /trace_gen_ok\{chain="mainnet"\} 2/);
            assert.equal(body.endsWith('\n'), true);
            assert.equal(stripPromPrefix(body, 'trace_gen_').includes('trace_gen_'), false);
            assert.match(dedupMetrics({
                scanned: 1, skippedNocode: 0, skippedBad: 0, clusters: 1,
                kept: 1, dropped: 0, cap: 1, copied: 1, lastRunTs: 1,
            }), /trace_dedup_scanned/);
            assert.match(genMetrics({
                ok: 1, skipped: 0, failed: 0, tokensIn: 1, tokensOut: 1,
                cacheHit: 0, cacheMiss: 1, planned: 3, dryRun: true, lastRunTs: 1,
            }), /trace_gen_planned\{chain="mainnet"\} 3/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('is a no-op without a path and reports a write error', () => {
        writePromSection('', 'trace_gen_ok{chain="mainnet"} 1\n', 'trace_gen_');
        const errors = [];
        writePromSection('/no/such/dir/metrics.prom', 'trace_gen_ok{chain="mainnet"} 1\n', 'trace_gen_', {
            onError: (msg) => errors.push(msg),
        });
        assert.equal(errors.length, 1);
        assert.match(errors[0], /metrics-error/);
    });
});
