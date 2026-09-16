# Agent notes

This repo builds **training prompts** for an SLM that explains Ethereum transactions. It is a small Node toolchain, not an app: collector → prepare → query → dedup.

Read `README.md` for the human-facing pipeline and env vars. This file is for changing the code without breaking layout, CAP accounting, or the explainer contract.

## Layout of the repo

All runnable code lives in `src/`. Tests stay in `test/` and import from `../src/…`.

| Path | Notes |
| --- | --- |
| `src/fetch_traces.mjs` | Live collector. Node builtins + static ESM imports only. The collector Docker image copies this file plus `proxy_accesslist.mjs` and `bucket_paths.mjs`. |
| `src/prepare-testdata.mjs` | Trace → `_sim.json` → `_prompt.json`. Talks to RPC + Sourcify via the explainer. |
| `src/query.mjs` | Read-only prompt filter. CLI is `parseArgs` / `main`; keep helpers exported for tests. |
| `src/dedup.mjs` | Cluster prompts by (path method_id × interface hash); copy CAP keep-set to `OUT`. DATA_DIR is read-only. |
| `src/bucket_paths.mjs` | **Single source of truth** for on-disk layout. |
| `src/proxy_accesslist.mjs` | Access list + proxy implementation resolution. |
| `src/sim-from-trace.mjs` | Collector file → Colibri simulation JSON. |
| `Dockerfile.traces` / `Dockerfile.prepare` / `Dockerfile.dedup` | COPY the needed `src/*.mjs` files into `/app` (flattened). Collector and dedup are alpine+node only. Prepare sparse-checkouts the explainer. Dedup copies `dedup.mjs`, `query.mjs`, `bucket_paths.mjs`. |
| `test/*.test.mjs` | `node:test`. No network. Use temp dirs. |

Everything is ESM (`.mjs`). Docker images do not use `package.json` `"type": "module"`; the `.mjs` suffix is enough.

Default explainer path is resolved from `src/` (`../../colibri-stateless/...`). Docker sets `EXPLAINER_DIR=/opt/explainer`.

## On-disk contract (do not invent a second layout)

Canonical path:

```
<root>/<codehash[0:2]>/<codehash[2:]>/<selector>/<txhash>.json
```

- Codehash and selector directories have **no `0x`**. Empty calldata selector is the directory `fallback`.
- Collector traces match `^0x[0-9a-f]{64}\.json$`. `_sim.json`, `_prompt.json`, `_prompt.nosrc` are siblings, not traces. `listTraceFiles` must ignore them.
- In-memory bucket id is `<64-hex-codehash>_<selector>` (`bucketKey`). CAP counting and query `-c`/`-m` depend on that.
- Writes are atomic: `file.tmp` then `rename`. Never leave a half-written JSON as the final name.
- `traces/`, `test_data/`, `train_data/`, and `sol_cache/` are gitignored. Do not commit them.

Changing the layout means updating `src/bucket_paths.mjs`, collector writes, prepare/query walks, and tests together.

## Collector invariants (`src/fetch_traces.mjs`)

- Sample by **`(codehash of tx.to, 4-byte selector)`**, not by address. Same bytecode + same method share a bucket even across proxy clones.
- Reserve the CAP slot **before** tracing; release it if the trace is missing or the RPC call fails.
- Skip creations (`!tx.to`) and EOAs (empty keccak codehash `0xc5d24601…`).
- Full-node state window is ~128 blocks. `MAX_LAG` must stay below that. Never “catch up” by tracing ancient blocks on a full node.
- Tracer is an inline Geth JS tracer (ES5, Geth builtins). It is not Node. Do not use `const`/`let`/arrow functions inside the `TRACER` string.
- Prometheus: one `PROM_FILE` per process **and** chain. Last writer wins if two services share a path.
- Do not assume RPC methods. The collector uses `eth_getBlockByNumber`, `eth_getProof`, `eth_getTransactionReceipt`, `eth_blockNumber`, `debug_traceTransaction`, `debug_traceBlockByNumber`. If you need another method, verify it exists on the target Geth build first.

