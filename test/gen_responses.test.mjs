import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    parseArgs,
    resolveConfig,
    responsePathForPrompt,
    promptSha256,
    estimateTokens,
    collectPromptJobs,
    readExistingResponse,
    hasFreshEntry,
    buildRequestBody,
    extractAssistantMessage,
    isRetriableStatus,
    backoffDelayMs,
    callDeepSeek,
    writeResponseEntry,
    runPool,
    formatSummary,
    formatMetrics,
    main,
    HELP,
    DEFAULT_MODEL,
    DEFAULT_STYLES,
    RESPONSE_VERSION,
} from '../src/gen_responses.mjs';

const TX_A = '0x' + 'aa'.repeat(32);
const TX_B = '0x' + 'bb'.repeat(32);
const HASH_A = '11'.repeat(32);
const HASH_B = '22'.repeat(32);
const METHOD = 'a9059cbb';

function makePromptFile() {
    return JSON.stringify([
        {
            style: 'simple',
            systemPrompt: 'You are the simple analyst.',
            userPrompt: '## Transaction Overview\n- Function: transfer\n',
        },
        {
            style: 'detailed',
            systemPrompt: 'You are the detailed analyst.',
            userPrompt: '## Transaction Overview\n- Function: transfer (detailed)\n',
        },
    ]);
}

