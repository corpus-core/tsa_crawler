# tsa_crawler

Tools that turn live Ethereum transactions into a prompt dataset for fine-tuning a small language model (SLM) that explains what a transaction does.

The pipeline is:

1. **Collect** execution traces from a Geth node, sampled by contract bytecode and method.
2. **Prepare** those traces into simulation JSON, then into two prompt styles (simple + detailed).
3. **Query** the resulting prompts so you can inspect coverage and pick training examples.
4. **Build the dataset** with `src/build_dataset.mjs`: dedup, teacher responses, validation, one regeneration pass, and the SFT export, in a single idempotent command. The sections below are the same stages runnable on their own.
5. **Train** the student with `train/tsa_train.py`: LoRA fine-tune on Together AI, convert the merged weights to MLC, publish them for WebLLM.

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
src/query.mjs             →  filter / dump prompts (review; not a build step)
        │
        ▼
src/build_dataset.mjs     →  dedup → gen → validate → regen → export
   src/dedup.mjs          →  CAP keep-set under TRAIN_DIR
   src/gen_responses.mjs  →  <txhash>_response.json
   src/validate_responses.mjs → <txhash>_validation.json
   src/export_dataset.mjs →  TRAIN_DIR/dataset/{train,val}.jsonl + manifest.json
        │
        ▼
train/tsa_train.py        →  Together AI LoRA job → merged HF checkpoint
                          →  MLC q4f16_1 weights → Hugging Face → WebLLM model record
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
        0x<txhash>_response.json  # teacher answers (one entry per style)
        0x<txhash>_validation.json # grounding ratio + judge verdict per style
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
| `-s` | Like `-d`, plus the siblings when present: `_sim.json` (light blue), the teacher answer from `_response.json` (light green), and the `_validation.json` summary (magenta) |
| `-v` | Keep only txs whose `_validation.json` reports a problem (grounding verdict `warn`/`fail`, or judge verdict not `good`). Combine with `-s` to review the flagged answers |
| `-t <0\|1>` | Keep txs whose collector trace has / lacks `.trace.call` |
| `-e` / `-E` | Keep txs whose listed sections are / are not resolved |
| `-S` | Print hit / dataset counts |
| `-x` / `-X` | Delete the collector trace of matching txs / the whole tx incl. all siblings (prunes empty dirs) |
| `-R` | Delete only `_response.json` + `_validation.json` of matching txs; prompt, sim, and trace stay, so the next `gen-responses` / `validate-responses` run regenerates them |
| `-h` | Help |

Review loop after `build-dataset` (the keep-set is `TRAIN_DIR`, default `<DATA_DIR>/train`):

```bash
DATA_DIR=./traces/train node src/query.mjs -v -S        # how many flagged?
DATA_DIR=./traces/train node src/query.mjs -v -s -l 5   # read prompt, answer, and why
DATA_DIR=./traces/train node src/query.mjs -v -R        # drop the flagged answers
DATA_DIR=./traces STAGES=gen,validate,export npm run build-dataset   # redo only those
```

`query -E tx -X` used to delete unresolved transactions from the source tree. Dedup now skips them (`REQUIRE_RESOLVED`) and leaves the traces in place.

---

## Build dataset — `src/build_dataset.mjs`

One idempotent command for everything after `prepare`. `dedup` reads `DATA_DIR` and writes the keep-set to `TRAIN_DIR`; `gen`, `validate`, and `export` then work only there. Each stage skips work that is already fresh, so running it again after `query -R` regenerates just the reset transactions.

Defaults that differ from the standalone tools: `REQUIRE_RESOLVED=tx,events` (unresolved prompts are skipped, not deleted), `STICKY=1` (an answered keeper keeps its cluster slot), `REGEN_ROUNDS=1` (answers with grounding `fail` or judge `wrong` are deleted and generated once more; `warn` and `flawed` stay), and the export gates `MIN_GROUNDING_RATIO=0.7` plus `REQUIRE_VALIDATION=1`. Set a variable to empty (`REQUIRE_RESOLVED=`) to turn that default off. The standalone `export-dataset` still exports everything when those gates are unset.

```bash
DATA_DIR=./traces node src/build_dataset.mjs --dry-run
DATA_DIR=./traces DEEPSEEK_API_KEY=sk-... npm run build-dataset
DATA_DIR=./traces STAGES=gen,validate,export npm run build-dataset
```

