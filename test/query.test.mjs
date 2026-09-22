import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    parseArgs,
    parseCodehashPrefix,
    parseMethodId,
    parseQueryTerm,
    parseSectionList,
    firstUserPrompt,
    matchesBucket,
    matchesFilters,
    isSectionResolved,
    isUnresolvedStateChange,
    isUnresolvedCall,
    splitSections,
    colorizePrompt,
    formatMatch,
    shouldUseColor,
    visitMatchingPrompts,
    pageHits,
    formatStats,
    shuffleInPlace,
    simPathForPrompt,
    loadSimText,
    hasTraceCall,
    responsePathForPrompt,
    validationPathForPrompt,
    readResponse,
    readValidation,
    hasValidationProblems,
    formatResponse,
    formatValidation,
    main,
    HELP,
    SECTION_COLOR,
    SIM_COLOR,
    RESPONSE_COLOR,
    VALIDATION_COLOR,
    RESET,
} from '../src/query.mjs';

const TX_A = '0x' + 'aa'.repeat(32);
const TX_B = '0x' + 'bb'.repeat(32);
const TX_C = '0x' + 'cc'.repeat(32);
const HASH = '11'.repeat(32);

function promptFile(userPrompt, extra = []) {
    return JSON.stringify([{ style: 'simple', userPrompt }, ...extra]);
}

function writePrompt(root, txhash, userPrompt, extra = [], { hash = HASH, method = 'ac9650d8' } = {}) {
    const dir = path.join(root, hash.slice(0, 2), hash.slice(2), method);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${txhash}_prompt.json`);
    fs.writeFileSync(file, promptFile(userPrompt, extra));
    return path.relative(root, file);
}

function writeTrace(root, txhash, body, { hash = HASH, method = 'ac9650d8' } = {}) {
    const dir = path.join(root, hash.slice(0, 2), hash.slice(2), method);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${txhash}.json`);
    fs.writeFileSync(file, JSON.stringify(body));
    return path.relative(root, file);
}

describe('parseArgs', () => {
    it('parses flags', () => {
        assert.deepEqual(parseArgs(['-q', 'approve', '-min', '10', '-max', '99', '-d']), {
            q: [{ term: 'approve' }],
            c: [],
            m: [],
            e: [],
            E: [],
            min: 10,
            max: 99,
            details: true,
            sim: false,
            validationProblems: false,
            random: false,
            stats: false,
            deleteTrace: false,
            deleteSiblings: false,
            deleteResponses: false,
            help: false,
        });
        assert.deepEqual(parseArgs(['-q', 'approve', '-q', 'spender']).q, [
            { term: 'approve' },
            { term: 'spender' },
        ]);
        assert.deepEqual(parseArgs(['-q', 'Events:Approval']).q, [
            { section: 'events', term: 'Approval' },
        ]);
        assert.equal(parseArgs(['-l', '3']).limit, 3);
        assert.equal(parseArgs(['-o', '7']).offset, 7);
        assert.equal(parseArgs(['-r']).random, true);
        assert.equal(parseArgs(['-t', '0']).hasCall, false);
        assert.equal(parseArgs(['-t', '1']).hasCall, true);
        assert.equal(parseArgs(['-s']).sim, true);
        assert.deepEqual(parseArgs(['-x']).deleteTrace, true);
        assert.deepEqual(parseArgs(['-X']), {
            q: [], c: [], m: [], e: [], E: [],
            details: false, sim: false, validationProblems: false, random: false, stats: false,
            deleteTrace: true, deleteSiblings: true, deleteResponses: false, help: false,
        });
        assert.deepEqual(parseArgs(['-s']), {
            q: [],
            c: [],
            m: [],
            e: [],
            E: [],
            details: true,
            sim: true,
            validationProblems: false,
            random: false,
            stats: false,
            deleteTrace: false,
            deleteSiblings: false,
            deleteResponses: false,
            help: false,
        });
        assert.deepEqual(
            parseArgs(['-c', '02', '-c', '0x02A3b2', '-m', '0x095ea7b3', '-m', 'fallback']),
            {
                q: [],
                c: ['02', '02a3b2'],
                m: ['095ea7b3', 'fallback'],
                e: [],
                E: [],
                details: false,
                sim: false,
                validationProblems: false,
                random: false,
                stats: false,
                deleteTrace: false,
                deleteSiblings: false,
                deleteResponses: false,
                help: false,
            },
        );
        assert.deepEqual(parseArgs(['-e', 'events,code', '-E', 'state,tx']), {
            q: [], c: [], m: [],
            e: ['events', 'code'],
            E: ['state', 'tx'],
            details: false, sim: false, validationProblems: false, random: false, stats: false,
            deleteTrace: false, deleteSiblings: false, deleteResponses: false, help: false,
        });
        assert.equal(parseArgs(['-S']).stats, true);
        assert.deepEqual(parseArgs(['-e', 'events', '-e', 'code,events']).e, ['events', 'code']);
        const reset = parseArgs(['-R']);
        assert.equal(reset.deleteResponses, true);
        assert.equal(reset.deleteTrace, false);
        assert.equal(reset.deleteSiblings, false);
        assert.equal(parseArgs(['-v', '-R']).validationProblems, true);
    });

    it('parses help', () => {
        assert.equal(parseArgs(['-h']).help, true);
        assert.equal(parseArgs(['--help']).help, true);
    });

    it('rejects missing values and unknown flags', () => {
        assert.throws(() => parseArgs(['-q', 'events:']), /requires a search string/);
        assert.throws(() => parseArgs(['-min', '-d']), /requires a value/);
        assert.throws(() => parseArgs(['-max', 'nope']), /non-negative integer/);
        assert.throws(() => parseArgs(['-c', 'zz']), /hex codehash prefix/);
        assert.throws(() => parseArgs(['-m', 'approve']), /method id/);
        assert.throws(() => parseArgs(['-t']), /requires 0 or 1/);
        assert.throws(() => parseArgs(['-t', '2']), /requires 0 or 1/);
        assert.throws(() => parseArgs(['-e']), /requires a value/);
        assert.throws(() => parseArgs(['-e', 'logs']), /unknown section/);
        assert.throws(() => parseArgs(['-e', 'tx', '-E', 'tx,state']), /same section/);
        assert.throws(() => parseArgs(['-z']), /unknown flag/);
    });
});