function writePrompt(root, tx, { hash = HASH_A, method = METHOD, body = makePromptFile() } = {}) {
    const dir = path.join(root, hash.slice(0, 2), hash.slice(2), method);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${tx}_prompt.json`);
    fs.writeFileSync(file, body);
    return file;
}

function capture() {
    const prev = process.exitCode;
    process.exitCode = undefined;
    const logs = [], errors = [];
    return { prev, logs, errors, io: { log: (m) => logs.push(m), error: (m) => errors.push(m) } };
}

function mockOkResponse({ content = 'The transaction transfers tokens.', reasoning = 'r', promptTokens = 100, completionTokens = 40, hit = 30, miss = 70 } = {}) {
    return {
        ok: true,
        status: 200,
        async json() {
            return {
                id: 'req_123',
                choices: [{
                    finish_reason: 'stop',
                    index: 0,
                    message: { role: 'assistant', content, reasoning_content: reasoning },
                }],
                usage: {
                    prompt_tokens: promptTokens,
                    completion_tokens: completionTokens,
                    total_tokens: promptTokens + completionTokens,
                    prompt_cache_hit_tokens: hit,
                    prompt_cache_miss_tokens: miss,
                },
            };
        },
        async text() { return ''; },
    };
}

describe('parseArgs / resolveConfig', () => {
    it('parses --dry-run, --limit, --help', () => {
        assert.deepEqual(parseArgs(['--dry-run']), { dryRun: true, help: false });
        assert.deepEqual(parseArgs(['--limit', '7']), { dryRun: false, help: false, limit: 7 });
        assert.equal(parseArgs(['-h']).help, true);
        assert.throws(() => parseArgs(['--limit']), /requires a value/);
        assert.throws(() => parseArgs(['--limit', '0']), /positive integer/);
        assert.throws(() => parseArgs(['--nope']), /unknown flag/);
    });

    it('applies env defaults', () => {
        const cfg = resolveConfig({});
        assert.equal(cfg.model, DEFAULT_MODEL);
        assert.deepEqual(cfg.styles, [...DEFAULT_STYLES]);
        assert.equal(cfg.thinking, 'enabled');
        assert.equal(cfg.reasoningEffort, 'high');
        assert.equal(cfg.force, false);
        assert.equal(cfg.keepReasoning, true);
    });

    it('validates THINKING and integer envs', () => {
        assert.throws(() => resolveConfig({ THINKING: 'maybe' }), /THINKING/);
        assert.throws(() => resolveConfig({ MAX_TOKENS: '0' }), /MAX_TOKENS/);
        assert.throws(() => resolveConfig({ CONCURRENCY: 'no' }), /CONCURRENCY/);
        assert.throws(() => resolveConfig({ MAX_RETRIES: '-1' }), /MAX_RETRIES/);
        const cfg = resolveConfig({ MAX_RETRIES: '0', KEEP_REASONING: '0', FORCE: '1', STYLES: 'simple,detailed' });
        assert.equal(cfg.maxRetries, 0);
        assert.equal(cfg.keepReasoning, false);
        assert.equal(cfg.force, true);
        assert.deepEqual(cfg.styles, ['simple', 'detailed']);
    });

    it('flag --limit overrides LIMIT env', () => {
        const cfg = resolveConfig({ LIMIT: '3' }, { limit: 8 });
        assert.equal(cfg.limit, 8);
        assert.equal(resolveConfig({ LIMIT: '3' }).limit, 3);
    });
});

describe('helpers', () => {
    it('promptSha256 differs for system-vs-user swap', () => {
        assert.notEqual(promptSha256('a', 'b'), promptSha256('b', 'a'));
        assert.equal(promptSha256('a', 'b'), promptSha256('a', 'b'));
    });

    it('estimateTokens rounds up chars/4', () => {
        assert.equal(estimateTokens(''), 0);
        assert.equal(estimateTokens('abcd'), 1);
        assert.equal(estimateTokens('abcde'), 2);
    });

    it('responsePathForPrompt swaps suffix', () => {
        assert.equal(
            responsePathForPrompt('/x/aa/bb/cc/0xdead_prompt.json'),
            '/x/aa/bb/cc/0xdead_response.json',
        );
    });

    it('isRetriableStatus covers 429/5xx and network errors', () => {
        assert.equal(isRetriableStatus(200), false);
        assert.equal(isRetriableStatus(400), false);
        assert.equal(isRetriableStatus(429), true);
        assert.equal(isRetriableStatus(503), true);
        assert.equal(isRetriableStatus(undefined), true);
    });

    it('backoffDelayMs is bounded and grows', () => {
        const rng = () => 0.5;
        assert.equal(backoffDelayMs(0, rng), 750);
        assert.equal(backoffDelayMs(1, rng), 1500);
        assert.ok(backoffDelayMs(10, rng) <= 30_000);
    });
});

describe('buildRequestBody / extractAssistantMessage', () => {
    it('builds a well-formed body with suffix + thinking', () => {
        const cfg = resolveConfig({ TEACHER_SYSTEM_SUFFIX: 'Answer in 3 sentences.' });
        const body = buildRequestBody(
            { systemPrompt: 'sys', userPrompt: 'usr' },
            cfg,
        );
        assert.equal(body.model, DEFAULT_MODEL);
        assert.equal(body.messages.length, 2);
        assert.equal(body.messages[0].role, 'system');
        assert.equal(body.messages[0].content, 'sys\n\nAnswer in 3 sentences.');
        assert.equal(body.messages[1].role, 'user');
        assert.equal(body.messages[1].content, 'usr');
        assert.deepEqual(body.thinking, { type: 'enabled' });
        assert.equal(body.reasoning_effort, 'high');
        assert.equal(body.stream, false);
        assert.ok(body.max_tokens > 0);
    });

    it('omits reasoning_effort when thinking is disabled', () => {
        const cfg = resolveConfig({ THINKING: 'disabled' });
        const body = buildRequestBody({ systemPrompt: 's', userPrompt: 'u' }, cfg);
        assert.equal(body.thinking.type, 'disabled');
        assert.equal(body.reasoning_effort, undefined);
    });

    it('rejects non-stop finish, empty content, missing choices', () => {
        assert.throws(() => extractAssistantMessage(null), /empty/);
        assert.throws(() => extractAssistantMessage({}), /no choices/);
        assert.throws(
            () => extractAssistantMessage({ choices: [{ finish_reason: 'length', message: { content: 'x' } }] }),
            /finish_reason=length/,
        );
        assert.throws(
            () => extractAssistantMessage({ choices: [{ finish_reason: 'stop', message: { content: '   ' } }] }),
            /empty content/,
        );
    });

    it('extracts content, reasoning, and usage', () => {
        const parsed = extractAssistantMessage({
            id: 'r1',
            choices: [{
                finish_reason: 'stop',
                message: { content: 'answer', reasoning_content: 'thought' },
            }],
            usage: { prompt_tokens: 10, completion_tokens: 3 },
        });
        assert.equal(parsed.content, 'answer');
        assert.equal(parsed.reasoningContent, 'thought');
        assert.equal(parsed.finishReason, 'stop');
        assert.equal(parsed.requestId, 'r1');
        assert.equal(parsed.usage.prompt_tokens, 10);
    });
});

describe('collectPromptJobs + response cache', () => {
    let root;
    afterEach(() => {
        if (root) fs.rmSync(root, { recursive: true, force: true });
        root = undefined;
    });

    it('emits one job per requested style, sorted by relPath then style', () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-'));
        writePrompt(root, TX_A);
        writePrompt(root, TX_B, { hash: HASH_B });
        const jobs = collectPromptJobs(root, ['simple', 'detailed']);
        assert.equal(jobs.length, 4);
        for (const j of jobs) {
            assert.ok(['simple', 'detailed'].includes(j.style));
            assert.equal(j.codehash.length, 64);
            assert.equal(j.methodId, METHOD);
        }
        // simple sorts before detailed by string order but relPath comes first.
        const relPaths = [...new Set(jobs.map((j) => j.relPath))];
        assert.deepEqual(relPaths, [...relPaths].sort());
    });

    it('ignores non-array prompt files and unknown styles', () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-'));
        writePrompt(root, TX_A, { body: JSON.stringify({ not: 'array' }) });
        writePrompt(root, TX_B, { hash: HASH_B, body: JSON.stringify([{ style: 'other', systemPrompt: 's', userPrompt: 'u' }]) });
        assert.deepEqual(collectPromptJobs(root, ['simple']), []);
    });

    it('hasFreshEntry checks style + sha + finishReason + non-empty content', () => {
        assert.equal(hasFreshEntry(null, 'simple', 'abc', false), false);
        const good = {
            responses: {
                simple: { finishReason: 'stop', content: 'x', promptSha256: 'abc' },
            },
        };
        assert.equal(hasFreshEntry(good, 'simple', 'abc', false), true);
        assert.equal(hasFreshEntry(good, 'simple', 'xyz', false), false);
        assert.equal(hasFreshEntry(good, 'simple', 'abc', true), false); // force
        assert.equal(hasFreshEntry(good, 'detailed', 'abc', false), false);
        const stale = { responses: { simple: { finishReason: 'length', content: 'x', promptSha256: 'abc' } } };
        assert.equal(hasFreshEntry(stale, 'simple', 'abc', false), false);
    });

    it('writeResponseEntry merges, preserves other styles, and is atomic', () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-'));
        const prompt = writePrompt(root, TX_A);
        writeResponseEntry(prompt, { txHash: TX_A, codehash: HASH_A, methodId: METHOD, model: 'deepseek-v4-pro' },
            'detailed', { content: 'D', finishReason: 'stop', promptSha256: 'h1', usage: {} });
        writeResponseEntry(prompt, { txHash: TX_A, codehash: HASH_A, methodId: METHOD, model: 'deepseek-flash' },
            'simple', { content: 'S', finishReason: 'stop', promptSha256: 'h2', usage: { prompt_tokens: 5 } });
        const respPath = responsePathForPrompt(prompt);
        assert.equal(fs.existsSync(respPath + '.tmp'), false);
        const j = JSON.parse(fs.readFileSync(respPath, 'utf8'));
        assert.equal(j.version, RESPONSE_VERSION);
        assert.equal(j.txHash, TX_A);
        assert.equal(j.responses.detailed.content, 'D');
        assert.equal(j.responses.detailed.model, 'deepseek-v4-pro');
        assert.equal(j.responses.simple.content, 'S');
        assert.equal(j.responses.simple.model, 'deepseek-flash');
        assert.equal(j.responses.simple.usage.prompt_tokens, 5);
        assert.equal(readExistingResponse(prompt).responses.simple.promptSha256, 'h2');
    });
});

describe('callDeepSeek', () => {
    it('retries on 429, then succeeds', async () => {
        let calls = 0;
        const sleeps = [];
        const data = await callDeepSeek({ ping: 1 }, {
            baseUrl: 'https://x', apiKey: 'k', timeoutMs: 100, maxRetries: 3,
        }, {
            fetch: async () => {
                calls++;
                if (calls < 3) return { ok: false, status: 429, async text() { return 'busy'; } };
                return mockOkResponse();
            },
            sleep: async (ms) => { sleeps.push(ms); },
            rng: () => 0.5,
        });
        assert.equal(calls, 3);
        assert.equal(sleeps.length, 2);
        assert.equal(data.choices[0].finish_reason, 'stop');
    });

    it('does not retry a 400 error', async () => {
        let calls = 0;
        await assert.rejects(callDeepSeek({}, {
            baseUrl: 'https://x', apiKey: 'k', timeoutMs: 100, maxRetries: 3,
        }, {
            fetch: async () => { calls++; return { ok: false, status: 400, async text() { return 'bad'; } }; },
            sleep: async () => { },
            rng: () => 0.5,
        }), /HTTP 400/);
        assert.equal(calls, 1);
    });

    it('gives up after maxRetries and rethrows the last error', async () => {
        let calls = 0;
        await assert.rejects(callDeepSeek({}, {
            baseUrl: 'https://x', apiKey: 'k', timeoutMs: 100, maxRetries: 2,
        }, {
            fetch: async () => { calls++; return { ok: false, status: 503, async text() { return 'down'; } }; },
            sleep: async () => { },
            rng: () => 0.5,
        }), /HTTP 503/);
        assert.equal(calls, 3);
    });
});

describe('runPool', () => {
    it('respects concurrency bound and covers all items', async () => {
        const items = Array.from({ length: 10 }, (_, i) => i);
        let inflight = 0;
        let maxInflight = 0;
        const done = new Set();
        await runPool(items, 3, async (x) => {
            inflight++;
            maxInflight = Math.max(maxInflight, inflight);
            await new Promise((r) => setImmediate(r));
            inflight--;
            done.add(x);
        });
        assert.equal(done.size, 10);
        assert.ok(maxInflight <= 3);
    });
});

describe('main', () => {
    let root;
    afterEach(() => {
        if (root) fs.rmSync(root, { recursive: true, force: true });
        root = undefined;
        process.exitCode = undefined;
    });

    it('prints help without DATA_DIR', async () => {
        const cap = capture();
        await main({}, ['-h'], cap.io);
        assert.equal(cap.logs[0], HELP);
        assert.equal(process.exitCode, undefined);
    });

    it('requires DATA_DIR', async () => {
        const cap = capture();
        await main({}, [], cap.io);
        assert.equal(process.exitCode, 1);
        assert.match(cap.errors.join('\n'), /DATA_DIR/);
    });

    it('requires DEEPSEEK_API_KEY unless dry-run', async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-'));
        writePrompt(root, TX_A);
        const cap = capture();
        await main({ DATA_DIR: root }, [], cap.io);
        assert.equal(process.exitCode, 1);
        assert.match(cap.errors.join('\n'), /DEEPSEEK_API_KEY/);
    });

    it('dry-run counts and estimates without needing a key', async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-'));
        writePrompt(root, TX_A);
        writePrompt(root, TX_B, { hash: HASH_B });
        const cap = capture();
        const prom = path.join(root, 'gen.prom');
        await main({ DATA_DIR: root, PROM_FILE: prom, CHAIN: 'sepolia' }, ['--dry-run'], cap.io);
        assert.equal(process.exitCode, undefined);
        assert.match(fs.readFileSync(prom, 'utf8'), /trace_gen_planned\{chain="sepolia"\} 2/);
        assert.match(fs.readFileSync(prom, 'utf8'), /trace_gen_dry_run\{chain="sepolia"\} 1/);
        const out = cap.logs.join('\n');
        assert.match(out, /2 candidate prompt-style pairs/);
        assert.match(out, /planned calls: 2/);
        assert.match(out, /est\. input tokens:/);
    });

    it('happy path: fetch is called, _response.json is written, skipped on rerun', async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-'));
        const prompt = writePrompt(root, TX_A);
        let calls = 0;
        const fakeFetch = async (url, init) => {
            calls++;
            assert.match(url, /\/chat\/completions$/);
            assert.equal(init.method, 'POST');
            const body = JSON.parse(init.body);
            assert.equal(body.model, DEFAULT_MODEL);
            assert.equal(body.messages[0].role, 'system');
            assert.equal(body.messages[1].role, 'user');
            return mockOkResponse({ content: 'answer', promptTokens: 200, completionTokens: 50 });
        };
        const cap = capture();
        await main({ DATA_DIR: root, DEEPSEEK_API_KEY: 'k', CONCURRENCY: '1', PROGRESS_EVERY: '0' }, [], cap.io, { fetch: fakeFetch, sleep: async () => { }, rng: () => 0.5, now: () => 1_000 });
        assert.equal(process.exitCode, undefined);
        assert.equal(calls, 1);
        const resp = JSON.parse(fs.readFileSync(responsePathForPrompt(prompt), 'utf8'));
        assert.equal(resp.responses.simple.content, 'answer');
        assert.equal(resp.responses.simple.finishReason, 'stop');
        assert.equal(resp.responses.simple.usage.prompt_tokens, 200);
        assert.equal(resp.responses.simple.usage.completion_tokens, 50);
        assert.equal(resp.responses.simple.reasoningContent, 'r');

        // Second run must skip.
        cap.logs.length = 0; cap.errors.length = 0;
        calls = 0;
        await main({ DATA_DIR: root, DEEPSEEK_API_KEY: 'k', CONCURRENCY: '1' }, [], cap.io, { fetch: fakeFetch, sleep: async () => { } });
        assert.equal(calls, 0);
        assert.match(cap.logs.join('\n'), /skipped:\s+1/);

        // FORCE overrides.
        cap.logs.length = 0;
        calls = 0;
        await main({ DATA_DIR: root, DEEPSEEK_API_KEY: 'k', CONCURRENCY: '1', FORCE: '1' }, [], cap.io, { fetch: fakeFetch, sleep: async () => { } });
        assert.equal(calls, 1);
    });

    it('LIMIT caps issued API calls', async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-'));
        writePrompt(root, TX_A);
        writePrompt(root, TX_B, { hash: HASH_B });
        let calls = 0;
        const cap = capture();
        await main({ DATA_DIR: root, DEEPSEEK_API_KEY: 'k', CONCURRENCY: '1' }, ['--limit', '1'], cap.io, {
            fetch: async () => { calls++; return mockOkResponse(); },
            sleep: async () => { },
        });
        assert.equal(calls, 1);
    });

    it('bad finish_reason is a failure, not a write', async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-'));
        const prompt = writePrompt(root, TX_A);
        const cap = capture();
        await main({ DATA_DIR: root, DEEPSEEK_API_KEY: 'k', CONCURRENCY: '1' }, [], cap.io, {
            fetch: async () => ({
                ok: true, status: 200,
                async json() { return { id: 'x', choices: [{ finish_reason: 'length', message: { content: 'partial' } }] }; },
                async text() { return ''; },
            }),
            sleep: async () => { },
        });
        assert.equal(process.exitCode, 1);
        assert.equal(fs.existsSync(responsePathForPrompt(prompt)), false);
        assert.match(cap.errors.join('\n'), /bad-response/);
    });
});

describe('formatSummary', () => {
    it('renders both dry-run and live variants', () => {
        assert.match(
            formatSummary({ ok: 0, skipped: 0, failed: 0, tokensIn: 100, tokensOut: 0, cacheHit: 0, cacheMiss: 0, dryRun: true, planned: 3 }),
            /dry-run summary/,
        );
        assert.match(
            formatSummary({ ok: 2, skipped: 1, failed: 0, tokensIn: 400, tokensOut: 80, cacheHit: 100, cacheMiss: 300 }),
            /prompt tokens: 400/,
        );
    });

    it('formatMetrics renders last-run gauges', () => {
        const body = formatMetrics({
            ok: 6, skipped: 2617, failed: 0, tokensIn: 34280, tokensOut: 56764,
            cacheHit: 33920, cacheMiss: 360, lastRunTs: 1700000000,
        }, 'mainnet');
        assert.match(body, /trace_gen_ok\{chain="mainnet"\} 6/);
        assert.match(body, /trace_gen_skipped\{chain="mainnet"\} 2617/);
        assert.match(body, /trace_gen_prompt_tokens\{chain="mainnet"\} 34280/);
        assert.match(body, /trace_gen_planned\{chain="mainnet"\} 6/);
        assert.match(body, /trace_gen_dry_run\{chain="mainnet"\} 0/);
        assert.equal(body.endsWith('\n'), true);
    });
});
