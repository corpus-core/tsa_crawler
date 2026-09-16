import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    parseArgs,
    resolveCap,
    DEFAULT_CAP,
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
        assert.equal(qualityScore({}), 1);
        assert.equal(clusterKey('a9059cbb', transferFp), `a9059cbb:${transferFp}`);
    });

    it('higher qualityScore evicts a lower one when CAP is full', () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-'));
        writePrompt(root, TX_A, wrapSource(ERC20_BASE));
        writePrompt(root, TX_B, wrapSource(ERC20_BASE));
        const { candidates } = collectCandidates(root, {
            qualityScore: (hit) => hit.relPath.includes(TX_B) ? 9 : 1,
        });
        const { kept, dropped } = selectByCap(candidates, 1);
        assert.equal(kept.length, 1);
        assert.ok(kept[0].relPath.includes(TX_B));
        assert.ok(dropped[0].relPath.includes(TX_A));
    });

    it('copyKeepers preserves layout and drops stale prompts', () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-'));
        const rel = writePrompt(root, TX_A, wrapSource(ERC20_BASE));
        const out = path.join(root, 'train');
        const stale = writePrompt(out, TX_B, wrapSource(ERC20_BASE));
        const { candidates } = collectCandidates(root);
        const kept = candidates.filter((c) => c.relPath === rel);
        copyKeepers(out, kept);
        assert.equal(fs.existsSync(path.join(out, rel)), true);
        assert.equal(fs.existsSync(path.join(out, stale)), false);
        const copied = JSON.parse(fs.readFileSync(path.join(out, rel), 'utf8'));
        assert.equal(copied[0].style, 'simple');
        assert.equal(copied[0].userPrompt, copied[1].userPrompt);
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
        const out = path.join(root, 'train');

        const { logs, io } = capture();
        main({ DATA_DIR: root }, ['--dry-run'], io);
        assert.equal(process.exitCode, undefined);
        assert.equal(fs.existsSync(out), false);
        assert.match(logs[0], /kept: 2/);
        assert.match(logs[0], /dropped: 0/);
        assert.match(logs[0], /cap: 5/);

        logs.length = 0;
        main({ DATA_DIR: root }, ['--out', out, '--keep', '1'], io);
        assert.equal(fs.existsSync(path.join(out, relA)), true);
        const prompts = [];
        for (const c of collectCandidates(out).candidates) prompts.push(c.relPath);
        assert.deepEqual(prompts, [relA]);
        const manifest = JSON.parse(fs.readFileSync(path.join(out, MANIFEST_NAME), 'utf8'));
        assert.equal(manifest.cap, 1);
        assert.equal(manifest.kept.length, 1);
        assert.equal(manifest.kept[0].relPath, relA);
        assert.equal(manifest.kept[0].txFunction, 'transfer');
    });
});
