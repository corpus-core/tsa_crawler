# Agent notes

This repo builds **training prompts and teacher responses** for an SLM that explains Ethereum transactions, and drives the fine-tune. It is a small Node toolchain plus one Python driver, not an app: collector → prepare → query, then `build_dataset` (dedup → gen-responses → validate-responses → export-dataset), then `train/tsa_train.py` (Together AI LoRA → MLC weights → Hugging Face).

Read `README.md` for the human-facing pipeline and env vars. This file is for changing the code without breaking layout, CAP accounting, or the explainer contract.

## Layout of the repo

All runnable code lives in `src/`. Tests stay in `test/` and import from `../src/…`.

| Path | Notes |
| --- | --- |
| `src/fetch_traces.mjs` | Live collector. Node builtins + static ESM imports only. The collector Docker image copies this file plus `proxy_accesslist.mjs` and `bucket_paths.mjs`. |
| `src/prepare-testdata.mjs` | Trace → `_sim.json` → `_prompt.json`. Talks to RPC + Sourcify via the explainer. |
| `src/query.mjs` | Read-only prompt filter. CLI is `parseArgs` / `main`; keep helpers exported for tests. |
| `src/dedup.mjs` | Cluster prompts by (path method_id × interface hash); copy CAP keep-set to `OUT`. DATA_DIR is read-only. |
| `src/gen_responses.mjs` | Call DeepSeek Chat Completions with the student prompt; write sibling `_response.json`. `fetch` is injectable for tests. |
| `src/validate_responses.mjs` | Deterministic number grounding of `_response.json` against the prompt plus a seed-stable sampled DeepSeek judge; writes sibling `_validation.json`. Imports `callDeepSeek` / `runPool` from `gen_responses.mjs` and the sibling-path helpers from `query.mjs`. |
| `src/export_dataset.mjs` | Pair `_prompt.json` + `_response.json`, emit `train.jsonl` / `val.jsonl` / `manifest.json` with a codehash-cohesive split. Optional gates on `_validation.json`. |
| `src/build_dataset.mjs` | In-process orchestrator. Calls each stage's `main(env, argv, io, deps)`. `STAGES` selects a subset; pipeline-only defaults (`REQUIRE_RESOLVED`, `STICKY`, export gates incl. `MAX_USER_CHARS`, regen) are applied here and stay off in the standalone tools. |
| `train/tsa_train.py` | Python CLI: `prepare` / `preview` / `estimate` / `create` / `status` / `wait` / `download` / `convert` / `serve` / `sync` / `pipeline` / `publish` / `eval-prep` / `endpoint`. Reads `DATASET_OUT`, writes only under `TRAIN_OUT` (default `train/out`, gitignored). `train/variants.json` maps a variant to Together base model, mlc-ai reference weights, prebuilt WebLLM WASM name, and HF repo. |
| `Dockerfile.train` | python:3.12-slim + `train/requirements.txt` + MLC CPU nightly wheels from `https://mlc.ai/wheels`. Entry point is `tsa_train.py`. |
| `Dockerfile.model` / `docker/model/default.conf.template` | nginx:alpine serving MLC weights from a read-only volume mounted at `/usr/share/nginx/html`, layout `<model_id>/<weights_version>/…`. The conf is an nginx-image envsubst template (`NGINX_PORT`, default 80); only defined env vars are substituted, nginx's `$uri`/`$1` stay. Weights are never copied into the image. Deployed from `devops/ccmainnet3/tsa_model` (host network, port 9501, `tsa_models` volume) behind the ccmainnet1 Caddy `/models/*`. |
| `Dockerfile.traces_http` / `docker/traces/default.conf.template` | nginx:alpine serving the trace volume read-only, including `latest.json` (`Cache-Control: no-store`; other files `max-age=300`; no autoindex). Deployed from `devops/ccmainnet3/tsa_traces` (host network, port 9502, `mainnet_traces` volume) behind the ccmainnet1 Caddy `/traces/*`. |
| `src/bucket_paths.mjs` | **Single source of truth** for on-disk layout. |
| `src/proxy_accesslist.mjs` | Access list + proxy implementation resolution. |
| `src/sim-from-trace.mjs` | Collector file → Colibri simulation JSON. |
| `Dockerfile.traces` / `Dockerfile.prepare` / `Dockerfile.dedup` / `Dockerfile.gen_responses` / `Dockerfile.validate_responses` / `Dockerfile.build_dataset` | COPY the needed `src/*.mjs` files into `/app` (flattened). Collector, dedup, gen-responses, validate-responses, and build-dataset are alpine+node only. Prepare sparse-checkouts the explainer and also copies `latest_examples.mjs`. Dedup copies `dedup.mjs`, `query.mjs`, `bucket_paths.mjs`, `prom_file.mjs`. Gen-responses copies `gen_responses.mjs`, `query.mjs`, `bucket_paths.mjs`, `prom_file.mjs`. Validate-responses copies those plus `validate_responses.mjs`. Build-dataset copies `build_dataset.mjs`, `dedup.mjs`, `gen_responses.mjs`, `validate_responses.mjs`, `export_dataset.mjs`, `query.mjs`, `bucket_paths.mjs`, `prom_file.mjs`. |
| `test/*.test.mjs` | `node:test`. No network. Use temp dirs. |

