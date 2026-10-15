# Server runbook (ccmainnet3)

How a collected trace tree becomes the model the playground loads. Collector and prepare stay up. Every step after that is a one-shot container, started by hand with `dc --profile … run --rm`.

`dc` is the zsh function on the server (`devops/_global/scripts/.zshrc`). It `cd`s to `/home/admin/devops/ccmainnet3`, loads `.env`, `.env.ccmainnet3`, and `.env.local`, and passes every service override. Run these commands there. A plain `docker compose` in this repo does not see those overrides or the named volumes.

The images are whatever `update.sh` last built from `tsa_crawler` `main` (each service's `.repo`). Ship code changes before a one-shot if the container should pick them up. `train/variants.json` is copied into the train image at build time; a version bump is invisible until that image is rebuilt.

## Always on

No profile. `update.sh` starts them; leave them running while the one-shots below work.

| Container | Volume | What it writes |
| --- | --- | --- |
| `mainnet_tsa_crawler` | `mainnet_traces` → `/data/traces` | collector traces, cap 5 per bucket |
| `mainnet_tsa_prepare` | `mainnet_traces`, cache on `mainnet_cache` | `_sim.json`, `_prompt.json`, `latest.json` (hourly) |
| `tsa_traces` | `mainnet_traces` read-only, host port 9502 | `https://playground.colibri-proof.tech/traces/` |
| `tsa_model` | `tsa_models` read-only, host port 9501 | `https://playground.colibri-proof.tech/models/` |

`tsa_model` is already serving. New weights show up when `sync` copies them into `tsa_models`; the container does not need a restart.

## Volumes the one-shots use

| Volume | Mount in build / train | Contents |
| --- | --- | --- |
| `mainnet_traces` | `/data/traces` (read-only on `mainnet_tsa_build`) | everything the crawler and prepare produced |
| `mainnet_dedup` | `/data/train` | dedup keep-set, `_response.json`, `_validation.json`, export at `/data/train/dataset`, train state at `/data/train/finetune` |
| `tsa_models` | `/models` | `<model_id>/<weights_version>/…` served by `tsa_model` |

Keys live in `ccmainnet3/.env.local`: `DEEPSEEK_API_KEY` for the build profile, `TOGETHER_API_KEY` for the train profile, `HF_TOKEN` only for `publish`.

## 1. Dedup into `mainnet_dedup`

Does not call DeepSeek. Compose still refuses to start the container when `DEEPSEEK_API_KEY` is unset, because the service definition interpolates it.

`CAP=3`, `REQUIRE_RESOLVED=tx,events`, `STICKY=1`. Sticky means a tx that already has a `_response.json` on `mainnet_dedup` keeps its cluster slot ahead of the quality score. The dry-run summary prints `pinned: N`. An empty keep-set pins nothing. To select purely by score, add `-e STICKY=`.

```bash
dc --profile build run --rm -e STAGES=dedup mainnet_tsa_build --dry-run
dc --profile build run --rm -e STAGES=dedup mainnet_tsa_build
```

The keep-set is smaller than the prompt tree: crawler cap is 5, dedup cap is 3, and unresolved `tx` / `events` sections are skipped. Logs: `docker logs -f mainnet_tsa_build` from a second shell. The container is removed when the run exits.

`mainnet_tsa_dedup` (profile `dedup`) and `mainnet_tsa_teach` (profile `teach`) are the older single-stage containers. They do not apply `REQUIRE_RESOLVED` or `STICKY`. Use `mainnet_tsa_build` for a new dataset.

## 2. Teacher, validation, export

This spends the DeepSeek balance (teacher on every keeper, judge on 5 %). One regeneration pass rewrites answers whose grounding verdict is `fail` or whose judge verdict is `wrong`. Export writes `/data/train/dataset/{train,val}.jsonl` and `manifest.json`, dropping rows under the grounding gate (`MIN_GROUNDING_RATIO=0.7`) and prompts longer than 60k characters.

```bash
dc --profile build run --rm -e STAGES=gen,validate,export mainnet_tsa_build
```

Dedup plus this step in one go, when the keep-set does not need a look first:

```bash
dc --profile build run --rm mainnet_tsa_build
```

Optional review of flagged answers, against the keep-set. `-R` deletes only `_response.json` and `_validation.json`; the next gen/validate/export run fills them back in.

```bash
dc --profile build run --rm -e DATA_DIR=/data/train --entrypoint node mainnet_tsa_build query.mjs -v -S
dc --profile build run --rm -e DATA_DIR=/data/train --entrypoint node mainnet_tsa_build query.mjs -v -s -l 5
dc --profile build run --rm -e DATA_DIR=/data/train --entrypoint node mainnet_tsa_build query.mjs -v -R
dc --profile build run --rm -e STAGES=gen,validate,export mainnet_tsa_build
```

## 3. Train

Reads `/data/train/dataset`. Writes the Together job, the merged checkpoint, and the MLC weights under `/data/train/finetune`. `convert` holds the bf16 checkpoint in RAM (about 10 GB for 4B, about 20 GB for 9B).

`--dry-run` stops after the token gate and the price estimate. Without `--yes` the paid `create` step asks on the TTY (`dc` allocates one). A recorded job is skipped on the next run; `--force-create` starts another, which needs a new Together `--suffix` because the previous name is taken.

```bash
dc --profile train run --rm mainnet_tsa_train pipeline --variant qwen3.5-4b --dry-run
dc --profile train run --rm mainnet_tsa_train pipeline --variant qwen3.5-4b
```

A detached run does not allocate a TTY, so `create` refuses to spend money unless `--yes` is passed:

```bash
dc --profile train run -d --rm mainnet_tsa_train pipeline --variant qwen3.5-4b --yes
```

Resume after a failure with the same command. A single stage:

```bash
dc --profile train run --rm -e STAGES=download,convert,sync mainnet_tsa_train pipeline --variant qwen3.5-4b
```

## 4. Deploy

`sync` (the last pipeline stage) copies the MLC directory to `/models/<model_id>/<weights_version>/` on `tsa_models`. `tsa_model` serves that path. The playground probes `https://playground.colibri-proof.tech/models/<model_id>/<weights_version>/mlc-chat-config.json` and uses it when the file is there.

The 4B entry in `train/variants.json` is `weights_version` `v2` and Together `suffix` `colibri-tsa-4b-v2`. `sync` therefore writes `/models/colibri-tsa-4b-q4f16_1-MLC/v2/` and leaves the previous weights in `v1`. The image copies `variants.json` at build time, so rebuild `mainnet_tsa_train` after this file changes and before the pipeline run. The playground keeps requesting `v1` until the explainer's `TSA_EXPLAINER_MODELS` names `v2` as well.

If a version directory already holds `mlc-chat-config.json`, pipeline `sync` skips it. Browsers cache shards by URL, so the next generation is a new directory:

1. Bump `weights_version` and `suffix` in `train/variants.json`, and the same version in the explainer's `TSA_EXPLAINER_MODELS`.
2. Let `update.sh` rebuild `mainnet_tsa_train` so the image contains the new `variants.json`.
3. Pass `--force-create` when `run.json` still records the previous Together job.
4. Sync only, after convert has already produced the weights:

```bash
dc --profile train run --rm -e STAGES=sync mainnet_tsa_train pipeline --variant qwen3.5-4b
```

Do not pass `--force` to overwrite an existing version directory.

`publish` uploads the same weights to Hugging Face and needs `HF_TOKEN`. The playground path above does not depend on it.

```bash
dc --profile train run --rm mainnet_tsa_train publish --variant qwen3.5-4b
```
