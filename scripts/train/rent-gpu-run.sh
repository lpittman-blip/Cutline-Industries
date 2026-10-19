#!/usr/bin/env bash
# Take a rented single-GPU box from bare Ubuntu to a running Artemis pretrain.
#
# Provider-agnostic: Lambda, RunPod, Crusoe, Vast, Paperspace — anything that
# hands you Ubuntu with an NVIDIA driver and SSH. No cloud IAM, no service
# accounts, no object-storage credentials, nothing to grant.
#
#   bash scripts/train/rent-gpu-run.sh --preflight    # check, download nothing
#   bash scripts/train/rent-gpu-run.sh                # 100m, ~1.4h on one H100
#   SIZE=1b SHARDS=85 bash scripts/train/rent-gpu-run.sh       # ~26h on one H100
#
# SHARDS SIZES THE POOL; STEPS SIZES THE RUN. They are separate numbers and the
# run is bounded by STEPS, not by the corpus: artemis.train samples windows from
# train.bin with a per-step seed, so a pool three times the token budget is three
# times the download and disk for no extra training. The defaults below keep the
# two within a few percent of each other, and the estimate is computed from the
# step budget so the quoted hours are the hours you will actually be billed.
#
# WHY 100m FIRST. Compute is roughly 6 x params x tokens. The 100m rung is
# ~1.8e18 FLOPs — about 1.3 hours and a few dollars on one H100. The 1b rung is
# ~1.2e20, two orders of magnitude more. Spending an afternoon proving the
# corpus filter, tokenizer, domain labels and training loop before committing
# days of GPU time is the cheapest insurance available.
#
# It also finally settles the MoE-vs-dense question on LABELLED data. The proto
# comparison ran with domain_labels false, so route_coef had nothing to
# supervise and the MoE lost to a matched dense baseline. That result does not
# generalise, and the 8b architecture choice rests on it.
set -euo pipefail

SIZE="${SIZE:-100m}"
SHARDS="${SHARDS:-43}"          # measured 70.4M tokens/filtered shard -> ~3.0B
WORK="${WORK:-/mnt/artemis}"
REPO_URL="${REPO_URL:-https://github.com/lpittman-g/Cutline-Industries.git}"
REPO_DIR="${REPO_DIR:-/opt/artemis/source}"
MIN_FREE_GIB="${MIN_FREE_GIB:-150}"
PREFLIGHT=0

#: Pin an immutable 40-hex commit. A branch name re-resolves on every retry, so
#: a run that restarts can silently train on different code than it started on.
SOURCE_REVISION="${SOURCE_REVISION:-}"

for arg in "$@"; do
  case "$arg" in
    --preflight) PREFLIGHT=1 ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

log() { echo "[$(date -u +%H:%M:%S)] $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

# --- 1. the machine -----------------------------------------------------------

log "checking the GPU"
command -v nvidia-smi >/dev/null || die "no nvidia-smi — this is not a GPU box"
nvidia-smi --query-gpu=index,name,memory.total,driver_version --format=csv,noheader \
  || die "nvidia-smi failed; the driver is not loaded"
NGPU=$(nvidia-smi --list-gpus | wc -l)
[ "$NGPU" -ge 1 ] || die "no GPU visible"
GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader | head -1)
VRAM_GIB=$(( $(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -1) / 1024 ))
log "$NGPU x $GPU_NAME, ${VRAM_GIB} GiB each"

# The 1b rung at batch 6 does not fit comfortably below ~40 GiB. Warn rather
# than refuse: a smaller BATCH with more ACCUM trades speed for memory.
if [ "$SIZE" = "1b" ] && [ "$VRAM_GIB" -lt 40 ]; then
  log "WARNING: ${VRAM_GIB} GiB for a 1b run is tight. Lower BATCH and raise ACCUM."
fi

log "checking disk"
mkdir -p "$WORK"
FREE_GIB=$(df -BG --output=avail "$WORK" | tail -1 | tr -dc '0-9')
log "${FREE_GIB} GiB free at $WORK (need >= ${MIN_FREE_GIB})"
[ "$FREE_GIB" -ge "$MIN_FREE_GIB" ] || die \
  "not enough disk. Raw shards, the filtered corpus and checkpoints all land here.
   Mount a larger volume at $WORK, or lower SHARDS."

# --- 2. source, pinned --------------------------------------------------------

if [ -z "$SOURCE_REVISION" ]; then
  log "WARNING: SOURCE_REVISION unset — using the default branch tip."
  log "         For a run you intend to cite, pin a 40-hex commit."
fi

if [ ! -d "$REPO_DIR/.git" ]; then
  log "cloning source"
  mkdir -p "$(dirname "$REPO_DIR")"
  git clone --quiet "$REPO_URL" "$REPO_DIR"
fi
cd "$REPO_DIR"
if [ -n "$SOURCE_REVISION" ]; then
  [[ "$SOURCE_REVISION" =~ ^[0-9a-f]{40}$ ]] || die "SOURCE_REVISION must be a 40-hex commit"
  git fetch --quiet origin "$SOURCE_REVISION"
  git checkout --quiet --detach "$SOURCE_REVISION"
