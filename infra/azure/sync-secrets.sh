#!/usr/bin/env bash
# Push secrets from Key Vault to the gateway VM's environment file.
#
#   bash infra/azure/sync-secrets.sh --check      # what differs, never values
#   bash infra/azure/sync-secrets.sh              # pull, write, restart, verify
#
# WHY THIS AND NOT A MANAGED IDENTITY. The gateway should read Key Vault itself
# at boot, so no secret ever lands on disk. That needs a managed identity on
# `cutline-vps`, and assigning one fails today:
#
#   FailedIdentityOperation ... "The directory object quota limit for the Tenant
#   has been exceeded. Please ask your administrator to increase the quota limit
#   or delete objects to reduce the used quota."
#
# A managed identity -- system- or user-assigned -- is a service principal, which
# is a directory object, so neither variant gets around it. Until a tenant admin
# raises the quota or frees objects, this script is the next best thing: the
# vault is the single source of truth, nothing lives in git, and rotation is
# "update the vault, run this". The secret still rests in a root-owned 600 file
# on the VM, which is exactly the part the identity would have removed.
#
# RUN THIS FROM A MACHINE WITH SSH TO THE VM. Port 22 is blocked outbound from
# Claude/Codex cloud containers to every host, so this cannot run from an agent
# session. It needs `az login` and an SSH key already trusted by the VM.
#
# Values are never printed, never passed as arguments (so they stay out of `ps`
# and shell history), and never written anywhere but the target file.
set -euo pipefail
umask 077

VAULT="${VAULT:-artemis-kv-6b22c1}"
VAULT_SUB="${VAULT_SUB:-bd193cb1-661c-44cc-bb7f-04d545296da8}"   # not the VM's subscription
SSH_TARGET="${SSH_TARGET:-azureuser@172.203.229.191}"
ENV_FILE="${ENV_FILE:-/etc/artemis-chat.env}"
SERVICE="${SERVICE:-artemis-chat}"
HEALTH_URL="${HEALTH_URL:-https://api.artemisai-bycutlineindustries.studio/api/health}"

#: vault secret name -> environment variable. Add a pair here and it is managed;
#: everything else in the env file is preserved untouched.
declare -A MANAGED=(
  [artemis-database-url]=ARTEMIS_DATABASE_URL
  [azure-ai-key]=AZURE_AI_KEY
  [xai-api-key]=XAI_API_KEY
)

CHECK=0
REQUIRE_ALL=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK=1 ;;
    --require-all) REQUIRE_ALL=1 ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

log() { echo "[$(date -u +%H:%M:%S)] $*"; }

command -v az >/dev/null || { echo "az CLI not found" >&2; exit 1; }
az account show -o none 2>/dev/null || { echo "run 'az login' first" >&2; exit 1; }

# --- what the vault holds ----------------------------------------------------
log "reading $VAULT"
AVAILABLE=$(az keyvault secret list --vault-name "$VAULT" --subscription "$VAULT_SUB" \
              --query "[].name" -o tsv)

present=() missing=()
for name in "${!MANAGED[@]}"; do
  if grep -qxF "$name" <<<"$AVAILABLE"; then present+=("$name"); else missing+=("$name"); fi
done

