#!/usr/bin/env bash
# Read and set the Vast.ai account spending controls, and say honestly which of
# them is actually a limit.
#
#   VAST_API_KEY=... bash scripts/train/vast-limits.sh                  # read only
#   VAST_API_KEY=... bash scripts/train/vast-limits.sh --alert-at 15    # low-balance alert
#   VAST_API_KEY=... bash scripts/train/vast-limits.sh --autobill-at 25 # opt in to autobilling
#
# WHAT THESE ACTUALLY DO. Vast has no hard "stop spending at $N" switch. There
# are three controls and they are not equivalent:
#
#   balance_threshold          Email when credit falls below this. A NOTIFICATION.
#   balance_threshold_enabled  Whether that email is sent at all.
#   autobill_threshold         Charge the saved card when credit falls below
#                              this. This SPENDS MONEY. It is the opposite of a
#                              limit: it refills the tank automatically.
#
# The only real cap on this platform is prepaid credit with NO card saved. At
# $0 the instances stop and nothing further can be charged, because there is
# nothing to charge. Every other control is a warning light.
#
# So this script sets the alert by default and makes autobilling an explicit
# opt-in with a warning, because turning autobilling on converts a bounded
# prepaid balance into an open tab against a card. Vast's own docs recommend
# autobilling to protect instances from deletion — that is a real tradeoff
# (data loss vs unbounded spend), and it should be a decision, not a default.
#
# Needs a key with user_read to read and user_write to set. The key used to
# RENT does not need either: see infra/vast/api-key-permissions.json for the
# scoped key to hand to automation, which deliberately cannot touch billing.
set -euo pipefail

API="${VAST_API_BASE:-https://console.vast.ai/api/v0}"
ALERT_AT=""
AUTOBILL_AT=""

CHARGES_DAYS=""

while [ $# -gt 0 ]; do
  case "$1" in
    --alert-at) ALERT_AT="${2:?--alert-at needs a dollar amount}"; shift 2 ;;
    --autobill-at) AUTOBILL_AT="${2:?--autobill-at needs a dollar amount}"; shift 2 ;;
    --disable-alert) ALERT_AT="off"; shift ;;
    --charges) CHARGES_DAYS="${2:-30}"; shift 2 ;;
    -h|--help) sed -n '2,32p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

die() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "[$(date -u +%H:%M:%S)] $*"; }

# Environment only. argv is world-readable in /proc and lands in shell history.
[ -n "${VAST_API_KEY:-}" ] || die "set VAST_API_KEY in the environment (not as an argument)"

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

show() {
  curl -sS -H "Authorization: Bearer $VAST_API_KEY" "$API/users/current" > "$TMP/u.json" \
    || die "could not read account"
  python3 - "$TMP/u.json" <<'PY'
import json, sys
u = json.load(open(sys.argv[1]))
if "credit" not in u:
    raise SystemExit(f"unexpected response (key may lack user_read): {str(u)[:200]}")
en = str(u.get("balance_threshold_enabled", "")).lower() in ("true", "1")
print(f"  credit                     ${float(u.get('credit') or 0):.2f}")
print(f"  low-balance alert          {'on' if en else 'OFF'}"
      f"{' at $' + str(u.get('balance_threshold')) if en and u.get('balance_threshold') else ''}")
ab = u.get("autobill_threshold")
print(f"  autobilling                {'ON at $' + str(ab) if ab else 'off'}"
      f"{'   <-- this SPENDS from a saved card' if ab else '   (good: prepaid credit is a real cap)'}")
PY
}

log "current state:"
show

# --- what it actually cost ---------------------------------------------------
# A limit you cannot audit is a guess. /api/v0/charges reports real per-contract
# spend broken down into gpu / disk / bwd / bwu, which is the only way to
# confirm an estimate or notice that a destroyed-looking instance is still
# billing storage. Needs billing_read, which the scoped rent key does NOT have
# -- deliberately; run this with your own key.
if [ -n "$CHARGES_DAYS" ]; then
  FROM=$(python3 -c "import time;print(int(time.time())-86400*int('$CHARGES_DAYS'))")
  TO=$(python3 -c "import time;print(int(time.time()))")
  log "charges, last $CHARGES_DAYS days:"
  curl -sS -G -H "Authorization: Bearer $VAST_API_KEY" \
      --data-urlencode "select_filters={\"day\":{\"gte\":$FROM,\"lte\":$TO}}" \
      --data-urlencode "limit=100" \
      "$API/charges" > "$TMP/charges.json" || die "could not read charges"
  python3 - "$TMP/charges.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
if d.get("success") is False:
    raise SystemExit(f"  rejected: {d.get('msg') or d}  (key needs billing_read)")
rows = d.get("results") or []
if not rows:
    print("  no charges in this window")
    raise SystemExit(0)
total = 0.0
for r in rows:
    amt = float(r.get("amount") or 0)
    total += amt
    print(f"  {r.get('source','?'):<24} ${amt:>8.3f}  {r.get('description','')}")
    for it in r.get("items") or []:
        print(f"      {it.get('type','?'):<6} ${float(it.get('amount') or 0):>8.3f}  {it.get('description','')}")
print(f"  {'TOTAL':<24} ${total:>8.3f}"
      + ("" if d.get("next_token") is None else "   (more pages; this is a partial total)"))
PY
fi

[ -n "$ALERT_AT$AUTOBILL_AT" ] || { echo; log "read-only; pass --alert-at, --autobill-at or --charges N"; exit 0; }

# Build only the fields being changed. Sending the whole user object back would
# rewrite unrelated profile fields with whatever this script happened to read.
PATCH_ALERT="$ALERT_AT" PATCH_AUTOBILL="$AUTOBILL_AT" python3 - > "$TMP/patch.json" <<'PY'
import json, os
p = {}
a = os.environ.get("PATCH_ALERT") or ""
b = os.environ.get("PATCH_AUTOBILL") or ""
if a == "off":
    p["balance_threshold_enabled"] = "false"
elif a:
    float(a)                                  # reject non-numeric before sending
    p["balance_threshold"] = a
    p["balance_threshold_enabled"] = "true"
if b:
    float(b)
    p["autobill_threshold"] = b
print(json.dumps(p))
PY
[ -s "$TMP/patch.json" ] || die "nothing to change"

if [ -n "$AUTOBILL_AT" ]; then
  cat >&2 <<EOF

  WARNING: autobilling at \$$AUTOBILL_AT means Vast charges your saved card
  whenever credit drops below that. Your spending is then bounded by the card,
  not by the credit you loaded — an idle instance you forget about keeps
  billing storage and keeps getting topped up. It does protect instances and
  data from deletion at \$0, which is a real benefit. Proceeding because you
  asked for it explicitly.

EOF
fi

log "applying: $(cat "$TMP/patch.json")"
curl -sS -X PUT -H "Authorization: Bearer $VAST_API_KEY" -H "Content-Type: application/json" \
     --data @"$TMP/patch.json" "$API/users/current" > "$TMP/resp.json" || die "update failed"
python3 - "$TMP/resp.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
if isinstance(d, dict) and d.get("success") is False:
    raise SystemExit(f"rejected: {d.get('msg') or d}")
PY

# Read back. A 200 is not proof the field took: verify rather than announce.
log "verifying:"
show