Everything is ESM (`.mjs`). Docker images do not use `package.json` `"type": "module"`; the `.mjs` suffix is enough.

Default explainer path is resolved from `src/` (`../../colibri-stateless/...`). Docker sets `EXPLAINER_DIR=/opt/explainer`.

## On-disk contract (do not invent a second layout)

Canonical path:

```
<root>/<codehash[0:2]>/<codehash[2:]>/<selector>/<txhash>.json
```

- Codehash and selector directories have **no `0x`**. Empty calldata selector is the directory `fallback`.
- Collector traces match `^0x[0-9a-f]{64}\.json$`. `_sim.json`, `_prompt.json`, `_prompt.nosrc`, `_response.json`, and `_validation.json` are siblings, not traces. `listTraceFiles` must ignore them.
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

A successful prompt also appends one row to `<IN>/latest.json` (override with `LATEST_FILE`, cap `LATEST_LIMIT`, default 200, `0` disables), but only when the simple prompt's transaction section has a decoded `- Function:` name. `- Function selector:` is skipped. When the file is still short of the cap, the start of a run drops selector rows and backfills from the newest decoded `_prompt.json` files already on disk (prepare otherwise skips those). The row is `{ txhash, function, contract, meta: { from, to, input, value }, path }` where `path` is the `_sim.json` relative to `IN`, `function` is that decoded name, and `contract` is `contractName` when the explainer metadata still has it, otherwise the first non-vendor `contract` declaration of `meta.to`. Oldest rows are dropped. The file sits at the trace root, so `walkBuckets` ignores it.

No Sourcify source → write `_prompt.nosrc`, do not write an empty prompt. `hasContractSource` is the gate; do not weaken it to “any metadata”.

The explainer lives **outside** this repo (`EXPLAINER_DIR`). Docker sets `SKIP_EXPLAINER_BUILD=1` and uses a prebuilt `dist/`. Local runs may `npm install` + `npm run build` in that package. Do not vendor the explainer into this tree.

`C4_STATE_DIR` is the Sourcify/solc cache. Default it to a dedicated dir in examples (`. ` is only the code default).

## Query invariants (`src/query.mjs`)

- Filters the first prompt entry only (simple style).
- `-c` / `-m` are OR within the flag; repeated `-q` is AND.
- Section prefixes for `-q`: `tx`, `events`, `state`, `call`, `code` — must match `SECTION_HEADERS` in the explainer user prompt. If the explainer changes headings, update both.
- `DATA_DIR` is required. Stream matches; do not load the whole tree into memory.
- `responsePathForPrompt` / `validationPathForPrompt` / `readResponse` / `readValidation` / `hasValidationProblems` live here and are the canonical sibling helpers; `gen_responses`, `validate_responses`, and `export_dataset` import them instead of re-deriving paths.
- `-s` appends, in this order and only when present: `_sim.json` (`SIM_COLOR`), the `_response.json` content per style (`RESPONSE_COLOR`, light green), the `_validation.json` summary (`VALIDATION_COLOR`, magenta). `-d` alone never reads those siblings.
- `-v` is an additional AND filter: keep only txs where `hasValidationProblems` is true (deterministic verdict `!= pass`, or a judge entry whose verdict `!= good`, including `unparseable`). A missing `_validation.json` is *not* a problem. `-S` still counts against the whole dataset.
- `-X` also removes `_response.json` and `_validation.json` so no orphaned siblings remain.
- `-R` (`unlinkResponseFiles`) removes **only** `_response.json` + `_validation.json` of matching txs and never prunes directories; prompt/sim/trace stay so `gen-responses` regenerates the answer (it treats a missing response file as new work). `-R` is a no-op when `-X` is also set (already covered); with `-x` it removes trace + teacher output. Matching paths are still listed, like `-x`.