if ((${#missing[@]})); then
  echo "not in the vault, so ${MANAGED[${missing[0]}]} and friends are left as-is:" >&2
  for name in "${missing[@]}"; do echo "  - $name -> ${MANAGED[$name]}" >&2; done
  if ((REQUIRE_ALL)); then echo "--require-all was given; stopping." >&2; exit 1; fi
fi
((${#present[@]})) || { echo "nothing to sync" >&2; exit 1; }

# --- what the VM currently has -----------------------------------------------
log "reading $ENV_FILE on $SSH_TARGET"
CURRENT=$(ssh -o BatchMode=yes "$SSH_TARGET" "sudo cat $ENV_FILE")

if ((CHECK)); then
  log "comparing (values are never printed)"
  for name in "${present[@]}"; do
    var=${MANAGED[$name]}
    vault_val=$(az keyvault secret show --vault-name "$VAULT" --subscription "$VAULT_SUB" \
                  -n "$name" --query value -o tsv)
    live_val=$(sed -n "s/^${var}=//p" <<<"$CURRENT" | head -1)
    if [ -z "$live_val" ]; then verdict="ABSENT on the VM"
    elif [ "$vault_val" = "$live_val" ]; then verdict="matches"
    else verdict="DIFFERS"; fi
    printf '  %-24s %s\n' "$var" "$verdict"
    unset vault_val live_val
  done
  exit 0
fi

# --- merge --------------------------------------------------------------------
# Rewrite only the managed variables. Every other line -- PORT, ARTEMIS_BIND,
# the allowed origins, the bootstrap flag -- is kept exactly as it is, because
# this script's job is secrets, not configuration.
NEW="$CURRENT"
changed=()
for name in "${present[@]}"; do
  var=${MANAGED[$name]}
  value=$(az keyvault secret show --vault-name "$VAULT" --subscription "$VAULT_SUB" \
            -n "$name" --query value -o tsv)
  [ -n "$value" ] || { echo "$name is empty in the vault; refusing" >&2; exit 1; }
  case "$value" in *$'\n'*) echo "$name contains a newline; not valid in an env file" >&2; exit 1 ;; esac

  # Merged in bash, line by line, on purpose. `awk -v` and `sed` both reprocess
  # the replacement text -- awk expands backslash escapes, so a secret
  # containing \n is silently split across two lines and the env file breaks;
  # sed treats & and / as syntax. Bash parameter expansion does neither.
  merged="" replaced=0
  while IFS= read -r line; do
    if [ "${line:0:${#var}+1}" = "${var}=" ]; then
      merged+="${var}=${value}"$'\n'
      replaced=1
    else
      merged+="$line"$'\n'
    fi
  done <<<"$NEW"
  ((replaced)) || merged+="${var}=${value}"$'\n'
  NEW="${merged%$'\n'}"
  changed+=("$var")
  unset value merged
done

log "updating: ${changed[*]}"

# --- write, restart, verify ----------------------------------------------------
# install(1) reads /dev/stdin, so the value never appears in argv on either side.
# Written to a temp path and moved into place, so a dropped connection cannot
# leave a half-written env file that stops the gateway booting.
printf '%s\n' "$NEW" | ssh -o BatchMode=yes "$SSH_TARGET" \
  "sudo install -m 600 -o root -g root /dev/stdin ${ENV_FILE}.new \
   && sudo cp -a ${ENV_FILE} ${ENV_FILE}.bak \
   && sudo mv ${ENV_FILE}.new ${ENV_FILE} \
   && sudo systemctl restart ${SERVICE}"

log "waiting for $SERVICE"
for _ in $(seq 1 20); do
  state=$(ssh -o BatchMode=yes "$SSH_TARGET" "systemctl is-active ${SERVICE}" || true)
  [ "$state" = "active" ] && break
  sleep 2
done
[ "$state" = "active" ] || {
  echo "service did not come back ($state). Previous file is at ${ENV_FILE}.bak:" >&2
  echo "  ssh $SSH_TARGET 'sudo mv ${ENV_FILE}.bak ${ENV_FILE} && sudo systemctl restart ${SERVICE}'" >&2
  exit 1
}

log "checking $HEALTH_URL"
if curl -fsS --max-time 20 "$HEALTH_URL" >/dev/null; then
  log "done — gateway healthy"
else
  echo "service is active but the health endpoint did not answer. Roll back with:" >&2
  echo "  ssh $SSH_TARGET 'sudo mv ${ENV_FILE}.bak ${ENV_FILE} && sudo systemctl restart ${SERVICE}'" >&2
  exit 1
fi
