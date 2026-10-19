#!/usr/bin/env bash
# Train Artemis on one Google Compute Engine GPU, then delete the VM.
#
#   gcloud auth activate-service-account --key-file=<key.json>
#   PROJECT=<id> bash scripts/train/gcp-train.sh --preflight   # checks only, spends nothing
#   PROJECT=<id> bash scripts/train/gcp-train.sh               # create, train, self-delete
#
# WHY GCE IS WORTH THE SETUP: the cost ceiling is enforced by the PLATFORM.
# `--max-run-duration` plus `--instance-termination-action=DELETE` makes Compute
# Engine delete the VM itself at a deadline it tracks. Unlike a watchdog inside
# the box or a poll loop in this script, it survives a crashed agent, a dropped
# network and a closed laptop. Nothing else used on this project has that:
# Vast needed a software watchdog, and Azure needs a human to remember.
#
# SPOT IS THE RIGHT CHOICE HERE, and that is unusual. Spot VMs are ~60-70%
# cheaper and can be preempted at any moment — normally disqualifying for a
# 29-hour job. But artemis.train checkpoints every 1000 steps and its resume is
# exact: batches are drawn from a per-step seed, and the fp16 loss scale is
# carried in the checkpoint. A preempted run restarts where it stopped. Set
# SPOT=0 to pay roughly triple for an uninterrupted run.
#
# The image is a Deep Learning VM, which ships the NVIDIA driver and CUDA
# preinstalled. That deliberately avoids driver installation, the single
# largest source of wasted time on a fresh GPU box.
set -euo pipefail

PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}"
ZONE="${ZONE:-us-central1-a}"
NAME="${NAME:-artemis-train}"
GPU="${GPU:-nvidia-tesla-t4}"
MACHINE="${MACHINE:-n1-standard-8}"   # T4 attaches to N1; 8 vCPUs for data prep
DISK_GB="${DISK_GB:-200}"             # ~43GB of run data + the DLVM image itself
MAX_HOURS="${MAX_HOURS:-36}"
SPOT="${SPOT:-1}"
SIZE="${SIZE:-100m}"
SHARDS="${SHARDS:-43}"
# UNVERIFIED. Deep Learning VM image families are renamed as CUDA versions move,
# and there were no Google Cloud credentials available to list them when this
# was written. If create fails with a message about the image family, list the
# real ones and pass IMAGE_FAMILY=<name>:
#   gcloud compute images list --project deeplearning-platform-release \
#     --filter="family~'cu1'" --format="value(family)" | sort -u
# Everything else in this script was validated against gcloud 589.0.0.
IMAGE_FAMILY="${IMAGE_FAMILY:-common-cu123-ubuntu-2204-py310}"
IMAGE_PROJECT="${IMAGE_PROJECT:-deeplearning-platform-release}"
PREFLIGHT=0

for a in "$@"; do
  case "$a" in
    --preflight) PREFLIGHT=1 ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done

die() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "[$(date -u +%H:%M:%S)] $*"; }

command -v gcloud >/dev/null || die "gcloud not on PATH"
[ -n "$PROJECT" ] || die "set PROJECT=<project-id>, or run: gcloud config set project <id>"

# --- read-only checks, in the order they actually fail -----------------------
log "project $PROJECT, zone $ZONE"

ACCOUNT=$(gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null | head -1)
[ -n "$ACCOUNT" ] || die "no active credentials. Run:
   gcloud auth activate-service-account --key-file=<key.json>
   See infra/gcp/bootstrap-for-agent.sh to produce that key from Cloud Shell."
log "authenticated as $ACCOUNT"

# Billing before quota: an unbilled project reports zero quota for everything,
# which looks like a quota problem and is not.
BILLING=$(gcloud billing projects describe "$PROJECT" \
            --format="value(billingEnabled)" 2>/dev/null || echo "")
case "$BILLING" in
  True) log "billing: enabled" ;;
  False) die "billing is NOT enabled on $PROJECT. Link an account:
   https://console.cloud.google.com/billing/linkedaccount?project=$PROJECT
   Note: a Free Trial billing account CANNOT use GPUs and cannot request GPU
   quota. Upgrading to a paid account keeps the remaining \$300 credit." ;;
  *) log "billing: could not read (key may lack billing permission) — continuing" ;;
esac

# Is this GPU even offered in this zone? A wrong zone is the most common cause
# of a confusing create failure.
if ! gcloud compute accelerator-types list --project "$PROJECT" \
      --filter="zone:($ZONE) name=($GPU)" --format="value(name)" 2>/dev/null | grep -q .; then
  log "WARNING: $GPU is not listed in $ZONE. Available there:"
  gcloud compute accelerator-types list --project "$PROJECT" \
    --filter="zone:($ZONE)" --format="value(name)" 2>/dev/null | sort -u | sed 's/^/    /' || true
  die "pick a different ZONE or GPU"
fi
log "$GPU is available in $ZONE"

# GPU quota starts at ZERO on every new GCP project, exactly as it did on the
# Azure subscription. Report it plainly rather than letting create fail.
log "GPU quota in $(echo "$ZONE" | sed 's/-[a-z]$//'):"
gcloud compute regions describe "$(echo "$ZONE" | sed 's/-[a-z]$//')" \
  --project "$PROJECT" --format="value(quotas)" 2>/dev/null \
  | tr ';' '\n' | grep -iE "GPU" | sed 's/^/    /' || log "    (could not read quotas)"