## Prepare invariants (`src/prepare-testdata.mjs`)

Two conceptual steps, three `STEPS` tokens:

1. **Step 1** — `traceToSimulation`. May hit RPC for access lists / revert data. Historical proofs need archive; fallbacks against `latest` can be wrong — do not silently treat that as canonical chain state.
2. **Step 2a** — at most **one** pending tx per bucket, and only buckets that have **no** `_prompt.json` / `_prompt.nosrc` yet. This is how new methods get coverage before the dataset drowns in extra `approve`s.
3. **Step 2b** — everything still missing a prompt/nosrc.

`STEPS=2` means 2a then 2b. `FORCE=1` rebuilds outputs; 2a still caps at one tx per bucket.

`_prompt.json` is always an **array** of `{ style, systemPrompt, userPrompt }` (`simple` then `detailed`). Query and tests read `parsedJson[0].userPrompt`. Do not switch to a single object.

No Sourcify source → write `_prompt.nosrc`, do not write an empty prompt. `hasContractSource` is the gate; do not weaken it to “any metadata”.

The explainer lives **outside** this repo (`EXPLAINER_DIR`). Docker sets `SKIP_EXPLAINER_BUILD=1` and uses a prebuilt `dist/`. Local runs may `npm install` + `npm run build` in that package. Do not vendor the explainer into this tree.

`C4_STATE_DIR` is the Sourcify/solc cache. Default it to a dedicated dir in examples (`. ` is only the code default).

## Query invariants (`src/query.mjs`)

- Filters the first prompt entry only (simple style).
- `-c` / `-m` are OR within the flag; repeated `-q` is AND.
- Section prefixes for `-q`: `tx`, `events`, `state`, `call`, `code` — must match `SECTION_HEADERS` in the explainer user prompt. If the explainer changes headings, update both.
- `DATA_DIR` is required. Stream matches; do not load the whole tree into memory.

## Dedup invariants (`src/dedup.mjs`)

- Read-only on `DATA_DIR`. Never delete source `_prompt.json` / `_prompt.nosrc`.
- First userPrompt only. Skip files without a `code` section C4 source body (and skip `_prompt.nosrc`).
- Cluster key is `<path method_id>:<sha256 of canonical public/external function+event signatures>`. Events/state/call do not affect the key.
- `qualityScore(hit)` is a hook; stub returns `1`. Per-cluster CAP keeps highest scores; ties keep the lexicographically first `relPath`.
- Index only metadata after scoring — do not retain every userPrompt in memory.
- `OUT` must not be `DATA_DIR` or a parent of it. A `train/` subdirectory under DATA_DIR is safe (`walkBuckets` ignores non-hex top-level names).

## Coding rules

- Comments and public docs in **English**. JSDoc on exported functions: markdown in the description, only `@param` and `@return` as tags.
- Prefer verifying Geth / explainer / SSZ field names in this repo or the explainer package over assuming they exist.
- Keep the collector Docker-compatible: no `npm install` in `src/fetch_traces.mjs`.
- New behavior needs a `node:test` case when it is pure (paths, filters, sim conversion, 2a/2b selection, dedup fingerprints). Do not add tests that call live RPC or Sourcify.
- Match existing style: no TypeScript, no extra frameworks, env vars for CLI config on collector/prepare/dedup, argv flags on query/dedup.

## Checks

```bash
npm test
```

That is `node --test test/*.test.mjs`. Run it after layout, query, sim, step-2a/2b, or dedup changes.

## Out of scope unless asked

- Fine-tuning / training loop (this repo only **produces** prompts).
- Changing compose host paths, Loki URLs, or production volume owners.
- Force-push, amending others' commits, or committing `test_data/` / secrets.