describe('parseCodehashPrefix / parseMethodId', () => {
    it('normalizes hex and 0x', () => {
        assert.equal(parseCodehashPrefix('02'), '02');
        assert.equal(parseCodehashPrefix('0x02A3b2'), '02a3b2');
        assert.equal(parseMethodId('095EA7B3'), '095ea7b3');
        assert.equal(parseMethodId('0x095ea7b3'), '095ea7b3');
        assert.equal(parseMethodId('fallback'), 'fallback');
        assert.equal(parseMethodId('0x'), 'fallback');
    });
});

describe('parseQueryTerm', () => {
    it('treats known prefixes as section filters', () => {
        assert.deepEqual(parseQueryTerm('approve'), { term: 'approve' });
        assert.deepEqual(parseQueryTerm('events:Approval'), { section: 'events', term: 'Approval' });
        assert.deepEqual(parseQueryTerm('tx:SUCCESS'), { section: 'tx', term: 'SUCCESS' });
        assert.deepEqual(parseQueryTerm('foo:bar'), { term: 'foo:bar' });
    });
});

describe('firstUserPrompt', () => {
    it('returns the first userPrompt', () => {
        assert.equal(firstUserPrompt([{ userPrompt: 'one' }, { userPrompt: 'two' }]), 'one');
    });

    it('returns null when missing', () => {
        assert.equal(firstUserPrompt([]), null);
        assert.equal(firstUserPrompt({}), null);
        assert.equal(firstUserPrompt([{ style: 'simple' }]), null);
    });
});

describe('hasTraceCall', () => {
    it('detects .trace.call on collector traces', () => {
        assert.equal(hasTraceCall({ trace: { keccak: [], sstore: [] } }), false);
        assert.equal(hasTraceCall({ trace: { call: { type: 'CALL' } } }), true);
        assert.equal(hasTraceCall({ trace: { call: null } }), false);
        assert.equal(hasTraceCall({}), false);
        assert.equal(hasTraceCall(null), false);
    });
});

describe('matchesBucket', () => {
    const hash = '0201e86aabc33eb086d42a52a29c37acf03ae452e64d595ac464c0f157f35664';

    it('prefixes the full codehash including the first byte', () => {
        assert.equal(matchesBucket(hash, '095ea7b3', { c: ['02'] }), true);
        assert.equal(matchesBucket(hash, '095ea7b3', { c: ['0201'] }), true);
        assert.equal(matchesBucket(hash, '095ea7b3', { c: ['01'] }), false);
        assert.equal(matchesBucket(hash, '095ea7b3', { c: ['02a3'] }), false);
        assert.equal(matchesBucket(hash, '095ea7b3', { c: ['02', '03'] }), true);
        assert.equal(matchesBucket(hash, '095ea7b3', { m: ['095ea7b3'] }), true);
        assert.equal(matchesBucket(hash, '095ea7b3', { m: ['a9059cbb'] }), false);
        assert.equal(matchesBucket(hash, '095ea7b3', { m: ['a9059cbb', '095ea7b3'] }), true);
        assert.equal(matchesBucket(hash, '095ea7b3', { c: ['02'], m: ['a9059cbb'] }), false);
    });
});

