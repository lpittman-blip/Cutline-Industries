#!/usr/bin/env bash
# Launch an 8-GPU Artemis training box on Nebius. Run this in Nebius Cloud Shell,
# where the CLI is already authenticated as you.
#
# It creates a project in the chosen region (if absent), then one 8-GPU VM whose
# cloud-init clones the repo and starts training Artemis's own weights. Nothing
# else is needed afterwards — the box trains unattended and checkpoints as it goes.
#
#   GITHUB_TOKEN=ghp_xxx bash nebius-launch-8gpu.sh
#
# Capacity as measured 2026-10-11 (re-check before running — it moves):
#   8x H200  eu-north1   on-demand NONE   preemptible 2/2   <- PLATFORM=gpu-h200-sxm MODE=preemptible
#   8x H100  eu-north1   on-demand 1/1    preemptible 2/2   <- PLATFORM=gpu-h100-sxm MODE=on-demand  (default)
#   8x H200  us-central1 / eu-west1: nothing free either way
#
# H100 on-demand is the default because a long run that cannot be preempted is
# worth more than a faster card that can be. 8x80GB is ample for the 1b rung.
set -euo pipefail

TENANT="${TENANT:-tenant-e00wxvkryxs522aaxt}"
REGION="${REGION:-eu-north1}"
PLATFORM="${PLATFORM:-gpu-h100-sxm}"          # or gpu-h200-sxm (preemptible only)
PRESET="${PRESET:-8gpu-128vcpu-1600gb}"
MODE="${MODE:-on-demand}"                      # on-demand | preemptible
DISK_GIB="${DISK_GIB:-2000}"
SIZE="${SIZE:-1b}"                             # model size from gateway/configs/models.yaml
SHARDS="${SHARDS:-100}"                        # FineWeb parquet shards (~120M tokens each)
STEPS="${STEPS:-100000}"
PROJECT_NAME="${PROJECT_NAME:-artemis-train-$REGION}"
VM_NAME="${VM_NAME:-artemis-8gpu}"
REPO_SLUG="${REPO_SLUG:-lpittman-g/Cutline-Industries}"

: "${GITHUB_TOKEN:?set GITHUB_TOKEN so the VM can clone the private repo}"

echo "==> project in $REGION"
PROJECT=$(nebius iam v2 project list --parent-id "$TENANT" --format json \
  | python3 -c "
import json,sys
want=sys.argv[1]
for p in json.load(sys.stdin).get('items',[]):
    if p['spec'].get('region')==want and p['metadata']['name'].startswith('artemis-train'):
        print(p['metadata']['id']); break
" "$REGION")

if [ -z "$PROJECT" ]; then
  PROJECT=$(nebius iam v2 project create --parent-id "$TENANT" --name "$PROJECT_NAME" \
    --region "$REGION" --format json | python3 -c "import json,sys; print(json.load(sys.stdin)['metadata']['id'])")
  echo "    created $PROJECT"
else
  echo "    reusing $PROJECT"
fi

echo "==> subnet"
SUBNET=$(nebius vpc subnet list --parent-id "$PROJECT" --format json \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['items'][0]['metadata']['id'])")
echo "    $SUBNET"

echo "==> cloud-init"
CLOUD_INIT=$(cat <<CI
#cloud-config
write_files:
  - path: /opt/train.sh
    permissions: '0755'
    content: |
      #!/bin/bash
      set -euo pipefail
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -qq && apt-get install -y -qq git python3-pip
      git clone https://${GITHUB_TOKEN}@github.com/${REPO_SLUG}.git /opt/artemis
      cd /opt/artemis
      SIZE=${SIZE} SHARDS=${SHARDS} STEPS=${STEPS} WORK=/mnt/artemis \\
        bash scripts/train/nebius-gpu-run.sh
runcmd:
  - [ bash, -lc, "nohup /opt/train.sh > /var/log/artemis-train.log 2>&1 &" ]
CI
)

echo "==> launching $PRESET on $PLATFORM ($MODE)"
ARGS=(
  --parent-id "$PROJECT"
  --name "$VM_NAME"
  --resources-platform "$PLATFORM"
  --resources-preset "$PRESET"
  --boot-disk-managed-disk-name "${VM_NAME}-boot"
  --boot-disk-managed-disk-type network_ssd
  --boot-disk-managed-disk-size-gibibytes "$DISK_GIB"
  --boot-disk-managed-disk-source-image-family-image-family ubuntu24.04-cuda13.0
  --boot-disk-attach-mode READ_WRITE
  --network-interfaces "[{\"name\":\"eth0\",\"ip_address\":{},\"public_ip_address\":{},\"subnet_id\":\"$SUBNET\"}]"
  --cloud-init-user-data "$CLOUD_INIT"
)
if [ "$MODE" = "preemptible" ]; then
  ARGS+=(--preemptible-on-preemption STOP --preemptible-priority 0)
else
  ARGS+=(--on-demand '{}')
fi

nebius compute instance create "${ARGS[@]}"

echo
echo "==> done. Watch it with:"
echo "    nebius compute instance list --parent-id $PROJECT"
echo "    ssh ubuntu@<public-ip> 'tail -f /var/log/artemis-train.log'"
echo
echo "    Training resumes from the newest checkpoint in /mnt/artemis/runs/$SIZE,"
echo "    so a preempted VM loses only the steps since the last checkpoint."
