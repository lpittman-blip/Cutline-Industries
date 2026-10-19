#!/usr/bin/env bash
# Artemis on 8 GPUs, in three stages.
#
#   Stage 1    pretrain Artemis's own weights on permissively-licensed,
#              domain-labelled human-written code.
#   Stage sft  teach it to hold a conversation, on chat data whose every row can
#              say where it came from: a consented human transcript, or an
#              open-weight teacher whose LICENCE grants the right to train on
#              its output. No hosted provider, ever — see artemis/teachers.py.
#   Stage 2    run the self-improvement loop on the resulting checkpoint, which
#              now has a signal to amplify.
#
#   STAGE=1   bash scripts/train/stages.sh   # pretrain only
#   STAGE=sft bash scripts/train/stages.sh   # chat tuning on a stage-1 checkpoint
#   STAGE=2   bash scripts/train/stages.sh   # self-play on an existing checkpoint
#   STAGE=all bash scripts/train/stages.sh   # 1, then sft, then 2
#             bash scripts/train/stages.sh   # 1 then 2, skipping chat tuning
#
# Stage 2 is pointless before stage 1: self-improvement amplifies a signal and
# cannot create one, so a model that never solves a problem produces no
# training data and improves by exactly zero forever. Stage sft closes the
# other gap — code self-play supplies no general chat education at all.
set -euo pipefail

STAGE="${STAGE:-both}"
WORK="${WORK:-/mnt/artemis}"
SIZE="${SIZE:-1b}"
SHARDS="${SHARDS:-284}"        # measured 70.4M tokens/shard at vocab 32000 -> ~20B
STEPS="${STEPS:-60000}"
BATCH="${BATCH:-6}"
ACCUM="${ACCUM:-4}"
LR="${LR:-3e-4}"
SEED="${SEED:-1337}"
# Routing supervision OFF by default. train.py defaults --route-coef to 0.1, and
# stages.sh did not pass it, so every real run so far would have used 0.1 — the
# setting two independent ablations measured as WORSE. From
# docs/MOE-ROUTING-ABLATION.md, matched arms at proto scale:
#
#   moe-unsup (route_coef 0)      val 3.5732   8.03 effective experts, 0 dead
#   moe-wide  (7 labels + build)  val 3.6115   2.05 effective experts, 7 dead
#   moe-sup   (3 labels + build)  val 3.6222   1.35 effective experts, 7 dead
#
# Supervision costs ~0.046 validation loss and kills seven of ten experts,
# because the term competes with next-token prediction for the same gradient.
# Widening the labels to 7 of 10 recovered only 22% of that, and dropping the
# `build` residual made it worse still. Set ROUTE_COEF=0.1 to override, but the
# evidence says do not.
ROUTE_COEF="${ROUTE_COEF:-0}"
# train.py defaults --warmup to 20, which is 10% of its own 200-step default
# run and 0.01% of a real 203,386-step 1b run. Twenty steps from zero to peak
# LR on a 1.3B model is how early loss spikes happen. Scale it with the run,
# with a floor for short ones; a wrapper that decides STEPS owns the schedule
# that depends on it.
# 1% of the run, floored at 100 for short runs but never more than 10% of the
# run, so a 200-step smoke test does not spend half of itself warming up.
WARMUP="${WARMUP:-$(python3 -c "s=$STEPS; print(max(1, min(int(0.1*s), max(100, int(0.01*s)))))")}"
VOCAB="${VOCAB:-32000}"        # must match configs/models.yaml for the GPU sizes
DATASET="${DATASET:-codeparrot/github-code-clean}"
REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
CKPT="${CKPT:-$WORK/runs/$SIZE/latest.pt}"
TOKENIZER="${TOKENIZER:-$WORK/tokenizer.json}"

