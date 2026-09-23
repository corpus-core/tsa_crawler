#!/usr/bin/env python3
"""Fine-tune the TSA explainer student models and package them for WebLLM.

The pipeline is a chain of idempotent subcommands. Each one reads and writes
`train/out/…`, so a step can be re-run without redoing the previous ones:

```
prepare  --variant V    train.jsonl/val.jsonl -> token gate -> upload JSONL -> Together file ids
limits   --variant V    Together's limits for the base model (seq length, LoRA rank)
preview  --variant V    tokenised sample rows as Together will train on them
estimate --variant V    price estimate for the configured job
create   --variant V    start the LoRA SFT job (asks for confirmation)
status   --variant V    job status, latest events, loss curve
wait     --variant V    poll until the job is finished
download --variant V    merged HF checkpoint -> train/out/V/merged/
convert  --variant V    HF checkpoint -> MLC q4f16_1 weights (+ reference check)
serve    --variant V    serve the MLC weights on localhost for a WebLLM test
sync     --variant V    rsync the MLC weights to the self-hosted model server
pipeline --variant V    prepare -> create -> wait -> download -> convert -> sync (STAGES, MODELS_DIR)
publish  --variant V    upload MLC weights to Hugging Face, write model_record.json
eval-prep --variant V   copy val prompts into a tree gen_responses.mjs can consume
endpoint up|down|status --variant V   dedicated Together endpoint for eval
```

Variants live in `train/variants.json`. Environment:

- `TOGETHER_API_KEY` for everything that talks to Together.
- `HF_TOKEN` for `publish`.
- `DATASET_OUT` (default `../train_data/sft`): directory with `train.jsonl`, `val.jsonl`.
- `TRAIN_OUT` (default `train/out`): working directory.
- `STAGES`, `MODELS_DIR`: defaults for `pipeline` (stage subset, sync target).

Only `prepare`, `convert`, `publish` and `eval-prep` touch the local file
system beyond `TRAIN_OUT`; nothing here modifies the prompt tree.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import time
from pathlib import Path
from typing import Any, NoReturn

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
VARIANTS_FILE = HERE / "variants.json"

TRAIN_NAME = "train.jsonl"
VAL_NAME = "val.jsonl"
UPLOAD_TRAIN = "train_upload.jsonl"
UPLOAD_VAL = "val_upload.jsonl"
UPLOAD_STATE = "upload.json"
RUN_STATE = "run.json"
MODEL_RECORD = "model_record.json"

# Default LoRA hyper-parameters. Together caps lora_r at 64 for Qwen3.5;
# rank 32 with alpha 64 is a common sweet spot for ~2.5k long examples.
DEFAULT_EPOCHS = 3
DEFAULT_LORA_R = 32
DEFAULT_LORA_ALPHA = 64
DEFAULT_LR = 1e-4
DEFAULT_WARMUP = 0.05
DEFAULT_N_EVALS = 3

# WebLLM resolves prebuilt model libraries under this prefix + version.
# Keep in sync with `modelLibURLPrefix` / `modelVersion` of the installed
# @mlc-ai/web-llm (0.2.84 at the time of writing).
MODEL_LIB_URL_PREFIX = "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/"
MODEL_LIB_VERSION = "v0_2_84/base"

# Fields of mlc-chat-config.json that must be identical between the
# reference weights and ours, otherwise the prebuilt WASM cannot run them.
REFERENCE_KEYS = (
    "model_type",
    "quantization",
    "vocab_size",
    "context_window_size",
    "sliding_window_size",
    "prefill_chunk_size",
    "attention_sink_size",
    "tensor_parallel_shards",
    "model_config",
)

FINISHED_STATES = {"completed", "cancelled", "error"}

# Assistant prefix that WebLLM injects with `enable_thinking: false` and that
# the Qwen3.5 chat template renders for the final assistant turn in SFT.
EMPTY_THINK_PREFIX = "<think>\n\n</think>\n\n"


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def log(msg: str) -> None:
    print(f"tsa-train: {msg}", flush=True)


def die(msg: str, code: int = 1) -> NoReturn:
    print(f"tsa-train: error: {msg}", file=sys.stderr, flush=True)
    sys.exit(code)


def read_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def write_json_atomic(path: Path, data: Any) -> None:
    """Write `data` as pretty JSON via `path.tmp` + rename."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, sort_keys=True)
        fh.write("\n")
    tmp.replace(path)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_variants() -> dict[str, dict[str, Any]]:
    data = read_json(VARIANTS_FILE)
    if not isinstance(data, dict):
        die(f"{VARIANTS_FILE} is not a JSON object")
    return {k: v for k, v in data.items() if not k.startswith("_")}


def get_variant(name: str) -> dict[str, Any]:
    variants = load_variants()
    if name not in variants:
        die(f"unknown variant '{name}'; available: {', '.join(sorted(variants))}")
    v = dict(variants[name])
    v["name"] = name
    for key in ("base_model", "mlc_reference", "model_lib", "quantization", "hf_repo", "model_id"):
        if not v.get(key):
            die(f"variant '{name}' is missing '{key}'")
    return v


def train_out() -> Path:
    return Path(os.environ.get("TRAIN_OUT") or (HERE / "out")).resolve()


def dataset_out() -> Path:
    return Path(os.environ.get("DATASET_OUT") or (REPO_ROOT / "train_data" / "sft")).resolve()


def variant_dir(variant: dict[str, Any]) -> Path:
    d = train_out() / variant["name"]
    d.mkdir(parents=True, exist_ok=True)
    return d


def run_state(variant: dict[str, Any]) -> dict[str, Any]:
    return read_json(variant_dir(variant) / RUN_STATE, {}) or {}


def save_run_state(variant: dict[str, Any], state: dict[str, Any]) -> None:
    write_json_atomic(variant_dir(variant) / RUN_STATE, state)


def together_client():
    key = os.environ.get("TOGETHER_API_KEY")
    if not key:
        die("TOGETHER_API_KEY is not set")
    try:
        from together import Together
    except ImportError:
        die("python package 'together' is missing; pip install -r train/requirements.txt")
    return Together(api_key=key)


def confirm(prompt: str, assume_yes: bool) -> bool:
    if assume_yes:
        return True
    if not sys.stdin.isatty():
        die("refusing to spend money without a TTY; pass --yes to confirm non-interactively")
    answer = input(f"{prompt} [y/N] ").strip().lower()
    return answer in ("y", "yes")


# ---------------------------------------------------------------------------
# prepare
# ---------------------------------------------------------------------------

def strip_row(row: dict[str, Any], line_no: int, source: str) -> dict[str, Any]:
    """Reduce an export row to the `messages` Together needs.

    Validates the structure Together enforces server-side (system/user
    first, then alternating user/assistant, assistant last) so a bad row
    fails here instead of after the upload.
    """
    messages = row.get("messages")
    if not isinstance(messages, list) or len(messages) < 2:
        die(f"{source}:{line_no}: 'messages' missing or too short")
    roles = [m.get("role") for m in messages]
    if roles[0] not in ("system", "user"):
        die(f"{source}:{line_no}: first role must be system or user, got {roles[0]}")
    body = roles[1:] if roles[0] == "system" else roles
    expected = "user"
    for r in body:
        if r != expected:
            die(f"{source}:{line_no}: roles must alternate user/assistant, got {roles}")
        expected = "assistant" if expected == "user" else "user"
    if roles[-1] != "assistant":
        die(f"{source}:{line_no}: last message must be from the assistant")
    clean = []
    for m in messages:
        content = m.get("content")
        if not isinstance(content, str) or not content.strip():
            die(f"{source}:{line_no}: empty content for role {m.get('role')}")
        clean.append({"role": m["role"], "content": content})
    return {"messages": clean}