cat <<MSG
    If every GPU limit reads 0, request an increase before creating anything:
      https://console.cloud.google.com/iam-admin/quotas?project=$PROJECT
    Metric: NVIDIA_T4_GPUS (or PREEMPTIBLE_NVIDIA_T4_GPUS for spot) = 1
MSG

# --- estimate ----------------------------------------------------------------
python3 - "$SHARDS" "$MAX_HOURS" "$SPOT" <<'PY'
import sys
shards, max_hours, spot = int(sys.argv[1]), float(sys.argv[2]), sys.argv[3] == "1"
tokens = shards * 70.4e6
flops = 6 * 110.8e6 * tokens            # 100m active params
hours = flops / (65e12 * 0.30) / 3600   # T4: ~65 TFLOPS peak fp16, 30% MFU
# Published on-demand us-central1 rates; spot is roughly 60-70% off. Indicative,
# not a quote — check the console for current pricing.
rate = (0.35 + 0.38) * (0.33 if spot else 1.0)
print(f"  pool            {tokens/1e9:.2f}B tokens")
print(f"  expected        {hours:.1f} h of training on a T4, plus a few hours of")
print(f"                  largely single-threaded data prep no GPU speeds up")
print(f"  rate            ~${rate:.2f}/hr ({'SPOT' if spot else 'on-demand'}, n1-standard-8 + T4)")
print(f"  expected cost   ~${hours*rate:.2f}")
print(f"  hard ceiling    {max_hours:.0f} h x ${rate:.2f} = ${max_hours*rate:.2f}, enforced by GCE")
if hours > max_hours:
    print(f"  *** WARNING estimate {hours:.1f}h exceeds MAX_HOURS={max_hours:.0f}; GCE will delete")
    print(f"      the VM mid-run. Raise MAX_HOURS or use a faster GPU.")
PY

if [ "$PREFLIGHT" = "1" ]; then
  log "preflight only — nothing created, nothing spent"
  exit 0
fi

# --- startup script ----------------------------------------------------------
# Runs as root on boot. Output goes to the serial console AND Cloud Logging,
# both readable over HTTPS with no SSH — the readback that was missing on Azure.
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/startup.sh" <<EOF
#!/bin/bash
exec > >(tee -a /var/log/artemis-startup.log | logger -t artemis -s 2>/dev/console) 2>&1
set -uo pipefail
echo "ARTEMIS boot \$(date -u +%FT%TZ)"
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader || \
  echo "ARTEMIS nvidia-smi failed — wrong image family?"
apt-get update -qq && apt-get install -y -qq git
git clone --quiet https://github.com/lpittman-g/Cutline-Industries.git /opt/artemis/source || true
cd /opt/artemis/source
echo "ARTEMIS commit \$(git log --oneline -1)"
mkdir -p /mnt/artemis
if SIZE=$SIZE SHARDS=$SHARDS WORK=/mnt/artemis REPO_DIR=/opt/artemis/source \\
   RATE_PER_HOUR=0 bash scripts/train/rent-gpu-run.sh; then
  echo "ARTEMIS_RUN_COMPLETE"
else
  echo "ARTEMIS_RUN_FAILED rc=\$?"
fi
# Delete self so a finished run stops billing immediately rather than waiting
# for max-run-duration. Uses the VM's own metadata identity, no key on the box.
NAME=\$(curl -s -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/name)
ZONE=\$(curl -s -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/zone | awk -F/ '{print \$NF}')
echo "ARTEMIS deleting \$NAME in \$ZONE"
gcloud compute instances delete "\$NAME" --zone "\$ZONE" --quiet || \\
  echo "ARTEMIS self-delete failed; max-run-duration will still terminate this VM"
EOF

ARGS=(
  --project "$PROJECT" --zone "$ZONE"
  --machine-type "$MACHINE"
  --accelerator "type=$GPU,count=1"
  --maintenance-policy TERMINATE          # GPUs cannot live-migrate; required
  --image-family "$IMAGE_FAMILY" --image-project "$IMAGE_PROJECT"
  --boot-disk-size "${DISK_GB}GB" --boot-disk-type pd-balanced
  --metadata-from-file "startup-script=$TMP/startup.sh"
  --metadata install-nvidia-driver=True
  --scopes cloud-platform                 # lets the box delete itself when done
  --max-run-duration "${MAX_HOURS}h"
  --instance-termination-action DELETE
)
[ "$SPOT" = "1" ] && ARGS+=(--provisioning-model SPOT)

log "creating $NAME ($MACHINE + $GPU, ${DISK_GB}GB, ceiling ${MAX_HOURS}h, $([ "$SPOT" = 1 ] && echo SPOT || echo on-demand))"
gcloud compute instances create "$NAME" "${ARGS[@]}" || die "create failed (see the quota note above)"

cat <<MSG

=== created. the VM trains, deletes itself when done, and GCE deletes it at
    ${MAX_HOURS}h regardless.

  watch       gcloud compute instances get-serial-port-output $NAME --zone $ZONE --project $PROJECT | tail -40
  logs        gcloud logging read 'logName:"artemis"' --project $PROJECT --limit 50
  status      gcloud compute instances describe $NAME --zone $ZONE --project $PROJECT --format='value(status)'
  delete now  gcloud compute instances delete $NAME --zone $ZONE --project $PROJECT --quiet

Look for ARTEMIS_RUN_COMPLETE. If the VM is gone and you never saw it, read the
serial output of the last boot — a spot preemption restarts from the last
checkpoint, which is expected and not a failure.
MSG
