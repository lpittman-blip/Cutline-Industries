#!/usr/bin/env bash
# Rent one GPU on Vast.ai, run the Artemis pretrain on it, destroy it.
#
# Runs HERE (laptop, CI, agent container) — not on the GPU. It talks to the
# Vast REST API over HTTPS only, so it works from anywhere that can reach the
# internet, with no SSH, no cloud IAM and no service account. That matters: the
# agent container this was written in has no outbound SSH at all, which is what
# made every ssh-based provider path unusable.
#
#   VAST_API_KEY=... bash scripts/train/vast-rent.sh --preflight   # price it, spend nothing
#   VAST_API_KEY=... bash scripts/train/vast-rent.sh               # rent, train, destroy
#
# WHY ONE GPU. Compute is ~6 x active_params x tokens. The 100m rung is
# 110.8M active params over a 3.03B-token pool = 2.0e18 FLOPs. At a realistic
# 30% MFU that is, against real Vast market prices measured 2026-10-19:
#
#   A100 40GB  $0.483/hr    6.0 h    ~$2.90      <- best $/run
#   RTX 5090   $0.530/hr    8.9 h    ~$4.70
#   RTX 4090   $0.441/hr   11.3 h    ~$5.00
#   H100 SXM   $2.206/hr    1.9 h    ~$4.15      <- best wall-clock
#
# The whole run is single-digit dollars on ONE card. An 8-GPU box finishes the
# compute in minutes but costs 10-70x/hr, and the data stage in front of it
# (download, licence filter, tokenizer, tokenise) is largely single-threaded,
# so eight GPUs sit idle through most of the wall clock you pay for. Rent one.
#
# SPENDING LIMITS — there are four, and only the last one is a guarantee.
#
#   1. MAX_DPH       this script refuses any offer above it ($/hr ceiling).
#   2. MAX_HOURS     in-container watchdog destroys the instance after N hours.
#   3. this script   polls, and destroys on success, failure or timeout.
#   4. your Vast     prepaid credit with NO card on file is an absolute cap:
#      credit        at $0 the instance stops and nothing more can be spent.
#
# 1-3 are software and can be defeated by a crash, a lost network, or this
# process being killed. Only 4 survives everything, because Vast cannot charge
# a card that is not there. Load the credit you are willing to lose and no
# more.
#
# The account-side controls (low-balance alert, and autobilling if you choose
# to save a card) are settable over the API, not just in the console — see
# scripts/train/vast-limits.sh, which also explains why autobilling is the
# opposite of a limit. Run that once; this script does not change account
# settings, and the scoped key in infra/vast/api-key-permissions.json
# deliberately cannot.
#
# Storage bills for as long as the instance EXISTS, including while stopped —
# so this destroys, never stops. A stopped instance is a slow leak.
set -euo pipefail

SIZE="${SIZE:-100m}"
SHARDS="${SHARDS:-43}"
MAX_DPH="${MAX_DPH:-0.70}"          # $/hr ceiling, total (GPU + disk + fees)
MAX_HOURS="${MAX_HOURS:-36}"        # watchdog: destroy after this long, no matter what
                                    # 36 fits the slowest card this will pick (3090, ~27h).
                                    # The estimate below warns if the chosen card needs more.
DISK_GIB="${DISK_GIB:-200}"         # 43 shards stream through; .bin + ckpts need room
GPU_QUERY="${GPU_QUERY:-}"          # e.g. 'gpu_name=A100_SXM4'; empty = any eligible
IMAGE="${IMAGE:-pytorch/pytorch:2.8.0-cuda12.8-cudnn9-devel}"
API="${VAST_API_BASE:-https://console.vast.ai/api/v0}"
# Pin an immutable commit: a branch re-resolves on every retry, so a restarted
# run can silently train on different code than it started on.
COMMIT="${COMMIT:-$(git -C "$(dirname "${BASH_SOURCE[0]}")/../.." rev-parse HEAD 2>/dev/null || echo main)}"
PREFLIGHT=0

for a in "$@"; do
  case "$a" in
    --preflight) PREFLIGHT=1 ;;
    -h|--help) sed -n '2,50p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done

die() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "[$(date -u +%H:%M:%S)] $*"; }

# The key goes in the environment and nowhere else. Never a command argument:
# argv is world-readable in /proc and lands in shell history and CI logs.
[ -n "${VAST_API_KEY:-}" ] || die "set VAST_API_KEY in the environment (not as an argument)"
command -v curl >/dev/null || die "curl required"
command -v python3 >/dev/null || die "python3 required"