def load_tokenizer(variant: dict[str, Any]):
    """Return a `tokenizers.Tokenizer` for the variant's base model.

    Downloads `tokenizer.json` from the Hugging Face repo of `base_model`
    (cached under `HF_HOME`). The token gate must use the student's own
    tokenizer: Solidity and hex tokenise at 1-2 chars/token, prose at 3-4,
    so neither character counts nor the teacher's `prompt_tokens` predict the
    real sequence length.
    """
    try:
        from huggingface_hub import hf_hub_download
        from tokenizers import Tokenizer
    except ImportError:
        die("python packages 'huggingface_hub' and 'tokenizers' are required; pip install -r train/requirements.txt")
    path = hf_hub_download(repo_id=variant["base_model"], filename="tokenizer.json")
    return Tokenizer.from_file(path)


def render_chatml(messages: list[dict[str, str]]) -> str:
    """Render a row the way the Qwen3.5 chat template does for non-thinking SFT.

    Mirrors the template: every turn is `<|im_start|>{role}\\n{content}<|im_end|>\\n`
    and the final assistant turn carries the empty thinking block. Used only
    for counting tokens; Together renders the real sequence server-side.
    """
    parts = []
    last = len(messages) - 1
    for i, m in enumerate(messages):
        content = m["content"]
        if m["role"] == "assistant" and i == last:
            content = f"{EMPTY_THINK_PREFIX}{content}"
        parts.append(f"<|im_start|>{m['role']}\n{content}<|im_end|>\n")
    return "".join(parts)


def count_tokens(tokenizer, messages: list[dict[str, str]]) -> int:
    return len(tokenizer.encode(render_chatml(messages), add_special_tokens=False).ids)


def convert_jsonl(src: Path, dest: Path, tokenizer, max_seq_tokens: int) -> dict[str, Any]:
    """Copy `src` to `dest` keeping only `messages` and rows within the token budget.

    Rows are dropped, never truncated: a cut prompt would no longer match what
    the explainer builds at inference, and the teacher answer refers to the
    full prompt. Returns counts and token percentiles for the manifest.
    """
    kept = 0
    dropped = 0
    lengths: list[int] = []
    dropped_lengths: list[int] = []
    tmp = dest.with_suffix(dest.suffix + ".tmp")
    with src.open("r", encoding="utf-8") as fin, tmp.open("w", encoding="utf-8") as fout:
        for line_no, line in enumerate(fin, 1):
            line = line.strip()
            if not line:
                continue
            row = strip_row(json.loads(line), line_no, str(src))
            n = count_tokens(tokenizer, row["messages"])
            if max_seq_tokens > 0 and n > max_seq_tokens:
                dropped += 1
                dropped_lengths.append(n)
                continue
            lengths.append(n)
            fout.write(json.dumps(row, ensure_ascii=False) + "\n")
            kept += 1
    tmp.replace(dest)
    return {
        "rows": kept,
        "dropped_too_long": dropped,
        "max_seq_tokens": max_seq_tokens,
        "tokens": {
            "p50": percentile(lengths, 0.5),
            "p90": percentile(lengths, 0.9),
            "max": max(lengths) if lengths else 0,
            "sum": sum(lengths),
        },
        "dropped_tokens_min": min(dropped_lengths) if dropped_lengths else None,
    }


def percentile(values: list[int], p: float) -> int:
    if not values:
        return 0
    s = sorted(values)
    return s[min(len(s) - 1, int(p * (len(s) - 1)))]


def upload_file(client, path: Path):
    """`files.upload` with a readable failure for the two common account errors.

    Together answers `401` on `/files` for accounts without billing set up
    (the SDK relabels that as "exceeds free trial credits"), and `409` when
    the same content was uploaded before.
    """
    try:
        from together import APIStatusError, AuthenticationError
    except ImportError:
        die("python package 'together' is missing; pip install -r train/requirements.txt")
    try:
        return client.files.upload(path, purpose="fine-tune", check=True)
    except AuthenticationError as exc:
        die(
            f"upload of {path.name} rejected with 401: {getattr(exc, 'body', None) or exc}\n"
            "  Fine-tuning uploads need a paid account: add billing/credits at\n"
            "  https://api.together.ai/settings/billing, then re-run prepare.\n"
            "  (If `limits` fails with 401 too, the key itself is wrong.)"
        )
    except APIStatusError as exc:
        die(f"upload of {path.name} failed: {exc}")


def wait_for_file(client, file_id: str, timeout_s: int = 1800) -> None:
    """Block until Together finished validating an uploaded file."""
    deadline = time.time() + timeout_s
    while True:
        info = client.files.retrieve(file_id)
        status = getattr(info, "processing_status", None)
        if status in (None, "COMPLETED"):
            return
        if status in ("FAILED", "INVALID_FORMAT"):
            report = getattr(info, "validation_report", None)
            die(f"file {file_id} rejected by Together: {status} {report!r}")
        if time.time() > deadline:
            die(f"file {file_id} still {status} after {timeout_s}s")
        log(f"file {file_id}: {status}, waiting ...")
        time.sleep(10)