describe('matchesFilters', () => {
    const text = 'Function: approve(_spender=0xabc)';

    it('matches substring, min, and max as AND', () => {
        assert.equal(matchesFilters(text, { q: ['approve'] }), true);
        assert.equal(matchesFilters(text, { q: ['Approve'] }), false);
        assert.equal(matchesFilters(text, { q: ['approve', 'spender'] }), true);
        assert.equal(matchesFilters(text, { q: ['approve', 'transfer'] }), false);
        assert.equal(matchesFilters(text, { min: text.length - 1 }), true);
        assert.equal(matchesFilters(text, { min: text.length }), false);
        assert.equal(matchesFilters(text, { max: text.length + 1 }), true);
        assert.equal(matchesFilters(text, { max: text.length }), false);
        assert.equal(matchesFilters(text, { q: ['approve'], min: 5, max: 1000 }), true);
        assert.equal(matchesFilters(text, { q: ['transfer'], min: 5 }), false);
    });

    it('scopes -q to a section when prefixed', () => {
        const prompt = [
            '## Transaction Overview',
            '- Function: approve',
            '## Emitted Events',
            '1. **Approval**',
            '## State Changes',
            '- slot',
            '## Call Trace',
            '1. approve [CALL]',
            '## Contract Source Code (untrusted, for storage interpretation only)',
            'event Approval',
        ].join('\n');

        assert.equal(matchesFilters(prompt, { q: ['events:Approval'] }), true);
        assert.equal(matchesFilters(prompt, { q: ['events:slot'] }), false);
        assert.equal(matchesFilters(prompt, { q: ['tx:approve'] }), true);
        assert.equal(matchesFilters(prompt, { q: ['tx:Approval'] }), false);
        assert.equal(matchesFilters(prompt, { q: ['code:Approval'] }), true);
        assert.equal(matchesFilters(prompt, { q: ['call:CALL'] }), true);
        assert.equal(matchesFilters(prompt, { q: ['state:slot'] }), true);
        assert.equal(matchesFilters(prompt, { q: ['Approval'] }), true);
        assert.equal(matchesFilters(prompt, { q: ['events:Approval', 'tx:approve'] }), true);
        assert.equal(matchesFilters(prompt, { q: ['events:Approval', 'tx:transfer'] }), false);
    });

    it('filters by resolved / unresolved sections', () => {
        const resolved = [
            '## Transaction Overview',
            '- Function: approve()',
            '## Emitted Events',
            '1. **Approval** on 0xabc',
            '## State Changes',
            '- 0xabc: allowance (uint256): 0 -> 1',
            '## Call Trace',
            '1. 0xa -> 0xb: approve(spender=0x1) [CALL]',
            '## Contract Source Code (untrusted, for storage interpretation only)',
            '<<<C4_UNTRUSTED_SOURCE filename="Token.sol">>>',
        ].join('\n');
        const unresolved = [
            '## Transaction Overview',
            '- Function selector: 0x095ea7b3',
            '## Emitted Events',
            '1. Unknown event on 0xabc',
            '## State Changes',
            '- 0x98db...003c: 0x304a...71ec: 1789740407 -> 1789760423',
            '## Call Trace',
            '1. 0xa -> 0xb: 0x095ea7b3 (0 ETH)',
            '## Contract Source Code (untrusted, for storage interpretation only)',
            '<<<C4_UNTRUSTED_SOURCE filename="Token.yul">>>',
        ].join('\n');

        assert.equal(matchesFilters(resolved, { e: ['tx', 'events', 'state', 'call', 'code'] }), true);
        assert.equal(matchesFilters(unresolved, { e: ['events', 'code'] }), false);
        assert.equal(matchesFilters(unresolved, { E: ['state', 'tx'] }), true);
        assert.equal(matchesFilters(resolved, { E: ['tx'] }), false);
        assert.equal(matchesFilters(resolved, { e: ['code'], E: ['tx'] }), false);
        assert.equal(matchesFilters(unresolved, { e: ['code'], E: ['tx'] }), false);
    });
});

describe('isSectionResolved', () => {
    it('tx: decoded name vs Function selector', () => {
        assert.equal(isSectionResolved('## Transaction Overview\n- Function: approve()\n', 'tx'), true);
        assert.equal(isSectionResolved('## Transaction Overview\n- Function selector: 0x095ea7b3\n', 'tx'), false);
        assert.equal(isSectionResolved('## Emitted Events\n1. **Approval**\n', 'tx'), false);
    });

    it('events: majority must not be Unknown event', () => {
        assert.equal(isSectionResolved('## Emitted Events\n1. **Transfer**\n2. **Approval**\n', 'events'), true);
        assert.equal(isSectionResolved('## Emitted Events\n1. **Transfer**\n2. Unknown event on 0xabc\n', 'events'), false);
        assert.equal(isSectionResolved('## Emitted Events\n1. Unknown event on 0xabc\n', 'events'), false);
        assert.equal(isSectionResolved('## Emitted Events\n', 'events'), false);
    });

    it('state: majority must not be slot N or hex storage key', () => {
        assert.equal(isUnresolvedStateChange('- 0x26d8...133c: slot 17: 1 -> 2'), true);
        assert.equal(isUnresolvedStateChange('- 0xeca8...0318: slot 4[0x9b8d...e2f7]: 1 -> 2'), true);
        assert.equal(isUnresolvedStateChange('- 0x98db...003c: 0x304a...71ec: 1789740407 -> 1789760423'), true);
        assert.equal(isUnresolvedStateChange('- WETH (0xc02a...6cc2): balanceOf[0x1f2f...f387] (mapping(address => uint256)): 1 -> 2'), false);

        const named = [
            '## State Changes',
            '- WETH (0xc02a...6cc2): balanceOf[0x1f2f...f387] (mapping(address => uint256)): 1 -> 2',
            '- 0x9b8d...e2f7: unlocked (uint256): 1 -> 1',
        ].join('\n');
        const raw = [
            '## State Changes',
            '- 0x26d8...133c: slot 17: 1 -> 2',
            '- 0x98db...003c: 0x304a...71ec: 1 -> 2',
        ].join('\n');
        const majorityNamed = [
            '## State Changes',
            '- 0x9b8d...e2f7: unlocked (uint256): 1 -> 1',
            '- 0x9b8d...e2f7: reserve0 (uint112): 1 -> 2',
            '- 0x26d8...133c: slot 17: 1 -> 2',
        ].join('\n');
        assert.equal(isSectionResolved(named, 'state'), true);
        assert.equal(isSectionResolved(raw, 'state'), false);
        assert.equal(isSectionResolved(majorityNamed, 'state'), true);
    });

    it('call: majority must not end with a 4-byte selector', () => {
        assert.equal(isUnresolvedCall('1. 0xa -> 0xb: 0x043a9b8d (0 ETH)'), true);
        assert.equal(isUnresolvedCall('1. 0xa -> 0xb: 0x043a9b8d [CALL]'), true);
        assert.equal(isUnresolvedCall('1. 0xa -> 0xb: exchange(i=0x0, j=0x1) [CALL]'), false);
        assert.equal(isSectionResolved('## Call Trace\n1. 0xa -> 0xb: approve() [CALL]\n2. 0xb -> 0xc: 0x095ea7b3 (0 ETH)\n3. 0xb -> 0xd: transfer() [CALL]\n', 'call'), true);
        assert.equal(isSectionResolved('## Call Trace\n1. 0xa -> 0xb: 0x043a9b8d (0 ETH)\n', 'call'), false);
    });

    it('code: at least one Solidity C4 fence', () => {
        assert.equal(isSectionResolved('## Contract Source Code (untrusted, for storage interpretation only)\n<<<C4_UNTRUSTED_SOURCE filename="Perlin.sol">>>\n', 'code'), true);
        assert.equal(isSectionResolved('## Contract Source Code (untrusted, for storage interpretation only)\n<<<C4_UNTRUSTED_SOURCE filename="WithdrawalRequestPredeploy.yul">>>\n', 'code'), false);
        assert.equal(isSectionResolved('## Transaction Overview\n- Function: approve()\n', 'code'), false);
    });
});

