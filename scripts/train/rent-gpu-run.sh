#!/usr/bin/env bash
# Take a rented single-GPU box from bare Ubuntu to a running Artemis pretrain.
#
# Provider-agnostic: Lambda, RunPod, Crusoe, Vast, Paperspace — anything that
# hands you Ubuntu with an NVIDIA driver and SSH. No cloud IAM, no service
# accounts, no object-storage credentials, nothing to grant.
#
#   bash scripts/train/rent-gpu-run.sh --preflight    # check, download nothing
#   bash scripts/train/rent-gpu-run.sh                # 100m, ~1.3h on one H100
#   SIZE=1b SHARDS=284 bash scripts/train/rent-gpu-run.sh      # ~3.5 days
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
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
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

# --- 2. estimate before spending ----------------------------------------------
# 6 x params x tokens, against ~400 TFLOPS effective (about 40% MFU, realistic
# at this scale). Rough, and stated as rough — it is a sanity check on the bill,
# not a promise.
PARAMS=$([ "$SIZE" = "1b" ] && echo 1000000000 || echo 100000000)
TOKENS=$(( SHARDS * 70400000 ))
# Values are passed as argv, not interpolated into the quoted program: nesting
# quotes three deep silently produced a malformed expression and printed "?".
HOURS=$(python3 -c \
  "import sys;p,t,n=map(float,sys.argv[1:4]);print(f'{6*p*t/(4e14*n)/3600:.1f}')" \
  "$PARAMS" "$TOKENS" "$NGPU" 2>/dev/null || echo "?")
# The default rate scales with GPU count: an 8-GPU box costs about 8x a 1-GPU
# box, so a flat per-machine default would understate a multi-GPU bill eightfold.
# Override RATE_PER_HOUR with the real per-MACHINE price from your provider.
RATE=$(python3 -c "import sys;print(f'{2.50*float(sys.argv[1]):.2f}')" "$NGPU" 2>/dev/null || echo 2.50)
RATE="${RATE_PER_HOUR:-$RATE}"
COST=$(python3 -c \
  "import sys;print(f'{float(sys.argv[1])*float(sys.argv[2]):.0f}')" \
  "$HOURS" "$RATE" 2>/dev/null || echo "?")
log "estimate: ${TOKENS} tokens, ~${HOURS} wall-clock hours on this machine"
log "          at \$${RATE}/hr for the box, roughly \$${COST} — rough, not a quote"
# Total compute cost barely moves with GPU count; what you buy with more GPUs is
# wall-clock. Adding GPUs only saves money if it shortens a run you are paying
# for by the hour anyway, and only at a sane per-GPU rate.

# --- 3. source, pinned --------------------------------------------------------

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

set +e
STAGE=1 SIZE="$SIZE" SHARDS="$SHARDS" WORK="$WORK" \
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