else
  git pull --quiet --ff-only || true
fi
log "source at $(git rev-parse HEAD)"

# --- 3. estimate before spending ----------------------------------------------
# This has to come AFTER the checkout: the sequence length and the active
# parameter count live in configs/models.yaml, and an estimate built from
# remembered numbers instead of the pinned config is how the 1b rung came to be
# quoted at 83 hours for a 26-hour run.
#
# 6 x active_params x tokens against ~400 TFLOPS effective (about 40% MFU,
# realistic at this scale). Rough, and stated as rough — a sanity check on the
# bill, not a promise.
#
# The token count is the STEP BUDGET, not the corpus: artemis.train computes
# tokens_per_step = batch * accum * max_seq_len * world_size and runs exactly
# --steps of them. SHARDS only sizes the pool it samples from.
BATCH="${BATCH:-6}"
ACCUM="${ACCUM:-4}"

# pyyaml is needed HERE, by the estimate, which also runs under --preflight —
# but dependency installation below is gated on PREFLIGHT=0. On a machine that
# does not already have it (any fresh box, including a home desktop) the read
# below failed and reported "could not read $SIZE from configs/models.yaml",
# which sends you looking at the config file instead of at a missing import.
python3 -c "import yaml" 2>/dev/null \
  || python3 -m pip install -q --break-system-packages pyyaml 2>/dev/null \
  || die "the estimate needs pyyaml. Install it, then re-run:
   python3 -m pip install --break-system-packages pyyaml"

read -r SEQ_LEN PARAMS <<<"$(python3 - "$REPO_DIR/gateway/configs/models.yaml" "$SIZE" <<'PY'
import sys, yaml
cfg = yaml.safe_load(open(sys.argv[1]))[sys.argv[2]]
# Active parameters, not total: a token passes through one expert per MoE layer,
# so total (153M / 1.31B) overstates the FLOPs per token by about a third.
active = {"100m": 111e6, "1b": 1.06e9, "3b": 3.38e9, "8b": 8.4e9}
print(int(cfg["max_seq_len"]), int(active.get(sys.argv[2], 1e8)))
PY
)" || die "could not read $SIZE from configs/models.yaml"

# SHARDS is the knob; STEPS follows from it unless set explicitly. Deriving it
# is what makes "more GPUs buy wall-clock, not a bigger bill" actually true:
# tokens_per_step scales with world size, so holding STEPS fixed across GPU
# counts multiplies the tokens trained — and the cost — by the GPU count, while
# the hours stay flat. Dividing STEPS by the same factor fixes the token budget,
# and then the hours fall as the GPUs rise and the total cost barely moves.
#
# Values are passed as argv, not interpolated into the quoted program: nesting
# quotes three deep silently produced a malformed expression and printed "?".
# The hours come from the DETECTED card, not a fixed 400 TFLOPS. The old flat
# assumption is datacenter-class: on an H100 it is about right, but it told a
# 3090 owner "1.4 hours" for a run that takes nearer 26, because a 3090 is
# ~71 TFLOPS peak bf16 against an H100's ~990. A 19x error in the one number
# the operator plans their day around.
read -r STEPS TPS TOKENS POOL RATIO HOURS EFF <<<"$(python3 - \
  "${STEPS:-0}" "$BATCH" "$ACCUM" "$SEQ_LEN" "$NGPU" "$SHARDS" "$PARAMS" "$GPU_NAME" <<'PY'
import math, sys
steps, batch, accum, seq, ngpu, shards, params = map(float, sys.argv[1:8])
name = sys.argv[8]
tps = batch * accum * seq * ngpu            # artemis.train's tokens_per_step
pool = shards * 70.4e6                      # measured: 70.4M tokens per filtered shard
if steps <= 0:
    steps = max(1.0, math.ceil(pool / tps)) # one pass over the pool, in expectation
tokens = steps * tps
# Peak DENSE bf16 tensor-core throughput per GPU. Figures vendors quote with
# sparsity are halved; sparsity does not apply to this workload.
PEAK = {"H200": 990e12, "H100": 990e12, "A100": 312e12, "L40S": 362e12,
        "B200": 2250e12, "5090": 210e12, "4090": 165e12, "4080": 97e12,
        "A6000": 155e12, "A5000": 58e12, "3090": 71e12, "A40": 150e12,
        "2080": 54e12, "T4": 65e12, "V100": 125e12}
peak = next((v for k, v in PEAK.items() if k.lower() in name.lower()), None)
MFU = 0.30
eff = (peak * MFU) if peak else 4e14        # fall back to the old assumption
hours = 6 * params * tokens / (eff * ngpu) / 3600
print(f"{steps:.0f} {tps:.0f} {tokens:.0f} {pool:.0f} {tokens/pool:.2f} "
      f"{hours:.1f} {'measured' if peak else 'assumed'}")
PY
)" || die "estimate failed"