describe('parseSectionList', () => {
    it('splits and lowercases section keys', () => {
        assert.deepEqual(parseSectionList('Events, CODE', '-e'), ['events', 'code']);
        assert.throws(() => parseSectionList('', '-e'), /requires a comma-separated list/);
        assert.throws(() => parseSectionList('logs', '-E'), /unknown section/);
    });
});

describe('splitSections / colorizePrompt', () => {
    const prompt = [
        '## Transaction Overview',
        'tx-body',
        '## Emitted Events',
        'ev-body',
    ].join('\n');

    it('splits on known headers', () => {
        const parts = splitSections(prompt);
        assert.deepEqual(parts.map((p) => p.key), ['tx', 'events']);
        assert.match(parts[0].text, /tx-body/);
        assert.match(parts[1].text, /ev-body/);
    });

    it('colorizes each section', () => {
        const out = colorizePrompt(prompt);
        assert.ok(out.includes(`${SECTION_COLOR.tx}## Transaction Overview${RESET}`));
        assert.ok(out.includes(`${SECTION_COLOR.tx}tx-body${RESET}`));
        assert.ok(out.includes(`${SECTION_COLOR.events}## Emitted Events${RESET}`));
        assert.equal(shouldUseColor({ isTTY: true }, {}), true);
        assert.equal(shouldUseColor({ isTTY: true }, { NO_COLOR: '1' }), false);
        assert.equal(shouldUseColor({ isTTY: false }, { FORCE_COLOR: '1' }), true);
    });
});

describe('formatStats', () => {
    it('renders hits, total, and a 2-decimal percent', () => {
        assert.equal(formatStats(1, 4), '1 / 4 (25.00%)');
        assert.equal(formatStats(2, 3), '2 / 3 (66.67%)');
        assert.equal(formatStats(0, 0), '0 / 0 (0.00%)');
        assert.equal(formatStats(0, 10), '0 / 10 (0.00%)');
    });
});

describe('pageHits', () => {
    const hits = ['a', 'b', 'c'];

    it('offsets then limits, shuffle first when random', () => {
        assert.deepEqual(pageHits(hits, { offset: 1 }), ['b', 'c']);
        assert.deepEqual(pageHits(hits, { offset: 1, limit: 1 }), ['b']);
        assert.deepEqual(pageHits(hits, { limit: 0 }), []);
        assert.deepEqual(pageHits(hits, { random: true, rng: () => 0 }), ['b', 'c', 'a']);
        assert.deepEqual(pageHits(hits, { random: true, offset: 1, limit: 1, rng: () => 0 }), ['c']);
        const copy = hits.slice();
        shuffleInPlace(copy, () => 0);
        assert.deepEqual(copy, ['b', 'c', 'a']);
        assert.deepEqual(hits, ['a', 'b', 'c']);
    });
});

describe('formatMatch', () => {
    it('prints path or path plus userPrompt', () => {
        assert.equal(formatMatch('a/b_prompt.json', 'hello', false), 'a/b_prompt.json');
        assert.equal(
            formatMatch('a/b_prompt.json', 'hello', true),
            '=== a/b_prompt.json ===\nhello',
        );
        assert.equal(
            formatMatch('a/b_prompt.json', 'hello', true, true),
            '=== a/b_prompt.json ===\nhello',
        );
    });

    it('appends simulation JSON, light blue when colored', () => {
        const sim = '{\n  "status": "0x1"\n}';
        assert.equal(
            formatMatch('a/b_prompt.json', 'hello', true, false, sim),
            '=== a/b_prompt.json ===\nhello\n## Simulation\n{\n  "status": "0x1"\n}',
        );
        const colored = formatMatch('a/b_prompt.json', 'hello', true, true, sim);
        assert.ok(colored.includes(`${SIM_COLOR}## Simulation${RESET}`));
        assert.ok(colored.includes(`${SIM_COLOR}  "status": "0x1"${RESET}`));
    });

    it('appends response (light green) and validation (magenta) after the sim', () => {
        const plain = formatMatch('a/b_prompt.json', 'hello', true, false, null, {
            responseText: '## Response [simple]\nanswer',
            validationText: '## Validation [simple] ok\n- numbers: pass ratio=1 (2/2)',
        });
        assert.equal(plain,
            '=== a/b_prompt.json ===\nhello\n## Response [simple]\nanswer\n## Validation [simple] ok\n- numbers: pass ratio=1 (2/2)');
        const colored = formatMatch('a/b_prompt.json', 'hello', true, true, '{}', {
            responseText: '## Response [simple]\nanswer',
            validationText: '## Validation [simple] ok',
        });
        assert.ok(colored.includes(`${RESPONSE_COLOR}answer${RESET}`));
        assert.ok(colored.includes(`${VALIDATION_COLOR}## Validation [simple] ok${RESET}`));
        // Order: prompt, sim, response, validation.
        assert.ok(colored.indexOf('## Simulation') < colored.indexOf('## Response'));
        assert.ok(colored.indexOf('## Response') < colored.indexOf('## Validation'));
        // Absent extras add nothing.
        assert.equal(formatMatch('p', 'hello', true, false, null, {}), '=== p ===\nhello');
    });
});

