# tsa_crawler

Tools that turn live Ethereum transactions into a prompt dataset for fine-tuning a small language model (SLM) that explains what a transaction does.

The pipeline is:

1. **Collect** execution traces from a Geth node, sampled by contract bytecode and method.
2. **Prepare** those traces into simulation JSON, then into two prompt styles (simple + detailed).
3. **Query** the resulting prompts so you can inspect coverage and pick training examples.
4. **Dedup** clusters similar contracts and copies a CAP-sized keep-set for training.

```
Geth (eth + debug)
        │
        ▼
src/fetch_traces.mjs      →  <txhash>.json          (raw collector traces)
        │
        ▼
src/prepare-testdata.mjs  →  <txhash>_sim.json      (step 1: simulation shape)
                          →  <txhash>_prompt.json   (step 2: explainer prompts)
                          →  <txhash>_prompt.nosrc  (Sourcify miss, skip later)
        │
        ▼
src/query.mjs             →  filter / dump prompts
src/dedup.mjs             →  CAP keep-set under OUT (same layout)
```

Requires **Node 18+** (Docker images use Node 22). No npm dependencies in this repo; the collector uses Node builtins only. Prompt generation needs the Colibri explainer from [colibri-stateless](https://github.com/corpus-core/colibri-stateless).

---

## Data layout

Traces and derived files live under `OUT` / `IN` / `DATA_DIR` (defaults: `./traces` for the collector, `./test_data` for prepare/query):

```
<data>/
  <hh>/                         # first byte of the to-address codehash
    <codehash[2:]>/             # remaining 62 hex chars (no 0x)
      <selector>/               # 8 hex chars, or `fallback` when calldata is empty
        0x<txhash>.json         # collector trace
        0x<txhash>_sim.json
        0x<txhash>_prompt.json
        0x<txhash>_prompt.nosrc
  .state.json                   # collector cursor (last processed block)
```

A **bucket** is `(codehash, selector)`. The collector stores at most `CAP` traces per bucket so the dataset stays diverse instead of filling up with the same `approve` on the same token.

`traces/`, `test_data/`, `train_data/`, and `sol_cache/` are gitignored.

---

## 1. Collector — `src/fetch_traces.mjs`

Forward-streaming sampler. Every `POLL_MS` it checks for a new block, selects contract calls whose bucket is not yet full, traces them, and writes JSON.

- Skips contract creations and EOAs (empty codehash).
- Restart-safe: cursor in `.state.json`, bucket counts reconstructed from the filesystem.
- Window-aware: a full node only keeps ~128 blocks of state. If lag exceeds `MAX_LAG`, older blocks are skipped rather than traced against missing state.
- Adaptive tracing: one selected tx → `debug_traceTransaction`; two or more → `debug_traceBlockByNumber` (the block is executed once).
- Each saved file has `meta`, optional `receipt`, `trace` (`keccak` / `sload` / `sstore` / `call` / `output`), and an `accessList` with proxy implementation resolution.

Needs a Geth node with the `eth` and `debug` namespaces.

```bash
RPC=http://127.0.0.1:8545 OUT=./traces CAP=5 node src/fetch_traces.mjs
```

| Env | Default | Meaning |
| --- | --- | --- |
| `RPC` | `http://127.0.0.1:8545` | Execution JSON-RPC |
| `OUT` | `./traces` | Output root |
| `CAP` | `5` | Max traces per `(codehash, selector)` bucket |
| `POLL_MS` | `12000` | Loop interval |
| `MAX_LAG` | `100` | Skip if behind more than this many blocks (`< 128`) |
| `TRACE_TIMEOUT` | `60s` | Per-tx tracer timeout |
| `INCLUDE_RECEIPTS` | `true` | Attach `eth_getTransactionReceipt` |
| `PROM_FILE` | *(off)* | Prometheus textfile path |
| `CHAIN` | `mainnet` | Metric label |

---

## 2. Prepare — `src/prepare-testdata.mjs`

Turns collector traces into prompts in two conceptual steps. Step 2 is split so **new buckets get one prompt first** (coverage), then the rest are filled in.

| Step | Input | Output |
| --- | --- | --- |
| **1** | `<txhash>.json` | `<txhash>_sim.json` — Colibri `ETH_SIMULATION_RESULT` shape (logs, call trace, storage diffs, access list) |
| **2a** | sims in buckets that have no prompt yet | one `_prompt.json` (or `_prompt.nosrc`) per new bucket |
| **2b** | remaining sims | the rest of the prompts |

Each `_prompt.json` is an array of two objects:

- `style: "simple"` — explainer default system prompt (non-technical)
- `style: "detailed"` — protocol-engineer walkthrough

Both share the same user prompt (decoded tx, events, state, call tree, Sourcify source). If Sourcify has no source, prepare writes `_prompt.nosrc` so later runs skip that tx.

The explainer is not in this repo. By default it is loaded from a sibling checkout:

`../colibri-stateless/bindings/emscripten/packages/explainer`

```bash
IN=./test_data RPC=https://mainnet1.colibri-proof.tech/execution node src/prepare-testdata.mjs
```

| Env | Default | Meaning |
| --- | --- | --- |
| `IN` | `./test_data` | Trace root |
| `RPC` | Colibri mainnet RPC | Used for access-list / revert fallbacks |
| `CHAIN_ID` | `1` | Passed to the explainer |
| `STEPS` | `1,2a,2b` | Subset to run (`2` means 2a then 2b) |
| `CONCURRENCY` | `4` | Parallel files |
| `FORCE` | *(off)* | Rebuild even if outputs exist |
| `INTERVAL_S` | `0` | Repeat forever when `> 0` |
| `EXPLAINER_DIR` | sibling colibri path | Explainer package root |
| `SKIP_EXPLAINER_BUILD` | *(off)* | Use existing `dist/` (required in Docker) |
| `C4_STATE_DIR` | `.` | Sourcify / solc cache |
| `PROM_FILE` | *(off)* | Prometheus textfile path |
| `CHAIN` | `mainnet` | Metric label |

---

## 3. Query — `src/query.mjs`

Walks `_prompt.json` files and filters them. Matching uses the **first** entry (`style: "simple"`). `-c` / `-m` are OR within the flag; `-q` terms are AND.

```bash
DATA_DIR=./test_data node src/query.mjs -c 02 -m 095ea7b3 -q approve -d
DATA_DIR=./test_data npm run query -- -q events:Approval -l 20
```

| Flag | Meaning |
| --- | --- |
| `-q <text>` | Substring in the user prompt. Prefix `tx:`, `events:`, `state:`, `call:`, or `code:` to limit the section |
| `-c <hex>` | Codehash prefix (includes the first-byte directory) |
| `-m <id>` | Method id (`095ea7b3` or `fallback`) |
| `-min` / `-max` | First userPrompt length |
| `-l <n>` | Stop after n matches |
| `-d` | Print path + prompt (colorized sections on a TTY) |
| `-t` | Like `-d`, plus the sibling `_sim.json` |
| `-h` | Help |

---

## 4. Dedup — `src/dedup.mjs`

Clusters `_prompt.json` files so similar contracts (e.g. ERC20 clones with different names/codehashes) share a bucket, then copies a CAP-sized keep-set to `OUT` (`_prompt.json` plus sibling `_sim.json` when present). Only the first `userPrompt` is used. Matching is **path method id × public Solidity interface** (function/event signatures from the `code` section). `_prompt.nosrc` and prompts without a C4 source body are skipped. `DATA_DIR` is never modified.

`qualityScore(hit)` ranks prompts inside a full cluster: `gasUsed/1e5 + events/3 + calls/5 + stateChanges/10` (gas commas like `46,622` are stripped). When a cluster is over `CAP`, the lowest-scoring prompts are dropped; ties keep the lexicographically first `relPath`.

```bash
DATA_DIR=./test_data node src/dedup.mjs --dry-run
DATA_DIR=./test_data OUT=./train_data CAP=5 node src/dedup.mjs
DATA_DIR=./test_data npm run dedup -- --out ./train_data --keep 1
```

| Env / flag | Default | Meaning |
| --- | --- | --- |
| `DATA_DIR` | *(required)* | Prompt tree (read-only) |
| `OUT` / `--out` | *(required unless `--dry-run`)* | Keep-set root; same sharding as `DATA_DIR` |
| `CAP` / `--keep` | `5` | Max prompts per (method × interface) cluster |
| `PROM_FILE` | *(off)* | Prometheus textfile path (own file; do not share with collector/prepare) |
| `CHAIN` | `mainnet` | Metric label |
| `PROGRESS_EVERY` | `5000` | Log `dedup: scanned N ...` every N prompt files (`0` = off) |
| `--dry-run` | | Stats only; no copy |
| `-h` | | Help |

`OUT` must not be `DATA_DIR` (or a parent of it). A subdirectory such as `DATA_DIR/train` is fine: `walkBuckets` ignores names that are not a 2-hex prefix. Each run overwrites previous keep-set `_prompt.json` and sibling `_sim.json` files under `OUT` and writes `OUT/.dedup-manifest.json`.

---

## Docker

`docker-compose.yml` runs two long-lived services against host paths (`/srv/trace-data`, `/srv/trace-cache`, node_exporter textfiles):

| Service | Image | Role |
| --- | --- | --- |
| `collector` | `Dockerfile.traces` | `src/fetch_traces.mjs`, host network so it can reach local Geth |
| `prepare` | `Dockerfile.prepare` | `src/prepare-testdata.mjs` plus a built explainer; outbound HTTPS for Sourcify |
| `dedup` | `Dockerfile.dedup` | One-shot `src/dedup.mjs`; profile `dedup`, does not start with `up` |

```bash
docker compose --profile dedup run --rm dedup
```

Dedup writes to `OUT=/data/traces/train` on the same volume. Collector, prepare, and dedup must **not** share a `PROM_FILE`. Compose host paths and Loki labels are environment-specific — edit them before `docker compose up`.

---

## Tests

```bash
npm test
```

Node's built-in test runner over `test/*.test.mjs`. Tests use temp dirs; they do not need Geth, Sourcify, or the explainer.

---

## Supporting modules

| File | Role |
| --- | --- |
| `src/bucket_paths.mjs` | Sharded layout, bucket keys, `listTraceFiles` |
| `src/proxy_accesslist.mjs` | SLOAD/SSTORE → access list, well-known proxy slots |
| `src/sim-from-trace.mjs` | Collector JSON → simulation result |
