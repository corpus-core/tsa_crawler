import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    parseArgs,
    resolveCap,
    resolveProgressEvery,
    resolveRequireResolved,
    DEFAULT_CAP,
    DEFAULT_PROGRESS_EVERY,
    HELP,
    qualityScore,
    extractSourceBodies,
    hasUsableSource,
    extractSignatures,
    interfaceFingerprint,
    clusterKey,
    collectCandidates,
    selectByCap,
    compareKeep,
    assertSafeOutDir,
    copyKeepers,
    formatMetrics,
    writeMetrics,
    main,
    MANIFEST_NAME,
} from '../src/dedup.mjs';

const TX_A = '0x' + 'aa'.repeat(32);
const TX_B = '0x' + 'bb'.repeat(32);
const TX_C = '0x' + 'cc'.repeat(32);
const TX_D = '0x' + 'dd'.repeat(32);
const HASH_A = '11'.repeat(32);
const HASH_B = '22'.repeat(32);

const ERC20_BASE = `
contract Token {
    string public name = "FOO";
    function transfer(address to, uint256 amount) public returns (bool) { return true; }
    function approve(address spender, uint256 amount) public returns (bool) { return true; }
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
}
`;

function wrapSource(code, filename = 'Token.sol') {
    return [
        '## Transaction Overview',
        '- Status: SUCCESS',
        '- From: 0x1111...1111',
        '- To: 0x2222...2222',
        '- Function: transfer(to=0x1, amount=1)',
        '- Gas used: 1',
        '',
        '## Contract Source Code (untrusted, for storage interpretation only)',
        '',
        '### Token (0x2222...2222)',
        `\`${filename}\`:`,
        `<<<C4_UNTRUSTED_SOURCE filename="${filename}">>>`,
        code,
        '<<<C4_END_UNTRUSTED_SOURCE>>>',
        '',
        'Please explain what this transaction would do.',
    ].join('\n');
}

function promptFile(userPrompt) {
    return JSON.stringify([
        { style: 'simple', systemPrompt: 'simple', userPrompt },
        { style: 'detailed', systemPrompt: 'detailed', userPrompt },
    ]);
}

