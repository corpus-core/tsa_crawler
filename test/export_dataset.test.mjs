import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    parseArgs,
    resolveConfig,
    splitFraction,
    isValCodehash,
    buildDatasetRow,
    processAll,
    percentile,
    buildManifest,
    formatSummary,
    validationGate,
    main,
    SKIP_REASONS,
    TRAIN_NAME,
    VAL_NAME,
    MANIFEST_NAME,
    HELP,
    DEFAULT_VAL_RATIO,
    DEFAULT_SEED,
} from '../src/export_dataset.mjs';
import {
    promptSha256,
    responsePathForPrompt,
    writeResponseEntry,
    RESPONSE_VERSION,
} from '../src/gen_responses.mjs';
import { writeValidationEntry } from '../src/validate_responses.mjs';

const METHOD = 'a9059cbb';
const TX_A = '0x' + 'aa'.repeat(32);
const TX_B = '0x' + 'bb'.repeat(32);
const TX_C = '0x' + 'cc'.repeat(32);
const HASH_A = '11'.repeat(32);
const HASH_B = '22'.repeat(32);
const HASH_C = '33'.repeat(32);

function promptBody({ simpleUser = 'user-simple', simpleSys = 'sys-simple', detailedUser = 'user-detailed', detailedSys = 'sys-detailed' } = {}) {
    return JSON.stringify([
        { style: 'simple', systemPrompt: simpleSys, userPrompt: simpleUser },
        { style: 'detailed', systemPrompt: detailedSys, userPrompt: detailedUser },
    ]);
}