| Env / flag | Default | Meaning |
| --- | --- | --- |
| `DATA_DIR` | *(required)* | Prompt tree from prepare |
| `TRAIN_DIR` | `<DATA_DIR>/train` | Dedup keep-set. On the server this is the separate `/data/train` volume |
| `DATASET_OUT` | `<TRAIN_DIR>/dataset` | `train.jsonl`, `val.jsonl`, `manifest.json` |
| `STAGES` | `dedup,gen,validate,export` | Subset, always run in that order |
| `REGEN_ROUNDS` | `1` | Redo passes for `fail` / judge `wrong` (`0` = off) |
| `REQUIRE_RESOLVED` | `tx,events` | Forwarded to dedup |
| `STICKY` | `1` | Forwarded to dedup |
| `MIN_GROUNDING_RATIO` / `REQUIRE_VALIDATION` | `0.7` / `1` | Export gates for this pipeline only |
| `MAX_USER_CHARS` | `60000` | Export gate: prompts longer than this are skipped (`too-long`), never truncated. Coarse guard only; the exact per-model sequence gate is `train/tsa_train.py prepare --max-seq-tokens` |
| `--dry-run` | | Forwarded to every stage; no copies, no API calls, no writes |

`dedup` or `export` failing stops the run. A teacher or judge call that fails after retries is logged and the other stages still run; the process then exits 1.

The deployment that actually runs is `devops/ccmainnet3/mainnet_tsa_build` (`dc --profile build run --rm mainnet_tsa_build`). `docker-compose.yml` in this repo is the reference copy of that service.

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
| `REQUIRE_RESOLVED` | *(off)* | Comma list (`tx,events,...`); candidates whose section is not decoded are skipped and counted as `skipped-unresolved` |
| `STICKY` | *(off)* | `1`: a keeper that already has a `_response.json` under `OUT` keeps its cluster slot ahead of the quality score |
| `PROM_FILE` | *(off)* | Prometheus textfile path (own file; do not share with collector/prepare) |
| `CHAIN` | `mainnet` | Metric label |
| `PROGRESS_EVERY` | `5000` | Log `dedup: scanned N ...` every N prompt files (`0` = off) |
| `--dry-run` | | Stats only; no copy |
| `-h` | | Help |

`OUT` must not be `DATA_DIR` (or a parent of it). A subdirectory such as `DATA_DIR/train` is fine: `walkBuckets` ignores names that are not a 2-hex prefix. Each run overwrites previous keep-set `_prompt.json` and sibling `_sim.json` files under `OUT` and writes `OUT/.dedup-manifest.json`. `_response.json` and `_validation.json` are not touched, so a sticky re-run keeps the answers already paid for. The manifest's `kept[]` entries carry `pinned: true` for those.

---

## 5. Teacher responses — `src/gen_responses.mjs`

Sends every `_prompt.json` first-entry (`style: "simple"` by default) to the DeepSeek Chat Completions API and stores the answer as a sibling `<txhash>_response.json`. The teacher receives **exactly the student prompt** (same system + user message) so the SLM learns to answer with the same context it will see in the browser at inference time. Failed calls, empty content, and any `finish_reason != "stop"` are never written; a re-run simply retries them.

The response file merges multiple styles safely, so a later `STYLES=detailed` run does not overwrite existing `simple` answers.

```bash
DATA_DIR=./dedup node src/gen_responses.mjs --dry-run
DATA_DIR=./dedup DEEPSEEK_API_KEY=sk-... LIMIT=5 node src/gen_responses.mjs
DATA_DIR=./dedup DEEPSEEK_API_KEY=sk-... npm run gen-responses -- --limit 5
```