function writePrompt(root, txhash, userPrompt, { hash = HASH_A, method = 'a9059cbb' } = {}) {
    const dir = path.join(root, hash.slice(0, 2), hash.slice(2), method);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${txhash}_prompt.json`);
    fs.writeFileSync(file, promptFile(userPrompt));
    return path.relative(root, file);
}

function numbered(n, line) {
    return Array.from({ length: n }, (_, i) => `${i + 1}. ${line}`).join('\n');
}

function bullets(n, line) {
    return Array.from({ length: n }, () => `- ${line}`).join('\n');
}

function scoredPrompt({
    gas = '1',
    eventCount = 0,
    callCount = 0,
    moreCalls = 0,
    stateCount = 0,
    code = ERC20_BASE,
} = {}) {
    const parts = [
        '## Transaction Overview',
        '- Status: SUCCESS',
        '- From: 0x1111...1111',
        '- To: 0x2222...2222',
        '- Function: transfer(to=0x1, amount=1)',
        `- Gas used: ${gas}`,
    ];
    if (eventCount) {
        parts.push('', '## Emitted Events', numbered(eventCount, '**Transfer** on 0x2222...2222'));
    }
    if (stateCount) {
        parts.push('', '## State Changes', bullets(stateCount, '0x2222...2222: slot 1: 0 -> 1'));
    }
    if (callCount || moreCalls) {
        const lines = ['', '## Call Trace'];
        if (callCount) lines.push(numbered(callCount, '0x1111...1111 -> 0x2222...2222: transfer(to=0x1, amount=1) [CALL]'));
        if (moreCalls) lines.push(`... and ${moreCalls} more calls`);
        parts.push(...lines);
    }
    parts.push(
        '',
        '## Contract Source Code (untrusted, for storage interpretation only)',
        '',
        '### Token (0x2222...2222)',
        '`Token.sol`:',
        '<<<C4_UNTRUSTED_SOURCE filename="Token.sol">>>',
        code,
        '<<<C4_END_UNTRUSTED_SOURCE>>>',
        '',
        'Please explain what this transaction would do.',
    );
    return parts.join('\n');
}

function capture() {
    const prevExit = process.exitCode;
    process.exitCode = undefined;
    const logs = [];
    const errors = [];
    return {
        prevExit,
        logs,
        errors,
        io: {
            log: (m) => logs.push(m),
            error: (m) => errors.push(m),
        },
    };
}

describe('parseArgs / resolveCap', () => {
    it('parses flags', () => {
        assert.deepEqual(parseArgs(['--dry-run', '--out', '/tmp/x', '--keep', '3']), {
            dryRun: true,
            help: false,
            out: '/tmp/x',
            keep: 3,
        });
        assert.equal(parseArgs(['-h']).help, true);
    });

    it('rejects bad flags', () => {
        assert.throws(() => parseArgs(['--keep']), /requires a value/);
        assert.throws(() => parseArgs(['--keep', '0']), /positive integer/);
        assert.throws(() => parseArgs(['--nope']), /unknown flag/);
    });

    it('resolves CAP with --keep winning over env', () => {
        assert.equal(resolveCap({}, {}), DEFAULT_CAP);
        assert.equal(resolveCap({ CAP: '8' }, {}), 8);
        assert.equal(resolveCap({ CAP: '8' }, { keep: 2 }), 2);
        assert.throws(() => resolveCap({ CAP: '0' }, {}), /positive integer/);
    });

    it('resolves PROGRESS_EVERY', () => {
        assert.equal(resolveProgressEvery({}), DEFAULT_PROGRESS_EVERY);
        assert.equal(resolveProgressEvery({ PROGRESS_EVERY: '1' }), 1);
        assert.equal(resolveProgressEvery({ PROGRESS_EVERY: '0' }), 0);
        assert.equal(resolveProgressEvery({ PROGRESS_EVERY: 'nope' }), DEFAULT_PROGRESS_EVERY);
    });
});

describe('source + signatures', () => {
    it('extracts C4 bodies and ignores wrappers', () => {
        const bodies = extractSourceBodies(wrapSource('contract C {}'));
        assert.equal(bodies.length, 1);
        assert.match(bodies[0], /contract C \{\}/);
        assert.equal(hasUsableSource(wrapSource('  ')), false);
        assert.equal(hasUsableSource('## Contract Source Code\nno markers'), false);
    });

    it('canonicalizes public functions and events; strips comments and strings', () => {
        const a = extractSignatures(ERC20_BASE).sort();
        const b = extractSignatures(`
            /* natspec */
            contract Other {
                string public name = "BAR"; // different token
                function transfer(address recipient, uint amount) public returns (bool) { return true; }
                function approve(address s, uint256 a) public returns (bool) { return false; }
                event Transfer(address indexed from, address indexed to, uint256 value);
                event Approval(address indexed owner, address indexed spender, uint256 value);
            }
        `).sort();
        assert.deepEqual(a, b);
        assert.ok(a.includes('function:transfer(address,uint256)'));
        assert.ok(a.includes('function:approve(address,uint256)'));
        assert.ok(a.includes('event:Transfer(address,address,uint256)'));
        assert.equal(interfaceFingerprint(wrapSource(ERC20_BASE)), interfaceFingerprint(wrapSource(`
            contract Clone { string public name = "X";
            function transfer(address to, uint256 amount) public returns (bool) {}
            function approve(address spender, uint256 amount) public returns (bool) {}
            event Transfer(address indexed from, address indexed to, uint256 value);
            event Approval(address indexed owner, address indexed spender, uint256 value); }
        `)));
    });

    it('splits on extra public mint; ignores extra internal function', () => {
        const base = new Set(extractSignatures(ERC20_BASE));
        const minted = new Set(extractSignatures(ERC20_BASE + `
            function mint(address to, uint256 amount) public {}
        `));
        const internalOnly = new Set(extractSignatures(ERC20_BASE + `
            function _mint(address to, uint256 amount) internal {}
        `));
        assert.ok(minted.has('function:mint(address,uint256)'));
        assert.notEqual(interfaceFingerprint(wrapSource(ERC20_BASE)),
            interfaceFingerprint(wrapSource(ERC20_BASE + ' function mint(address to, uint256 amount) public {}')));
        assert.deepEqual([...internalOnly].sort(), [...base].sort());
    });

    it('skips constructor and private functions', () => {
        const sigs = extractSignatures(`
            contract C {
                constructor(string memory n) {}
                function hidden() private {}
                function secret() internal view returns (uint256) { return 1; }
                function visible(address a) external {}
                fallback() external payable {}
                receive() external payable {}
            }
        `);
        assert.deepEqual(sigs.sort(), [
            'fallback()',
            'function:visible(address)',
            'receive()',
        ]);
    });
});

describe('qualityScore', () => {
    it('returns 0 without a userPrompt', () => {
        assert.equal(qualityScore({}), 0);
        assert.equal(qualityScore({ userPrompt: 1 }), 0);
    });

    it('parses en-US gas commas and weights events, calls, and state changes', () => {
        const userPrompt = scoredPrompt({
            gas: '46,622',
            eventCount: 1,
            callCount: 1,
            stateCount: 0,
        });
        assert.equal(qualityScore({ userPrompt }), 46622 / 100000 + 1 / 3 + 1 / 5);
    });

    it('adds truncated call-trace remainder from the more-calls line', () => {
        const userPrompt = scoredPrompt({
            gas: '100,000',
            eventCount: 3,
            callCount: 20,
            moreCalls: 7,
            stateCount: 10,
        });
        assert.equal(qualityScore({ userPrompt }), 1 + 1 + 27 / 5 + 1);
    });
});

describe('selectByCap / compareKeep', () => {
    it('keeps highest score; ties use relPath', () => {
        const a = { relPath: 'a/x', cluster: 'c', score: 1 };
        const b = { relPath: 'b/x', cluster: 'c', score: 3 };
        const c = { relPath: 'c/x', cluster: 'c', score: 3 };
        assert.ok(compareKeep(b, a) < 0);
        const { kept, dropped } = selectByCap([a, b, c], 1);
        assert.deepEqual(kept.map((x) => x.relPath), ['b/x']);
        assert.equal(dropped.length, 2);
    });

    it('equal scores keep the lexicographically first relPath', () => {
        const { kept, dropped } = selectByCap([
            { relPath: 'zz.json', cluster: 'c', score: 1 },
            { relPath: 'aa.json', cluster: 'c', score: 1 },
        ], 1);
        assert.deepEqual(kept.map((x) => x.relPath), ['aa.json']);
        assert.deepEqual(dropped.map((x) => x.relPath), ['zz.json']);
        assert.equal(kept[0].pinned, false);
    });

    it('pinned keepers take slots before a higher score, still within cap', () => {
        const low = { relPath: 'low.json', cluster: 'c', score: 1 };
        const mid = { relPath: 'mid.json', cluster: 'c', score: 5 };
        const high = { relPath: 'high.json', cluster: 'c', score: 9 };
        const pinned = new Set(['low.json', 'mid.json']);
        const { kept, dropped } = selectByCap([high, low, mid], 2, { pinned });
        assert.deepEqual(kept.map((x) => x.relPath), ['low.json', 'mid.json']);
        assert.deepEqual(kept.map((x) => x.pinned), [true, true]);
        assert.deepEqual(dropped.map((x) => x.relPath), ['high.json']);
        assert.equal(dropped[0].pinned, false);
        // Cap still applies among the pinned themselves (score order).
        const tight = selectByCap([high, low, mid], 1, { pinned });
        assert.deepEqual(tight.kept.map((x) => x.relPath), ['mid.json']);
        // Without the set, score wins as before.
        assert.deepEqual(selectByCap([high, low, mid], 1).kept.map((x) => x.relPath), ['high.json']);
    });
});

describe('collectCandidates + copy', () => {
    let root;
    afterEach(() => {
        if (root) fs.rmSync(root, { recursive: true, force: true });
        root = undefined;
        process.exitCode = undefined;
    });

    it('clusters ERC20 clones, splits mint and method_id, skips nosrc/no-code', () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-'));
        const cloneA = writePrompt(root, TX_A, wrapSource(ERC20_BASE), { hash: HASH_A, method: 'a9059cbb' });
        const cloneB = writePrompt(root, TX_B, wrapSource(`
            // BAR token
            contract BAR { string public name = "BAR";
            function transfer(address to, uint256 amount) public returns (bool) { return true; }
            function approve(address spender, uint256 amount) public returns (bool) { return true; }
            event Transfer(address indexed from, address indexed to, uint256 value);
            event Approval(address indexed owner, address indexed spender, uint256 value); }
        `), { hash: HASH_B, method: 'a9059cbb' });
        const approve = writePrompt(root, TX_C, wrapSource(ERC20_BASE), { hash: HASH_A, method: '095ea7b3' });
        const minted = writePrompt(root, TX_D, wrapSource(ERC20_BASE + `
            function mint(address to, uint256 amount) public {}
        `), { hash: HASH_B, method: 'a9059cbb' });

        const noCode = writePrompt(root, '0x' + 'ee'.repeat(32),
            '## Transaction Overview\n- Function: transfer(to=0x1, amount=1)\n',
            { hash: HASH_A, method: 'a9059cbb' });
        const nosrcDir = path.join(root, HASH_A.slice(0, 2), HASH_A.slice(2), 'a9059cbb');
        fs.writeFileSync(path.join(nosrcDir, `${'0x' + 'ff'.repeat(32)}_prompt.nosrc`), '{}\n');

        const { candidates, scanned, skippedNocode } = collectCandidates(root);
        assert.equal(scanned, 5);
        assert.equal(skippedNocode, 1);
        assert.equal(candidates.length, 4);
        assert.ok(!candidates.some((c) => c.relPath === noCode));

        const transferFp = candidates.find((c) => c.relPath === cloneA).fingerprint;
        assert.equal(candidates.find((c) => c.relPath === cloneB).fingerprint, transferFp);
        assert.equal(candidates.find((c) => c.relPath === cloneA).cluster,
            candidates.find((c) => c.relPath === cloneB).cluster);
        assert.notEqual(candidates.find((c) => c.relPath === approve).cluster,
            candidates.find((c) => c.relPath === cloneA).cluster);
        assert.notEqual(candidates.find((c) => c.relPath === minted).fingerprint, transferFp);

        const { kept } = selectByCap(candidates, 1);
        const transferKept = kept.filter((k) => k.methodId === 'a9059cbb' && k.fingerprint === transferFp);
        assert.equal(transferKept.length, 1);
        assert.equal(transferKept[0].relPath, cloneA);
        assert.equal(clusterKey('a9059cbb', transferFp), `a9059cbb:${transferFp}`);
    });

    it('higher qualityScore evicts a lower one when CAP is full', () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-'));
        writePrompt(root, TX_A, scoredPrompt({ gas: '1' }));
        writePrompt(root, TX_B, scoredPrompt({ gas: '200,000', eventCount: 3 }));
        const { candidates } = collectCandidates(root);
        const { kept, dropped } = selectByCap(candidates, 1);
        assert.equal(kept.length, 1);
        assert.ok(kept[0].relPath.includes(TX_B));
        assert.ok(dropped[0].relPath.includes(TX_A));
        assert.ok(kept[0].score > dropped[0].score);
    });

    it('copyKeepers preserves layout, copies sibling sims, and drops stale files', () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-'));
        const rel = writePrompt(root, TX_A, wrapSource(ERC20_BASE));
        const simRel = rel.replace(/_prompt\.json$/, '_sim.json');
        fs.writeFileSync(path.join(root, simRel), JSON.stringify({ status: '0x1' }));
        const out = path.join(root, 'train');
        const stale = writePrompt(out, TX_B, wrapSource(ERC20_BASE));
        const staleSim = stale.replace(/_prompt\.json$/, '_sim.json');
        fs.writeFileSync(path.join(out, staleSim), '{}');
        const { candidates } = collectCandidates(root);
        const kept = candidates.filter((c) => c.relPath === rel);
        const stats = copyKeepers(out, kept);
        assert.deepEqual(stats, { prompts: 1, sims: 1 });
        assert.equal(fs.existsSync(path.join(out, rel)), true);
        assert.equal(fs.existsSync(path.join(out, simRel)), true);
        assert.equal(fs.existsSync(path.join(out, stale)), false);
        assert.equal(fs.existsSync(path.join(out, staleSim)), false);
        const copied = JSON.parse(fs.readFileSync(path.join(out, rel), 'utf8'));
        assert.equal(copied[0].style, 'simple');
        assert.equal(copied[0].userPrompt, copied[1].userPrompt);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, simRel), 'utf8')), { status: '0x1' });
    });

    it('copyKeepers skips a missing sibling sim', () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-'));
        const rel = writePrompt(root, TX_A, wrapSource(ERC20_BASE));
        const stats = copyKeepers(path.join(root, 'train'), [{ relPath: rel, absPath: path.join(root, rel) }]);
        assert.deepEqual(stats, { prompts: 1, sims: 0 });
        assert.equal(fs.existsSync(path.join(root, 'train', rel)), true);
    });

    it('refuses OUT equal to DATA_DIR', () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-'));
        assert.throws(() => assertSafeOutDir(root, root), /must not be DATA_DIR/);
        assert.throws(() => assertSafeOutDir(path.join(root, 'data'), root), /must not contain DATA_DIR/);
        assert.doesNotThrow(() => assertSafeOutDir(root, path.join(root, 'train')));
    });
});

describe('main', () => {
    let root;
    afterEach(() => {
        if (root) fs.rmSync(root, { recursive: true, force: true });
        root = undefined;
        process.exitCode = undefined;
    });

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

    it('dry-run does not copy; --keep 1 writes one file and a manifest', () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-'));
        const relA = writePrompt(root, TX_A, wrapSource(ERC20_BASE), { hash: HASH_A });
        writePrompt(root, TX_B, wrapSource(ERC20_BASE), { hash: HASH_B });
        const simA = relA.replace(/_prompt\.json$/, '_sim.json');
        fs.writeFileSync(path.join(root, simA), JSON.stringify({ gasUsed: '0x10' }));
        const out = path.join(root, 'train');

        const { logs, io } = capture();
        main({ DATA_DIR: root, PROGRESS_EVERY: '1' }, ['--dry-run'], io);
        assert.equal(process.exitCode, undefined);
        assert.equal(fs.existsSync(out), false);
        assert.match(logs.join('\n'), /dedup: scanning /);
        assert.match(logs.join('\n'), /dedup: scanned 1 \.\.\./);
        assert.match(logs.join('\n'), /dedup: scanned 2, \d+ clusters/);
        assert.match(logs.join('\n'), /dedup: scanning /);
        assert.match(logs.join('\n'), /kept: 2/);
        assert.match(logs.join('\n'), /dropped: 0/);
        assert.match(logs.join('\n'), /cap: 5/);

        logs.length = 0;
        main({ DATA_DIR: root }, ['--out', out, '--keep', '1'], io);
        assert.match(logs.join('\n'), /dedup: copying 1 prompts /);
        assert.equal(fs.existsSync(path.join(out, relA)), true);
        assert.equal(fs.existsSync(path.join(out, simA)), true);
        const prompts = [];
        for (const c of collectCandidates(out).candidates) prompts.push(c.relPath);
        assert.deepEqual(prompts, [relA]);
        const manifest = JSON.parse(fs.readFileSync(path.join(out, MANIFEST_NAME), 'utf8'));
        assert.equal(manifest.cap, 1);
        assert.equal(manifest.kept.length, 1);
        assert.equal(manifest.kept[0].relPath, relA);
        assert.equal(manifest.kept[0].txFunction, 'transfer');
        assert.equal(manifest.kept[0].pinned, false);
    });

    it('REQUIRE_RESOLVED skips candidates whose section is not decoded', () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-'));
        const decoded = writePrompt(root, TX_A, wrapSource(ERC20_BASE), { hash: HASH_A });
        const selector = wrapSource(ERC20_BASE).replace(
            '- Function: transfer(to=0x1, amount=1)',
            '- Function selector: 0xa9059cbb',
        );
        writePrompt(root, TX_B, selector, { hash: HASH_B });
        const open = collectCandidates(root);
        assert.equal(open.candidates.length, 2);
        assert.equal(open.skippedUnresolved, 0);
        const filtered = collectCandidates(root, { requireResolved: ['tx'] });
        assert.equal(filtered.skippedUnresolved, 1);
        assert.deepEqual(filtered.candidates.map((c) => c.relPath), [decoded]);
        assert.throws(() => resolveRequireResolved({ REQUIRE_RESOLVED: 'nope' }), /unknown section/);
        assert.deepEqual(resolveRequireResolved({}), []);
        assert.deepEqual(resolveRequireResolved({ REQUIRE_RESOLVED: '' }), []);
        assert.deepEqual(resolveRequireResolved({ REQUIRE_RESOLVED: 'tx,events' }), ['tx', 'events']);
    });

    it('STICKY keeps the answered tx even when a richer one arrives', () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-'));
        const low = writePrompt(root, TX_A, scoredPrompt({ gas: '1' }), { hash: HASH_A });
        writePrompt(root, TX_B, scoredPrompt({ gas: '200,000', eventCount: 3 }), { hash: HASH_B });
        const out = path.join(root, 'train');
        const answered = path.join(out, low);
        fs.mkdirSync(path.dirname(answered), { recursive: true });
        fs.writeFileSync(answered, fs.readFileSync(path.join(root, low)));
        fs.writeFileSync(answered.replace(/_prompt\.json$/, '_response.json'), JSON.stringify({
            responses: { simple: { content: 'paid answer', finishReason: 'stop' } },
        }));

        const { logs, io } = capture();
        main({ DATA_DIR: root, OUT: out, STICKY: '1', CAP: '1' }, [], io);
        assert.match(logs.join('\n'), /pinned: 1/);
        assert.equal(fs.existsSync(path.join(out, low)), true);
        const manifest = JSON.parse(fs.readFileSync(path.join(out, MANIFEST_NAME), 'utf8'));
        assert.equal(manifest.kept.length, 1);
        assert.equal(manifest.kept[0].relPath, low);
        assert.equal(manifest.kept[0].pinned, true);
        // The paid answer survived the keep-set rewrite.
        assert.equal(fs.existsSync(answered.replace(/_prompt\.json$/, '_response.json')), true);
    });

    it('writes PROM_FILE after a completed run, including dry-run', () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-'));
        writePrompt(root, TX_A, wrapSource(ERC20_BASE), { hash: HASH_A });
        writePrompt(root, TX_B, wrapSource(ERC20_BASE), { hash: HASH_B });
        const prom = path.join(root, 'trace_dedup_mainnet.prom');
        const { io } = capture();
        main({ DATA_DIR: root, PROM_FILE: prom, CHAIN: 'sepolia' }, ['--dry-run', '--keep', '1'], io);
        assert.equal(fs.existsSync(prom + '.tmp'), false);
        const body = fs.readFileSync(prom, 'utf8');
        assert.match(body, /trace_dedup_scanned\{chain="sepolia"\} 2/);
        assert.match(body, /trace_dedup_kept\{chain="sepolia"\} 1/);
        assert.match(body, /trace_dedup_dropped\{chain="sepolia"\} 1/);
        assert.match(body, /trace_dedup_copied\{chain="sepolia"\} 0/);
        assert.match(body, /trace_dedup_dry_run\{chain="sepolia"\} 1/);
        assert.match(body, /trace_dedup_last_run_timestamp\{chain="sepolia"\} \d+/);
        assert.equal(body.endsWith('\n'), true);

        const out = path.join(root, 'train');
        main({ DATA_DIR: root, PROM_FILE: prom, CHAIN: 'sepolia' }, ['--out', out, '--keep', '1'], io);
        const after = fs.readFileSync(prom, 'utf8');
        assert.match(after, /trace_dedup_copied\{chain="sepolia"\} 1/);
        assert.match(after, /trace_dedup_copied_sim\{chain="sepolia"\} 0/);
        assert.match(after, /trace_dedup_dry_run\{chain="sepolia"\} 0/);
    });

    it('does not write PROM_FILE on help', () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-'));
        const prom = path.join(root, 'unused.prom');
        const { io } = capture();
        main({ PROM_FILE: prom }, ['-h'], io);
        assert.equal(fs.existsSync(prom), false);
    });
});

describe('formatMetrics / writeMetrics', () => {
    it('renders last-run gauges with a trailing newline', () => {
        const body = formatMetrics({
            scanned: 10,
            skippedNocode: 2,
            skippedBad: 1,
            clusters: 3,
            kept: 4,
            dropped: 3,
            cap: 5,
            copied: 4,
            copiedSim: 4,
            lastRunTs: 1700000000,
            dryRun: false,
        }, 'mainnet');
        assert.match(body, /# TYPE trace_dedup_scanned gauge/);
        assert.match(body, /trace_dedup_scanned\{chain="mainnet"\} 10/);
        assert.match(body, /trace_dedup_skipped_nocode\{chain="mainnet"\} 2/);
        assert.match(body, /trace_dedup_cap\{chain="mainnet"\} 5/);
        assert.match(body, /trace_dedup_copied_sim\{chain="mainnet"\} 4/);
        assert.equal(body.endsWith('\n'), true);
    });

    it('is a no-op without PROM_FILE and writes atomically when set', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-prom-'));
        try {
            writeMetrics('', { scanned: 1, skippedNocode: 0, skippedBad: 0, clusters: 1, kept: 1, dropped: 0, cap: 1, copied: 1, lastRunTs: 1 });
            const prom = path.join(dir, 'm.prom');
            writeMetrics(prom, { scanned: 1, skippedNocode: 0, skippedBad: 0, clusters: 1, kept: 1, dropped: 0, cap: 1, copied: 1, lastRunTs: 1 });
            assert.equal(fs.existsSync(prom + '.tmp'), false);
            assert.match(fs.readFileSync(prom, 'utf8'), /trace_dedup_scanned\{chain="mainnet"\} 1/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
