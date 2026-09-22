import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    parseArgs,
    resolveConfig,
    canonicalNumber,
    scaleUp,
    scaleDown,
    roundDecimalString,
    maskNonNumeric,
    extractNumbers,
    buildPromptIndex,
    groundingMode,
    computeDeterministic,
    shouldSample,
    buildJudgeRequest,
    parseJudgeContent,
    collectPairs,
    planWork,
    writeValidationEntry,
    pickWorst,
    formatSummary,
    main,
    HELP,
    JUDGE_SYSTEM_PROMPT,
    VALIDATION_VERSION,
    DEFAULT_TRIVIAL_MAX,
} from '../src/validate_responses.mjs';
import { promptSha256, writeResponseEntry } from '../src/gen_responses.mjs';
import { readValidation, validationPathForPrompt } from '../src/query.mjs';

const METHOD = 'a9059cbb';
const TX_A = '0x' + 'aa'.repeat(32);
const TX_B = '0x' + 'bb'.repeat(32);
const HASH_A = '11'.repeat(32);
const HASH_B = '22'.repeat(32);

const SYS = 'sys';
const USER_PROMPT = [
    '## Transaction Overview',
    '- Status: SUCCESS',
    '- From: 0x2127...e880',
    '- Function: claim(distributionId=0x29, merkleProof=[])',
    '- Gas used: 97,476',
    '',
    '## Emitted Events',
    '1. **Transfer** on 0xdbd1...5931',
    '   Parameters: from=0x1349...13a4, to=0x2127...e880, value=1000 (raw: 1000000000000000000000)',
    '2. **Transfer** on USDT (0xdac1...1ec7)',
    '   Parameters: value=139231085',
    '',
    '## State Changes',
    '- 0x1349...13a4: distributions[41]: 0 -> 1',
].join('\n');

