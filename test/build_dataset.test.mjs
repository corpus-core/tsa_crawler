import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    parseArgs,
    parseStages,
    resolveConfig,
    isRegenTarget,
    selectRegenTargets,
    main,
    HELP,
    DEFAULT_STAGES,
} from '../src/build_dataset.mjs';
import { promptSha256, writeResponseEntry, responsePathForPrompt } from '../src/gen_responses.mjs';
import { sha256Hex, writeValidationEntry } from '../src/validate_responses.mjs';
import { readValidation } from '../src/query.mjs';

const METHOD = 'a9059cbb';
const TX_A = '0x' + 'aa'.repeat(32);
const HASH_A = '11'.repeat(32);
const SYS = 'sys-simple';
const USER = '## Transaction Overview\n- Status: SUCCESS\n- Function: transfer(to=0x1, amount=1)\n- Gas used: 21,000\n';

function writePrompt(root, user = USER) {
    const dir = path.join(root, HASH_A.slice(0, 2), HASH_A.slice(2), METHOD);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${TX_A}_prompt.json`);
    fs.writeFileSync(file, JSON.stringify([
        { style: 'simple', systemPrompt: SYS, userPrompt: user },
        { style: 'detailed', systemPrompt: 'sys-detailed', userPrompt: user },
    ]));
    return file;
}

function teacherResponse(content) {
    return {
        ok: true, status: 200,
        async json() {
            return {
                id: 'req',
                choices: [{ finish_reason: 'stop', message: { content } }],
                usage: { prompt_tokens: 10, completion_tokens: 4 },
            };
        },
        async text() { return ''; },
    };
}

function capture() {
    process.exitCode = undefined;
    const logs = [], errors = [];
    return { logs, errors, io: { log: (m) => logs.push(m), error: (m) => errors.push(m) } };
}

describe('parseArgs / resolveConfig', () => {
    it('parses flags and rejects unknowns', () => {
        assert.deepEqual(parseArgs([]), { dryRun: false, help: false });
        assert.equal(parseArgs(['--dry-run']).dryRun, true);
        assert.equal(parseArgs(['-h']).help, true);
        assert.throws(() => parseArgs(['--out']), /unknown flag/);
    });

    it('defaults stages, paths, sticky and the export gates', () => {
        assert.deepEqual(parseStages(undefined), [...DEFAULT_STAGES]);
        assert.deepEqual(parseStages('export,gen'), ['gen', 'export']);
        assert.throws(() => parseStages('nope'), /unknown stage/);
        assert.throws(() => parseStages(','), /empty/);
        const cfg = resolveConfig({ DATA_DIR: '/data/traces' }, {});
        assert.equal(cfg.trainDir, '/data/traces/train');
        assert.equal(cfg.datasetOut, '/data/traces/train/dataset');
        assert.equal(cfg.requireResolved, 'tx,events');
        assert.equal(cfg.sticky, '1');
        assert.equal(cfg.minGroundingRatio, '0.7');
        assert.equal(cfg.requireValidation, '1');
        assert.equal(cfg.maxUserChars, '60000');
        assert.equal(cfg.regenRounds, 1);
        const off = resolveConfig({
            DATA_DIR: '/t', TRAIN_DIR: '/keep', DATASET_OUT: '/out',
            REQUIRE_RESOLVED: '', STICKY: '0', MIN_GROUNDING_RATIO: '0', REQUIRE_VALIDATION: '0',
            MAX_USER_CHARS: '', REGEN_ROUNDS: '0', STAGES: 'dedup',
        }, { dryRun: true });
        assert.equal(off.trainDir, '/keep');
        assert.equal(off.datasetOut, '/out');
        assert.equal(off.requireResolved, '');
        assert.equal(off.sticky, '0');
        assert.equal(off.minGroundingRatio, '0');
        assert.equal(off.requireValidation, '0');
        assert.equal(off.maxUserChars, '');
        assert.equal(off.regenRounds, 0);
        assert.equal(off.dryRun, true);
        assert.deepEqual(off.stages, ['dedup']);
        assert.throws(() => resolveConfig({ REGEN_ROUNDS: '-1' }), /REGEN_ROUNDS/);
    });
});

describe('isRegenTarget / selectRegenTargets', () => {
    it('redoes fail and judge=wrong, keeps warn, flawed, and stale checks', () => {
        const content = 'sent 99999';
        const sha = sha256Hex(content);
        const check = (verdict, judge) => ({ contentSha256: sha, deterministic: { verdict }, judge: judge || null });
        assert.equal(isRegenTarget(check('fail'), content), true);
        assert.equal(isRegenTarget(check('pass', { verdict: 'wrong', score: 1 }), content), true);
        assert.equal(isRegenTarget(check('warn'), content), false);
        assert.equal(isRegenTarget(check('pass', { verdict: 'flawed', score: 3 }), content), false);
        assert.equal(isRegenTarget(check('pass', { verdict: 'good', score: 5 }), content), false);
        assert.equal(isRegenTarget(check('fail'), 'different content'), false, 'stale check is not actionable');
        assert.equal(isRegenTarget(null, content), false);
    });

    let root;
    afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); root = undefined; });

    it('returns one path per tx and ignores a warn-only file', () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-'));
        const bad = writePrompt(root);
        const badContent = 'sent 99999 tokens';
        writeResponseEntry(bad, { txHash: TX_A, codehash: HASH_A, methodId: METHOD, model: 'm' }, 'simple', {
            content: badContent, finishReason: 'stop', usage: {}, promptSha256: promptSha256(SYS, USER),
        });
        writeValidationEntry(bad, { txHash: TX_A, codehash: HASH_A, methodId: METHOD }, 'simple', {
            contentSha256: sha256Hex(badContent),
            deterministic: { verdict: 'fail', numbers: { ratio: 0, total: 1, grounded: 0, unmatched: ['99999'] } },
            judge: { verdict: 'flawed', score: 3 },
        });
        assert.deepEqual(selectRegenTargets(root, ['simple']), [bad]);

        writeValidationEntry(bad, { txHash: TX_A, codehash: HASH_A, methodId: METHOD }, 'simple', {
            contentSha256: sha256Hex(badContent),
            deterministic: { verdict: 'warn', numbers: { ratio: 0.5, total: 2, grounded: 1, unmatched: ['99999'] } },
            judge: null,
        });
        assert.deepEqual(selectRegenTargets(root, ['simple']), []);
    });
});

describe('main', () => {
    let root;
    afterEach(() => {
        if (root) fs.rmSync(root, { recursive: true, force: true });
        root = undefined;
        process.exitCode = undefined;
    });

    it('help and missing DATA_DIR', async () => {
        let cap = capture();
        await main({}, ['-h'], cap.io);
        assert.equal(cap.logs[0], HELP);
        cap = capture();
        await main({}, [], cap.io);
        assert.equal(process.exitCode, 1);
        assert.match(cap.errors[0], /DATA_DIR/);
    });

    it('dry-run needs no API key and writes nothing when the keep-set does not exist yet', async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-'));
        writePrompt(root);
        const cap = capture();
        await main({ DATA_DIR: root, REQUIRE_RESOLVED: '', PROGRESS_EVERY: '0' }, ['--dry-run'], cap.io, {
            fetch: async () => { throw new Error('no network in dry-run'); },
        });
        assert.equal(process.exitCode, undefined);
        assert.equal(fs.existsSync(path.join(root, 'train')), false);
        assert.match(cap.logs.join('\n'), /skipping gen,validate,export/);
    });

    it('refuses a live run without an API key', async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-'));
        const cap = capture();
        await main({ DATA_DIR: root, STAGES: 'gen', JUDGE_SAMPLE_PCT: '0' }, [], cap.io);
        assert.equal(process.exitCode, 1);
        assert.match(cap.errors.join('\n'), /DEEPSEEK_API_KEY/);
    });

    it('generates, validates, exports, and redoes a failed answer exactly once', async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-'));
        const train = path.join(root, 'train');
        const prompt = writePrompt(train);
        const bad = 'sent 99999 tokens';
        writeResponseEntry(prompt, { txHash: TX_A, codehash: HASH_A, methodId: METHOD, model: 'm' }, 'simple', {
            content: bad, finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 },
            promptSha256: promptSha256(SYS, USER),
        });
        writeValidationEntry(prompt, { txHash: TX_A, codehash: HASH_A, methodId: METHOD }, 'simple', {
            contentSha256: sha256Hex(bad),
            deterministic: { verdict: 'fail', numbers: { ratio: 0, total: 1, grounded: 0, unmatched: ['99999'] } },
            judge: null,
        });

        let calls = 0;
        const cap = capture();
        await main({
            DATA_DIR: root,
            TRAIN_DIR: train,
            DATASET_OUT: path.join(train, 'dataset'),
            STAGES: 'gen,validate,export',
            DEEPSEEK_API_KEY: 'k',
            JUDGE_SAMPLE_PCT: '0',
            PROGRESS_EVERY: '0',
            REGEN_ROUNDS: '2',
        }, [], cap.io, {
            fetch: async () => { calls++; return teacherResponse('The transfer succeeds.'); },
            sleep: async () => {},
            now: () => 1_000,
        });
        assert.equal(process.exitCode, undefined, cap.errors.join('\n'));
        assert.equal(calls, 1, 'the fresh bad answer is skipped, then generated once');
        const response = JSON.parse(fs.readFileSync(responsePathForPrompt(prompt), 'utf8'));
        assert.equal(response.responses.simple.content, 'The transfer succeeds.');
        assert.equal(readValidation(prompt).checks.simple.deterministic.verdict, 'pass');
        assert.match(cap.logs.join('\n'), /regen round 1: 1 tx/);
        assert.match(cap.logs.join('\n'), /regen round 2: nothing to redo/);
        assert.match(cap.logs.join('\n'), /regenerated=1/);
        const rows = fs.readFileSync(path.join(train, 'dataset', 'train.jsonl'), 'utf8').trim().split('\n');
        assert.equal(rows.length, 1);
        const row = JSON.parse(rows[0]);
        assert.equal(row.messages[2].content, 'The transfer succeeds.');
        assert.equal(row.meta.validation.grounding_verdict, 'pass');
    });

    it('a dedup failure stops the pipeline before any API call', async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-'));
        let calls = 0;
        const cap = capture();
        await main({
            DATA_DIR: root, DEEPSEEK_API_KEY: 'k', CAP: '0', PROGRESS_EVERY: '0',
        }, [], cap.io, { fetch: async () => { calls++; return teacherResponse('x'); } });
        assert.equal(process.exitCode, 1);
        assert.equal(calls, 0);
        assert.match(cap.errors.join('\n'), /stage dedup failed/);
        assert.equal(cap.logs.join('\n').includes('=== gen ==='), false);
    });
});