describe('formatResponse / formatValidation', () => {
    it('renders one block per style and flags non-stop finishes', () => {
        const text = formatResponse({
            responses: {
                simple: { model: 'deepseek-v4-pro', content: 'short\n\n', finishReason: 'stop' },
                detailed: { content: 'cut', finishReason: 'length' },
            },
        });
        assert.equal(text, '## Response [simple] (deepseek-v4-pro)\nshort\n## Response [detailed] (finish=length)\ncut');
        assert.equal(formatResponse({ responses: {} }), null);
        assert.equal(formatResponse({ responses: { simple: { content: 42 } } }), null);
    });

    it('renders deterministic + judge lines and the PROBLEM flag', () => {
        const ok = formatValidation({
            checks: {
                simple: {
                    deterministic: { verdict: 'pass', numbers: { ratio: 1, grounded: 3, total: 3, unmatched: [] } },
                    judge: null,
                },
            },
        });
        assert.equal(ok, '## Validation [simple] ok\n- numbers: pass ratio=1 (3/3)');

        const bad = formatValidation({
            checks: {
                simple: {
                    sampled: true,
                    deterministic: { verdict: 'warn', numbers: { ratio: 0.75, grounded: 3, total: 4, unmatched: ['4.93'] } },
                    judge: {
                        model: 'deepseek-v4-pro', score: 3, verdict: 'flawed',
                        issues: [{ type: 'wrong-number', quote: '4.93 USDT', explanation: 'sum not in data' }],
                    },
                },
            },
        });
        assert.equal(bad, [
            '## Validation [simple] PROBLEM',
            '- numbers: warn ratio=0.75 (3/4)',
            '  unmatched: 4.93',
            '- judge: flawed score=3 (deepseek-v4-pro)',
            '  * wrong-number: "4.93 USDT" — sum not in data',
        ].join('\n'));

        const pending = formatValidation({
            checks: { simple: { sampled: true, deterministic: { verdict: 'pass', numbers: { ratio: 1, grounded: 0, total: 0, unmatched: [] } } } },
        });
        assert.match(pending, /judge: sampled, not run yet/);
        assert.equal(formatValidation({ checks: {} }), null);
    });
});

describe('readValidation / hasValidationProblems', () => {
    let root;
    afterEach(() => {
        if (root) fs.rmSync(root, { recursive: true, force: true });
        root = undefined;
    });

    it('derives sibling paths', () => {
        assert.equal(responsePathForPrompt('/x/0xab_prompt.json'), '/x/0xab_response.json');
        assert.equal(validationPathForPrompt('/x/0xab_prompt.json'), '/x/0xab_validation.json');
    });

    it('flags non-pass verdicts and non-good judges; missing file is not a problem', () => {
        assert.equal(hasValidationProblems(null), false);
        assert.equal(hasValidationProblems({ checks: {} }), false);
        assert.equal(hasValidationProblems({ checks: { simple: { deterministic: { verdict: 'pass' }, judge: null } } }), false);
        assert.equal(hasValidationProblems({ checks: { simple: { deterministic: { verdict: 'warn' } } } }), true);
        assert.equal(hasValidationProblems({ checks: { simple: { deterministic: { verdict: 'fail' } } } }), true);
        assert.equal(hasValidationProblems({ checks: { simple: { deterministic: { verdict: 'pass' }, judge: { verdict: 'good' } } } }), false);
        assert.equal(hasValidationProblems({ checks: { simple: { deterministic: { verdict: 'pass' }, judge: { verdict: 'flawed' } } } }), true);
        assert.equal(hasValidationProblems({ checks: { simple: { deterministic: { verdict: 'pass' }, judge: { verdict: 'unparseable' } } } }), true);
        // Style filter.
        const mixed = { checks: { simple: { deterministic: { verdict: 'pass' } }, detailed: { deterministic: { verdict: 'fail' } } } };
        assert.equal(hasValidationProblems(mixed, ['simple']), false);
        assert.equal(hasValidationProblems(mixed, ['detailed']), true);
        assert.equal(hasValidationProblems(mixed), true);
    });

    it('readValidation / readResponse return null for missing or malformed files and warn only on parse errors', () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'q-'));
        const prompt = path.join(root, `${TX_A}_prompt.json`);
        const warns = [];
        assert.equal(readValidation(prompt, (m) => warns.push(m)), null);
        assert.equal(readResponse(prompt, (m) => warns.push(m)), null);
        assert.equal(warns.length, 0, 'ENOENT is silent');
        fs.writeFileSync(validationPathForPrompt(prompt), '{bad');
        fs.writeFileSync(responsePathForPrompt(prompt), '{"responses": "nope"}');
        assert.equal(readValidation(prompt, (m) => warns.push(m)), null);
        assert.equal(readResponse(prompt, (m) => warns.push(m)), null);
        assert.equal(warns.length, 1, 'only the JSON parse error warns');
        fs.writeFileSync(validationPathForPrompt(prompt), JSON.stringify({ checks: { simple: { deterministic: { verdict: 'fail' } } } }));
        assert.equal(readValidation(prompt).checks.simple.deterministic.verdict, 'fail');
    });
});