api() { # api METHOD PATH [json-body]
  local m="$1" p="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$m" -H "Authorization: Bearer $VAST_API_KEY" \
         -H "Content-Type: application/json" -d "$body" "$API$p"
  else
    curl -sS -X "$m" -H "Authorization: Bearer $VAST_API_KEY" "$API$p"
  fi
}

# --- pick an offer -----------------------------------------------------------
# Vast encodes compute_cap as 750 for sm_75, 800 for sm_80, and so on.
#
# Two filters, both learned the hard way. A bare `compute_cap >= 750` floor
# returns a GTX 1660 Super as the cheapest match: it IS Turing, but TU116 ships
# with no tensor cores whatsoever, so fp16 buys nothing and the run would crawl
# at fp32 rates. And at 6GB it would not hold 153M params plus AdamW state plus
# activations at seq 2048 anyway. So require Ampere or newer, which guarantees
# both bf16 and tensor cores, and require real VRAM.
#
# MIN_COMPUTE_CAP=750 is a deliberate opt-in for a T4 or 2080 Ti — Turing cards
# that do have tensor cores — now that artemis.train falls back to fp16 with
# loss scaling. Nothing below 750 can run this at all.
MIN_COMPUTE_CAP="${MIN_COMPUTE_CAP:-800}"
MIN_GPU_RAM_GIB="${MIN_GPU_RAM_GIB:-20}"
log "searching offers under \$$MAX_DPH/hr, >=${DISK_GIB}GiB disk, >=${MIN_GPU_RAM_GIB}GiB VRAM, cap>=${MIN_COMPUTE_CAP}"
QUERY=$(python3 - "$MAX_DPH" "$DISK_GIB" "$GPU_QUERY" "$MIN_COMPUTE_CAP" "$MIN_GPU_RAM_GIB" <<'PY'
import json, sys
dph, disk, extra = float(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
cap, vram = int(sys.argv[4]), int(sys.argv[5])
# gpu_ram is reported in MiB.
q = {"rentable": {"eq": True}, "verified": {"eq": True},
     "num_gpus": {"eq": 1}, "compute_cap": {"gte": cap},
     "gpu_ram": {"gte": vram * 1024},
     "disk_space": {"gte": disk}, "dph_total": {"lte": dph},
     "type": "on-demand", "order": [["dph_total", "asc"]], "limit": 20}
for tok in extra.split():
    k, _, v = tok.partition("=")
    if k and v:
        q[k] = {"eq": v}
print(json.dumps(q))
PY
) || die "query build failed"

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
api POST /bundles/ "$QUERY" > "$TMP/offers.json" || die "offer search failed"
# Response goes through a file, never through string interpolation into a
# Python literal: an API field containing a quote or backslash would otherwise
# break the parse or inject code.
read -r OFFER_ID OFFER_DPH OFFER_DESC <<<"$(python3 - "$TMP/offers.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
offers = d.get("offers") or []
if not offers:
    raise SystemExit(0)
o = offers[0]
print(o["id"], f"{o['dph_total']:.4f}",
      f"{o['num_gpus']}x {o['gpu_name']} {o['gpu_ram'] / 1024:.0f}GB "
      f"${o['dph_total']:.3f}/hr cap{o['compute_cap']} {o.get('geolocation') or '?'}")
PY
)" || true
[ -n "${OFFER_ID:-}" ] || die "no offer matched. Raise MAX_DPH (now $MAX_DPH) or lower DISK_GIB (now $DISK_GIB)."
log "cheapest eligible: offer $OFFER_ID — $OFFER_DESC"

# --- estimate ----------------------------------------------------------------
# $/hr comes from the API field, not scraped back out of the description.
#
# The cheapest $/hr is NOT the cheapest $/run, and the gap is wide enough to
# matter: a 3090 at $0.17/hr needs ~27h (~$4.60) while an H100 at $2.21/hr
# needs ~1.9h (~$4.15). So price the run, not the hour -- and check the
# estimate against the watchdog, because a slow card killed at 90% done costs
# the full bill and yields no checkpoint.
python3 - "$OFFER_DPH" "$SHARDS" "$MAX_HOURS" "$OFFER_DESC" <<'PYEST'
import sys
dph, shards = float(sys.argv[1]), int(sys.argv[2])
max_hours, desc = float(sys.argv[3]), sys.argv[4]
tokens = shards * 70.4e6
flops = 6 * 110.8e6 * tokens          # 100m active params
# Peak DENSE bf16 tensor-core throughput. Vendor figures quoted with sparsity
# are halved here; sparsity does not apply to this workload.
PEAK = {"H200": 990e12, "H100": 990e12, "A100": 312e12, "L40S": 362e12,
        "RTX 5090": 210e12, "RTX 4090": 165e12, "RTX 4080": 97e12,
        "A6000": 155e12, "A5000": 58e12, "RTX 3090": 71e12, "A40": 150e12,
        "RTX 2080": 54e12, "T4": 65e12}