# --- stage sft ---------------------------------------------------------------
SEEDS="${SEEDS:-$WORK/sft/seeds.jsonl}"          # HUMAN-WRITTEN prompts; see docs
SFT_RECORDS="${SFT_RECORDS:-$WORK/sft/records.jsonl}"
SFT_OUT="${SFT_OUT:-$WORK/runs/$SIZE/sft.pt}"
SFT_EPOCHS="${SFT_EPOCHS:-2}"
SFT_LR="${SFT_LR:-2e-5}"
# Teachers must be in artemis.teachers.TEACHERS, which holds only Apache-2.0 and
# MIT models. Empty means "every approved teacher", which is the useful default:
# an ensemble disagrees, and disagreement is where the signal is.
TEACHERS="${TEACHERS:-}"

log() { echo "[$(date -u +%H:%M:%S)] $*"; }

stage1() {
  log "stage 1: pretrain $SIZE"
  nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader
  NGPU=$(nvidia-smi --list-gpus | wc -l)
  [ "$NGPU" -gt 0 ] || { echo "no GPU visible"; exit 1; }

  # Ubuntu 24.04 marks the system Python externally managed (PEP 668), so
  # EVERY pip call needs --break-system-packages — including the pip
  # self-upgrade, which is the one that killed an earlier boot under
  # `set -e`. And awscli has no apt package on noble at all.
  pip_install() { python3 -m pip install -q --break-system-packages "$@"; }
  pip_install torch numpy pyyaml tokenizers huggingface_hub pyarrow awscli
  command -v aws >/dev/null || echo "WARNING: aws CLI unavailable; progress sync disabled"

  log "downloading $SHARDS shards of $DATASET"
  mkdir -p "$WORK/raw"
  python3 - "$WORK/raw" "$SHARDS" "$DATASET" <<'PY'
import sys
from pathlib import Path
from huggingface_hub import hf_hub_download
out, n, repo = Path(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
for i in range(n):
    name = f"data/train-{i:05d}-of-00880.parquet"
    try:
        hf_hub_download(repo, name, repo_type="dataset", local_dir=str(out))
    except Exception as e:
        print("stopped at", name, e); break
    if i % 20 == 0:
        print("shard", i, flush=True)
PY

  log "filtering to permissive licences and labelling domains"
  cd "$REPO/gateway"
  python3 -m artemis.code_corpus --out "$WORK/corpus.jsonl" "$WORK"/raw/data/*.parquet

  log "training tokenizer (vocab $VOCAB) and tokenising"
  python3 - "$WORK" "$VOCAB" <<'PY'
import json, sys
from pathlib import Path
sys.path.insert(0, ".")
from artemis.tokenizer import train_tokenizer
from artemis.data import prepare

work, vocab = Path(sys.argv[1]), int(sys.argv[2])
flat = work / "corpus.txt"
with flat.open("w", encoding="utf-8") as f:
    for line in (work / "corpus.jsonl").open(encoding="utf-8"):
        if line.strip():
            f.write(json.loads(line)["text"].replace("\n", " ") + "\n")
train_tokenizer([str(flat)], vocab, str(work / "tokenizer.json"))
m = prepare([{"path": str(work / "corpus.jsonl"),
              "license": "permissive-only (filtered by artemis.code_corpus)",
              "origin": "codeparrot/github-code-clean, human-written source"}],
            str(work / "tokenizer.json"), str(work / "data"), val_fraction=0.002)
print("train tokens:", m["train_tokens"], "val:", m["val_tokens"],
      "domain labels:", m["domain_labels"])
PY

  log "pretraining on $NGPU GPU(s)"
  log "schedule: $STEPS steps, warmup $WARMUP ($(python3 -c "print(f'{100*$WARMUP/$STEPS:.2f}')")% of the run), lr $LR, seed $SEED"
  log "route_coef $ROUTE_COEF ($([ "$ROUTE_COEF" = "0" ] && echo "supervision off — see docs/MOE-ROUTING-ABLATION.md" || echo "supervision ON, against the measured result"))"
  ARGS=(--size "$SIZE" --data "$WORK/data" --out "$WORK/runs/$SIZE"
        --steps "$STEPS" --batch "$BATCH" --accum "$ACCUM"
        --lr "$LR" --warmup "$WARMUP" --seed "$SEED"
        --route-coef "$ROUTE_COEF"
        --eval-every 500 --eval-batches 50 --ckpt-every 1000)
  if [ "$NGPU" -gt 1 ]; then
    torchrun --nproc_per_node "$NGPU" -m artemis.train "${ARGS[@]}"
  else
    python3 -m artemis.train "${ARGS[@]}"
  fi
  log "stage 1 done: $CKPT"
}

stage_sft() {
  log "stage sft: chat tuning on $CKPT"
  [ -f "$CKPT" ] || { echo "no checkpoint at $CKPT — run stage 1 first"; exit 1; }
  cd "$REPO/gateway"

  # Generate from the approved teachers only when there is no corpus yet. A
  # rerun must not silently append another pass of the same seeds on top of an
  # existing corpus — that reweights whatever is already there.
  if [ ! -f "$SFT_RECORDS" ]; then
    [ -f "$SEEDS" ] || { cat >&2 <<'MSG'
No seed prompts found, and none can be generated here.

Seeds must be HUMAN-WRITTEN. A model writing the questions as well as the
answers is a model talking to itself: the distribution narrows instead of
widening, which is the one documented failure mode of synthetic data. Supply
$SEEDS as JSONL of {"prompt": ..., "source": ...} drawn from real product
questions, hand-written sets, or a human-authored licensed corpus.
MSG
      exit 1; }
    log "generating SFT data from approved open-weight teachers"
    pip_install() { python3 -m pip install -q --break-system-packages "$@"; }
    pip_install vllm
    python3 -m artemis.teachers --verify     # allowlist vs the live model cards
    mkdir -p "$(dirname "$SFT_RECORDS")"
    # shellcheck disable=SC2086 — TEACHERS is an intentional word-split list
    python3 -m artemis.teachers --seeds "$SEEDS" --out "$SFT_RECORDS" \
      --tensor-parallel "${TP:-2}" ${TEACHERS:+--teachers $TEACHERS}
  else
    log "using existing corpus at $SFT_RECORDS"
  fi

  # Validate provenance before loading a model: a bad row should cost an error
  # message, not an hour of GPU time followed by a tainted checkpoint.
  python3 -m artemis.sft --check-only --checkpoint "$CKPT" --tokenizer "$TOKENIZER" \
    --records "$SFT_RECORDS" --out "$SFT_OUT"
  python3 -m artemis.sft --checkpoint "$CKPT" --tokenizer "$TOKENIZER" \
    --records "$SFT_RECORDS" --out "$SFT_OUT" \
    --epochs "$SFT_EPOCHS" --lr "$SFT_LR"
  log "stage sft done: $SFT_OUT (report alongside it as sft.json)"
}

stage2() {
  log "stage 2: self-improvement on $CKPT"
  [ -f "$CKPT" ] || { echo "no checkpoint at $CKPT — run stage 1 first"; exit 1; }
  cd "$REPO/gateway"
  # Docker gives the sandbox no network, a read-only root and hard caps; the
  # loop refuses to run generated code any other way without an explicit flag.
  command -v docker >/dev/null || {
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq && apt-get install -y -qq docker.io
    systemctl start docker || true
  }
  docker pull -q python:3.11-slim || true
  python3 -m artemis.selfplay --checkpoint "$CKPT" --tokenizer "$TOKENIZER" \
    --out "$WORK/runs/selfplay" --rounds "${ROUNDS:-20}" \
    --train-per-round "${TPR:-32}" --samples "${SAMPLES:-4}"
  log "stage 2 done; labelled corpus at $WORK/runs/selfplay/labelled/verified.jsonl"
}

case "$STAGE" in
  1) stage1 ;;
  sft) stage_sft ;;
  2) stage2 ;;
  both) stage1; stage2 ;;
  # Chat tuning runs before self-play: selfplay fine-tunes the same weights, so
  # tuning after it would partly overwrite what the loop just earned.
  all) stage1; stage_sft; CKPT="$SFT_OUT"; stage2 ;;
  *) echo "STAGE must be 1, sft, 2, both or all"; exit 1 ;;
esac
