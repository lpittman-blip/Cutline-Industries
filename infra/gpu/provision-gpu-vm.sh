#!/usr/bin/env bash
# Stand up a GPU VM running vLLM, and point the Artemis terminal at it.
#
#   ./provision-gpu-vm.sh --size Standard_NC24ads_A100_v4 --region eastus
#
# STATE OF PLAY, checked 2026-10-10 against all three subscriptions
# (65c3f7b2…, 8c9ca5bc…, bd193cb1…) in eastus, southcentralus and westus3:
# every GPU quota reads 0, so `az vm create` with any GPU size fails before it
# starts. This script cannot be run until that changes. Request quota first:
#
#   portal.azure.com -> Quotas -> Compute -> pick region -> "NC/ND/NV family vCPUs"
#   -> New quota request. Ask for the family matching --size, not a vCPU count in
#   the abstract; a grant on the wrong family does not help.
#
# A single A100 80GB (NC24ads_A100_v4) is about $3.67/hr pay-as-you-go, so roughly
# $2,600 a month left running. DEALLOCATE IT WHEN IDLE: a stopped-but-allocated VM
# bills at the full rate.
set -euo pipefail

SIZE="Standard_NC24ads_A100_v4"
REGION="eastus"
GROUP="artm-rg"
NAME="artemis-gpu"
MODEL="${ARTEMIS_SERVED_MODEL:-}"   # a HuggingFace id, or a path to Artemis's own weights
PORT=8000

while [ $# -gt 0 ]; do
  case "$1" in
    --size) SIZE="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --group) GROUP="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    *) echo "usage: $0 [--size S] [--region R] [--group G] [--name N] [--model M]" >&2; exit 2 ;;
  esac
done
[ -n "$MODEL" ] || { echo "--model is required (a HuggingFace id, or Artemis's checkpoint path)" >&2; exit 2; }

# ---------------------------------------------------------------- preflight
# Fail on quota here, with the number, rather than after a VM create has already
# created a NIC, a disk and a public IP that then have to be cleaned up.
echo "==> checking quota for $SIZE in $REGION"
family=$(az vm list-skus -l "$REGION" --size "${SIZE%%_*}" --query "[?name=='$SIZE'].family|[0]" -o tsv 2>/dev/null || true)
usage=$(az vm list-usage -l "$REGION" --query "[?contains(localName,'GPU')].{n:localName,c:currentValue,l:limit}" -o tsv 2>/dev/null || true)
echo "$usage" | sed 's/^/    /'
if ! echo "$usage" | awk -F'\t' '$3 > 0 {found=1} END {exit !found}'; then
  echo
  echo "!! Every GPU quota in $REGION is 0. Request quota before running this." >&2
  echo "!! portal.azure.com -> Quotas -> Compute -> $REGION -> the family for $SIZE" >&2
  exit 1
fi
[ -n "$family" ] && echo "    sku family: $family"

# ---------------------------------------------------------------- the VM
echo "==> creating $NAME ($SIZE) in $REGION"
az group create -n "$GROUP" -l "$REGION" -o none
az vm create \
  --resource-group "$GROUP" --name "$NAME" --location "$REGION" --size "$SIZE" \
  --image Canonical:ubuntu-24_04-lts:server:latest \
  --admin-username azureuser --generate-ssh-keys \
  --public-ip-sku Standard --nsg-rule SSH -o none

# vLLM is NOT opened to the internet. The terminal reaches it over an SSH tunnel:
#   ssh -N -L 8000:localhost:8000 azureuser@<ip>
#   artemis config --url http://localhost:8000
# An open inference port is an open wallet: anyone who finds it spends your GPU.
echo "==> installing driver, CUDA and vLLM (several minutes)"
az vm run-command invoke -g "$GROUP" -n "$NAME" --command-id RunShellScript --scripts "
set -eux
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ubuntu-drivers-common python3-venv python3-pip
ubuntu-drivers install --gpgpu
python3 -m venv /opt/vllm
/opt/vllm/bin/pip install -q --upgrade pip
/opt/vllm/bin/pip install -q vllm
cat >/etc/systemd/system/vllm.service <<UNIT
[Unit]
Description=vLLM serving ${MODEL}
After=network-online.target
[Service]
ExecStart=/opt/vllm/bin/vllm serve ${MODEL} --host 127.0.0.1 --port ${PORT}
Restart=on-failure
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now vllm
" -o none

IP=$(az vm show -d -g "$GROUP" -n "$NAME" --query publicIps -o tsv)
cat <<DONE

==> $NAME is up at $IP

Open the tunnel, then point the terminal at it:

    ssh -N -L ${PORT}:localhost:${PORT} azureuser@${IP} &
    artemis config --url http://localhost:${PORT}
    artemis gpu

'artemis gpu' reads vLLM's /metrics, so KV-cache use, running and queued requests
appear in the status bar. Stop paying for it with:

    az vm deallocate -g ${GROUP} -n ${NAME} --no-wait
DONE