## Dedup invariants (`src/dedup.mjs`)

- Read-only on `DATA_DIR`. Never delete source `_prompt.json` / `_prompt.nosrc`.
- First userPrompt only. Skip files without a `code` section C4 source body (and skip `_prompt.nosrc`).
- Cluster key is `<path method_id>:<sha256 of canonical public/external function+event signatures>`. Events/state/call do not affect the key.
- `qualityScore(hit)` is `gasUsed/1e5 + eventCount/3 + callCount/5 + stateChangeCount/10` from the first userPrompt sections (gas thousands-separators stripped). Per-cluster CAP keeps highest scores; ties keep the lexicographically first `relPath`.
- `REQUIRE_RESOLVED` (default empty = off) skips candidates for which `isSectionResolved` is false on a listed section, counted as `skippedUnresolved` in the summary, manifest, and `trace_dedup_skipped_unresolved`. This replaces deleting unresolved txs with `query -E -X`.
- `STICKY=1` (default off; the build pipeline sets it) pins a candidate when `OUT` already has a readable `_response.json` at the same `relPath`. `selectByCap(candidates, cap, { pinned })` sorts pinned first, then `compareKeep`, and never exceeds `cap`. Kept manifest entries carry `pinned`. `copyKeepers` still deletes only prompts and sims, so the paid answer survives the rewrite.
- Index only metadata after scoring — do not retain every userPrompt in memory.
- `OUT` must not be `DATA_DIR` or a parent of it. A `train/` subdirectory under DATA_DIR is safe (`walkBuckets` ignores non-hex top-level names).
- Keep-set copy: `_prompt.json` plus sibling `_sim.json` when present. Do not copy collector traces. Missing sims are skipped. Do not delete `_response.json` / `_validation.json`.
- Prometheus: own `PROM_FILE` per process **and** chain. Write after every completed run (including `--dry-run`); skip help / early validation errors. Atomic `*.tmp` + rename. The file is shared with gen and validate: `writePromSection` replaces only the `trace_dedup_` metrics.

## Build-pipeline invariants (`src/build_dataset.mjs`)

- Calls `dedup` / `gen` / `validate` / `export` `main()` in-process. No shell. `deps` (`fetch`, `sleep`, `rng`, `now`) are forwarded to gen and validate; tests never hit the network.
- `STAGES` default `dedup,gen,validate,export`, always in that order. `dedup` reads `DATA_DIR` and writes `TRAIN_DIR` (default `<DATA_DIR>/train`; the server sets `/data/train` because the keep-set is a separate volume). Later stages read `TRAIN_DIR`. Export writes `DATASET_OUT` (default `<TRAIN_DIR>/dataset`, a non-hex name so `walkBuckets` ignores it).
- Pipeline-only defaults, applied only when the env var is unset (an empty value turns them off): `REQUIRE_RESOLVED=tx,events`, `STICKY=1`, `REGEN_ROUNDS=1`, `MIN_GROUNDING_RATIO=0.7`, `REQUIRE_VALIDATION=1`, `MAX_USER_CHARS=60000`. Standalone `export-dataset` keeps every gate off.
- Regen, after validate, only when both `gen` and `validate` are in `STAGES`: a **fresh** check with `deterministic.verdict === 'fail'` or `judge.verdict === 'wrong'` is deleted via `unlinkResponseFiles` and generated again, at most `REGEN_ROUNDS` times. `warn` and `flawed` are not redone. `--dry-run` counts them and deletes nothing.
- Reset `process.exitCode` before each stage. `dedup` or `export` failing aborts the pipeline. A gen/validate exit 1 (individual calls failed) is remembered and the process exits 1 at the end. A missing `DEEPSEEK_API_KEY` fails before any write when a live gen or judge sample is planned.
- `--dry-run` is forwarded to every stage. A dry-run dedup does not create `TRAIN_DIR`; later stages are skipped with a log line instead of failing their directory check.