def cmd_prepare(args: argparse.Namespace) -> None:
    variant = get_variant(args.variant)
    src_dir = dataset_out()
    train_src = src_dir / TRAIN_NAME
    val_src = src_dir / VAL_NAME
    if not train_src.is_file():
        die(f"{train_src} not found (set DATASET_OUT or run build_dataset first)")
    out = train_out()
    out.mkdir(parents=True, exist_ok=True)

    # The sequence budget is the serving context window of the variant unless
    # overridden: a row that does not fit in the browser is not worth training
    # on, and Together would silently truncate rows above its own max_seq_length.
    max_seq = args.max_seq_tokens if args.max_seq_tokens is not None else int(variant.get("context_window_size", 0))
    tokenizer = load_tokenizer(variant)
    log(f"token gate: {variant['base_model']} tokenizer, max_seq_tokens={max_seq or 'off'}")

    train_dest = out / UPLOAD_TRAIN
    val_dest = out / UPLOAD_VAL
    train_stats = convert_jsonl(train_src, train_dest, tokenizer, max_seq)
    val_stats = convert_jsonl(val_src, val_dest, tokenizer, max_seq) if val_src.is_file() else {"rows": 0, "dropped_too_long": 0, "tokens": {"p50": 0, "p90": 0, "max": 0, "sum": 0}}
    n_train, n_val = train_stats["rows"], val_stats["rows"]
    for name, st in (("train", train_stats), ("val", val_stats)):
        t = st["tokens"]
        log(f"{name}: kept {st['rows']} dropped {st['dropped_too_long']} (too long); seq tokens p50={t['p50']} p90={t['p90']} max={t['max']} sum={t['sum']}")
    if n_train == 0:
        die("no train rows")

    state = read_json(out / UPLOAD_STATE, {}) or {}
    state["gate"] = {"variant": variant["name"], "max_seq_tokens": max_seq, "train": train_stats, "val": val_stats}
    train_sha = sha256_file(train_dest)
    val_sha = sha256_file(val_dest) if n_val else None

    try:
        from together.lib.utils.files import check_file
    except ImportError:
        check_file = None  # type: ignore[assignment]
    if check_file is not None:
        for p in (train_dest, val_dest) if n_val else (train_dest,):
            report = check_file(p)
            if not report.get("is_check_passed"):
                die(f"together check failed for {p}: {report.get('message')}")
        log("local together file check passed")

    if args.dry_run:
        log("dry-run: skipping upload")
        write_json_atomic(out / UPLOAD_STATE, state)
        return

    client = together_client()
    changed = False
    if state.get("train_sha256") != train_sha or not state.get("train_file_id"):
        resp = upload_file(client, train_dest)
        wait_for_file(client, resp.id)
        state.update({"train_file_id": resp.id, "train_sha256": train_sha, "train_rows": n_train})
        changed = True
        log(f"uploaded train file -> {resp.id}")
    else:
        log(f"train file unchanged -> {state['train_file_id']}")

    if n_val:
        if state.get("val_sha256") != val_sha or not state.get("val_file_id"):
            resp = upload_file(client, val_dest)
            wait_for_file(client, resp.id)
            state.update({"val_file_id": resp.id, "val_sha256": val_sha, "val_rows": n_val})
            changed = True
            log(f"uploaded val file -> {resp.id}")
        else:
            log(f"val file unchanged -> {state['val_file_id']}")
    else:
        state.pop("val_file_id", None)
        state.pop("val_sha256", None)

    if changed:
        state["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    write_json_atomic(out / UPLOAD_STATE, state)


def upload_state_or_die() -> dict[str, Any]:
    state = read_json(train_out() / UPLOAD_STATE)
    if not state or not state.get("train_file_id"):
        die("no uploaded training file; run `prepare` first")
    return state


# ---------------------------------------------------------------------------
# preview / estimate / create
# ---------------------------------------------------------------------------


def cmd_preview(args: argparse.Namespace) -> None:
    """Show how Together tokenises sample rows.

    The important check: the assistant turn must start with the empty
    thinking block `<think>\\n\\n</think>\\n\\n`, because that is the prefix
    WebLLM injects with `enable_thinking: false`. If the rendered rows do not
    contain it, training and inference disagree on the assistant prefix.
    """
    variant = get_variant(args.variant)
    upload = upload_state_or_die()
    client = together_client()
    resp = client.fine_tuning.preview(
        model=variant["base_model"],
        training_file=upload["train_file_id"],
        top_k=args.rows,
        training_method="sft",
    )
    log(f"model={resp.model} format={resp.dataset_format} max_seq_length={resp.max_seq_length} train_on_inputs={resp.train_on_inputs}")
    # Together's `tokens` are byte-level BPE strings ("Ċ" for newline), so
    # decode the ids with the base model's tokenizer to get real text.
    tokenizer = load_tokenizer(variant)
    decode = lambda ids: tokenizer.decode(list(ids), skip_special_tokens=False)  # noqa: E731
    assistant_prefix = f"<|im_start|>assistant\n{EMPTY_THINK_PREFIX}"
    for i, row in enumerate(resp.rows):
        text = decode(row.input_ids)
        trained_ids = [tid for tid, lab in zip(row.input_ids, row.labels) if lab != -100]
        trained_text = decode(trained_ids)
        has_prefix = assistant_prefix in text
        # The loss must cover only the answer: the trained span should start
        # right after the empty thinking block, not include prompt tokens.
        trained_starts_clean = not trained_text.startswith("<|im_start|>") and "<|im_start|>user" not in trained_text
        log(
            f"row {i}: tokens={row.num_tokens} trained={row.num_trained_tokens} spans={len(row.trained_spans)} "
            f"truncated={row.truncated} empty_think_prefix={'yes' if has_prefix else 'NO'} answer_only_loss={'yes' if trained_starts_clean else 'NO'}"
        )
        head = text[: args.chars].replace("\n", "\\n")
        tail = text[-args.chars:].replace("\n", "\\n")
        trained_head = trained_text[:200].replace("\n", "\\n")
        print(f"  head: {head}")
        print(f"  tail: {tail}")
        print(f"  trained head: {trained_head}")
        if not has_prefix:
            log("warning: rendered row lacks the empty thinking block after the assistant header; check the chat template before training")
        if not trained_starts_clean:
            log("warning: trained span includes prompt tokens; train_on_inputs is not off")
        if row.truncated:
            log("warning: row truncated at max_seq_length; lower --max-seq-tokens in prepare")


def training_params(variant: dict[str, Any], args: argparse.Namespace, upload: dict[str, Any]) -> dict[str, Any]:
    params: dict[str, Any] = {
        "training_file": upload["train_file_id"],
        "model": variant["base_model"],
        "n_epochs": args.epochs,
        "learning_rate": args.lr,
        "warmup_ratio": args.warmup,
        "lora": True,
        "lora_r": args.lora_r,
        "lora_alpha": args.lora_alpha,
        "lora_dropout": 0.0,
        "train_on_inputs": False,
        "suffix": args.suffix or variant.get("suffix") or f"colibri-tsa-{variant['name']}",
        "n_checkpoints": 1,
        # Explicit: Together's per-model default is unknown and rows above it
        # are truncated silently. The SDK validates against max_seq_length_sft.
        "max_seq_length": args.max_seq_length or int(variant.get("context_window_size", 0)) or None,
    }
    if upload.get("val_file_id"):
        params["validation_file"] = upload["val_file_id"]
        params["n_evals"] = args.n_evals
    return params


def estimate(client, params: dict[str, Any]):
    est = client.fine_tuning.estimate_price(
        training_file=params["training_file"],
        model=params["model"],
        n_epochs=params["n_epochs"],
        n_evals=params.get("n_evals", 0),
        training_method={"method": "sft", "train_on_inputs": False},
        training_type={"type": "Lora", "lora_r": params["lora_r"], "lora_alpha": params["lora_alpha"]},
        **({"validation_file": params["validation_file"]} if params.get("validation_file") else {}),
    )
    return est


def print_estimate(est) -> float | None:
    if not getattr(est, "estimation_available", False):
        log(f"price estimate unavailable: {getattr(est, 'unavailable_reason', '?')}")
        return None
    price = est.estimated_total_price
    log(
        f"estimate: total ${price:.2f} "
        f"(train tokens {est.estimated_train_token_count:,.0f}, eval tokens {est.estimated_eval_token_count or 0:,.0f}, "
        f"limit ${est.user_limit or 0:.2f}, allowed={est.allowed_to_proceed})"
    )
    return price


def cmd_limits(args: argparse.Namespace) -> None:
    """Print Together's fine-tuning limits for the variant's base model.

    Run this before `create`: it confirms the model is fine-tunable at all
    and that `max_seq_length_sft` covers the variant's context window.
    """
    variant = get_variant(args.variant)
    client = together_client()
    lim = client.fine_tuning.model_limits(model_name=variant["base_model"])
    ctx = int(variant.get("context_window_size", 0))
    log(f"{variant['base_model']}:")
    print(f"  max_seq_length_sft      {lim.max_seq_length_sft}  (variant context_window_size {ctx}: {'ok' if ctx <= lim.max_seq_length_sft else 'TOO LARGE'})")
    print(f"  min_max_seq_length      {lim.min_max_seq_length}")
    print(f"  lora max_rank           {lim.lora_training.max_rank}  (default --lora-r {DEFAULT_LORA_R})")
    print(f"  lora target_modules     {', '.join(lim.lora_training.target_modules)}")
    print(f"  batch size              {lim.lora_training.min_batch_size}..{lim.lora_training.max_batch_size}")
    print(f"  learning rate           {lim.min_learning_rate}..{lim.max_learning_rate}  (default --lr {DEFAULT_LR})")
    print(f"  max epochs / evals      {lim.max_num_epochs} / {lim.max_num_evals}")
    print(f"  merge_output_lora       {lim.merge_output_lora}  (must be True for `download --checkpoint-type merged`)")
    print(f"  supports_full_training  {lim.supports_full_training}")
    if ctx > lim.max_seq_length_sft:
        die(f"context_window_size {ctx} exceeds Together's SFT limit {lim.max_seq_length_sft}; lower --max-seq-tokens in prepare")
    if DEFAULT_LORA_R > lim.lora_training.max_rank:
        log(f"warning: default lora_r {DEFAULT_LORA_R} exceeds max_rank {lim.lora_training.max_rank}; pass --lora-r")


def cmd_estimate(args: argparse.Namespace) -> None:
    variant = get_variant(args.variant)
    upload = upload_state_or_die()
    client = together_client()
    print_estimate(estimate(client, training_params(variant, args, upload)))


def cmd_create(args: argparse.Namespace) -> None:
    variant = get_variant(args.variant)
    upload = upload_state_or_die()
    state = run_state(variant)
    if state.get("job_id") and not args.force:
        die(f"variant already has job {state['job_id']} ({state.get('status', '?')}); pass --force to start another")
    client = together_client()
    params = training_params(variant, args, upload)
    log("job parameters: " + json.dumps(params, sort_keys=True))
    est = estimate(client, params)
    price = print_estimate(est)
    if price is not None and getattr(est, "allowed_to_proceed", True) is False:
        die("Together reports the account is not allowed to proceed (credit limit)")
    if not confirm(f"start LoRA job on {variant['base_model']} for about ${price if price is not None else float('nan'):.2f}?", args.yes):
        log("aborted")
        return
    job = client.fine_tuning.create(**params)
    state.update({
        "job_id": job.id,
        "status": job.status,
        "base_model": variant["base_model"],
        "params": params,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "estimated_price": price,
    })
    save_run_state(variant, state)
    log(f"started job {job.id} status={job.status}")


# ---------------------------------------------------------------------------
# status / wait
# ---------------------------------------------------------------------------

def job_or_die(variant: dict[str, Any]) -> tuple[dict[str, Any], str]:
    state = run_state(variant)
    job_id = state.get("job_id")
    if not job_id:
        die(f"variant '{variant['name']}' has no job; run `create` first")
    return state, job_id


def job_progress_line(job) -> str:
    """`epochs_completed` and Together's own ETA to the next state, when present."""
    parts = []
    epochs = getattr(job, "epochs_completed", None)
    if epochs is not None:
        parts.append(f"epochs_completed={epochs}/{getattr(job, 'n_epochs', '?')}")
    prog = getattr(job, "progress", None)
    if prog is not None and getattr(prog, "estimate_available", False):
        secs = int(prog.seconds_remaining or 0)
        parts.append(f"eta_next_state={secs // 3600}h{(secs % 3600) // 60:02d}m")
    tokens = getattr(job, "token_count", None)
    if tokens:
        parts.append(f"tokens_processed={tokens:,}")
    return " ".join(parts)


def refresh_job(client, variant: dict[str, Any], state: dict[str, Any], job_id: str):
    job = client.fine_tuning.retrieve(job_id)
    state["status"] = job.status
    output_name = getattr(job, "x_model_output_name", None) or getattr(job, "model_output_name", None)
    if output_name:
        state["output_name"] = output_name
    model_object_id = getattr(job, "api_model_object_id", None) or getattr(job, "model_object_id", None)
    if model_object_id:
        state["model_object_id"] = model_object_id
    save_run_state(variant, state)
    return job


def print_metrics(client, job_id: str, limit: int = 12) -> None:
    try:
        metrics = client.fine_tuning.list_metrics(job_id)
    except Exception as exc:  # metrics are best-effort
        log(f"metrics unavailable: {exc}")
        return
    rows = metrics.metrics or []
    if not rows:
        return
    log(f"metrics ({len(rows)} points, showing last {min(limit, len(rows))}):")
    for m in rows[-limit:]:
        print("  " + " ".join(f"{k}={v:.4g}" if isinstance(v, float) else f"{k}={v}" for k, v in sorted(m.items())))


def cmd_status(args: argparse.Namespace) -> None:
    variant = get_variant(args.variant)
    state, job_id = job_or_die(variant)
    client = together_client()
    job = refresh_job(client, variant, state, job_id)
    log(f"job {job_id}: status={job.status} {job_progress_line(job)} output_name={state.get('output_name')} model_object_id={state.get('model_object_id')}")
    try:
        events = client.fine_tuning.list_events(job_id)
        for ev in (events.data or [])[-8:]:
            print(f"  [{getattr(ev, 'created_at', '')}] {getattr(ev, 'message', ev)}")
    except Exception as exc:
        log(f"events unavailable: {exc}")
    print_metrics(client, job_id)


def cmd_wait(args: argparse.Namespace) -> None:
    variant = get_variant(args.variant)
    state, job_id = job_or_die(variant)
    client = together_client()
    last = None
    while True:
        job = refresh_job(client, variant, state, job_id)
        line = f"{job.status} {job_progress_line(job)}".strip()
        if line != last:
            log(f"job {job_id}: {line}")
            last = line
        if job.status in FINISHED_STATES:
            break
        time.sleep(args.interval)
    print_metrics(client, job_id)
    if job.status != "completed":
        die(f"job finished with status {job.status}")


# ---------------------------------------------------------------------------
# download
# ---------------------------------------------------------------------------

ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"
GZIP_MAGIC = b"\x1f\x8b"


def archive_format(path: Path) -> str | None:
    """Detect `tar.zst` / `tar.gz` / `tar` from the file content.

    The Together CLI may leave the download under a temp name without an
    extension, so the name cannot be trusted.
    """
    with path.open("rb") as fh:
        head = fh.read(4)
    if head == ZSTD_MAGIC:
        return "tar.zst"
    if head[:2] == GZIP_MAGIC:
        return "tar.gz"
    if tarfile.is_tarfile(path):
        return "tar"
    return None


def extract_archive(archive: Path, dest: Path) -> None:
    """Extract a tar archive (zstd, gzip or plain) into `dest` (fresh directory)."""
    fmt = archive_format(archive)
    if fmt is None:
        die(f"unknown archive format: {archive}")
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    if fmt == "tar.zst":
        try:
            import zstandard
        except ImportError:
            die("python package 'zstandard' is missing; pip install -r train/requirements.txt")
        with archive.open("rb") as fh:
            dctx = zstandard.ZstdDecompressor()
            with dctx.stream_reader(fh) as reader:
                with tarfile.open(fileobj=reader, mode="r|") as tar:
                    tar.extractall(dest, filter="data")
    else:
        with tarfile.open(archive) as tar:
            tar.extractall(dest, filter="data")


def find_hf_dir(root: Path) -> Path:
    """Return the directory that holds `config.json` (archives may nest one level)."""
    if (root / "config.json").is_file():
        return root
    for p in root.rglob("config.json"):
        return p.parent
    die(f"no config.json under {root}; not a Hugging Face checkpoint")


def cmd_download(args: argparse.Namespace) -> None:
    variant = get_variant(args.variant)
    state, job_id = job_or_die(variant)
    vdir = variant_dir(variant)
    merged = vdir / "merged"
    if (merged / "config.json").is_file() and not args.force:
        log(f"merged checkpoint already present at {merged}; pass --force to re-download")
        return
    client = together_client()
    job = refresh_job(client, variant, state, job_id)
    if job.status != "completed":
        die(f"job {job_id} is {job.status}; wait for completion first")

    dl_dir = vdir / "download"
    dl_dir.mkdir(parents=True, exist_ok=True)
    # Despite its name, the CLI's `--output-dir` is the output *file*: with an
    # existing directory the SDK's shutil.move() drops the finished download
    # into it under its temp name (`tmpXXXXXXXX`, no extension). Pass a file
    # path, and adopt such a leftover from an earlier run instead of
    # re-downloading 7 GB - the SDK only moves the file after the size check.
    archive = dl_dir / f"{job_id}-merged.tar.zst"
    if not archive.is_file() or args.force:
        leftovers = [p for p in dl_dir.iterdir() if p.is_file() and not p.name.endswith(".lock") and p != archive]
        adopted = next((p for p in leftovers if archive_format(p) is not None), None) if not args.force else None
        if adopted is not None:
            log(f"adopting earlier download {adopted.name} ({adopted.stat().st_size / 1e9:.2f} GB) as {archive.name}")
            adopted.replace(archive)
        else:
            # The SDK exposes checkpoint download only through its CLI; reuse it
            # instead of re-implementing the streaming download.
            cli = shutil.which("together")
            if not cli:
                die("`together` CLI not found on PATH (it ships with the python package)")
            cmd = [cli, "fine-tuning", "download", job_id, "--checkpoint-type", "merged", "--output-dir", str(archive)]
            log("running: " + " ".join(cmd))
            subprocess.run(cmd, check=True, env=dict(os.environ))
    else:
        log(f"reusing downloaded archive {archive}")
    if not archive.is_file():
        die(f"download produced no file at {archive}")
    log(f"extracting {archive.name} ({archive.stat().st_size / 1e9:.2f} GB, {archive_format(archive)})")
    extract_archive(archive, merged)
    hf_dir = find_hf_dir(merged)
    if hf_dir != merged:
        # Flatten so `merged/config.json` exists.
        tmp = vdir / "merged.flat"
        if tmp.exists():
            shutil.rmtree(tmp)
        shutil.move(str(hf_dir), str(tmp))
        shutil.rmtree(merged)
        tmp.rename(merged)
    state["merged_dir"] = str(merged)
    save_run_state(variant, state)
    cfg = read_json(merged / "config.json", {})
    log(f"merged checkpoint ready: architectures={cfg.get('architectures')} model_type={cfg.get('model_type')}")


# ---------------------------------------------------------------------------
# convert
# ---------------------------------------------------------------------------

def fetch_reference_config(variant: dict[str, Any]) -> dict[str, Any]:
    try:
        from huggingface_hub import hf_hub_download
    except ImportError:
        die("python package 'huggingface_hub' is missing; pip install -r train/requirements.txt")
    path = hf_hub_download(repo_id=variant["mlc_reference"], filename="mlc-chat-config.json")
    return read_json(Path(path))


def diff_reference(ours: dict[str, Any], ref: dict[str, Any]) -> list[str]:
    problems = []
    for key in REFERENCE_KEYS:
        if ours.get(key) != ref.get(key):
            problems.append(f"{key}: ours={json.dumps(ours.get(key))[:200]} reference={json.dumps(ref.get(key))[:200]}")
    ours_tpl = (ours.get("conv_template") or {}).get("name")
    ref_tpl = (ref.get("conv_template") or {}).get("name")
    if ours_tpl != ref_tpl:
        problems.append(f"conv_template.name: ours={ours_tpl} reference={ref_tpl}")
    return problems


def cmd_convert(args: argparse.Namespace) -> None:
    variant = get_variant(args.variant)
    state = run_state(variant)
    vdir = variant_dir(variant)
    merged = Path(state.get("merged_dir") or (vdir / "merged"))
    if not (merged / "config.json").is_file():
        die(f"no merged checkpoint at {merged}; run `download` first")
    mlc_out = vdir / "mlc"
    if (mlc_out / "mlc-chat-config.json").is_file() and not args.force:
        log(f"MLC weights already at {mlc_out}; pass --force to rebuild")
        return

    # The nightly wheel ships no console script; `python -m mlc_llm` is the entry point.
    import importlib.util
    if importlib.util.find_spec("mlc_llm") is None:
        die("python package 'mlc_llm' is missing; see train/requirements.txt for the nightly wheel install")
    mlc_llm = [sys.executable, "-m", "mlc_llm"]

    ref = fetch_reference_config(variant)
    quant = variant["quantization"]
    if ref.get("quantization") != quant:
        die(f"reference {variant['mlc_reference']} uses quantization {ref.get('quantization')}, variant says {quant}")
    conv_template = (ref.get("conv_template") or {}).get("name")
    if not conv_template:
        die("reference config has no conv_template.name")
    log(
        f"reference: model_type={ref.get('model_type')} quantization={ref.get('quantization')} "
        f"conv_template={conv_template} context_window_size={ref.get('context_window_size')} prefill_chunk_size={ref.get('prefill_chunk_size')}"
    )

    if mlc_out.exists():
        shutil.rmtree(mlc_out)
    mlc_out.mkdir(parents=True)

    convert_cmd = [
        *mlc_llm, "convert_weight", str(merged),
        "--quantization", quant,
        "--model-type", str(ref["model_type"]),
        "--device", args.device,
        "--output", str(mlc_out),
    ]
    log("running: " + " ".join(convert_cmd))
    subprocess.run(convert_cmd, check=True)

    gen_cmd = [
        *mlc_llm, "gen_config", str(merged),
        "--quantization", quant,
        "--model-type", str(ref["model_type"]),
        "--conv-template", conv_template,
        "--context-window-size", str(ref["context_window_size"]),
        "--prefill-chunk-size", str(ref["prefill_chunk_size"]),
        "--output", str(mlc_out),
    ]
    log("running: " + " ".join(gen_cmd))
    subprocess.run(gen_cmd, check=True)

    ours = read_json(mlc_out / "mlc-chat-config.json")
    problems = diff_reference(ours, ref)
    if problems:
        for p in problems:
            log("MISMATCH " + p)
        die("converted config differs from the reference; the prebuilt WASM would not load these weights")
    log("converted config matches the reference on all architecture fields")

    shards = sorted(mlc_out.glob("params_shard_*.bin"))
    total = sum(p.stat().st_size for p in shards)
    log(f"MLC weights: {len(shards)} shards, {total / 1e9:.2f} GB at {mlc_out}")
    state["mlc_dir"] = str(mlc_out)
    state["reference_config"] = {k: ref.get(k) for k in ("model_type", "quantization", "prefill_chunk_size", "context_window_size")}
    state["reference_conv_template"] = conv_template
    save_run_state(variant, state)


# ---------------------------------------------------------------------------
# publish
# ---------------------------------------------------------------------------

def build_model_record(variant: dict[str, Any]) -> dict[str, Any]:
    """WebLLM `ModelRecord` for this variant, plus the display metadata the explainer shows."""
    return {
        "model": f"https://huggingface.co/{variant['hf_repo']}",
        "model_id": variant["model_id"],
        "model_lib": f"{MODEL_LIB_URL_PREFIX}{MODEL_LIB_VERSION}/{variant['model_lib']}",
        "vram_required_MB": variant.get("vram_required_MB"),
        "low_resource_required": bool(variant.get("low_resource_required", False)),
        "overrides": {"context_window_size": int(variant.get("context_window_size", 16384))},
        "download_gb": variant.get("download_gb"),
        "weights_version": variant.get("weights_version", "v1"),
        "base_model": variant["base_model"],
    }


def cmd_publish(args: argparse.Namespace) -> None:
    variant = get_variant(args.variant)
    state = run_state(variant)
    vdir = variant_dir(variant)
    mlc_dir = Path(state.get("mlc_dir") or (vdir / "mlc"))
    if not (mlc_dir / "mlc-chat-config.json").is_file():
        die(f"no MLC weights at {mlc_dir}; run `convert` first")
    record = build_model_record(variant)
    write_json_atomic(vdir / MODEL_RECORD, record)
    log(f"wrote {vdir / MODEL_RECORD}")
    if args.dry_run:
        log("dry-run: skipping Hugging Face upload")
        print(json.dumps(record, indent=2))
        return
    token = os.environ.get("HF_TOKEN")
    if not token:
        die("HF_TOKEN is not set")
    try:
        from huggingface_hub import HfApi
    except ImportError:
        die("python package 'huggingface_hub' is missing; pip install -r train/requirements.txt")
    api = HfApi(token=token)
    api.create_repo(repo_id=variant["hf_repo"], repo_type="model", private=args.private, exist_ok=True)
    readme = mlc_dir / "README.md"
    if not readme.exists():
        readme.write_text(
            f"# {variant['model_id']}\n\n"
            f"MLC/WebLLM weights ({variant['quantization']}) of `{variant['base_model']}` fine-tuned to explain "
            f"Ethereum transactions for the corpus-core Colibri explainer.\n\n"
            f"Model library (prebuilt by mlc-ai): `{record['model_lib']}`\n\n"
            f"Load with `@mlc-ai/web-llm` by adding this `ModelRecord` to `appConfig.model_list`:\n\n"
            f"```json\n{json.dumps({k: record[k] for k in ('model', 'model_id', 'model_lib', 'vram_required_MB', 'low_resource_required', 'overrides')}, indent=2)}\n```\n",
            encoding="utf-8",
        )
    log(f"uploading {mlc_dir} -> {variant['hf_repo']} (this can take a while)")
    api.upload_folder(folder_path=str(mlc_dir), repo_id=variant["hf_repo"], repo_type="model",
                      commit_message=f"tsa explainer {variant['name']} from job {state.get('job_id', '?')}")
    state["hf_repo"] = variant["hf_repo"]
    state["published_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    save_run_state(variant, state)
    log("published; model record:")
    print(json.dumps(record, indent=2))


# ---------------------------------------------------------------------------
# serve (local WebLLM test before publishing)
# ---------------------------------------------------------------------------

def cmd_serve(args: argparse.Namespace) -> None:
    """Serve the converted MLC weights over HTTP for a local WebLLM test.

    WebLLM appends `resolve/main/` to any model URL that lacks it (see
    `cleanModelUrl` in `@mlc-ai/web-llm`), so the server strips that prefix
    and answers with CORS headers. Point the explainer's model record at
    `http://localhost:<port>/` (the playground accepts `?modelUrl=`).
    """
    import http.server
    import socketserver

    variant = get_variant(args.variant)
    state = run_state(variant)
    mlc_dir = Path(state.get("mlc_dir") or (variant_dir(variant) / "mlc"))
    if not (mlc_dir / "mlc-chat-config.json").is_file():
        die(f"no MLC weights at {mlc_dir}; run `convert` first")
    root = str(mlc_dir)

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=root, **kw)

        def translate_path(self, path: str) -> str:  # noqa: N802
            if path.startswith("/resolve/"):
                # /resolve/<rev>/file -> /file
                parts = path.split("/", 3)
                path = "/" + (parts[3] if len(parts) > 3 else "")
            return super().translate_path(path)

        def end_headers(self) -> None:
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "*")
            self.send_header("Cache-Control", "no-cache")
            super().end_headers()

        def do_OPTIONS(self) -> None:  # noqa: N802
            self.send_response(204)
            self.end_headers()

        def log_message(self, fmt: str, *a: Any) -> None:
            if args.verbose:
                super().log_message(fmt, *a)

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer((args.host, args.port), Handler) as httpd:
        url = f"http://{args.host}:{args.port}/"
        log(f"serving {mlc_dir} at {url} (Ctrl-C to stop)")
        print(f"  model record URL: {url}")
        print(f"  playground:       http://localhost:5173/?modelUrl={url}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            log("stopped")


def sync_weights(variant: dict[str, Any], dest: str, version: str | None, *, force: bool, dry_run: bool, exists_ok: bool) -> None:
    """rsync the MLC weights to `<dest>/<model_id>/<weights_version>/`.

    That layout is what `docker/model/nginx.conf` serves and what the
    explainer's model record expects. `dest` is a local directory (e.g. the
    mounted `tsa_models` volume) or `host:/path`. An existing version directory
    is never overwritten in place unless `force`, because browsers cache the
    shards by URL and would mix old and new files; with `exists_ok` (pipeline)
    that case is a logged skip instead of an error.
    """
    state = run_state(variant)
    mlc_dir = Path(state.get("mlc_dir") or (variant_dir(variant) / "mlc"))
    if not (mlc_dir / "mlc-chat-config.json").is_file():
        die(f"no MLC weights at {mlc_dir}; run `convert` first")
    version = version or variant.get("weights_version") or "v1"
    rsync = shutil.which("rsync")
    if not rsync:
        die("`rsync` not found on PATH")
    dest = dest.rstrip("/")
    target = f"{dest}/{variant['model_id']}/{version}/"
    remote = ":" in dest
    if remote:
        host, _, remote_path = dest.partition(":")
        probe = ["ssh", host, f"test -e {remote_path}/{variant['model_id']}/{version}/mlc-chat-config.json"]
        exists = subprocess.run(probe, check=False).returncode == 0
        mkdir = ["ssh", host, f"mkdir -p {remote_path}/{variant['model_id']}/{version}"]
    else:
        exists = (Path(dest) / variant["model_id"] / version / "mlc-chat-config.json").is_file()
        mkdir = ["mkdir", "-p", f"{dest}/{variant['model_id']}/{version}"]
    if exists and not force:
        if exists_ok:
            log(f"{target} already holds weights; skipping (bump weights_version for new weights)")
            return
        die(f"{target} already holds weights; bump weights_version in variants.json or pass --force")
    subprocess.run(mkdir, check=True)
    # `--progress` rather than `--info=progress2`: macOS ships openrsync / rsync 2.6.
    cmd = [rsync, "-av", "--delete", "--progress", f"{mlc_dir}/", target]
    if dry_run:
        cmd.insert(1, "--dry-run")
    log("running: " + " ".join(cmd))
    subprocess.run(cmd, check=True)
    if not dry_run:
        state["synced"] = {"dest": target, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        save_run_state(variant, state)
        log(f"weights available at <model-server>/{variant['model_id']}/{version}/ ; the playground picks them up from <origin>/models/{variant['model_id']}/{version}/")


def cmd_sync(args: argparse.Namespace) -> None:
    if not args.dest:
        die("sync needs --dest or MODELS_DIR")
    sync_weights(get_variant(args.variant), args.dest, args.version, force=args.force, dry_run=args.dry_run, exists_ok=False)


# ---------------------------------------------------------------------------
# pipeline
# ---------------------------------------------------------------------------

PIPELINE_STAGES = ("prepare", "create", "wait", "download", "convert", "sync")
API_STAGES = {"prepare", "create", "wait", "download"}


def parse_stages(raw: str | None) -> list[str]:
    """`STAGES`-style list (`prepare,create,...`), validated and put in pipeline order."""
    if not raw or not raw.strip():
        return list(PIPELINE_STAGES)
    wanted = [s.strip() for s in raw.split(",") if s.strip()]
    unknown = [s for s in wanted if s not in PIPELINE_STAGES]
    if unknown:
        die(f"unknown stage(s) {', '.join(unknown)}; valid: {', '.join(PIPELINE_STAGES)}")
    return [s for s in PIPELINE_STAGES if s in wanted]


def cmd_pipeline(args: argparse.Namespace) -> None:
    """Run the training stages in order, in-process, each one idempotent.

    Mirrors `build_dataset.mjs` for the dataset: one command that can be
    re-run after a failure and continues where the recorded state left off
    (`create` is skipped when a job exists, `download`/`convert`/`sync` skip
    finished outputs). `--dry-run` runs the token gate and the price estimate
    and stops before anything is uploaded or paid for.
    """
    variant = get_variant(args.variant)
    stages = parse_stages(args.stages if args.stages is not None else os.environ.get("STAGES"))
    dest = args.dest or os.environ.get("MODELS_DIR")
    if "sync" in stages and not dest:
        die("sync stage needs --dest or MODELS_DIR (the mounted tsa_models volume)")
    if not args.dry_run and API_STAGES & set(stages) and not os.environ.get("TOGETHER_API_KEY"):
        die("TOGETHER_API_KEY is not set")
    log(f"pipeline variant={variant['name']} stages={','.join(stages)} dest={dest or '-'} dry_run={args.dry_run}")

    for stage in stages:
        log(f"=== {stage}")
        if stage == "prepare":
            cmd_prepare(argparse.Namespace(variant=args.variant, max_seq_tokens=args.max_seq_tokens, dry_run=args.dry_run))
        elif stage == "create":
            if args.dry_run:
                # The estimate needs the upload ids; without them there is
                # nothing to price, so report and stop here.
                if read_json(train_out() / UPLOAD_STATE, {}).get("train_file_id"):
                    cmd_estimate(args)
                log("dry-run: stopping before create")
                return
            if run_state(variant).get("job_id") and not args.force_create:
                log(f"job {run_state(variant)['job_id']} already recorded; skipping create (use --force-create for a new job)")
            else:
                cmd_create(argparse.Namespace(**vars(args), force=args.force_create))
        elif stage == "wait":
            cmd_wait(argparse.Namespace(variant=args.variant, interval=args.interval))
        elif stage == "download":
            cmd_download(argparse.Namespace(variant=args.variant, force=False))
        elif stage == "convert":
            cmd_convert(argparse.Namespace(variant=args.variant, device=args.device, force=False))
        elif stage == "sync":
            sync_weights(variant, dest, None, force=False, dry_run=False, exists_ok=True)
    log("pipeline done")


# ---------------------------------------------------------------------------
# eval-prep / endpoint
# ---------------------------------------------------------------------------

def cmd_eval_prep(args: argparse.Namespace) -> None:
    """Copy the val prompts into a standalone prompt tree.

    `gen_responses.mjs` and `validate_responses.mjs` operate on a whole
    `DATA_DIR`, so evaluation needs a tree that contains only the val txs.
    `meta.rel_path` in `val.jsonl` points at the `_prompt.json` inside the
    dedup keep-set (`TRAIN_DIR`), which is the source here.
    """
    variant = get_variant(args.variant)
    val_src = dataset_out() / VAL_NAME
    if not val_src.is_file():
        die(f"{val_src} not found")
    raw_train_dir = args.train_dir or os.environ.get("TRAIN_DIR")
    if not raw_train_dir:
        die("TRAIN_DIR (the dedup keep-set that holds the _prompt.json files) is required: --train-dir or env TRAIN_DIR")
    train_dir = Path(raw_train_dir).resolve()
    if not train_dir.is_dir():
        die(f"TRAIN_DIR is not a directory: {train_dir}")
    dest = variant_dir(variant) / "eval" / "data"
    if dest.exists() and not args.force:
        die(f"{dest} exists; pass --force to rebuild")
    if dest.exists():
        shutil.rmtree(dest)
    copied = 0
    missing = 0
    with val_src.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            rel = (row.get("meta") or {}).get("rel_path")
            if not rel:
                missing += 1
                continue
            src = train_dir / rel
            if not src.is_file():
                missing += 1
                continue
            target = dest / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, target)
            copied += 1
    log(f"copied {copied} val prompts to {dest} (missing {missing})")
    state = run_state(variant)
    endpoint_name = state.get("endpoint_model") or state.get("output_name") or "<endpoint-model>"
    print(
        "\nRun the student against the val prompts with the existing tooling:\n"
        f"  DATA_DIR={dest} MODEL='{endpoint_name}' DEEPSEEK_BASE_URL=https://api.together.xyz/v1 \\\n"
        f"    DEEPSEEK_API_KEY=$TOGETHER_API_KEY STYLES=simple node src/gen_responses.mjs\n"
        f"  DATA_DIR={dest} DEEPSEEK_API_KEY=$DEEPSEEK_API_KEY JUDGE_SAMPLE_PCT=100 node src/validate_responses.mjs\n"
        f"  DATA_DIR={dest} node src/query.mjs -S\n"
        "The dedicated endpoint URL printed by `endpoint up` may differ from the serverless base URL; use that one.\n"
    )


def cmd_endpoint(args: argparse.Namespace) -> None:
    variant = get_variant(args.variant)
    state, job_id = job_or_die(variant)
    client = together_client()
    if args.action == "status":
        ep_id = state.get("endpoint_id")
        if not ep_id:
            log("no endpoint recorded")
            return
        ep = client.endpoints.retrieve(ep_id)
        log(f"endpoint {ep.id}: state={ep.state} model={ep.model} hardware={ep.hardware} name={ep.name}")
        return
    if args.action == "down":
        ep_id = state.get("endpoint_id")
        if not ep_id:
            log("no endpoint recorded")
            return
        client.endpoints.delete(ep_id)
        for key in ("endpoint_id", "endpoint_model", "endpoint_hardware"):
            state.pop(key, None)
        save_run_state(variant, state)
        log(f"deleted endpoint {ep_id}")
        return

    # up
    if state.get("endpoint_id"):
        die(f"endpoint {state['endpoint_id']} already recorded; run `endpoint down` first")
    refresh_job(client, variant, state, job_id)
    model_name = state.get("output_name")
    if not model_name:
        die("job has no output model name yet")
    hw = client.endpoints.list_hardware(model=model_name)
    options = [h for h in (hw.data or []) if not h.availability or h.availability.status == "available"]
    if not options:
        die(f"no available hardware for {model_name}: {[h.id for h in (hw.data or [])]}")
    options.sort(key=lambda h: h.pricing.cents_per_minute)
    chosen = next((h for h in options if h.id == args.hardware), None) if args.hardware else options[0]
    if chosen is None:
        die(f"hardware {args.hardware} not available; options: {[h.id for h in options]}")
    price_h = chosen.pricing.cents_per_minute * 60 / 100
    log(f"hardware {chosen.id}: {chosen.specs.gpu_count}x {chosen.specs.gpu_type} ({chosen.specs.gpu_memory} GB) ~${price_h:.2f}/h")
    if not confirm(f"start dedicated endpoint for {model_name} on {chosen.id} (~${price_h:.2f}/h, auto-stop after {args.inactive_timeout} min idle)?", args.yes):
        log("aborted")
        return
    ep = client.endpoints.create(
        model=model_name,
        hardware=chosen.id,
        autoscaling={"min_replicas": 1, "max_replicas": 1},
        display_name=f"tsa-eval-{variant['name']}",
        inactive_timeout=args.inactive_timeout,
        state="STARTED",
    )
    state.update({"endpoint_id": ep.id, "endpoint_model": ep.name or ep.model, "endpoint_hardware": chosen.id})
    save_run_state(variant, state)
    log(f"endpoint {ep.id} state={ep.state}; use MODEL='{state['endpoint_model']}' for gen_responses. Remember `endpoint down`.")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def add_variant_arg(p: argparse.ArgumentParser) -> None:
    p.add_argument("--variant", required=True, help="variant name from train/variants.json")


def add_training_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--epochs", type=int, default=DEFAULT_EPOCHS)
    p.add_argument("--lr", type=float, default=DEFAULT_LR)
    p.add_argument("--warmup", type=float, default=DEFAULT_WARMUP)
    p.add_argument("--lora-r", type=int, default=DEFAULT_LORA_R)
    p.add_argument("--lora-alpha", type=int, default=DEFAULT_LORA_ALPHA)
    p.add_argument("--n-evals", type=int, default=DEFAULT_N_EVALS)
    p.add_argument("--max-seq-length", type=int, default=None,
                   help="Together max_seq_length (default: the variant's context_window_size)")
    p.add_argument("--suffix", default=None, help="model name suffix (default from variants.json)")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="tsa_train", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("prepare", help="build + upload the training JSONL")
    add_variant_arg(p)
    p.add_argument("--max-seq-tokens", type=int, default=None,
                   help="drop rows whose rendered sequence exceeds this many tokens (default: the variant's context_window_size; 0 = off)")
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(fn=cmd_prepare)

    p = sub.add_parser("preview", help="show tokenised sample rows")
    add_variant_arg(p)
    p.add_argument("--rows", type=int, default=2)
    p.add_argument("--chars", type=int, default=300)
    p.set_defaults(fn=cmd_preview)

    p = sub.add_parser("limits", help="Together fine-tuning limits for the base model")
    add_variant_arg(p)
    p.set_defaults(fn=cmd_limits)

    p = sub.add_parser("estimate", help="price estimate")
    add_variant_arg(p)
    add_training_args(p)
    p.set_defaults(fn=cmd_estimate)

    p = sub.add_parser("create", help="start the fine-tuning job")
    add_variant_arg(p)
    add_training_args(p)
    p.add_argument("--yes", action="store_true", help="do not ask for confirmation")
    p.add_argument("--force", action="store_true", help="start even if a job is recorded")
    p.set_defaults(fn=cmd_create)

    p = sub.add_parser("status", help="job status and metrics")
    add_variant_arg(p)
    p.set_defaults(fn=cmd_status)

    p = sub.add_parser("wait", help="poll until the job finishes")
    add_variant_arg(p)
    p.add_argument("--interval", type=int, default=60)
    p.set_defaults(fn=cmd_wait)

    p = sub.add_parser("download", help="download the merged checkpoint")
    add_variant_arg(p)
    p.add_argument("--force", action="store_true")
    p.set_defaults(fn=cmd_download)

    p = sub.add_parser("convert", help="convert the merged checkpoint to MLC weights")
    add_variant_arg(p)
    p.add_argument("--device", default="cpu", help="mlc_llm convert_weight device (cpu|metal|cuda)")
    p.add_argument("--force", action="store_true")
    p.set_defaults(fn=cmd_convert)

    p = sub.add_parser("publish", help="upload MLC weights to Hugging Face")
    add_variant_arg(p)
    p.add_argument("--private", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(fn=cmd_publish)

    p = sub.add_parser("serve", help="serve the MLC weights locally for a WebLLM test before publishing")
    add_variant_arg(p)
    p.add_argument("--host", default="localhost")
    p.add_argument("--port", type=int, default=8787)
    p.add_argument("--verbose", action="store_true", help="log every request")
    p.set_defaults(fn=cmd_serve)

    p = sub.add_parser("sync", help="rsync the MLC weights to a self-hosted model server (<dest>/<model_id>/<version>/)")
    add_variant_arg(p)
    p.add_argument("--dest", default=os.environ.get("MODELS_DIR"), help="local dir (the mounted tsa_models volume, env MODELS_DIR) or host:/path")
    p.add_argument("--version", default=None, help="weights version directory (default from variants.json)")
    p.add_argument("--force", action="store_true", help="overwrite an existing version directory")
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(fn=cmd_sync)

    p = sub.add_parser("pipeline", help="run prepare -> create -> wait -> download -> convert -> sync in one go (idempotent)")
    add_variant_arg(p)
    add_training_args(p)
    p.add_argument("--stages", default=None, help=f"comma list, default all in order (env STAGES): {','.join(PIPELINE_STAGES)}")
    p.add_argument("--dest", default=None, help="sync target, local dir or host:/path (env MODELS_DIR)")
    p.add_argument("--max-seq-tokens", type=int, default=None, help="prepare token gate (default: variant context_window_size)")
    p.add_argument("--interval", type=int, default=60, help="wait poll interval in seconds")
    p.add_argument("--device", default="cpu", help="mlc_llm convert_weight device")
    p.add_argument("--yes", action="store_true", help="do not ask before starting the paid job")
    p.add_argument("--force-create", action="store_true", help="start a new job even if one is recorded")
    p.add_argument("--dry-run", action="store_true", help="token gate + estimate only; nothing uploaded, nothing paid")
    p.set_defaults(fn=cmd_pipeline)

    p = sub.add_parser("eval-prep", help="copy val prompts into a tree for gen_responses.mjs")
    add_variant_arg(p)
    p.add_argument("--train-dir", default=None, help="dedup keep-set with the _prompt.json files (env TRAIN_DIR)")
    p.add_argument("--force", action="store_true")
    p.set_defaults(fn=cmd_eval_prep)

    p = sub.add_parser("endpoint", help="dedicated Together endpoint for evaluation")
    p.add_argument("action", choices=["up", "down", "status"])
    add_variant_arg(p)
    p.add_argument("--hardware", default=None, help="hardware id (default: cheapest available)")
    p.add_argument("--inactive-timeout", type=int, default=30, help="minutes of idle time before Together stops the endpoint")
    p.add_argument("--yes", action="store_true")
    p.set_defaults(fn=cmd_endpoint)

    return parser


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
