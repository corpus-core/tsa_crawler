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
    firstUserPrompt,
    matchesBucket,
    matchesFilters,
    splitSections,
    colorizePrompt,
    formatMatch,
    shouldUseColor,
    visitMatchingPrompts,
    pageHits,
    shuffleInPlace,
    simPathForPrompt,
    loadSimText,
    hasTraceCall,
    main,
    HELP,
    SECTION_COLOR,
    SIM_COLOR,
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
            min: 10,
            max: 99,
            details: true,
            sim: false,
            random: false,
            deleteTrace: false,
            deleteSiblings: false,
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
            q: [], c: [], m: [],
            details: false, sim: false, random: false,
            deleteTrace: true, deleteSiblings: true, help: false,
        });
        assert.deepEqual(parseArgs(['-s']), {
            q: [],
            c: [],
            m: [],
            details: true,
            sim: true,
            random: false,
            deleteTrace: false,
            deleteSiblings: false,
            help: false,
        });
        assert.deepEqual(
            parseArgs(['-c', '02', '-c', '0x02A3b2', '-m', '0x095ea7b3', '-m', 'fallback']),
            {
                q: [],
                c: ['02', '02a3b2'],
                m: ['095ea7b3', 'fallback'],
                details: false,
                sim: false,
                random: false,
                deleteTrace: false,
                deleteSiblings: false,
                help: false,
            },
        );
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

        const { errors, io } = capture();
        main({ DATA_DIR: root }, ['-t', '0', '-X'], io);
        assert.equal(fs.existsSync(`${stem}.json`), false);
        assert.equal(fs.existsSync(abs), false);
        assert.equal(fs.existsSync(`${stem}_sim.json`), false);
        assert.equal(fs.existsSync(`${stem}_prompt.nosrc`), false);
        assert.equal(fs.existsSync(`${stem}_sim.nosrc`), false);
        assert.equal(fs.existsSync(path.join(root, HASH.slice(0, 2))), false);
        assert.equal(fs.existsSync(root), true);
        assert.match(errors.join('\n'), /delete: done 1 txs/);
    });
});
