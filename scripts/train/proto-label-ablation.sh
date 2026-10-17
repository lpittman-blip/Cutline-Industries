#!/usr/bin/env bash
# Does widening the labels fix the router collapse, and does the `build`
# residual have to go too?
#
#   bash scripts/train/proto-label-ablation.sh
#
# WHAT THE FIRST ABLATION LEFT OPEN. docs/MOE-ROUTING-ABLATION.md established
# that routing supervision over 3 of 10 experts costs ~0.046 validation loss
# and kills seven experts outright. Content labelling now reaches 7 of 10, but
# measuring the new distribution showed why that may not be enough:
#
#   build 77.3%  test 14.7%  memory 6.4%  security 0.6%  cost 0.5%
#   observability 0.2%  deploy 0.3%
#
#   effective domains 2.10, and experts_per_token is 2.
#
# A label set that needs only 2.10 experts can still be satisfied by pinning a
# fixed pair, which is exactly the failure. The dominant term is `build`, and
# `build` is not a domain — it is "source that matched nothing else".
# Supervising on a residual teaches one expert to mean everything. Dropping it
# leaves 22.7% of tokens supervised, raises effective domains to 2.50 (above
# experts_per_token), and frees the rest for the balance term.
#
# TWO NEW ARMS, because the question has two parts:
#
#   moe-wide    widened labels, build residual kept      does widening alone help?
#   moe-nores   widened labels, build left unlabelled    does the residual have to go?
#
# The dense and moe-unsup arms are NOT re-run: neither reads domain labels
# (route_coef 0 never adds the supervision term; proto-dense has no router), so
# their numbers carry over unchanged — but only if the token stream is
# identical. That is asserted below rather than assumed.
set -euo pipefail

WORK="${WORK:-/tmp/artemis-proto-lab}"
OLD="${OLD:-$WORK/data}"          # first ablation's data: tokens + old labels
NEW="${NEW:-$WORK/v2/data}"       # same tokens, widened labels
STEPS="${STEPS:-2500}"
BATCH="${BATCH:-16}"
LR="${LR:-3e-4}"
SEED="${SEED:-1337}"
REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

log() { echo "[$(date -u +%H:%M:%S)] $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

# --- 1. the reuse is only valid if the tokens did not move --------------------
# Relabelling must change train.dom and nothing else. If train.bin differs, the
# carried-over dense and moe-unsup numbers describe a different corpus and the
# four-way comparison is meaningless.
for f in train.bin val.bin; do
  [ -f "$OLD/$f" ] && [ -f "$NEW/$f" ] || die "missing $f in $OLD or $NEW"
  a=$(sha256sum "$OLD/$f" | cut -d' ' -f1)
  b=$(sha256sum "$NEW/$f" | cut -d' ' -f1)
  [ "$a" = "$b" ] || die "$f differs between the two label sets.
   The relabelled corpus selected different documents, so dense and moe-unsup
   cannot be carried over. Re-run all four arms against \$NEW instead."
  log "$f identical across label sets ($(echo "$a" | cut -c1-12)...)"
done

# --- 2. derive the no-residual label shard ------------------------------------
# Same tokens, same everything, with the `build` label replaced by 255
# (artemis.data.UNLABELED). Deriving it rather than rebuilding the corpus keeps
# the two supervised arms differing in exactly one thing.
NORES="$WORK/v2-nores"
if [ ! -f "$NORES/data/train.dom" ]; then
  log "deriving the no-residual label shard"
  mkdir -p "$NORES/data"
  cp "$NEW"/train.bin "$NEW"/val.bin "$NEW"/manifest.json "$NORES/data/"
  python3 - "$NEW" "$NORES/data" "$REPO/gateway" <<'PY'
import json, shutil, sys
from pathlib import Path
sys.path.insert(0, sys.argv[3])
import numpy as np
from artemis.data import UNLABELED
from artemis.model import EXPERT_NAMES

src, dst = Path(sys.argv[1]), Path(sys.argv[2])
build = EXPERT_NAMES.index("build")
for split in ("train", "val"):
    d = np.fromfile(src / f"{split}.dom", dtype=np.uint8)
    before = int((d == build).sum())
    d[d == build] = UNLABELED
    d.tofile(dst / f"{split}.dom")
    left = int((d != UNLABELED).sum())
    print(f"{split}: {before:,} build tokens unlabelled, {left:,} still supervised "
          f"({100*left/len(d):.1f}%)")
PY
else
  log "no-residual shard already present"
fi

# --- 3. the two new arms ------------------------------------------------------
cd "$REPO/gateway"
run() {
  local name="$1" data="$2"
  local out="$WORK/runs/$name"
  local done_steps=0
  if [ -f "$out/metrics.jsonl" ]; then
    done_steps=$(python3 -c "
import json,sys
last=0
for line in open(sys.argv[1]):
    if line.strip(): last=json.loads(line).get('step', last)
print(last)" "$out/metrics.jsonl")
  fi
  if [ "$done_steps" -ge "$STEPS" ]; then log "$name at $done_steps/$STEPS — skipping"; return; fi
  [ "$done_steps" -gt 0 ] && log "$name resuming from $done_steps/$STEPS"
  log "arm $name (data $data)"
  python3 -m artemis.train --size proto --data "$data" --out "$out" \
    --steps "$STEPS" --batch "$BATCH" --lr "$LR" --seed "$SEED" \
    --route-coef 0.1 --eval-every 100 --eval-batches 20 --ckpt-every 500
}

run moe-wide  "$NEW"
run moe-nores "$NORES/data"

log "four-way comparison"
python3 - "$WORK/runs" "$REPO/gateway" <<'PY'
import json, math, sys
from pathlib import Path
sys.path.insert(0, sys.argv[2])

runs = Path(sys.argv[1])
arms = [("dense", "no MoE"), ("moe-unsup", "route_coef 0"),
        ("moe-sup", "3 labels + build"), ("moe-wide", "7 labels + build"),
        ("moe-nores", "7 labels, no build")]
rows = []
for name, note in arms:
    p = runs / name
    if not (p / "metrics.jsonl").exists():
        continue
    recs = [json.loads(l) for l in (p / "metrics.jsonl").open() if l.strip()]
    val = [r["val_loss"] for r in recs if "val_loss" in r]
    ent = recs[-1].get("router_entropy")
    eff = sum(math.exp(e) for e in ent) / len(ent) if ent else None
    load = recs[-1].get("expert_load")
    dead = sum(1 for v in load[0] if v < 0.0005) if load else None
    rows.append((name, note, min(val), eff, dead, recs[-1]["step"]))

w = max(len(r[0]) for r in rows)
print(f"{'arm':<{w}}  {'setup':<20}  {'best val':>9}  {'eff experts':>11}  {'dead':>5}  steps")
for n, note, v, eff, dead, s in rows:
    e = f"{eff:>11.2f}" if eff else f"{'—':>11}"
    d = f"{dead:>5}" if dead is not None else f"{'—':>5}"
    print(f"{n:<{w}}  {note:<20}  {v:>9.4f}  {e}  {d}  {s}")

d = {r[0]: r[2] for r in rows}
print()
def gap(a, b, label):
    if {a, b} <= d.keys():
        g = d[b] - d[a]
        verdict = "tie" if abs(g) < 1e-4 else (f"{a} better" if g > 0 else f"{b} better")
        print(f"{label:<34} {g:+.4f}  ({verdict})")
gap("moe-wide", "moe-sup", "widening the labels is worth:")
gap("moe-nores", "moe-wide", "dropping the build residual is worth:")
gap("moe-nores", "moe-unsup", "best supervised vs no supervision:")
PY