| Env / flag | Default | Meaning |
| --- | --- | --- |
| `DATA_DIR` | *(required)* | Prompt tree root |
| `DEEPSEEK_API_KEY` | *(required unless `--dry-run`)* | DeepSeek key |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | Endpoint (OpenAI-compatible) |
| `MODEL` | `deepseek-v4-pro` | Teacher model |
| `STYLES` | `simple` | Comma list; each style becomes one API call per tx |
| `THINKING` | `enabled` | `enabled` or `disabled` |
| `REASONING_EFFORT` | `high` | `low` / `high` / `max` (ignored when thinking disabled) |
| `MAX_TOKENS` | `16384` | Response cap incl. reasoning tokens |
| `CONCURRENCY` | `4` | Parallel API calls |
| `MAX_RETRIES` | `5` | Exponential backoff on `429`/`5xx`/network/timeout |
| `TIMEOUT_MS` | `600000` | Per-request timeout |
| `TEACHER_SYSTEM_SUFFIX` | *(empty)* | Appended to the student system prompt |
| `KEEP_REASONING` | `1` | Store `reasoning_content` for later CoT distillation |
| `FORCE` | *(off)* | Regenerate even when the sibling already matches the prompt hash |
| `LIMIT` / `--limit <n>` | *(off)* | Cap issued API calls (useful for smoke tests) |
| `PROGRESS_EVERY` | `25` | Log processed-count every N prompts (`0` = off) |
| `--dry-run` | | Count prompts + estimate input tokens; no API calls |
| `-h` | | Help |

Each `_response.json` is:

```json
{
  "version": 1,
  "txHash": "0x…",
  "codehash": "…",
  "methodId": "…",
  "model": "deepseek-v4-pro",
  "responses": {
    "simple": {
      "model": "deepseek-v4-pro",
      "content": "…",
      "reasoningContent": "…",
      "finishReason": "stop",
      "usage": { "prompt_tokens": 0, "completion_tokens": 0, "prompt_cache_hit_tokens": 0, "prompt_cache_miss_tokens": 0, "reasoning_tokens": 0 },
      "promptSha256": "…",
      "requestId": "…",
      "createdAt": "…",
      "durationMs": 0
    }
  }
}
```

Cost note: thinking mode charges its reasoning stream as output tokens; use `THINKING=disabled` on Flash for cheap smoke tests. Peak vs off-peak rates apply, see the DeepSeek pricing page.

---

## 6. Validate responses — `src/validate_responses.mjs`

Checks every `_response.json` against its `_prompt.json` and writes a sibling `<txhash>_validation.json`. Two layers:

1. **Deterministic number grounding** (always, no API). Every non-trivial number in the answer must be traceable to the user prompt. Accepted derivations: literal token (`97,476` → `97476`), hex value (`0x29` → `41`), decimal scaling by `SCALE_EXPONENTS` (`1,000` ↔ `1000000000000000000000`), the decimals count implied by an `x (raw: y)` pair, and rounding/truncation to the answer's own precision (`139.23 USDT` from `139231085`). Hex tokens, truncated addresses (`0x2127...e880`), and standard ids (`ERC-20`, `EIP-1559`) are masked first. The result is a `ratio = grounded / total` and a verdict: `pass` (≥ `RATIO_PASS`), `warn` (≥ `RATIO_WARN`), else `fail`. Unmatched numbers are listed so you can see *what* the teacher made up (or summed).
2. **LLM judge** (sampled). A seed-stable `JUDGE_SAMPLE_PCT` of txs (`sha256(seed, txhash)`) is graded by DeepSeek against the same prompt. The judge returns strict JSON `{score 1–5, verdict good|flawed|wrong, issues[]}`; unparseable replies are stored as `verdict: "unparseable"` and retried on the next run. Raising the percentage later only adds txs, existing verdicts are reused.

```bash
DATA_DIR=./dedup node src/validate_responses.mjs --dry-run           # counts + judge token estimate, no writes
DATA_DIR=./dedup JUDGE_SAMPLE_PCT=0 node src/validate_responses.mjs  # deterministic only, no API key needed
DATA_DIR=./dedup DEEPSEEK_API_KEY=sk-... LIMIT=3 npm run validate-responses
```

| Env / flag | Default | Meaning |
| --- | --- | --- |
| `DATA_DIR` | *(required)* | Prompt tree root |
| `STYLES` | `simple` | Styles to validate |
| `TRIVIAL_MAX` | `2` | Integers `≤ n` are ignored (`0 -> 1`, "2 events"); fractions never are |
| `RATIO_PASS` / `RATIO_WARN` | `0.9` / `0.7` | Verdict thresholds |
| `SCALE_EXPONENTS` | `6,8,9,18` | Token decimals tried for scaled matches |
| `JUDGE_SAMPLE_PCT` | `5` | Percent of txs sent to the judge; `0` disables it (then no API key is needed) |
| `JUDGE_SEED` | `1` | Sample salt |
| `JUDGE_MODEL` / `JUDGE_THINKING` / `JUDGE_REASONING_EFFORT` / `JUDGE_MAX_TOKENS` | `deepseek-v4-pro` / `enabled` / `high` / `16384` | Judge request (reasoning tokens count against the cap; too low → `finish_reason=length`, stored as `unparseable`) |
| `DEEPSEEK_API_KEY` | | Required only when judge calls are planned |
| `CONCURRENCY` / `MAX_RETRIES` / `TIMEOUT_MS` | `4` / `5` / `600000` | Same semantics as gen-responses |
| `FORCE` | | `1` recomputes everything |
| `FORCE_JUDGE` | | `1` re-judges sampled txs, keeps the deterministic part |
| `LIMIT` / `--limit` | | Cap judge calls (unjudged sampled txs stay pending) |
| `--dry-run` | | No API calls, no writes |