MFU = 0.30
peak = next((v for k, v in PEAK.items() if k.lower() in desc.lower()), None)
print(f"  pool            {tokens / 1e9:.2f}B tokens")
print(f"  training FLOPs  {flops:.2e}")
if peak:
    hrs = flops / (peak * MFU) / 3600
    print(f"  expected        {hrs:.1f} h compute at {MFU:.0%} MFU = ${hrs * dph:.2f}"
          f"  (plus a few hours of largely single-threaded data prep)")
    if hrs > max_hours:
        print(f"  *** WARNING estimate {hrs:.1f} h exceeds MAX_HOURS={max_hours:.0f}: the watchdog")
        print(f"      would destroy the box mid-run, billing the lot and saving no")
        print(f"      checkpoint. Raise MAX_HOURS, or pin a faster card with e.g.")
        print(f"      GPU_QUERY='gpu_name=A100_SXM4'.")
else:
    print(f"  expected        unknown throughput for this card; hours not estimated")
print(f"  worst case      {max_hours:.0f} h x ${dph:.3f}/hr = ${max_hours * dph:.2f} (watchdog ceiling)")
PYEST

if [ "$PREFLIGHT" = "1" ]; then
  log "preflight only — nothing rented, nothing spent"
  exit 0
fi

# --- balance check -----------------------------------------------------------
# Vast requires prepaid credit; renting with an empty balance produces an
# instance that is immediately stopped and then deleted, which looks exactly
# like a broken launch. Check before renting so the failure is legible.
api GET /users/current/ > "$TMP/user.json" 2>/dev/null || true
BAL=$(python3 - "$TMP/user.json" <<'PY'
import json, sys
try:
    print(float(json.load(open(sys.argv[1]))["credit"]))
except Exception:
    print("")          # unreadable: wrong endpoint, scoped key, or network
PY
)
if [ -z "$BAL" ]; then
  # A key scoped without user_read, or a moved endpoint, should not block a
  # user who has decided to rent. Warn and go on; the real cap is the credit
  # balance itself, which Vast enforces whatever this script believes.
  log "WARNING: could not read account credit (key may lack user_read) — continuing"
else
  log "account credit: \$$BAL"
  awk -v b="$BAL" 'BEGIN { exit (b >= 5) ? 0 : 1 }' || \
    die "credit \$$BAL will not finish a run. Add credit: https://cloud.vast.ai/billing/"
fi

# --- onstart ------------------------------------------------------------------
# Kept small on purpose: Vast caps onstart at 16KB, so this fetches the real
# in-instance script from the pinned commit instead of inlining it.
#
# The watchdog and the completion teardown both use CONTAINER_API_KEY, the
# restricted key Vast injects into every container, which can only stop or
# destroy THIS instance. A full-access key never touches the box — so a
# compromised or shared instance cannot spend money or read the account.
#
# Best-effort caveat, stated because it matters: Vast does not document a
# stable env var for the contract id, so this resolves it from VAST_CONTAINERLABEL
# ("C.1234567") and falls back to CONTAINER_ID. If neither is present the
# watchdog logs and gives up, and the orchestrator-side poll below is what
# actually tears the instance down. That is why MAX_HOURS is not the guarantee
# and prepaid credit is.
ONSTART=$(cat <<'OS'
#!/bin/bash
exec > >(tee -a /var/log/artemis-onstart.log) 2>&1
set -uo pipefail
ID="${VAST_CONTAINERLABEL#C.}"; [ -n "$ID" ] || ID="${CONTAINER_ID:-}"
destroy() {
  if [ -n "$ID" ] && [ -n "${CONTAINER_API_KEY:-}" ]; then
    echo "ARTEMIS destroying instance $ID ($1)"
    curl -sS -X DELETE -H "Authorization: Bearer $CONTAINER_API_KEY" \
      "https://console.vast.ai/api/v0/instances/$ID/" || true
  else
    echo "ARTEMIS cannot self-destroy ($1): no contract id or restricted key in env"
  fi
}
( sleep __MAX_SECONDS__; echo "ARTEMIS watchdog fired"; destroy "watchdog ${0}" ) &
apt-get update -qq && apt-get install -y -qq git curl
git clone --quiet https://github.com/lpittman-g/Cutline-Industries.git /opt/artemis/source
git -C /opt/artemis/source checkout --quiet __COMMIT__
cd /opt/artemis/source
echo "ARTEMIS commit $(git log --oneline -1)"
nvidia-smi --query-gpu=name,memory.total,compute_cap --format=csv,noheader
if SIZE=__SIZE__ SHARDS=__SHARDS__ bash scripts/train/rent-gpu-run.sh; then
  echo "ARTEMIS_RUN_COMPLETE"
  destroy "run complete"
else
  echo "ARTEMIS_RUN_FAILED rc=$?"
  destroy "run failed"
fi
OS
)
ONSTART="${ONSTART//__MAX_SECONDS__/$(python3 -c "print(int(float('$MAX_HOURS')*3600))")}"
ONSTART="${ONSTART//__COMMIT__/$COMMIT}"
ONSTART="${ONSTART//__SIZE__/$SIZE}"
ONSTART="${ONSTART//__SHARDS__/$SHARDS}"
[ "${#ONSTART}" -lt 16000 ] || die "onstart is ${#ONSTART} bytes; Vast caps it at 16KB"