function writePrompt(root, tx, hash = HASH_A, body = promptBody()) {
    const dir = path.join(root, hash.slice(0, 2), hash.slice(2), METHOD);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${tx}_prompt.json`);
    fs.writeFileSync(file, body);
    return file;
}

function writeResponse(promptPath, style, {
    sys = 'sys-simple', usr = 'user-simple',
    content = 'answer', finishReason = 'stop', model = 'deepseek-v4-pro',
    promptTokens = 100, completionTokens = 25,
} = {}) {
    writeResponseEntry(promptPath,
        { txHash: 'x', codehash: 'y', methodId: METHOD, model },
        style,
        {
            content,
            finishReason,
            usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
            promptSha256: promptSha256(sys, usr),
        });
}

function capture() {
    process.exitCode = undefined;
    const logs = [], errors = [];
    return { logs, errors, io: { log: (m) => logs.push(m), error: (m) => errors.push(m) } };
}

describe('parseArgs / resolveConfig', () => {
    it('parses flags', () => {
        assert.deepEqual(parseArgs(['--dry-run']), { dryRun: true, help: false });
        assert.deepEqual(parseArgs(['--out', '/tmp/o']), { dryRun: false, help: false, out: '/tmp/o' });
        assert.equal(parseArgs(['-h']).help, true);
        assert.throws(() => parseArgs(['--out']), /requires a value/);
        assert.throws(() => parseArgs(['--zzz']), /unknown flag/);
    });

    it('rejects bad VAL_RATIO', () => {
        assert.throws(() => resolveConfig({ VAL_RATIO: '1.5' }), /VAL_RATIO/);
        assert.throws(() => resolveConfig({ VAL_RATIO: 'nope' }), /VAL_RATIO/);
        const cfg = resolveConfig({ VAL_RATIO: '0.1', SEED: 'x', STYLES: 'simple' });
        assert.equal(cfg.valRatio, 0.1);
        assert.equal(cfg.seed, 'x');
        assert.deepEqual(cfg.styles, ['simple']);
    });
});

describe('split', () => {
    it('splitFraction is deterministic and in [0,1)', () => {
        const a = splitFraction(HASH_A, DEFAULT_SEED);
        const b = splitFraction(HASH_A, DEFAULT_SEED);
        assert.equal(a, b);
        assert.ok(a >= 0 && a < 1);
        assert.notEqual(splitFraction(HASH_A, DEFAULT_SEED), splitFraction(HASH_B, DEFAULT_SEED));
        assert.notEqual(splitFraction(HASH_A, '1'), splitFraction(HASH_A, '2'));
    });

    it('isValCodehash is stable and honours valRatio=0', () => {
        assert.equal(isValCodehash(HASH_A, 0, DEFAULT_SEED), false);
        // With ratio 1, every hash but exactly 0 would go to val; nothing = 1.
        for (const h of [HASH_A, HASH_B, HASH_C]) {
            assert.equal(isValCodehash(h, 0, '1'), false);
        }
    });
});

describe('processAll', () => {
    let root;
    afterEach(() => {
        if (root) fs.rmSync(root, { recursive: true, force: true });
        root = undefined;
    });

    it('keeps only rows with matching hash + stop + non-empty content; counts skip reasons', () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-'));
        const goodPrompt = writePrompt(root, TX_A, HASH_A);
        writeResponse(goodPrompt, 'simple');

        const stalePrompt = writePrompt(root, TX_B, HASH_B);
        // Response built for a different userPrompt.
        writeResponse(stalePrompt, 'simple', { usr: 'wrong' });

        const badFinishPrompt = writePrompt(root, TX_C, HASH_C);
        writeResponse(badFinishPrompt, 'simple', { finishReason: 'length' });

        const missingRespPrompt = writePrompt(root, '0x' + 'dd'.repeat(32), '44'.repeat(32));
        void missingRespPrompt;

        const rows = [];
        const stats = processAll(root, { styles: ['simple'], valRatio: 0, seed: '1', teacherSystemSuffix: '' },
            (row, split) => rows.push({ row, split }));

        assert.equal(rows.length, 1);
        assert.equal(rows[0].row.messages.length, 3);
        assert.equal(rows[0].row.messages[0].role, 'system');
        assert.equal(rows[0].row.messages[1].role, 'user');
        assert.equal(rows[0].row.messages[2].role, 'assistant');
        assert.equal(rows[0].row.messages[2].content, 'answer');
        assert.equal(rows[0].row.meta.tx, TX_A);
        assert.equal(rows[0].row.meta.style, 'simple');
        assert.equal(rows[0].row.meta.method_id, METHOD);
        assert.equal(rows[0].row.meta.prompt_tokens, 100);
        assert.equal(stats.kept.train, 1);
        assert.equal(stats.kept.val, 0);
        assert.equal(stats.skipped[SKIP_REASONS.STALE_HASH], 1);
        assert.equal(stats.skipped[SKIP_REASONS.BAD_FINISH], 1);
        assert.equal(stats.skipped[SKIP_REASONS.NO_RESPONSE_FILE], 1);
        assert.equal(stats.tokens.prompt, 100);
    });

    it('teacher suffix must match generation-time suffix, otherwise stale', () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-'));
        const prompt = writePrompt(root, TX_A, HASH_A);
        writeResponse(prompt, 'simple'); // uses bare sys-simple / user-simple

        const rows = [];
        const stats = processAll(root, { styles: ['simple'], valRatio: 0, seed: '1', teacherSystemSuffix: 'suffix' },
            (r) => rows.push(r));
        assert.equal(rows.length, 0);
        assert.equal(stats.skipped[SKIP_REASONS.STALE_HASH], 1);
    });

    it('codehash-cohesive split; two txs of the same codehash never split', () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-'));
        const p1 = writePrompt(root, TX_A, HASH_A);
        const p2 = writePrompt(root, TX_B, HASH_A);
        const p3 = writePrompt(root, TX_C, HASH_B);
        writeResponse(p1, 'simple');
        writeResponse(p2, 'simple');
        writeResponse(p3, 'simple');
        // valRatio = 1 - epsilon puts every codehash in val, but the API forbids 1.
        // We use a large ratio and check same-codehash cohesion instead.
        const splits = new Map();
        processAll(root, { styles: ['simple'], valRatio: 0.5, seed: 'test-seed', teacherSystemSuffix: '' },
            (row, split) => splits.set(row.meta.tx, split));
        assert.equal(splits.size, 3);
        assert.equal(splits.get(TX_A), splits.get(TX_B), 'same codehash → same split');
    });

    it('unreadable prompt file and non-array body get counted', () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-'));
        writePrompt(root, TX_A, HASH_A, 'not json');
        writePrompt(root, TX_B, HASH_B, JSON.stringify({ not: 'array' }));
        const stats = processAll(root, { styles: ['simple'], valRatio: 0, seed: '1', teacherSystemSuffix: '' }, () => {});
        assert.equal(stats.scanned, 2);
        assert.equal(stats.skipped[SKIP_REASONS.UNREADABLE], 1);
        assert.equal(stats.skipped[SKIP_REASONS.BAD_PROMPT], 1);
    });
});

describe('buildDatasetRow / percentile / manifest', () => {
    it('row shape matches OpenAI chat messages', () => {
        const row = buildDatasetRow(
            { txHash: TX_A, codehash: HASH_A, methodId: METHOD, style: 'simple', userPrompt: 'u', systemPrompt: 's', relPath: 'a/b/c.json' },
            { content: 'C', model: 'm', usage: { prompt_tokens: 3, completion_tokens: 2 } },
            's-with-suffix',
        );
        assert.equal(row.messages[0].content, 's-with-suffix');
        assert.equal(row.messages[1].content, 'u');
        assert.equal(row.messages[2].content, 'C');
        assert.equal(row.meta.rel_path, 'a/b/c.json');
        assert.equal(row.meta.prompt_tokens, 3);
        assert.equal(row.meta.completion_tokens, 2);
        assert.equal(row.meta.model, 'm');
    });

    it('percentile handles empty and small arrays', () => {
        assert.equal(percentile([], 0.5), 0);
        assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
        assert.equal(percentile([1, 2, 3, 4, 5], 0), 1);
        assert.equal(percentile([1, 2, 3, 4, 5], 1), 5);
    });

    it('buildManifest exposes length percentiles and skip counts', () => {
        const stats = {
            scanned: 3,
            kept: { train: 2, val: 1 },
            codehashes: { train: new Set(['a']), val: new Set(['b']) },
            skipped: { [SKIP_REASONS.STALE_HASH]: 1 },
            tokens: { prompt: 10, completion: 5 },
            models: { 'deepseek-v4-pro': 3 },
            promptLengths: [10, 20, 30],
            answerLengths: [5, 15, 25],
        };
        const manifest = buildManifest(stats, { styles: ['simple'], valRatio: 0.1, seed: 'x' });
        assert.equal(manifest.version, 2);
        assert.equal(manifest.kept.train, 2);
        assert.equal(manifest.codehashes.train, 1);
        assert.equal(manifest.lengths.user_chars.p50, 20);
        assert.equal(manifest.lengths.assistant_chars.max, 25);
        // No validation stats supplied → neutral block, gates all off.
        assert.deepEqual(manifest.validation.gates, {
            requireValidation: false, minGroundingRatio: 0, minJudgeScore: 0, requireJudgePass: false,
        });
        assert.equal(manifest.validation.rowsValidated, 0);
        assert.equal(manifest.validation.groundingRatio.mean, null);
        const summary = formatSummary(manifest);
        assert.match(summary, /train rows:\s+2/);
        assert.match(summary, /stale-hash: 1/);
        assert.match(summary, /gates=none/);
    });

    it('buildManifest reports validation stats and active gates', () => {
        const stats = {
            scanned: 2, kept: { train: 2, val: 0 },
            codehashes: { train: new Set(['a']), val: new Set() },
            skipped: {}, tokens: { prompt: 0, completion: 0 }, models: {},
            promptLengths: [1, 2], answerLengths: [1, 2],
            validation: { validated: 2, judged: 1, ratios: [0.5, 1], judgeScores: { 4: 1 } },
        };
        const manifest = buildManifest(stats, {
            styles: ['simple'], valRatio: 0, seed: 'x',
            minGroundingRatio: 0.7, requireJudgePass: true,
        });
        assert.equal(manifest.validation.rowsValidated, 2);
        assert.equal(manifest.validation.rowsJudged, 1);
        assert.equal(manifest.validation.groundingRatio.mean, 0.75);
        assert.deepEqual(manifest.validation.judgeScores, { 4: 1 });
        const summary = formatSummary(manifest);
        assert.match(summary, /gates=MIN_GROUNDING_RATIO=0\.7,REQUIRE_JUDGE_PASS/);
        assert.match(summary, /judge scores:\s+4=1/);
    });

    it('row meta carries validation fields when a fresh check is given', () => {
        const check = {
            deterministic: { verdict: 'warn', numbers: { ratio: 0.75 } },
            judge: { score: 3, verdict: 'flawed' },
        };
        const row = buildDatasetRow(
            { txHash: TX_A, codehash: HASH_A, methodId: METHOD, style: 'simple', userPrompt: 'u', systemPrompt: 's', relPath: 'p' },
            { content: 'C' }, 's', check,
        );
        assert.deepEqual(row.meta.validation, {
            grounding_ratio: 0.75, grounding_verdict: 'warn', judge_score: 3, judge_verdict: 'flawed',
        });
        const bare = buildDatasetRow(
            { txHash: TX_A, codehash: HASH_A, methodId: METHOD, style: 'simple', userPrompt: 'u', systemPrompt: 's', relPath: 'p' },
            { content: 'C' }, 's',
        );
        assert.equal('validation' in bare.meta, false);
    });
});

describe('validationGate', () => {
    const off = { requireValidation: false, minGroundingRatio: 0, minJudgeScore: 0, requireJudgePass: false };
    const check = (ratio, judge) => ({
        contentSha256: 'sha',
        deterministic: { verdict: 'pass', numbers: { ratio } },
        judge: judge || null,
    });

    it('is a no-op when every gate is off', () => {
        assert.equal(validationGate(null, 'sha', off), null);
        assert.equal(validationGate(check(0.1, { score: 1, verdict: 'wrong' }), 'sha', off), null);
    });

    it('REQUIRE_VALIDATION skips missing and stale checks', () => {
        const cfg = { ...off, requireValidation: true };
        assert.equal(validationGate(null, 'sha', cfg), SKIP_REASONS.NO_VALIDATION);
        assert.equal(validationGate(check(1), 'other', cfg), SKIP_REASONS.STALE_VALIDATION);
        assert.equal(validationGate(check(1), 'sha', cfg), null);
    });

    it('MIN_GROUNDING_RATIO only bites when a fresh check exists', () => {
        const cfg = { ...off, minGroundingRatio: 0.8 };
        assert.equal(validationGate(null, 'sha', cfg), null, 'missing → pass without REQUIRE_VALIDATION');
        assert.equal(validationGate(check(0.5), 'other', cfg), null, 'stale → treated as missing');
        assert.equal(validationGate(check(0.5), 'sha', cfg), SKIP_REASONS.LOW_GROUNDING);
        assert.equal(validationGate(check(0.8), 'sha', cfg), null, 'boundary is inclusive');
    });

    it('MIN_JUDGE_SCORE ignores unjudged rows; REQUIRE_JUDGE_PASS does not', () => {
        const min = { ...off, minJudgeScore: 4 };
        assert.equal(validationGate(check(1), 'sha', min), null);
        assert.equal(validationGate(check(1, { score: 3, verdict: 'flawed' }), 'sha', min), SKIP_REASONS.LOW_JUDGE);
        assert.equal(validationGate(check(1, { score: 4, verdict: 'good' }), 'sha', min), null);
        assert.equal(validationGate(check(1, { score: null, verdict: 'unparseable' }), 'sha', min), null, 'unparseable has no score');

        const pass = { ...off, requireJudgePass: true };
        assert.equal(validationGate(null, 'sha', pass), SKIP_REASONS.NO_VALIDATION);
        assert.equal(validationGate(check(1), 'sha', pass), SKIP_REASONS.JUDGE_NOT_GOOD);
        assert.equal(validationGate(check(1, { score: 3, verdict: 'flawed' }), 'sha', pass), SKIP_REASONS.JUDGE_NOT_GOOD);
        assert.equal(validationGate(check(1, { score: 5, verdict: 'good' }), 'sha', pass), null);
    });

    it('processAll applies gates end-to-end and records skip reasons', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-'));
        try {
            const pGood = writePrompt(root, TX_A, HASH_A);
            const pLow = writePrompt(root, TX_B, HASH_B);
            const pNoVal = writePrompt(root, TX_C, HASH_C);
            writeResponse(pGood, 'simple', { content: 'good answer' });
            writeResponse(pLow, 'simple', { content: 'low answer' });
            writeResponse(pNoVal, 'simple', { content: 'unchecked' });
            const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
            writeValidationEntry(pGood, { txHash: TX_A, codehash: HASH_A, methodId: METHOD }, 'simple', {
                contentSha256: sha('good answer'),
                deterministic: { verdict: 'pass', numbers: { ratio: 1 } },
                judge: { score: 5, verdict: 'good' },
            });
            writeValidationEntry(pLow, { txHash: TX_B, codehash: HASH_B, methodId: METHOD }, 'simple', {
                contentSha256: sha('low answer'),
                deterministic: { verdict: 'fail', numbers: { ratio: 0.2 } },
                judge: null,
            });

            const base = { styles: ['simple'], valRatio: 0, seed: '1', teacherSystemSuffix: '' };
            let rows = [];
            let stats = processAll(root, { ...base, minGroundingRatio: 0.7 }, (r) => rows.push(r));
            assert.equal(rows.length, 2, 'good + unchecked pass; low skipped');
            assert.equal(stats.skipped[SKIP_REASONS.LOW_GROUNDING], 1);
            assert.equal(stats.validation.validated, 1);
            assert.equal(stats.validation.judged, 1);
            assert.deepEqual(stats.validation.judgeScores, { 5: 1 });
            const goodRow = rows.find((r) => r.meta.tx === TX_A);
            assert.equal(goodRow.meta.validation.judge_score, 5);
            assert.equal('validation' in rows.find((r) => r.meta.tx === TX_C).meta, false);

            rows = [];
            stats = processAll(root, { ...base, requireValidation: true, minGroundingRatio: 0.7 }, (r) => rows.push(r));
            assert.equal(rows.length, 1);
            assert.equal(stats.skipped[SKIP_REASONS.NO_VALIDATION], 1);
            assert.equal(stats.skipped[SKIP_REASONS.LOW_GROUNDING], 1);

            rows = [];
            stats = processAll(root, { ...base, requireJudgePass: true }, (r) => rows.push(r));
            assert.equal(rows.length, 1);
            assert.equal(rows[0].meta.tx, TX_A);
            assert.equal(stats.skipped[SKIP_REASONS.JUDGE_NOT_GOOD], 1, 'low has no judge');
            assert.equal(stats.skipped[SKIP_REASONS.NO_VALIDATION], 1);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('resolveConfig parses gate env vars and rejects out-of-range values', () => {
        const cfg = resolveConfig({ REQUIRE_VALIDATION: '1', MIN_GROUNDING_RATIO: '0.75', MIN_JUDGE_SCORE: '4', REQUIRE_JUDGE_PASS: '1' });
        assert.equal(cfg.requireValidation, true);
        assert.equal(cfg.minGroundingRatio, 0.75);
        assert.equal(cfg.minJudgeScore, 4);
        assert.equal(cfg.requireJudgePass, true);
        const def = resolveConfig({});
        assert.equal(def.requireValidation, false);
        assert.equal(def.minGroundingRatio, 0);
        assert.equal(def.minJudgeScore, 0);
        assert.equal(def.requireJudgePass, false);
        assert.throws(() => resolveConfig({ MIN_GROUNDING_RATIO: '1.5' }), /MIN_GROUNDING_RATIO/);
        assert.throws(() => resolveConfig({ MIN_JUDGE_SCORE: '6' }), /MIN_JUDGE_SCORE/);
    });
});

describe('main', () => {
    let root;
    afterEach(() => {
        if (root) fs.rmSync(root, { recursive: true, force: true });
        root = undefined;
        process.exitCode = undefined;
    });

    it('help / DATA_DIR / OUT gating', () => {
        const cap = capture();
        main({}, ['-h'], cap.io);
        assert.equal(cap.logs[0], HELP);
        const cap2 = capture();
        main({}, [], cap2.io);
        assert.equal(process.exitCode, 1);
        assert.match(cap2.errors.join('\n'), /DATA_DIR/);
        const cap3 = capture();
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-'));
        try {
            main({ DATA_DIR: tmp }, [], cap3.io);
            assert.equal(process.exitCode, 1);
            assert.match(cap3.errors.join('\n'), /OUT is not set/);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('writes train + val + manifest deterministically', () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-'));
        const prompts = [
            writePrompt(root, TX_A, HASH_A),
            writePrompt(root, TX_B, HASH_B),
            writePrompt(root, TX_C, HASH_C),
        ];
        for (const p of prompts) writeResponse(p, 'simple');
        const out = path.join(root, 'sft');
        const cap = capture();
        main({ DATA_DIR: root, OUT: out, VAL_RATIO: '0.5', SEED: 'stable-seed' }, [], cap.io);
        assert.equal(process.exitCode, undefined);
        const train = fs.readFileSync(path.join(out, TRAIN_NAME), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
        const val = fs.readFileSync(path.join(out, VAL_NAME), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
        assert.equal(train.length + val.length, 3);
        for (const row of [...train, ...val]) {
            assert.equal(row.messages.length, 3);
            assert.equal(row.messages[2].role, 'assistant');
            assert.equal(row.messages[2].content, 'answer');
        }
        const manifest = JSON.parse(fs.readFileSync(path.join(out, MANIFEST_NAME), 'utf8'));
        assert.equal(manifest.kept.train + manifest.kept.val, 3);
        assert.equal(manifest.scanned, 3);
        assert.equal(manifest.valRatio, 0.5);
        assert.equal(manifest.seed, 'stable-seed');
    });

    it('dry-run writes no files but logs a summary', () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-'));
        const prompt = writePrompt(root, TX_A, HASH_A);
        writeResponse(prompt, 'simple');
        const cap = capture();
        main({ DATA_DIR: root, VAL_RATIO: String(DEFAULT_VAL_RATIO) }, ['--dry-run'], cap.io);
        assert.equal(process.exitCode, undefined);
        assert.equal(fs.existsSync(path.join(root, 'sft')), false);
        assert.match(cap.logs.join('\n'), /train rows:/);
    });
});

describe('interop with gen_responses writer', () => {
    it('a file written by writeResponseEntry is directly consumable', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-'));
        try {
            const prompt = writePrompt(root, TX_A, HASH_A);
            writeResponseEntry(prompt, { txHash: TX_A, codehash: HASH_A, methodId: METHOD, model: 'deepseek-v4-pro' },
                'simple', {
                    content: 'live',
                    finishReason: 'stop',
                    usage: { prompt_tokens: 1, completion_tokens: 1 },
                    promptSha256: promptSha256('sys-simple', 'user-simple'),
                });
            const respPath = responsePathForPrompt(prompt);
            const j = JSON.parse(fs.readFileSync(respPath, 'utf8'));
            assert.equal(j.version, RESPONSE_VERSION);
            const rows = [];
            processAll(root, { styles: ['simple'], valRatio: 0, seed: '1', teacherSystemSuffix: '' },
                (row) => rows.push(row));
            assert.equal(rows.length, 1);
            assert.equal(rows[0].messages[2].content, 'live');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