function sha(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

function writePrompt(root, tx, hash = HASH_A, user = USER_PROMPT) {
    const dir = path.join(root, hash.slice(0, 2), hash.slice(2), METHOD);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${tx}_prompt.json`);
    fs.writeFileSync(file, JSON.stringify([
        { style: 'simple', systemPrompt: SYS, userPrompt: user },
        { style: 'detailed', systemPrompt: SYS, userPrompt: user },
    ]));
    return file;
}

function writeResponse(promptPath, style, content, { finishReason = 'stop', user = USER_PROMPT } = {}) {
    writeResponseEntry(promptPath, { txHash: 'x', codehash: 'y', methodId: METHOD, model: 'deepseek-v4-pro' }, style, {
        content, finishReason, usage: { prompt_tokens: 1, completion_tokens: 1 }, promptSha256: promptSha256(SYS, user),
    });
}

function judgeResponse(json, { finishReason = 'stop', usage = { prompt_tokens: 100, completion_tokens: 20 } } = {}) {
    const content = typeof json === 'string' ? json : JSON.stringify(json);
    return {
        ok: true, status: 200,
        async json() { return { id: 'req-1', choices: [{ finish_reason: finishReason, message: { content } }], usage }; },
        async text() { return ''; },
    };
}

function capture() {
    const prev = process.exitCode;
    process.exitCode = undefined;
    const logs = [], errors = [];
    return { logs, errors, prev, io: { log: (m) => logs.push(m), error: (m) => errors.push(m) } };
}

describe('parseArgs / resolveConfig', () => {
    it('parses flags', () => {
        assert.deepEqual(parseArgs([]), { dryRun: false, help: false });
        assert.deepEqual(parseArgs(['--dry-run', '--limit', '3']), { dryRun: true, help: false, limit: 3 });
        assert.equal(parseArgs(['-h']).help, true);
        assert.throws(() => parseArgs(['--limit']), /requires a value/);
        assert.throws(() => parseArgs(['--limit', '0']), /positive integer/);
        assert.throws(() => parseArgs(['--nope']), /unknown flag/);
    });

    it('resolves defaults and validates ranges', () => {
        const cfg = resolveConfig({});
        assert.deepEqual(cfg.styles, ['simple']);
        assert.equal(cfg.trivialMax, DEFAULT_TRIVIAL_MAX);
        assert.equal(cfg.ratioPass, 0.9);
        assert.equal(cfg.ratioWarn, 0.7);
        assert.deepEqual(cfg.scaleExponents, [6, 8, 9, 18]);
        assert.equal(cfg.judgeSamplePct, 5);
        assert.equal(cfg.judgeModel, 'deepseek-v4-pro');
        assert.equal(cfg.judgeThinking, 'enabled');
        assert.equal(cfg.force, false);
        assert.equal(cfg.forceJudge, false);
        assert.equal(cfg.limit, undefined);

        const custom = resolveConfig({
            STYLES: 'simple,detailed', TRIVIAL_MAX: '10', RATIO_PASS: '0.8', RATIO_WARN: '0.5',
            SCALE_EXPONENTS: '6,18,18', JUDGE_SAMPLE_PCT: '0', JUDGE_THINKING: 'disabled', FORCE_JUDGE: '1', LIMIT: '7',
        }, {});
        assert.deepEqual(custom.styles, ['simple', 'detailed']);
        assert.equal(custom.trivialMax, 10);
        assert.deepEqual(custom.scaleExponents, [6, 18]);
        assert.equal(custom.judgeSamplePct, 0);
        assert.equal(custom.judgeThinking, 'disabled');
        assert.equal(custom.forceJudge, true);
        assert.equal(custom.force, false);
        assert.equal(custom.limit, 7);
        assert.equal(resolveConfig({ LIMIT: '7' }, { limit: 2 }).limit, 2, '--limit wins over LIMIT');
        assert.equal(resolveConfig({ FORCE: '1' }).forceJudge, true, 'FORCE implies FORCE_JUDGE');

        assert.throws(() => resolveConfig({ RATIO_PASS: '1.5' }), /RATIO_PASS/);
        assert.throws(() => resolveConfig({ RATIO_PASS: '0.5', RATIO_WARN: '0.8' }), /RATIO_WARN must not exceed/);
        assert.throws(() => resolveConfig({ JUDGE_SAMPLE_PCT: '101' }), /JUDGE_SAMPLE_PCT/);
        assert.throws(() => resolveConfig({ JUDGE_THINKING: 'maybe' }), /JUDGE_THINKING/);
        assert.throws(() => resolveConfig({ SCALE_EXPONENTS: '6,x' }), /SCALE_EXPONENTS/);
    });
});

describe('number canonicalisation', () => {
    it('canonicalNumber strips separators, leading zeros, trailing fraction zeros, expands sci', () => {
        assert.equal(canonicalNumber('1,000'), '1000');
        assert.equal(canonicalNumber('1_000_000'), '1000000');
        assert.equal(canonicalNumber('007'), '7');
        assert.equal(canonicalNumber('108.60'), '108.6');
        assert.equal(canonicalNumber('0.0'), '0');
        assert.equal(canonicalNumber('-5'), '5');
        assert.equal(canonicalNumber('1e18'), '1000000000000000000');
        assert.equal(canonicalNumber('2.5e6'), '2500000');
        assert.equal(canonicalNumber('1.5e-3'), '0.0015');
        assert.equal(canonicalNumber('1e-1'), '0.1');
        assert.equal(canonicalNumber('abc'), null);
        assert.equal(canonicalNumber('1.'), null);
        // A Solidity hex digit `e` is not an exponent. Expanding it would
        // ask String.repeat for ~10^14 zeros and throw RangeError.
        assert.equal(canonicalNumber('001e848000000000000'), null);
        assert.equal(canonicalNumber('1e' + '9'.repeat(20)), null);
        assert.equal(canonicalNumber('1e-400'), null);
    });

    it('scaleUp / scaleDown are exact on long integers', () => {
        assert.equal(scaleUp('1000', 18), '1000000000000000000000');
        assert.equal(scaleUp('0.00180777', 8), '180777');
        assert.equal(scaleUp('1.5', 0), null, 'fraction would remain');
        assert.equal(scaleUp('1.234', 2), null);
        assert.equal(scaleDown('139231085', 6), '139.231085');
        assert.equal(scaleDown('794', 8), '0.00000794');
        assert.equal(scaleDown('1000000000000000000000', 18), '1000');
        assert.equal(scaleDown('1.5', 2), null, 'only integers');
    });

    it('roundDecimalString rounds half-up / truncates with carry, null when precise enough', () => {
        assert.equal(roundDecimalString('0.022978', 5), '0.02298');
        assert.equal(roundDecimalString('0.022978', 5, 'trunc'), '0.02297');
        assert.equal(roundDecimalString('139.231085', 2), '139.23');
        assert.equal(roundDecimalString('99.995', 2), '100');
        assert.equal(roundDecimalString('0.999', 0), '1');
        assert.equal(roundDecimalString('139.231085', 0), '139');
        assert.equal(roundDecimalString('1.5', 1), null);
        assert.equal(roundDecimalString('12', 0), null);
    });
});

describe('extractNumbers', () => {
    it('ignores hex, truncated addresses, standard ids, and identifiers with digits', () => {
        const text = 'Sent 1,000 USDT to 0x2127...e880 (ERC-20, EIP-1559) via 0xabcdef1234 on Uniswap v3; uint256 slot; tick=66529 and sqrtPriceX96.';
        assert.deepEqual(extractNumbers(text), ['1000', '66529']);
        assert.equal(maskNonNumeric('0xdead...beef 12'), '  12');
        assert.equal(maskNonNumeric('dead...beef 12').trim(), '12');
        const blob = 'hex"001e848000000000000f0ba30000fc73" then 12 wei';
        assert.deepEqual(extractNumbers(blob), ['12']);
        assert.doesNotThrow(() => buildPromptIndex(blob));
    });

    it('drops trivial integers but never fractions; keeps duplicates', () => {
        // `1.0` canonicalises to the trivial integer `1` and is dropped like any other.
        assert.deepEqual(extractNumbers('0 -> 1, 2 items, 3 items, 0.5 ETH, 1.0 WETH, 1.5 WETH'), ['3', '0.5', '1.5']);
        assert.deepEqual(extractNumbers('#41 and 41 again'), ['41', '41']);
        assert.deepEqual(extractNumbers('1 -> 5', { trivialMax: 10 }), []);
        assert.deepEqual(extractNumbers('amount0=-136111489'), ['136111489']);
        assert.deepEqual(extractNumbers('about 1e18 wei'), ['1000000000000000000']);
    });
});

describe('buildPromptIndex / groundingMode', () => {
    const index = buildPromptIndex(USER_PROMPT);

    it('indexes literals, hex values, derived decimals and fractional candidates', () => {
        assert.ok(index.literal.has('97476'), 'gas with separators');
        assert.ok(index.literal.has('1000000000000000000000'));
        assert.ok(index.literal.has('41'));
        assert.ok(index.hex.has('41'), '0x29 → 41');
        assert.ok(index.decimals.has('18'), '(raw: …) pair → 18 decimals');
        assert.ok(index.fractional.includes('139.231085'), '139231085 / 1e6');
        assert.ok(!index.hex.has('8743'), 'truncated 0x2127...e880 is not a value');
    });

    it('classifies each grounding mode', () => {
        assert.equal(groundingMode('97476', index), 'literal');
        assert.equal(groundingMode('41', index), 'literal');
        assert.equal(groundingMode('1000', index), 'literal', 'human value is literal too');
        assert.equal(groundingMode('18', index), 'decimals');
        assert.equal(groundingMode('139.231085', index), 'scaled');
        assert.equal(groundingMode('139.23', index), 'rounded');
        assert.equal(groundingMode('139', index), 'rounded', 'integer >= 100 may round');
        assert.equal(groundingMode('4.93', index), null);
        assert.equal(groundingMode('12345', index), null);
        const hexOnly = buildPromptIndex('Function: transfer(amount=0x174876e800)');
        assert.equal(groundingMode('100000000000', hexOnly), 'hex');
        assert.equal(groundingMode('100000', hexOnly), 'scaled', 'hex value / 1e6');
    });

    it('does not let small integers match by rounding', () => {
        const idx = buildPromptIndex('value=2500000');
        assert.equal(groundingMode('2.5', idx), 'scaled');
        assert.equal(groundingMode('3', idx), null, '2.5 rounds to 3 but ints < 100 are excluded');
        assert.equal(groundingMode('250', buildPromptIndex('value=249600000')), 'rounded');
    });
});

describe('computeDeterministic', () => {
    it('produces ratio, verdict, unmatched and mode histogram', () => {
        const content = 'Claimed distribution #41: 1,000 tokens (raw 1000000000000000000000, 18 decimals) plus 139.23 USDT. Also 4.93 USDT and 0.00000795 WBTC leftover.';
        const det = computeDeterministic(USER_PROMPT, content);
        assert.equal(det.numbers.total, 7);
        assert.equal(det.numbers.grounded, 5);
        assert.deepEqual(det.numbers.unmatched, ['4.93', '0.00000795']);
        assert.equal(det.numbers.ratio, 0.7143);
        assert.equal(det.verdict, 'warn');
        assert.deepEqual(det.numbers.matchModes, { literal: 3, hex: 0, scaled: 0, decimals: 1, rounded: 1 });
        assert.deepEqual(det.thresholds, { pass: 0.9, warn: 0.7 });
    });

    it('empty responses pass; thresholds and trivialMax are configurable', () => {
        assert.equal(computeDeterministic(USER_PROMPT, 'No numbers here.').verdict, 'pass');
        assert.equal(computeDeterministic(USER_PROMPT, 'No numbers here.').numbers.ratio, 1);
        const strict = computeDeterministic(USER_PROMPT, '41 and 999', { ratioPass: 1, ratioWarn: 0.5 });
        assert.equal(strict.verdict, 'warn');
        const fail = computeDeterministic(USER_PROMPT, '999 998 997', {});
        assert.equal(fail.verdict, 'fail');
        assert.equal(computeDeterministic(USER_PROMPT, '5 and 6', { trivialMax: 10 }).numbers.total, 0);
    });
});

describe('shouldSample', () => {
    it('is deterministic, seed-dependent, monotone in pct, and honours 0 / 100', () => {
        assert.equal(shouldSample(TX_A, '1', 0), false);
        assert.equal(shouldSample(TX_A, '1', 100), true);
        assert.equal(shouldSample(TX_A, '1', 50), shouldSample(TX_A, '1', 50));
        assert.equal(shouldSample(TX_A, '1', 50), shouldSample(TX_A.toUpperCase(), '1', 50), 'case-insensitive');
        const txs = Array.from({ length: 400 }, (_, i) => '0x' + i.toString(16).padStart(64, '0'));
        const at10 = txs.filter((t) => shouldSample(t, 's', 10));
        const at30 = txs.filter((t) => shouldSample(t, 's', 30));
        assert.ok(at10.length > 15 && at10.length < 70, `10% of 400 ≈ 40 (got ${at10.length})`);
        assert.ok(at10.every((t) => at30.includes(t)), 'raising pct only grows the set');
        const other = txs.filter((t) => shouldSample(t, 'other-seed', 10));
        assert.notDeepEqual(at10, other);
    });
});

describe('judge request / response', () => {
    it('buildJudgeRequest wraps both texts as data and forwards thinking config', () => {
        const body = buildJudgeRequest({ userPrompt: 'P', content: 'A' }, {
            judgeModel: 'm', judgeThinking: 'enabled', judgeReasoningEffort: 'high', judgeMaxTokens: 123,
        });
        assert.equal(body.model, 'm');
        assert.equal(body.max_tokens, 123);
        assert.equal(body.stream, false);
        assert.deepEqual(body.thinking, { type: 'enabled' });
        assert.equal(body.reasoning_effort, 'high');
        assert.equal(body.messages[0].role, 'system');
        assert.equal(body.messages[0].content, JUDGE_SYSTEM_PROMPT);
        assert.match(body.messages[1].content, /<<<SOURCE_DATA>>>\nP\n<<<END_SOURCE_DATA>>>/);
        assert.match(body.messages[1].content, /<<<ANALYST_ANSWER>>>\nA\n<<<END_ANALYST_ANSWER>>>/);
        const off = buildJudgeRequest({ userPrompt: 'P', content: 'A' }, { judgeModel: 'm', judgeThinking: 'disabled', judgeReasoningEffort: 'high', judgeMaxTokens: 1 });
        assert.equal('reasoning_effort' in off, false);
    });

    it('parseJudgeContent accepts plain, fenced, and prose-wrapped JSON', () => {
        const good = parseJudgeContent('{"score":5,"verdict":"good","issues":[]}');
        assert.deepEqual(good, { score: 5, verdict: 'good', issues: [] });
        const fenced = parseJudgeContent('```json\n{"score":3,"verdict":"flawed","issues":[{"type":"speculation","quote":"q","explanation":"e"}]}\n```');
        assert.equal(fenced.verdict, 'flawed');
        assert.deepEqual(fenced.issues, [{ type: 'speculation', quote: 'q', explanation: 'e' }]);
        const prose = parseJudgeContent('Here you go: {"score":2,"verdict":"wrong"} thanks');
        assert.equal(prose.score, 2);
        assert.equal(prose.verdict, 'wrong');
    });

    it('parseJudgeContent derives verdict from score, normalises issue types, flags garbage', () => {
        assert.equal(parseJudgeContent('{"score":4}').verdict, 'good');
        assert.equal(parseJudgeContent('{"score":3,"verdict":"meh"}').verdict, 'flawed');
        assert.equal(parseJudgeContent('{"score":1}').verdict, 'wrong');
        assert.deepEqual(parseJudgeContent('{"score":5,"issues":[{"type":"weird","quote":1}]}').issues, [{ type: 'other', quote: '', explanation: '' }]);
        for (const bad of ['', 'no json', '{"score":9}', '{"verdict":"good"}', '[1,2]', '{"score":"x"}']) {
            const r = parseJudgeContent(bad);
            assert.equal(r.verdict, 'unparseable', bad);
            assert.ok(r.error, bad);
        }
    });
});

describe('planWork', () => {
    const cfg = { force: false, forceJudge: false };
    const check = (contentSha, judge) => ({ contentSha256: contentSha, deterministic: { verdict: 'pass' }, judge });

    it('recomputes when missing or stale, reuses when fresh', () => {
        assert.deepEqual(planWork(null, 'a', false, cfg), { recomputeDeterministic: true, runJudge: false, reuseJudge: null });
        assert.deepEqual(planWork(check('old'), 'a', false, cfg), { recomputeDeterministic: true, runJudge: false, reuseJudge: null });
        assert.deepEqual(planWork(check('a'), 'a', false, cfg), { recomputeDeterministic: false, runJudge: false, reuseJudge: null });
        assert.equal(planWork(check('a'), 'a', false, { force: true, forceJudge: true }).recomputeDeterministic, true);
    });

    it('judge runs when sampled and no usable result exists; FORCE_JUDGE re-runs', () => {
        const judged = { verdict: 'good', score: 5 };
        assert.equal(planWork(check('a', null), 'a', true, cfg).runJudge, true);
        assert.equal(planWork(check('a', judged), 'a', true, cfg).runJudge, false);
        assert.deepEqual(planWork(check('a', judged), 'a', true, cfg).reuseJudge, judged);
        assert.equal(planWork(check('a', { verdict: 'unparseable' }), 'a', true, cfg).runJudge, true, 'unparseable is retried');
        assert.equal(planWork(check('a', judged), 'a', true, { force: false, forceJudge: true }).runJudge, true);
        assert.equal(planWork(check('a', judged), 'a', true, { force: false, forceJudge: true }).reuseJudge, null);
        assert.equal(planWork(check('old', judged), 'a', true, cfg).reuseJudge, null, 'stale content drops the old judge');
        assert.equal(planWork(check('a', judged), 'a', false, cfg).runJudge, false, 'unsampled never judges');
    });
});

describe('collectPairs / writeValidationEntry', () => {
    let root;
    afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); root = undefined; });

    it('collects only styles with a usable stop response, sorted by path', () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'val-'));
        const pB = writePrompt(root, TX_B, HASH_B);
        const pA = writePrompt(root, TX_A, HASH_A);
        writeResponse(pA, 'simple', 'A simple');
        writeResponse(pA, 'detailed', 'A detailed');
        writeResponse(pB, 'simple', 'cut', { finishReason: 'length' });
        writePrompt(root, '0x' + 'cc'.repeat(32), '33'.repeat(32)); // no response

        const pairs = collectPairs(root, ['simple', 'detailed']);
        assert.deepEqual(pairs.map((p) => [p.txHash, p.style]), [[TX_A, 'detailed'], [TX_A, 'simple']]);
        assert.equal(pairs[0].codehash, HASH_A);
        assert.equal(pairs[0].methodId, METHOD);
        assert.equal(pairs[0].responseModel, 'deepseek-v4-pro');
        assert.equal(pairs[0].userPrompt, USER_PROMPT);
        assert.equal(collectPairs(root, ['simple']).length, 1);
    });

    it('writeValidationEntry merges styles atomically and is readable via query.readValidation', () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'val-'));
        const p = writePrompt(root, TX_A);
        const meta = { txHash: TX_A, codehash: HASH_A, methodId: METHOD };
        writeValidationEntry(p, meta, 'simple', { contentSha256: 's', deterministic: { verdict: 'pass' }, judge: null });
        writeValidationEntry(p, meta, 'detailed', { contentSha256: 'd', deterministic: { verdict: 'warn' }, judge: null });
        const v = readValidation(p);
        assert.equal(v.version, VALIDATION_VERSION);
        assert.equal(v.txHash, TX_A);
        assert.deepEqual(Object.keys(v.checks).sort(), ['detailed', 'simple']);
        assert.equal(v.checks.simple.contentSha256, 's');
        assert.equal(fs.existsSync(validationPathForPrompt(p) + '.tmp'), false);
    });
});

describe('summary helpers', () => {
    it('pickWorst sorts by judge score, then ratio, then path', () => {
        const list = [
            { relPath: 'c', ratio: 1, judgeScore: null },
            { relPath: 'a', ratio: 0.5, judgeScore: null },
            { relPath: 'b', ratio: 1, judgeScore: 2 },
            { relPath: 'd', ratio: 0.5, judgeScore: null },
        ];
        assert.deepEqual(pickWorst(list, 3).map((x) => x.relPath), ['b', 'a', 'd']);
    });

    it('formatSummary renders both dry-run and live variants', () => {
        const base = {
            pairs: 2, processed: 1, skipped: 1, detRecomputed: 1, verdicts: { pass: 1, warn: 1 }, ratioSum: 1.5, ratioCount: 2,
            judgePlanned: 1, judgeOk: 1, judgeFailed: 0, judgeScores: { 4: 1 }, judgeTokensIn: 10, judgeTokensOut: 2,
            worst: [{ relPath: 'p', style: 'simple', ratio: 0.5, verdict: 'warn', judgeScore: null, unmatched: ['1', '2', '3', '4', '5', '6'] }],
        };
        const dry = formatSummary({ ...base, dryRun: true, estJudgeTokens: 999 });
        assert.match(dry, /dry-run summary/);
        assert.match(dry, /est\. judge input tokens: 999/);
        assert.match(dry, /mean ratio:\s+0\.7500/);
        assert.match(dry, /unmatched=\[1,2,3,4,5,…\]/);
        const live = formatSummary(base);
        assert.match(live, /judge scores:\s+1=0 2=0 3=0 4=1 5=0 unparseable=0/);
        assert.match(live, /judge tokens:\s+in=10 out=2/);
    });
});

describe('main', () => {
    let root;
    let prevExit;
    afterEach(() => {
        if (root) fs.rmSync(root, { recursive: true, force: true });
        root = undefined;
        process.exitCode = prevExit;
    });

    it('help / DATA_DIR gating', async () => {
        let cap = capture(); prevExit = cap.prev;
        await main({}, ['-h'], cap.io);
        assert.equal(cap.logs[0], HELP);
        cap = capture();
        await main({}, [], cap.io);
        assert.equal(process.exitCode, 1);
        assert.match(cap.errors[0], /DATA_DIR/);
        cap = capture();
        await main({ DATA_DIR: '/nonexistent/x' }, [], cap.io);
        assert.equal(process.exitCode, 1);
        cap = capture();
        await main({ DATA_DIR: os.tmpdir() }, ['--bogus'], cap.io);
        assert.equal(process.exitCode, 1);
        assert.match(cap.errors[0], /unknown flag/);
    });

    it('dry-run computes verdicts without writing or fetching', async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'val-'));
        const p = writePrompt(root, TX_A);
        writeResponse(p, 'simple', 'Claimed #41, 1,000 tokens, 999 unknown.');
        const cap = capture(); prevExit = cap.prev;
        let fetches = 0;
        await main({ DATA_DIR: root, JUDGE_SAMPLE_PCT: '100' }, ['--dry-run'], cap.io, { fetch: async () => { fetches++; } });
        assert.equal(process.exitCode, undefined);
        assert.equal(fetches, 0);
        assert.equal(fs.existsSync(validationPathForPrompt(p)), false);
        const out = cap.logs.join('\n');
        assert.match(out, /pairs:\s+1/);
        assert.match(out, /judge planned:\s+1/);
        assert.match(out, /verdicts:\s+pass=0 warn=0 fail=1/);
    });

    it('writes _validation.json, skips fresh entries on rerun, FORCE recomputes', async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'val-'));
        const p = writePrompt(root, TX_A);
        writeResponse(p, 'simple', 'Claimed #41 with 1,000 tokens.');
        let cap = capture(); prevExit = cap.prev;
        await main({ DATA_DIR: root, JUDGE_SAMPLE_PCT: '0', PROGRESS_EVERY: '0' }, [], cap.io, { now: () => 1_000 });
        assert.equal(process.exitCode, undefined);
        const v = readValidation(p);
        const check = v.checks.simple;
        assert.equal(check.contentSha256, sha('Claimed #41 with 1,000 tokens.'));
        assert.equal(check.promptSha256, promptSha256(SYS, USER_PROMPT));
        assert.equal(check.responseModel, 'deepseek-v4-pro');
        assert.equal(check.sampled, false);
        assert.equal(check.judge, null);
        assert.equal(check.deterministic.verdict, 'pass');
        assert.equal(check.deterministic.numbers.total, 2);
        assert.equal(check.checkedAt, new Date(1_000).toISOString());
        assert.match(cap.logs.join('\n'), /processed:\s+1/);

        cap = capture();
        await main({ DATA_DIR: root, JUDGE_SAMPLE_PCT: '0' }, [], cap.io, {});
        assert.match(cap.logs.join('\n'), /skipped \(fresh\):\s+1/);
        assert.match(cap.logs.join('\n'), /processed:\s+0/);

        cap = capture();
        await main({ DATA_DIR: root, JUDGE_SAMPLE_PCT: '0', FORCE: '1' }, [], cap.io, { now: () => 2_000 });
        assert.equal(readValidation(p).checks.simple.checkedAt, new Date(2_000).toISOString());

        // Changed response content → stale → recomputed.
        writeResponse(p, 'simple', 'Completely new 777 text.');
        cap = capture();
        await main({ DATA_DIR: root, JUDGE_SAMPLE_PCT: '0' }, [], cap.io, {});
        assert.equal(readValidation(p).checks.simple.deterministic.verdict, 'fail');
    });

    it('refuses to judge without an API key, but only when judge calls are planned', async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'val-'));
        const p = writePrompt(root, TX_A);
        writeResponse(p, 'simple', 'text 41');
        let cap = capture(); prevExit = cap.prev;
        await main({ DATA_DIR: root, JUDGE_SAMPLE_PCT: '100' }, [], cap.io, {});
        assert.equal(process.exitCode, 1);
        assert.match(cap.errors[0], /DEEPSEEK_API_KEY is not set/);
        assert.equal(fs.existsSync(validationPathForPrompt(p)), false, 'nothing written before the check');
        cap = capture();
        await main({ DATA_DIR: root, JUDGE_SAMPLE_PCT: '0' }, [], cap.io, {});
        assert.equal(process.exitCode, undefined);
    });

    it('runs the judge for sampled txs, stores the parsed verdict, reuses it, honours LIMIT', async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'val-'));
        const pA = writePrompt(root, TX_A, HASH_A);
        const pB = writePrompt(root, TX_B, HASH_B);
        writeResponse(pA, 'simple', 'Claimed #41.');
        writeResponse(pB, 'simple', 'Claimed #41 too.');
        let calls = 0;
        const bodies = [];
        const fetch = async (url, init) => {
            calls++;
            bodies.push(JSON.parse(init.body));
            assert.match(url, /\/chat\/completions$/);
            assert.equal(init.headers.authorization, 'Bearer k');
            return judgeResponse({ score: 3, verdict: 'flawed', issues: [{ type: 'speculation', quote: 'too', explanation: 'x' }] });
        };
        const env = { DATA_DIR: root, DEEPSEEK_API_KEY: 'k', JUDGE_SAMPLE_PCT: '100', CONCURRENCY: '1', PROGRESS_EVERY: '0', JUDGE_MODEL: 'judge-m' };
        let cap = capture(); prevExit = cap.prev;
        await main(env, ['--limit', '1'], cap.io, { fetch, sleep: async () => { }, now: () => 5_000 });
        assert.equal(process.exitCode, undefined);
        assert.equal(calls, 1, 'LIMIT caps judge calls');
        assert.equal(bodies[0].model, 'judge-m');
        assert.deepEqual(bodies[0].thinking, { type: 'enabled' });
        const judged = [readValidation(pA), readValidation(pB)].filter((v) => v.checks.simple.judge);
        const pending = [readValidation(pA), readValidation(pB)].filter((v) => !v.checks.simple.judge);
        assert.equal(judged.length, 1);
        assert.equal(pending.length, 1, 'the other tx keeps its deterministic result and waits');
        assert.equal(pending[0].checks.simple.sampled, true);
        const j = judged[0].checks.simple.judge;
        assert.equal(j.score, 3);
        assert.equal(j.verdict, 'flawed');
        assert.equal(j.model, 'judge-m');
        assert.equal(j.sampleRatePct, 100);
        assert.equal(j.usage.prompt_tokens, 100);
        assert.equal(j.requestId, 'req-1');
        assert.deepEqual(j.issues, [{ type: 'speculation', quote: 'too', explanation: 'x' }]);
        assert.match(cap.logs.join('\n'), /judge ok:\s+1/);

        // Second run: judges only the pending one, reuses the stored verdict.
        cap = capture();
        await main(env, [], cap.io, { fetch, sleep: async () => { } });
        assert.equal(calls, 2);
        assert.ok(readValidation(pA).checks.simple.judge && readValidation(pB).checks.simple.judge);

        // Third run: nothing to do.
        cap = capture();
        await main(env, [], cap.io, { fetch, sleep: async () => { } });
        assert.equal(calls, 2);
        assert.match(cap.logs.join('\n'), /skipped \(fresh\):\s+2/);

        // FORCE_JUDGE re-judges without touching the deterministic result.
        cap = capture();
        await main({ ...env, FORCE_JUDGE: '1' }, [], cap.io, { fetch, sleep: async () => { } });
        assert.equal(calls, 4);
    });

    it('records unparseable judge output with the raw content and retries it next run', async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'val-'));
        const p = writePrompt(root, TX_A);
        writeResponse(p, 'simple', 'Claimed #41.');
        let calls = 0;
        const fetch = async () => { calls++; return judgeResponse('I refuse to answer in JSON.'); };
        const env = { DATA_DIR: root, DEEPSEEK_API_KEY: 'k', JUDGE_SAMPLE_PCT: '100', PROGRESS_EVERY: '0' };
        let cap = capture(); prevExit = cap.prev;
        await main(env, [], cap.io, { fetch, sleep: async () => { } });
        const j = readValidation(p).checks.simple.judge;
        assert.equal(j.verdict, 'unparseable');
        assert.equal(j.score, null);
        assert.match(j.error, /no JSON object/);
        assert.equal(j.rawContent, 'I refuse to answer in JSON.');
        assert.match(cap.logs.join('\n'), /unparseable=1/);
        cap = capture();
        await main(env, [], cap.io, { fetch, sleep: async () => { } });
        assert.equal(calls, 2, 'unparseable results are retried');
    });

    it('truncated judge reply (finish_reason=length) is unparseable with an actionable error', async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'val-'));
        const p = writePrompt(root, TX_A);
        writeResponse(p, 'simple', 'Claimed #41.');
        // Some models return partial JSON when the cap hits; it must not be trusted.
        const fetch = async () => judgeResponse('{"score":5,"verdict":"good"', { finishReason: 'length' });
        const cap = capture(); prevExit = cap.prev;
        await main({ DATA_DIR: root, DEEPSEEK_API_KEY: 'k', JUDGE_SAMPLE_PCT: '100', PROGRESS_EVERY: '0' }, [], cap.io, { fetch, sleep: async () => { } });
        const j = readValidation(p).checks.simple.judge;
        assert.equal(j.verdict, 'unparseable');
        assert.equal(j.score, null);
        assert.equal(j.finishReason, 'length');
        assert.match(j.error, /finish_reason=length.*JUDGE_MAX_TOKENS/);
    });

    it('API failure after retries is reported, deterministic result still written, exit code 1', async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'val-'));
        const p = writePrompt(root, TX_A);
        writeResponse(p, 'simple', 'Claimed #41.');
        let calls = 0;
        const fetch = async () => { calls++; return { ok: false, status: 500, async text() { return 'boom'; } }; };
        const cap = capture(); prevExit = cap.prev;
        await main({ DATA_DIR: root, DEEPSEEK_API_KEY: 'k', JUDGE_SAMPLE_PCT: '100', MAX_RETRIES: '1', PROGRESS_EVERY: '0' }, [], cap.io, { fetch, sleep: async () => { }, rng: () => 0.5 });
        assert.equal(calls, 2);
        assert.equal(process.exitCode, 1);
        const v = readValidation(p);
        assert.equal(v.checks.simple.deterministic.verdict, 'pass');
        assert.equal(v.checks.simple.judge, null);
        assert.match(cap.errors.join('\n'), /judge-fail/);
        assert.match(cap.logs.join('\n'), /judge failed:\s+1/);
    });
});
