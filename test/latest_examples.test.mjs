import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    backfillLatestExamples,
    contractNameForAddress,
    contractNameFromPrompt,
    contractNameFromSources,
    exampleEntry,
    functionNameFromPrompt,
    latestLimit,
    pushLatest,
    recordLatestExample,
    simRelPath,
    txhashOf,
} from '../src/latest_examples.mjs';

const HASH = '0x' + 'ab'.repeat(32);

const PROMPT = `## Transaction Overview
- Status: SUCCESS
- From: 0x6fdb...5312
- To: 0xad37...d718
- Function: stakeWithPermit(account=0x6fdb, amount=1)
- Gas used: 200,055

## Emitted Events
1. **Staked** on 0xad37...d718
`;

describe('functionNameFromPrompt', () => {
    it('reads the decoded name from the transaction section', () => {
        assert.equal(functionNameFromPrompt(PROMPT), 'stakeWithPermit');
    });

    it('ignores a later call that repeats Function:', () => {
        const text = PROMPT + '\n## Call Trace\n- Function: transfer(to=0x1)\n';
        assert.equal(functionNameFromPrompt(text), 'stakeWithPermit');
    });

    it('falls back to the selector when the call did not decode', () => {
        const text = '## Transaction Overview\n- Function selector: 0x095ea7b3\n\n## Emitted Events\n';
        assert.equal(functionNameFromPrompt(text), '0x095ea7b3');
    });
});

describe('contractNameFromSources', () => {
    it('prefers a non-vendor contract over OpenZeppelin', () => {
        const name = contractNameFromSources({
            '@openzeppelin/contracts/access/Ownable.sol': { content: 'contract Ownable {' },
            'contracts/DAOStaking.sol': { content: 'contract DAOStaking is Ownable {' },
        });
        assert.equal(name, 'DAOStaking');
    });

    it('uses contractName when the metadata still has it', () => {
        const contracts = new Map([
            ['0xad37', { contractName: 'WETH', sources: { 'X.sol': { content: 'contract Other {' } } }],
        ]);
        assert.equal(contractNameForAddress(contracts, '0xAD37'), 'WETH');
    });
});

describe('pushLatest', () => {
    it('drops the oldest entry once the cap is reached and moves a repeat to the end', () => {
        let list = [];
        for (const txhash of ['0x1', '0x2', '0x3']) {
            list = pushLatest(list, { txhash }, 2);
        }
        assert.deepEqual(list.map((row) => row.txhash), ['0x2', '0x3']);
        list = pushLatest(list, { txhash: '0x2', function: 'again' }, 2);
        assert.deepEqual(list.map((row) => row.txhash), ['0x3', '0x2']);
        assert.equal(list[1].function, 'again');
    });
});

describe('recordLatestExample', () => {
    it('writes a rolling list at the trace root', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'latest-examples-'));
        const trace = path.join(root, '0b', 'cd'.repeat(31), '73d6a889', `${HASH}.json`);
        fs.mkdirSync(path.dirname(trace), { recursive: true });
        const contracts = new Map([
            ['0xabc', {
                sources: { 'contracts/DAOStaking.sol': { content: 'contract DAOStaking {' } },
            }],
        ]);
        const written = await recordLatestExample({
            root,
            traceFile: trace,
            userPrompt: PROMPT,
            contracts,
            meta: {
                txHash: HASH,
                from: '0xfrom',
                to: '0xabc',
                input: '0x1234',
                value: '0x0',
                block: 1,
            },
            limit: 200,
            fileName: 'latest.json',
        });
        assert.equal(written, path.join(root, 'latest.json'));
        const rows = JSON.parse(fs.readFileSync(written, 'utf8'));
        assert.equal(rows.length, 1);
        assert.equal(rows[0].txhash, HASH);
        assert.equal(rows[0].function, 'stakeWithPermit');
        assert.equal(rows[0].contract, 'DAOStaking');
        assert.deepEqual(rows[0].meta, {
            from: '0xfrom',
            to: '0xabc',
            input: '0x1234',
            value: '0x0',
        });
        assert.equal(rows[0].path, simRelPath(root, trace));
        assert.equal(rows[0].path.includes('\\'), false);
        assert.equal(txhashOf({}, trace), HASH);
        assert.equal(exampleEntry({
            txhash: HASH, userPrompt: '', contract: '', meta: {}, simRelPath: 'a',
        }).function, '');
        assert.equal(latestLimit('0'), 0);
        assert.equal(latestLimit('15'), 15);
    });

    it('backfills the newest existing prompts and ignores vendor contracts', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'latest-backfill-'));
        const older = writePair(root, 1, 'older');
        const newer = writePair(root, 2, 'newer');
        const oldTime = Date.now() - 10_000;
        fs.utimesSync(older.prompt, oldTime / 1000, oldTime / 1000);
        const written = backfillLatestExamples(root, [older.trace, newer.trace], 1);
        const rows = JSON.parse(fs.readFileSync(written, 'utf8'));
        assert.equal(rows.length, 1);
        assert.equal(rows[0].function, 'newer');
        assert.equal(rows[0].contract, 'Token');
        assert.equal(backfillLatestExamples(root, [older.trace, newer.trace], 1), null);
        assert.equal(contractNameFromPrompt(PROMPT), '');
    });
});

function writePair(root, n, fnName) {
    const hash = '0x' + n.toString(16).padStart(64, '0');
    const dir = path.join(root, 'aa', 'bb'.repeat(31), '095ea7b3');
    fs.mkdirSync(dir, { recursive: true });
    const trace = path.join(dir, `${hash}.json`);
    fs.writeFileSync(trace, JSON.stringify({
        meta: { txHash: hash, from: '0x1', to: '0x2', input: '0x', value: '0x1' },
    }));
    const prompt = path.join(dir, `${hash}_prompt.json`);
    const userPrompt = `## Transaction Overview\n- Function: ${fnName}(x=1)\n\n`
        + '<<<C4_UNTRUSTED_SOURCE filename="@openzeppelin/contracts/access/Ownable.sol">>> contract Ownable { <<<C4_END_UNTRUSTED_SOURCE>>>\n'
        + '<<<C4_UNTRUSTED_SOURCE filename="contracts/Token.sol">>> contract Token { <<<C4_END_UNTRUSTED_SOURCE>>>';
    fs.writeFileSync(prompt, JSON.stringify([{ style: 'simple', userPrompt }]));
    return { trace, prompt };
}