A check is **fresh** when its `contentSha256` equals the current response content; fresh checks are skipped, so re-runs after `gen-responses` only touch new or regenerated answers. Each `_validation.json`:

```json
{
  "version": 1, "txHash": "0x…", "codehash": "…", "methodId": "…",
  "checks": {
    "simple": {
      "checkedAt": "…", "responseModel": "deepseek-v4-pro",
      "promptSha256": "…", "contentSha256": "…", "sampled": true,
      "deterministic": {
        "numbers": { "total": 9, "grounded": 7, "ratio": 0.7778, "unmatched": ["4.93"], "trivialMax": 2,
                     "matchModes": { "literal": 1, "hex": 0, "scaled": 3, "decimals": 0, "rounded": 3 } },
        "verdict": "warn", "thresholds": { "pass": 0.9, "warn": 0.7 }
      },
      "judge": { "model": "deepseek-v4-pro", "score": 4, "verdict": "good", "issues": [], "usage": { "…": 0 }, "…": "…" }
    }
  }
}
```

Use `query -v` (optionally with `-s`) to review the flagged answers; use the export gates below to keep them out of the dataset.

---

## 7. Export dataset — `src/export_dataset.mjs`

Pairs every `_prompt.json` with its sibling `_response.json` and emits one JSONL row per (tx × style) in the standard OpenAI chat-messages shape. TRL `SFTTrainer`, Unsloth, and Axolotl consume it directly.

The train/val split is **deterministic and codehash-cohesive**: every tx sharing a codehash goes into the same split, so validation never leaks contract-specific idioms from training. Rows whose `promptSha256` no longer matches the current prompt (e.g. the prompt was regenerated with a different source budget), whose `finishReason != "stop"`, or with empty content are skipped and counted by reason.

Optional **quality gates** read the sibling `_validation.json`. All are off by default; a stale check (`contentSha256` mismatch) counts as missing.

```bash
DATA_DIR=./dedup node src/export_dataset.mjs --dry-run
DATA_DIR=./dedup OUT=./train_data/sft node src/export_dataset.mjs
DATA_DIR=./dedup npm run export-dataset -- --out ./train_data/sft
```

| Env / flag | Default | Meaning |
| --- | --- | --- |
| `DATA_DIR` | *(required)* | Prompt tree root |
| `OUT` / `--out` | *(required unless `--dry-run`)* | Output directory |
| `STYLES` | `simple` | Comma list of styles to export |
| `VAL_RATIO` | `0.05` | Fraction of codehashes for `val.jsonl` (0 disables val) |
| `SEED` | `1` | Salt for the codehash split hash |
| `TEACHER_SYSTEM_SUFFIX` | *(empty)* | Must match the value used at generation time |
| `REQUIRE_VALIDATION` | *(off)* | `1`: rows without a fresh `_validation.json` check → skip `no-validation` / `stale-validation` |
| `MIN_GROUNDING_RATIO` | `0` | Rows with `numbers.ratio < X` → skip `low-grounding` (unvalidated rows pass unless `REQUIRE_VALIDATION`) |
| `MIN_JUDGE_SCORE` | `0` | Rows with `judge.score < X` → skip `low-judge` (only where a judge ran) |
| `REQUIRE_JUDGE_PASS` | *(off)* | `1`: keep only `judge.verdict == "good"`; unjudged rows → skip `judge-not-good` |
| `MAX_USER_CHARS` | `0` (off) | Skip rows whose `userPrompt` exceeds N characters → skip `too-long`. Rows are dropped, never truncated, so the training prompt stays byte-identical to what the explainer builds at inference |
| `PROGRESS_EVERY` | `500` | Log `export: scanned N ...` every N prompt files (`0` = off) |
| `--dry-run` | | Stats only; no files written |
| `-h` | | Help |