## Teacher-response invariants (`src/gen_responses.mjs`)

- **Grounding**: the teacher sees exactly the student prompt (same `systemPrompt` + `userPrompt`). `TEACHER_SYSTEM_SUFFIX` is the only allowed extension; it is stored implicitly via `promptSha256` so the exporter can detect drift.
- Response siblings live next to the trace/prompt files as `<txhash>_response.json`. `listTraceFiles` must ignore them (same rule as `_sim.json` / `_prompt.json`).
- Never store a failed call. `finish_reason != "stop"`, empty `content`, HTTP 4xx (except 429), and hard failures after `MAX_RETRIES` are logged and skipped, not written.
- Merge on write: preserve entries for other styles when adding a new one. The per-entry `model` field is authoritative for the exporter; the top-level `model` is informational.
- Retry only 429, 5xx, and network/timeout errors, with full-jitter exponential backoff bounded at 30s. `AbortController` enforces `TIMEOUT_MS` per attempt.
- `fetch`, `sleep`, `rng`, and `now` are injectable through `main`'s `deps` argument. All tests use mocks; no live DeepSeek call is ever made from `node:test`.
- Atomic writes: `.tmp` + `rename` in `writeResponseEntry`.
- Prometheus: after a completed run (including `--dry-run`), write `trace_gen_*` gauges into `PROM_FILE` via `writePromSection`. Last run only; a regen pass replaces the previous gen section.

## Validation invariants (`src/validate_responses.mjs`)