# The script body reaches Python through the environment and json.dumps does
# the quoting. Interpolating it into a Python string literal would corrupt the
# first time the script contained a quote or backslash — and it contains both.
printf '%s' "$ONSTART" > "$TMP/onstart.sh"
ARTEMIS_IMAGE="$IMAGE" ARTEMIS_DISK="$DISK_GIB" python3 - "$TMP/onstart.sh" > "$TMP/body.json" <<'PY'
import json, os, sys
print(json.dumps({"image": os.environ["ARTEMIS_IMAGE"],
                  "disk": int(os.environ["ARTEMIS_DISK"]),
                  "onstart": open(sys.argv[1]).read(),
                  "runtype": "ssh"}))
PY
[ -s "$TMP/body.json" ] || die "request build failed"

log "renting offer $OFFER_ID (watchdog ${MAX_HOURS}h, pinned ${COMMIT:0:12})"
curl -sS -X PUT -H "Authorization: Bearer $VAST_API_KEY" -H "Content-Type: application/json" \
     --data @"$TMP/body.json" "$API/asks/$OFFER_ID/" > "$TMP/created.json" || die "create failed"
INSTANCE=$(python3 - "$TMP/created.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
if not d.get("success"):
    raise SystemExit(0)
print(d["new_contract"])
PY
)
[ -n "$INSTANCE" ] || die "create rejected: $(cat "$TMP/created.json")"
log "instance $INSTANCE created — storage billing starts now, GPU billing at running"

# Always tear down, including on Ctrl-C: an orphaned instance is an open tab.
trap 'echo; log "interrupted — destroying $INSTANCE"; api DELETE "/instances/$INSTANCE/" >/dev/null || true' INT TERM

# --- poll --------------------------------------------------------------------
# Terminal states are checked explicitly. A poll loop that only waits for
# "running" spins forever on a crashed container while disk keeps billing —
# the single most expensive mistake available here.
DEADLINE=$(python3 -c "import time; print(int(time.time() + float('$MAX_HOURS')*3600) + 900)")
while :; do
  S=$(api GET "/instances/$INSTANCE/" | python3 -c "
import json,sys
try: i=json.load(sys.stdin).get('instances') or {}
except Exception: print('unreadable'); raise SystemExit
print(i.get('actual_status') or 'provisioning')")
  log "status: $S"
  case "$S" in
    running) break ;;
    exited|offline|unknown)
      log "terminal state '$S' before running — destroying and giving up"
      api DELETE "/instances/$INSTANCE/" >/dev/null || true
      die "instance reached '$S'; try again (often a different host succeeds)" ;;
  esac
  [ "$(date +%s)" -lt "$DEADLINE" ] || { api DELETE "/instances/$INSTANCE/" >/dev/null || true; die "timed out waiting to run"; }
  sleep 20
done

log "running. the box trains, self-destructs when done, and the watchdog caps it at ${MAX_HOURS}h."
cat <<EOF

  logs      curl -sS -H "Authorization: Bearer \$VAST_API_KEY" $API/instances/$INSTANCE/
  destroy   curl -sS -X DELETE -H "Authorization: Bearer \$VAST_API_KEY" $API/instances/$INSTANCE/
  balance   curl -sS -H "Authorization: Bearer \$VAST_API_KEY" $API/users/current/

Look for ARTEMIS_RUN_COMPLETE. Confirm the instance is gone before walking away —
storage bills while it exists, even stopped.
EOF