describe('visitMatchingPrompts', () => {
    let root;

    afterEach(() => {
        if (root) fs.rmSync(root, { recursive: true, force: true });
        root = undefined;
    });

    it('walks buckets and applies filters to the first userPrompt only', () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'query-'));
        const short = writePrompt(root, TX_A, 'approve short');
        const long = writePrompt(root, TX_B, 'approve ' + 'x'.repeat(40));
        writePrompt(root, TX_C, 'transfer only', [{ userPrompt: 'approve hidden' }]);
        fs.writeFileSync(
            path.join(root, HASH.slice(0, 2), HASH.slice(2), 'ac9650d8', `${TX_A}.json`),
            '{}',
        );

        const hits = [];
        visitMatchingPrompts(root, { q: ['approve'], min: 20 }, (hit) => hits.push(hit.relPath));
        assert.deepEqual(hits, [long]);
        assert.ok(!hits.includes(short));
    });

    it('warns and skips invalid JSON', () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'query-'));
        const dir = path.join(root, HASH.slice(0, 2), HASH.slice(2), 'ac9650d8');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${TX_A}_prompt.json`), '{not json');
        const ok = writePrompt(root, TX_B, 'ok');

        const hits = [];
        const warns = [];
        visitMatchingPrompts(root, {}, (hit) => hits.push(hit.relPath), (m) => warns.push(m));
        assert.deepEqual(hits, [ok]);
        assert.equal(warns.length, 1);
        assert.match(warns[0], /skip/);
    });

    it('filters by codehash prefix (including first byte) and method id', () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'query-'));
        const hash02 = '02' + '01'.repeat(31);
        const hash03 = '03' + '01'.repeat(31);
        const in02approve = writePrompt(root, TX_A, 'ok', [], { hash: hash02, method: '095ea7b3' });
        const in02transfer = writePrompt(root, TX_B, 'ok', [], { hash: hash02, method: 'a9059cbb' });
        writePrompt(root, TX_C, 'ok', [], { hash: hash03, method: '095ea7b3' });

        const byPrefix = [];
        visitMatchingPrompts(root, { c: ['02'] }, (hit) => byPrefix.push(hit.relPath));
        assert.deepEqual(new Set(byPrefix), new Set([in02approve, in02transfer]));

        const byLonger = [];
        visitMatchingPrompts(root, { c: ['0201'] }, (hit) => byLonger.push(hit.relPath));
        assert.deepEqual(new Set(byLonger), new Set([in02approve, in02transfer]));

        const restOnly = [];
        visitMatchingPrompts(root, { c: ['01'] }, (hit) => restOnly.push(hit.relPath));
        assert.deepEqual(restOnly, []);

        const byMethod = [];
        visitMatchingPrompts(root, { m: ['095ea7b3'] }, (hit) => byMethod.push(hit.relPath));
        assert.equal(byMethod.length, 2);
        assert.ok(byMethod.includes(in02approve));
        assert.ok(!byMethod.includes(in02transfer));

        const both = [];
        visitMatchingPrompts(root, { c: ['02'], m: ['095ea7b3'] }, (hit) => both.push(hit.relPath));
        assert.deepEqual(both, [in02approve]);
    });

    it('stops after -l matches', () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'query-'));
        writePrompt(root, TX_A, 'ok');
        writePrompt(root, TX_B, 'ok');
        writePrompt(root, TX_C, 'ok');

        const hits = [];
        visitMatchingPrompts(root, { limit: 2 }, (hit) => hits.push(hit.relPath));
        assert.equal(hits.length, 2);

        const none = [];
        visitMatchingPrompts(root, { limit: 0 }, (hit) => none.push(hit.relPath));
        assert.deepEqual(none, []);
    });

    it('applies offset before limit, and shuffles before both when -r', () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'query-'));
        writePrompt(root, TX_A, 'ok');
        writePrompt(root, TX_B, 'ok');
        writePrompt(root, TX_C, 'ok');

        const all = [];
        visitMatchingPrompts(root, {}, (hit) => all.push(hit.relPath));
        assert.equal(all.length, 3);

        const skipped = [];
        visitMatchingPrompts(root, { offset: 1, limit: 1 }, (hit) => skipped.push(hit.relPath));
        assert.deepEqual(skipped, all.slice(1, 2));

        const shuffled = [];
        visitMatchingPrompts(root, { random: true, limit: 2, rng: () => 0 }, (hit) => shuffled.push(hit.relPath));
        assert.deepEqual(
            shuffled,
            pageHits(all, { random: true, limit: 2, rng: () => 0 }),
        );
        assert.equal(shuffled.length, 2);
        assert.ok(shuffled.includes(all[2]) || shuffled[0] !== all[0]);
    });

    it('filters collector traces by .trace.call (-t 0/1)', () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'query-'));
        const noCallPrompt = writePrompt(root, TX_A, 'ok');
        writeTrace(root, TX_A, { trace: { keccak: [], sstore: [] } });
        const withCallPrompt = writePrompt(root, TX_B, 'ok');
        writeTrace(root, TX_B, { trace: { keccak: [], call: { type: 'CALL', from: '0x1' } } });
        const noTracePrompt = writePrompt(root, TX_C, 'ok');

        const missing = [];
        visitMatchingPrompts(root, { hasCall: false }, (hit) => missing.push(hit.relPath));
        assert.deepEqual(new Set(missing), new Set([noCallPrompt, noTracePrompt]));

        const present = [];
        visitMatchingPrompts(root, { hasCall: true }, (hit) => present.push(hit.relPath));
        assert.deepEqual(present, [withCallPrompt]);
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

    function capture() {
        prevExit = process.exitCode;
        process.exitCode = undefined;
        const logs = [];
        const errors = [];
        return {
            logs,
            errors,
            io: {
                log: (m) => logs.push(m),
                error: (m) => errors.push(m),
            },
        };
    }

    it('requires DATA_DIR', () => {
        const { errors, io } = capture();
        main({}, [], io);
        assert.equal(process.exitCode, 1);
        assert.match(errors[0], /DATA_DIR is not set/);
    });

    it('prints help without DATA_DIR', () => {
        const { logs, io } = capture();
        main({}, ['-h'], io);
        assert.equal(process.exitCode, undefined);
        assert.equal(logs[0], HELP);
    });

    it('lists matching relative paths and details', () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'query-'));
        const rel = writePrompt(root, TX_A, 'Function: approve');
        const { logs, io } = capture();
        main({ DATA_DIR: root }, ['-q', 'approve'], io);
        assert.deepEqual(logs, [rel]);

        logs.length = 0;
        main({ DATA_DIR: root, FORCE_COLOR: '0' }, ['-q', 'approve', '-d'], io);
        assert.deepEqual(logs, [`=== ${rel} ===\nFunction: approve`]);

        logs.length = 0;
        main({ DATA_DIR: root }, ['-q', 'approve', '-q', 'Function'], io);
        assert.deepEqual(logs, [rel]);

        logs.length = 0;
        main({ DATA_DIR: root }, ['-q', 'approve', '-q', 'transfer'], io);
        assert.deepEqual(logs, []);
    });

    it('prints hit / dataset counts with -S and skips path listing', () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'query-'));
        writePrompt(root, TX_A, 'Function: approve');
        writePrompt(root, TX_B, 'Function: transfer');
        writePrompt(root, TX_C, 'Function: approve');

        const { logs, io } = capture();
        main({ DATA_DIR: root }, ['-q', 'approve', '-S'], io);
        assert.deepEqual(logs, ['2 / 3 (66.67%)']);

        logs.length = 0;
        main({ DATA_DIR: root }, ['-q', 'approve', '-S', '-c', '22'], io);
        assert.deepEqual(logs, ['0 / 3 (0.00%)']);
    });

    it('prints sibling _sim.json with -s', () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'query-'));
        const rel = writePrompt(root, TX_A, 'Function: approve');
        const abs = path.join(root, rel);
        fs.writeFileSync(simPathForPrompt(abs), JSON.stringify({ status: '0x1', gasUsed: '0x10' }));

        const { logs, errors, io } = capture();
        main({ DATA_DIR: root, FORCE_COLOR: '0' }, ['-s'], io);
        assert.equal(errors.length, 0);
        assert.match(logs[0], /Function: approve/);
        assert.match(logs[0], /## Simulation/);
        assert.match(logs[0], /"status": "0x1"/);
        assert.equal(loadSimText(abs), '{\n  "status": "0x1",\n  "gasUsed": "0x10"\n}');
    });

    it('warns when -s has no sibling sim file', () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'query-'));
        writePrompt(root, TX_A, 'Function: approve');
        const { logs, errors, io } = capture();
        main({ DATA_DIR: root, FORCE_COLOR: '0' }, ['-s'], io);
        assert.match(errors[0], /skip sim/);
        assert.match(logs[0], /Function: approve/);
        assert.equal(logs[0].includes('## Simulation'), false);
    });

    it('deletes only the collector trace with -x', () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'query-'));
        const rel = writePrompt(root, TX_A, 'ok');
        const abs = path.join(root, rel);
        const trace = abs.replace(/_prompt\.json$/, '.json');
        const sim = abs.replace(/_prompt\.json$/, '_sim.json');
        fs.writeFileSync(trace, JSON.stringify({ trace: { keccak: [] } }));
        fs.writeFileSync(sim, '{}');

        const { errors, io } = capture();
        main({ DATA_DIR: root, PROGRESS_EVERY: '1' }, ['-t', '0', '-x'], io);
        assert.equal(fs.existsSync(trace), false);
        assert.equal(fs.existsSync(abs), true);
        assert.equal(fs.existsSync(sim), true);
        assert.match(errors.join('\n'), /delete: done 1 txs, 1 files/);
    });

    it('deletes siblings and prunes empty dirs with -X', () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'query-'));
        const rel = writePrompt(root, TX_A, 'ok');
        const abs = path.join(root, rel);
        const stem = abs.replace(/_prompt\.json$/, '');
        fs.writeFileSync(`${stem}.json`, JSON.stringify({ trace: { keccak: [] } }));
        fs.writeFileSync(`${stem}_sim.json`, '{}');
        fs.writeFileSync(`${stem}_prompt.nosrc`, '{}\n');
        fs.writeFileSync(`${stem}_sim.nosrc`, '{}\n');
        fs.writeFileSync(`${stem}_response.json`, '{"responses":{}}\n');
        fs.writeFileSync(`${stem}_validation.json`, '{"checks":{}}\n');

        const { errors, io } = capture();
        main({ DATA_DIR: root }, ['-t', '0', '-X'], io);
        assert.equal(fs.existsSync(`${stem}.json`), false);
        assert.equal(fs.existsSync(abs), false);
        assert.equal(fs.existsSync(`${stem}_sim.json`), false);
        assert.equal(fs.existsSync(`${stem}_prompt.nosrc`), false);
        assert.equal(fs.existsSync(`${stem}_sim.nosrc`), false);
        assert.equal(fs.existsSync(`${stem}_response.json`), false);
        assert.equal(fs.existsSync(`${stem}_validation.json`), false);
        assert.equal(fs.existsSync(path.join(root, HASH.slice(0, 2))), false);
        assert.equal(fs.existsSync(root), true);
        assert.match(errors.join('\n'), /delete: done 1 txs/);
    });

    it('-R removes only _response.json and _validation.json; combines with -v', () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'query-'));
        const relBad = writePrompt(root, TX_A, 'Function: approve');
        const relOk = writePrompt(root, TX_B, 'Function: approve');
        const relNoResp = writePrompt(root, TX_C, 'Function: approve');
        const stem = (rel) => path.join(root, rel).replace(/_prompt\.json$/, '');
        for (const rel of [relBad, relOk]) {
            fs.writeFileSync(`${stem(rel)}.json`, '{"trace":{}}');
            fs.writeFileSync(`${stem(rel)}_sim.json`, '{}');
            fs.writeFileSync(`${stem(rel)}_response.json`, '{"responses":{}}');
        }
        fs.writeFileSync(`${stem(relBad)}_validation.json`, JSON.stringify({ checks: { simple: { deterministic: { verdict: 'fail' } } } }));
        fs.writeFileSync(`${stem(relOk)}_validation.json`, JSON.stringify({ checks: { simple: { deterministic: { verdict: 'pass' } } } }));

        // Only the flagged tx loses its teacher output.
        let cap = capture();
        main({ DATA_DIR: root }, ['-v', '-R'], cap.io);
        assert.deepEqual(cap.logs, [relBad], 'matching paths are still listed');
        assert.equal(fs.existsSync(`${stem(relBad)}_response.json`), false);
        assert.equal(fs.existsSync(`${stem(relBad)}_validation.json`), false);
        assert.equal(fs.existsSync(`${stem(relBad)}_prompt.json`), true, 'prompt stays');
        assert.equal(fs.existsSync(`${stem(relBad)}_sim.json`), true, 'sim stays');
        assert.equal(fs.existsSync(`${stem(relBad)}.json`), true, 'trace stays');
        assert.equal(fs.existsSync(`${stem(relOk)}_response.json`), true, 'unflagged tx untouched');
        assert.equal(fs.existsSync(`${stem(relOk)}_validation.json`), true);
        assert.match(cap.errors.join('\n'), /reset: done 1 txs, 2 files/);

        // No siblings present → counted as a tx with 0 files, no error.
        cap = capture();
        main({ DATA_DIR: root }, ['-q', 'approve', '-R'], cap.io);
        assert.equal(cap.logs.length, 3);
        assert.match(cap.errors.join('\n'), /reset: done 3 txs, 2 files/);
        assert.equal(fs.existsSync(`${stem(relOk)}_response.json`), false);
        assert.equal(fs.existsSync(`${stem(relNoResp)}_prompt.json`), true);
        assert.equal(fs.existsSync(path.join(root, HASH.slice(0, 2))), true, 'no dir pruning with -R');
    });

    it('-s prints the sibling response and validation when present', () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'query-'));
        const rel = writePrompt(root, TX_A, 'Function: approve');
        const abs = path.join(root, rel);
        fs.writeFileSync(simPathForPrompt(abs), '{"status":"0x1"}');
        fs.writeFileSync(responsePathForPrompt(abs), JSON.stringify({
            responses: { simple: { model: 'deepseek-v4-pro', content: 'It approves.', finishReason: 'stop' } },
        }));
        fs.writeFileSync(validationPathForPrompt(abs), JSON.stringify({
            checks: { simple: { deterministic: { verdict: 'pass', numbers: { ratio: 1, grounded: 1, total: 1, unmatched: [] } }, judge: null } },
        }));

        const { logs, errors, io } = capture();
        main({ DATA_DIR: root, FORCE_COLOR: '0' }, ['-s'], io);
        assert.equal(errors.length, 0);
        const out = logs[0];
        assert.ok(out.indexOf('## Simulation') < out.indexOf('## Response [simple] (deepseek-v4-pro)\nIt approves.'));
        assert.ok(out.indexOf('## Response') < out.indexOf('## Validation [simple] ok\n- numbers: pass ratio=1 (1/1)'));

        // Color: response light green, validation magenta.
        logs.length = 0;
        main({ DATA_DIR: root, FORCE_COLOR: '1' }, ['-s'], io);
        assert.ok(logs[0].includes(`${RESPONSE_COLOR}It approves.${RESET}`));
        assert.ok(logs[0].includes(`${VALIDATION_COLOR}## Validation [simple] ok${RESET}`));

        // -d alone does not load the siblings.
        logs.length = 0;
        main({ DATA_DIR: root, FORCE_COLOR: '0' }, ['-d'], io);
        assert.equal(logs[0].includes('## Response'), false);
        assert.equal(logs[0].includes('## Validation'), false);
    });

    it('-v keeps only txs whose validation reports a problem', () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'query-'));
        const relOk = writePrompt(root, TX_A, 'Function: approve');
        const relWarn = writePrompt(root, TX_B, 'Function: approve');
        const relJudge = writePrompt(root, TX_C, 'Function: transfer');
        writePrompt(root, '0x' + 'dd'.repeat(32), 'Function: approve'); // no validation at all
        const write = (rel, checks) => fs.writeFileSync(validationPathForPrompt(path.join(root, rel)), JSON.stringify({ checks }));
        write(relOk, { simple: { deterministic: { verdict: 'pass' }, judge: { verdict: 'good', score: 5 } } });
        write(relWarn, { simple: { deterministic: { verdict: 'warn' }, judge: null } });
        write(relJudge, { simple: { deterministic: { verdict: 'pass' }, judge: { verdict: 'wrong', score: 2 } } });

        const { logs, io } = capture();
        main({ DATA_DIR: root }, ['-v'], io);
        assert.deepEqual(logs.sort(), [relWarn, relJudge].sort());

        // -v combines with the other filters (AND).
        logs.length = 0;
        main({ DATA_DIR: root }, ['-v', '-q', 'transfer'], io);
        assert.deepEqual(logs, [relJudge]);

        // -S counts against the whole dataset.
        logs.length = 0;
        main({ DATA_DIR: root }, ['-v', '-S'], io);
        assert.deepEqual(logs, ['2 / 4 (50.00%)']);
    });
});