# RATE_PER_HOUR=0 is the right answer for hardware you own, and saying "$0/hr"
# beats quoting a rental price at someone training on their own desktop.
RATE="${RATE_PER_HOUR:-$(python3 -c \
  "import sys;print(f'{2.50*float(sys.argv[1]):.2f}')" "$NGPU")}"
COST=$(python3 -c \
  "import sys;print(f'{float(sys.argv[1])*float(sys.argv[2]):.2f}')" "$HOURS" "$RATE")

log "estimate: $SIZE, seq ${SEQ_LEN}, ${STEPS} steps x ${TPS} tokens/step"
log "          ${TOKENS} tokens trained from a ${POOL}-token pool (ratio ${RATIO})"
if [ "$(python3 -c "print(float('$RATE') == 0)")" = "True" ]; then
  log "          ~${HOURS} wall-clock hours on your own hardware — no hourly cost"
else
  log "          ~${HOURS} wall-clock hours at \$${RATE}/hr => roughly \$${COST} — rough, not a quote"
  log "          set RATE_PER_HOUR=0 if this machine is yours"
fi
# 'assumed' means the card is not in the throughput table and the hours fall
# back to a datacenter-class guess, so they may be badly optimistic. Say which.
log "          (throughput for '${GPU_NAME}': ${EFF})"

# A pool far from the budget is a bug in the invocation, not a preference.
# Under 0.5: you are paying to download and store tokens the run never reaches.
# Over 1.5: the run samples the same windows repeatedly, which is memorisation.
case "$(python3 -c "import sys;r=float(sys.argv[1]);print('low' if r<0.5 else 'high' if r>1.5 else 'ok')" "$RATIO")" in
  low)  log "WARNING: pool is $(python3 -c "import sys;print(f'{1/float(sys.argv[1]):.1f}')" "$RATIO")x the token budget."
        log "         Lower SHARDS to $(python3 -c "import sys;print(int(float(sys.argv[1])/70.4e6+1))" "$TOKENS"), or raise STEPS." ;;
  high) log "WARNING: the budget is ${RATIO}x the pool — windows will repeat."
        log "         Raise SHARDS to $(python3 -c "import sys;print(int(float(sys.argv[1])/70.4e6+1))" "$TOKENS"), or lower STEPS." ;;
esac

# --- 4. dependencies ----------------------------------------------------------
# Ubuntu marks the system Python externally managed (PEP 668), so EVERY pip call
# needs --break-system-packages or it exits non-zero and `set -e` kills the run.
# Do NOT add a pip self-upgrade: it tries to uninstall the distro's pip and
# fails with "RECORD file not found". And awscli has no apt package on noble.
pip_install() { python3 -m pip install -q --break-system-packages "$@"; }

if [ "$PREFLIGHT" = "0" ]; then
  log "installing dependencies"
  pip_install torch numpy pyyaml tokenizers huggingface_hub pyarrow
  python3 -c "import torch; assert torch.cuda.is_available(), 'torch cannot see the GPU'" \
    || die "torch is installed but CUDA is unavailable — driver/toolkit mismatch"
  log "torch $(python3 -c 'import torch;print(torch.__version__)') sees $(python3 -c 'import torch;print(torch.cuda.device_count())') GPU(s)"
fi

# --- 5. status file, so progress is visible without any cloud service ----------
STATUS="$WORK/status.txt"
write_status() { printf '%s  %s\n' "$(date -u +%FT%TZ)" "$*" >> "$STATUS"; }
write_status "preflight ok: $NGPU x $GPU_NAME, size=$SIZE shards=$SHARDS rev=$(git rev-parse --short HEAD)"

if [ "$PREFLIGHT" = "1" ]; then
  log "preflight only — nothing downloaded, nothing trained."
  log "status: $STATUS"
  exit 0
fi

# --- 6. train -----------------------------------------------------------------
# stages.sh already branches on GPU count: with NGPU=1 it calls
# `python3 -m artemis.train` directly instead of torchrun. Nothing to special-case.
log "handing off to stages.sh (stage 1, size $SIZE)"
write_status "training started"

# STEPS, BATCH and ACCUM must be exported too, not just SIZE and SHARDS.
# stages.sh defaults STEPS to 60000 independently, so leaving them out meant the
# estimate above described one run and stages.sh ran another.
set +e
STAGE=1 SIZE="$SIZE" SHARDS="$SHARDS" WORK="$WORK" \
  STEPS="$STEPS" BATCH="$BATCH" ACCUM="$ACCUM" \
  bash "$REPO_DIR/scripts/train/stages.sh"
RC=$?
set -e

if [ "$RC" -ne 0 ]; then
  write_status "training FAILED rc=$RC"
  die "stage 1 failed (rc=$RC). The run is resumable: re-run this script; the
   downloaded shards under $WORK/raw are reused."
fi

write_status "training finished"
log "done. checkpoint: $WORK/runs/$SIZE/latest.pt"
log ""
log "To retrieve results, from your own machine:"
log "  scp -r <user>@<this-host>:$WORK/runs/$SIZE ./artemis-$SIZE"
log ""
log "Shut the box down when you have them — rented GPUs bill by the hour."