- Reads `_prompt.json` + `_response.json`, writes only `<txhash>_validation.json` (atomic `.tmp` + rename, merged per style like `writeResponseEntry`). Never touches responses or prompts.
- A check is **fresh** when `contentSha256 === sha256(response.content)`. Fresh checks are skipped unless `FORCE=1`. Changing the prompt does not by itself invalidate the deterministic check (the response text is what is graded); `promptSha256` is stored for drift inspection only.
- Number extraction masks hex tokens, Solidity `hex"…"` literals, truncated addresses (`0x2127...e880`, `2127...e880`), and standard ids (`ERC-20`, `EIP-1559`) **before** matching digits, and rejects tokens preceded by `[A-Za-z0-9_.]` (so `v3`, `X96`, `uint256` never count). Scientific notation is expanded only up to 256 digits; a larger exponent returns `null` instead of throwing. Integers `<= TRIVIAL_MAX` are dropped; fractions never are. `1.0` canonicalises to `1` and is therefore trivial.
- Grounding modes, checked in order: `literal`, `hex` (BigInt of any full `0x…` token ≤ 32 bytes), `scaled` (× or ÷ `10^k` for `k` in `SCALE_EXPONENTS`), `decimals` (the `k` that links an `x (raw: y)` pair), `rounded` (a fractional prompt value, literal or scaled-down, rounds half-up or truncates to the answer's own precision; integers only from `ROUNDED_MIN_INT = 100`). Sums, differences, prices, and percentages are intentionally **not** derived — they land in `unmatched` and the judge covers them.
- All decimal arithmetic is string-based (`scaleUp` / `scaleDown` / `roundDecimalString`). Never route uint256 values through `Number`.
- `ratio = grounded / total`; `total === 0` is a `pass` with ratio 1. Verdict: `pass` ≥ `RATIO_PASS`, `warn` ≥ `RATIO_WARN`, else `fail`. `RATIO_WARN <= RATIO_PASS` is enforced.
- Judge sample is `sha256(JUDGE_SEED || "\0judge\0" || lower(txhash))` mapped to `[0,100)` and compared with `JUDGE_SAMPLE_PCT`; raising the percentage only adds txs. A usable judge result (verdict `!= unparseable`) is reused; `unparseable` is retried on the next run; `FORCE_JUDGE=1` (or `FORCE=1`) re-judges.
- The judge receives the same user prompt wrapped in `<<<SOURCE_DATA>>>` and the answer in `<<<ANALYST_ANSWER>>>`; both are data. It must reply with strict JSON `{score 1–5, verdict good|flawed|wrong, issues[]}`; `parseJudgeContent` tolerates fences/prose but never throws. `rawContent` (truncated) is stored only for unparseable replies.
- No API key is needed when `JUDGE_SAMPLE_PCT=0` or nothing is planned; the run fails **before** writing anything if judge calls are planned without `DEEPSEEK_API_KEY`. `LIMIT` caps judge calls; capped txs keep their deterministic result with `judge: null` and are picked up next run.
- HTTP, retry, backoff, and pool come from `gen_responses.mjs` (`callDeepSeek`, `runPool`); do not duplicate them. `fetch`, `sleep`, `rng`, `now` are injectable via `main`'s `deps`. Tests never call the network.
- Exit code 1 only when a judge call failed after retries; deterministic results for that tx are still written.
- Prometheus: after a completed run (including `--dry-run`), write `trace_validate_*` gauges into the same `PROM_FILE`. Verdicts, mean ratio, and `trace_validate_judge_score` cover every scanned pair (reused judge results included). `judge_ok` / `judge_failed` / token gauges count only API calls of this run. A regen pass replaces the section.

## Export invariants (`src/export_dataset.mjs`)

- One JSONL row per (prompt file × style): `messages = [system, user, assistant]` where `assistant.content` is exactly `entry.content`. **Never** put `reasoning_content` in the assistant message.
- Skip when `entry.promptSha256` does not match the current prompt hash, when `entry.finishReason != "stop"`, or when `content` is empty. All skips are counted by reason in the manifest.
- Split is deterministic: `sha256(SEED || codehash)` bucketed against `VAL_RATIO`. Every tx under the same codehash lands in the same split — do not weaken this or the val loss will underestimate generalisation.
- `DATA_DIR` is read-only. The exporter writes only under `OUT` (`train.jsonl`, `val.jsonl`, `manifest.json`) with atomic writes.
- Validation gates (`validationGate`) are all **off by default** and must never change the default export. A check whose `contentSha256` differs from the response content is stale and treated as missing. `REQUIRE_VALIDATION` / `REQUIRE_JUDGE_PASS` reject missing/stale checks (`no-validation` / `stale-validation`); `MIN_GROUNDING_RATIO` and `MIN_JUDGE_SCORE` only bite when a fresh check (resp. a judge result) exists. `REQUIRE_JUDGE_PASS` also rejects unjudged rows (`judge-not-good`).
- `meta.validation` (`grounding_ratio`, `grounding_verdict`, `judge_score`, `judge_verdict`) is added to a row only when a fresh check exists. Manifest is `version: 2` and carries a `validation` block (gates, rows validated/judged, ratio mean/p10/p50, judge-score histogram) plus `maxUserChars`.
- `MAX_USER_CHARS` (default 0 = off) skips rows whose `userPrompt.length` exceeds it (`too-long`), checked before the response lookup so `no-response-file` stays meaningful. **Never truncate** a prompt: the explainer builds the same prompt at inference, the closing sentence is the last line, and the teacher answer refers to the full content.

## Training invariants (`train/tsa_train.py`)

- Base models are the Qwen3.5 family only, because `@mlc-ai/web-llm` ships prebuilt model libraries for 2B/4B/9B and the explainer sends one `enable_thinking: false` path. Adding a variant means adding an entry to `train/variants.json`, not new code.
- No WASM is compiled. `convert` calls `convert_weight` in-process, then `python -m mlc_llm gen_config` (the nightly wheel ships no `mlc_llm` console script). For `qwen3_5` the export spec is patched down to `embed`: tracing `batch_prefill` segfaults in `tvm::ffi::ReprPrint` on the current CPU nightly, and the weight step only needs the parameter list the exporter walks off the module. The same nightly's loader passes `mlc_param.dtype` (`T.float16`) into `ndarray.astype`; NumPy 2 rejects it, so `convert` rewrites those `functools.partial` dtype keywords to a NumPy dtype string before `convert_weight` runs. `GroupQuantize.quantize_weight` also segfaults in this nightly (the compiled Relax kernel, even on a 64×32 input), so `convert` packs `q4f16_1` in NumPy with the same group scale, zero-point and uint32 nibble layout as `pack_weight`. `gen_config` copies `model_type`, `conv_template`, `context_window_size`, `prefill_chunk_size` from the `mlc-chat-config.json` of `mlc_reference`; `convert` then fails if any of `REFERENCE_KEYS` or `conv_template.name` differ. The prebuilt WASM only runs weights that match its compiled architecture.
- Non-thinking SFT: rows carry only `messages` (no `reasoning`). The Qwen3.5 chat template renders the final assistant turn as `<|im_start|>assistant\n<think>\n\n</think>\n\n{content}`, which is byte-identical to WebLLM's `enable_thinking: false` prefix. `preview` exists to confirm this on Together's tokenised output before `create`.
- Money: `create` and `endpoint up` print the estimate / hourly price and require a TTY confirmation or `--yes`. `download` reuses the `together` CLI instead of internal SDK download classes. `prepare` re-uploads only when the upload JSONL's SHA-256 changed.
- Sequence gate lives in `prepare`, not in the exporter: `count_tokens` renders the row as ChatML (`render_chatml`, with the empty think block) and tokenises it with the base model's `tokenizer.json`. Rows above `--max-seq-tokens` (default `context_window_size` of the variant) are dropped, never truncated. Character counts and the teacher's `prompt_tokens` are not proxies (measured 1.1–3.3 chars/token and a Qwen/DeepSeek ratio up to 2.3×).
- Eval reuses the Node tooling: `eval-prep` copies the val `_prompt.json` files (via `meta.rel_path`) into `train/out/<variant>/eval/data`; `gen_responses.mjs` with `DEEPSEEK_BASE_URL` pointed at Together and `MODEL` set to the endpoint, then `validate_responses.mjs`. Do not add a second grading implementation in Python.
- `TRAIN_OUT` may live under `TRAIN_DIR` (server: `/data/train/finetune`); `walkBuckets` ignores the non-hex name. `HF_HOME` is redirected there too so the container has no hidden cache.
- Public model name is **Colibri TSA**: `model_id` `colibri-tsa-<size>-q4f16_1-MLC`, `hf_repo` `corpus-core/colibri-tsa-…`, Together suffix `colibri-tsa-<size>-vN`. Variant keys (`qwen3.5-4b`) name the base, not the product.
- `download`: the `together` CLI's `--output-dir` is the output **file**; pass `<dl_dir>/<job>-merged.tar.zst`, never a directory (the SDK `shutil.move`s the finished temp file into an existing dir under its `tmpXXXX` name). `archive_format` sniffs zstd/gzip/tar magic instead of trusting the name, and a complete leftover temp file is adopted rather than downloaded again.
- `pipeline` is the train-step orchestrator (counterpart of `build_dataset.mjs`): stages `prepare,create,wait,download,convert,sync` in that fixed order, `STAGES`/`--stages` selects a subset, each stage skips recorded work (`create` with an existing `job_id`, `download`/`convert` with existing output, `sync` with an existing version via `exists_ok`). Money still goes through `confirm` (`--yes`). `--dry-run` never uploads or creates. A missing `TOGETHER_API_KEY` fails before any stage runs when an API stage is selected. `MODELS_DIR` is the `sync` default (`/models` in the image = the `tsa_models` volume).
- Self-hosted weights: `sync` copies `train/out/<variant>/mlc/` to `<dest>/<model_id>/<weights_version>/` (in-process for a local dest, `rsync` for `host:/path`) and refuses to overwrite an existing version without `--force`. Browsers cache shards by URL, so new weights need a new `weights_version` in **both** `train/variants.json` and the explainer's `TSA_EXPLAINER_MODELS`; never replace files in place under an existing version. `docker/model/default.conf.template` must keep the `resolve/<rev>/` rewrite (WebLLM's `cleanModelUrl` appends `resolve/main/`), CORS `*`, and `immutable` caching; `/health` is blocked at Caddy.

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

- A local training loop (TRL/Unsloth). Training runs on Together AI through `train/tsa_train.py`; this repo never downloads base-model weights for training.
- Changing compose host paths, Loki URLs, or production volume owners.
- Force-push, amending others' commits, or committing `test_data/` / secrets.