Each JSONL row:

```json
{"messages":[{"role":"system","content":"…"},{"role":"user","content":"…"},{"role":"assistant","content":"…"}],
 "meta":{"tx":"0x…","codehash":"…","method_id":"…","style":"simple","model":"deepseek-v4-pro","prompt_tokens":0,"completion_tokens":0,"rel_path":"…",
         "validation":{"grounding_ratio":1,"grounding_verdict":"pass","judge_score":5,"judge_verdict":"good"}}}
```

`meta.validation` is present only when a fresh check exists, so downstream filtering is possible without re-exporting. The run also writes `manifest.json` (`version: 2`) with counts, per-reason skip totals, token sums, distinct codehashes per split, character-length percentiles, and a `validation` block (active gates, rows validated/judged, grounding-ratio mean/p10/p50, judge-score histogram).

Typical feasibility-study setting: `MIN_GROUNDING_RATIO=0.7` drops the `fail` verdicts while keeping unvalidated rows; add `REQUIRE_VALIDATION=1` once every response has been validated.

Why drop instead of truncate: the last line of every user prompt is `Please explain what this transaction would do.`, and the teacher answered the full prompt. A truncated prompt would end mid-trace or mid-source, teach the student to answer prompts it will never see in production, and pair it with an answer that references data the student cannot see. The over-long rows (about 3 % at 60k chars) are dominated by huge `Call Trace` / `State Changes` / calldata sections, not by Solidity source, which the explainer already caps at `maxSourceChars` (10000 by default).

---

## 8. Train — `train/tsa_train.py`

Python driver (Together AI SDK, Hugging Face Hub, MLC LLM) that turns `train.jsonl` / `val.jsonl` into WebLLM-loadable weights. Variants are declared in `train/variants.json`; `qwen3.5-4b` is the primary target, `qwen3.5-9b` (the "large" option, ~5 GB download) and `qwen3.5-2b` reuse the same dataset. All three have prebuilt WebLLM model libraries, so no WASM is compiled: only the weights change.

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r train/requirements.txt
pip install --pre -U -f https://mlc.ai/wheels mlc-llm-nightly-cpu mlc-ai-nightly-cpu   # convert step only
export TOGETHER_API_KEY=... HF_TOKEN=... DATASET_OUT=./train_data/sft

python train/tsa_train.py limits   --variant qwen3.5-4b # Together limits: max_seq_length_sft, LoRA rank
python train/tsa_train.py prepare  --variant qwen3.5-4b # strip meta, token gate, upload (idempotent)
python train/tsa_train.py preview  --variant qwen3.5-4b # tokenised rows; check the empty <think> prefix
python train/tsa_train.py estimate --variant qwen3.5-4b
python train/tsa_train.py create   --variant qwen3.5-4b # asks before spending
python train/tsa_train.py wait     --variant qwen3.5-4b
python train/tsa_train.py download --variant qwen3.5-4b # merged bf16 checkpoint
python train/tsa_train.py convert  --variant qwen3.5-4b # MLC q4f16_1, checked against mlc-ai reference config
python train/tsa_train.py serve    --variant qwen3.5-4b # local test: playground ?modelUrl=http://localhost:8787/
python train/tsa_train.py sync     --variant qwen3.5-4b --dest /models # self-hosted (MODELS_DIR)
python train/tsa_train.py publish  --variant qwen3.5-4b # Hugging Face upload + model_record.json

# or all of prepare -> create -> wait -> download -> convert -> sync at once:
python train/tsa_train.py pipeline --variant qwen3.5-4b --dry-run   # token gate + estimate, nothing paid
python train/tsa_train.py pipeline --variant qwen3.5-4b --yes
STAGES=download,convert,sync python train/tsa_train.py pipeline --variant qwen3.5-4b
```

| Step | Notes |
| --- | --- |
| `prepare` | Keeps only `messages`, enforces system/user-first + alternating roles, **drops rows whose rendered ChatML sequence exceeds `--max-seq-tokens`** (default: the variant's `context_window_size`; counted with the base model's own `tokenizer.json`), runs Together's local file check, uploads train + val once (SHA-256 tracked in `train/out/upload.json`, gate stats included). The gate is token-based on purpose: these prompts tokenise between 1.1 and 3.3 chars/token depending on their hex share, so no character cap predicts the sequence length |
| `preview` | Together's tokenised rendering of sample rows. The assistant turn must start with `<think>\n\n</think>\n\n`: that is the prefix WebLLM injects with `enable_thinking: false`, so training and inference agree |
| `limits` | `fine_tuning.model_limits` for the base model. Fails if the variant's `context_window_size` exceeds `max_seq_length_sft`; warns if the default LoRA rank exceeds `max_rank` |
| `create` | LoRA SFT: `lora_r=32`, `lora_alpha=64`, `lr=1e-4`, 3 epochs, loss on assistant tokens only, `max_seq_length` = variant `context_window_size` (explicit, so Together never truncates rows silently). Prints the price estimate (about 18M Qwen tokens/epoch for the current dataset at 32k) and requires confirmation or `--yes` |
| `download` | Uses the `together` CLI (`--checkpoint-type merged`, with an explicit output *file* — the CLI's `--output-dir` is a file path) and extracts the archive into `train/out/<variant>/merged/`. The format is detected from the content, not the name, and a finished download left under a temp name by an earlier run is adopted instead of fetched again |
| `convert` | In-process `convert_weight` (Qwen3.5 traces only `embed`, because this MLC nightly segfaults while building the GatedDeltaNet graph; parameter names and shapes do not depend on it) plus `python -m mlc_llm gen_config`, with `model_type`, `conv_template`, `context_window_size` and `prefill_chunk_size` taken from the reference `mlc-ai/Qwen3.5-*-q4f16_1-MLC` config; aborts if the produced config differs on any architecture field, because the prebuilt WASM would not load the weights |
| `serve` | Static HTTP server (CORS, strips WebLLM's `resolve/main/` prefix) for `train/out/<variant>/mlc`. Open the playground with `?modelUrl=http://localhost:8787/` to run the converted weights in the browser before anything is published |
| `sync` | `rsync` the MLC directory to `<dest>/<model_id>/<weights_version>/` (`--dest` or `MODELS_DIR`; local path such as the mounted `tsa_models` volume, or `host:/path`). That is the layout the `model` container serves; refuses to overwrite an existing version unless `--force`, because browsers cache shards by URL — bump `weights_version` in `variants.json` (and in the explainer's `TSA_EXPLAINER_MODELS`) for new weights instead |
| `pipeline` | The orchestrator, the training counterpart of `build_dataset`: runs `prepare`, `create`, `wait`, `download`, `convert`, `sync` in that order, in-process. `STAGES` (or `--stages`) picks a subset; every stage skips work that is already recorded (`create` when a job exists, `download`/`convert`/`sync` when their output is there), so the command can be re-run after a failure. `--dry-run` stops after the token gate and the price estimate. `--yes` skips the TTY confirmation for the paid job; `--force-create` starts a new job despite a recorded one. Training args (`--epochs`, `--lora-r`, …) are the same as for `create` |
| `publish` | `huggingface_hub.upload_folder` to `hf_repo`; writes `train/out/<variant>/model_record.json`, the `ModelRecord` the explainer registers in `TSA_EXPLAINER_MODELS` |
| `eval-prep` / `endpoint` | Copy the val prompts into a standalone tree and start a dedicated Together endpoint, then run `gen_responses.mjs` + `validate_responses.mjs` against it to get the student's grounding ratio and judge score with the same metrics as the teacher. `endpoint down` afterwards; dedicated endpoints bill per GPU-hour |

`train/out/` is gitignored. `Dockerfile.train` (`docker compose --profile train run --rm train <subcommand>`) bundles the Python dependencies and the MLC CPU wheels; `convert` needs roughly twice the bf16 checkpoint size in RAM.

On the consumer side, `@corpus-core/colibri-explainer` lists the published models in `TSA_EXPLAINER_MODELS`, defaults to the 4B variant, merges the records into WebLLM's `prebuiltAppConfig`, and sends `extra_body.enable_thinking: false` so Qwen3.5 answers without a thinking block.

### Self-hosting the weights (`Dockerfile.model`)

While a model is not final it is not published to Hugging Face or any registry. Instead `Dockerfile.model` builds a plain nginx (`docker/model/default.conf.template`, port via `NGINX_PORT`) that serves a read-only volume laid out as `<model_id>/<weights_version>/…`, exactly what `sync` produces:

- WebLLM appends `resolve/main/` to every model URL; nginx rewrites `/<id>/<ver>/resolve/<rev>/<file>` to `/<id>/<ver>/<file>`.
- Every path is versioned, so files are served with `Cache-Control: immutable` and CORS `*`; `gzip` is off (q4f16 shards do not compress), directory listing is off, `/health` answers `ok`.
- On the server the whole train step runs on `ccmainnet3`, where the dataset volumes already live: `mainnet_tsa_train` (this image, `Dockerfile.train`) mounts `mainnet_dedup` as `/data/train` and the `tsa_models` volume as `/models`; `pipeline`'s `sync` stage writes into it. `tsa_model` (`Dockerfile.model`) serves that volume in host network on `9501`, and the Caddy on `ccmainnet1` maps `https://playground.colibri-proof.tech/models/*` to it (ufw on ccmainnet3 must allow the lb's IP on 9501). The playground probes `<origin>/models/<model_id>/<weights_version>/mlc-chat-config.json` on load and, when present, uses that same-origin URL instead of the Hugging Face default; `?modelUrl=` still overrides both.

```bash
# on ccmainnet3 (devops/ccmainnet3):
dc --profile train run --rm mainnet_tsa_train pipeline --variant qwen3.5-4b --yes
# local check of the model container against train/out/<variant>/mlc:
python train/tsa_train.py sync --variant qwen3.5-4b --dest /tmp/models
MODEL_ROOT=/tmp/models docker compose --profile model up model   # serves <MODEL_ROOT>/<model_id>/<version>/
```

---

## Docker

`docker-compose.yml` runs two long-lived services against host paths (`/srv/trace-data`, `/srv/trace-cache`, node_exporter textfiles):

| Service | Image | Role |
| --- | --- | --- |
| `collector` | `Dockerfile.traces` | `src/fetch_traces.mjs`, host network so it can reach local Geth |
| `prepare` | `Dockerfile.prepare` | `src/prepare-testdata.mjs` plus a built explainer; outbound HTTPS for Sourcify |
| `dedup` | `Dockerfile.dedup` | One-shot `src/dedup.mjs`; profile `dedup`, does not start with `up` |
| `gen-responses` | `Dockerfile.gen_responses` | One-shot `src/gen_responses.mjs`; profile `gen-responses`, does not start with `up`. Reads the deduped keep-set at `/data/traces/train` and writes sibling `_response.json` files via the DeepSeek API |
| `validate-responses` | `Dockerfile.validate_responses` | One-shot `src/validate_responses.mjs`; profile `validate-responses`, does not start with `up`. Writes sibling `_validation.json` files; only the judge sample (`JUDGE_SAMPLE_PCT`, default 5 %) needs the API |
| `build-dataset` | `Dockerfile.build_dataset` | One-shot `src/build_dataset.mjs`; profile `build-dataset`, does not start with `up`. The normal way to run dedup + gen + validate + export |
| `train` | `Dockerfile.train` | `train/tsa_train.py <subcommand>`; profile `train`. Python + Together SDK + MLC CPU wheels; mounts the keep-set volume and needs `TOGETHER_API_KEY` (and `HF_TOKEN` for `publish`) |
| `model` | `Dockerfile.model` | nginx serving MLC weights from a read-only volume (`MODEL_ROOT`, default `/srv/tsa-models`) on `127.0.0.1:9501`; profile `model`. Weights are never baked into the image. On the server this is `tsa_models`, a named volume shared with `train` |

```bash
docker compose --profile build-dataset run --rm build-dataset
docker compose --profile build-dataset run --rm -e STAGES=gen,validate,export build-dataset
# The single-stage profiles are still there for debugging:
docker compose --profile dedup run --rm dedup
docker compose --profile gen-responses run --rm gen-responses
docker compose --profile validate-responses run --rm -e JUDGE_SAMPLE_PCT=0 validate-responses
```

`docker-compose.yml` here is a reference (host paths `/srv/trace-data`). The compose files that deploy are `devops/ccmainnet3/mainnet_tsa_{crawler,prepare,build}/docker-compose.override.yml`: traces and the keep-set are separate named volumes, and `DEEPSEEK_API_KEY` comes from `ccmainnet3/.env.local` on the host. Collector, prepare, and dedup must **not** share a `PROM_FILE` (`build-dataset` writes the dedup textfile). `DEEPSEEK_API_KEY` is required for the `build-dataset`, `gen-responses`, and `validate-responses` profiles; compose fails loudly if it is unset.

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
