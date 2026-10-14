#!/usr/bin/env bash
# Does the MoE beat a matched-compute dense baseline once the router has
# something to learn from? Three arms, one answer.
#
#   bash scripts/train/proto-routing-ablation.sh
#
# WHY THIS EXISTS. The first proto comparison concluded dense wins (val 3.9397
# dense vs 3.9429 MoE). That conclusion does not survive inspection of how it
# was produced: the corpus carried no domain labels, so manifest.domain_labels
# was false, every token arrived with domain -1, and model.py's routing
# supervision term was multiplied by nothing. The run measured an MoE whose
# router was learning only from the load-balance and z-loss terms — an
# unsupervised router — and the 8b architecture decision was taken on it.
#
# THE THREE ARMS. Two arms would confound two different questions. If a
# supervised MoE beats dense, that could be the architecture or the extra
# training signal; without the middle arm there is no way to tell.
#
#   moe-sup     MoE, route_coef 0.1, labelled corpus   architecture + supervision
#   moe-unsup   MoE, route_coef 0,   labelled corpus   architecture alone
#   dense       proto-dense, matched active params     neither
#
# proto (8.2M total / 5.9M active) and proto-dense (5.9M) have the same depth,
# width, attention and sequence length, so compute per token is matched and the
# comparison is about where the parameters went, not how many there are.
#
# Everything else is held fixed: same tokenizer, same token shards, same seed,
# same steps, same batch, same learning-rate schedule. The only thing that
# varies between arms is the one named above.
set -euo pipefail

WORK="${WORK:-/tmp/artemis-proto-lab}"
DATA="${DATA:-$WORK/data}"
STEPS="${STEPS:-1500}"
BATCH="${BATCH:-16}"
LR="${LR:-3e-4}"
SEED="${SEED:-1337}"
REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

log() { echo "[$(date -u +%H:%M:%S)] $*"; }

[ -f "$DATA/manifest.json" ] || {
  echo "no prepared data at $DATA — run the corpus build first" >&2; exit 1; }

# The premise of the whole experiment. If this is false the run is the old run
# again, and silently so: route_coef would multiply a term that is never set.
python3 - "$DATA/manifest.json" <<'PY'
import json, math, sys
m = json.load(open(sys.argv[1]))
if not m.get("domain_labels"):
    raise SystemExit("manifest says domain_labels false — the router would have "
                     "nothing to supervise and this would repeat the old result")
tok = m["domain_tokens"]
tot = sum(v["train"] for v in tok.values())
print(f"labelled train tokens: {tot:,}")
for d, v in tok.items():
    if v["train"]:
        print(f"  {d:<14} {v['train']:>12,}  {100*v['train']/max(1,tot):5.1f}%")
PY

cd "$REPO/gateway"
run() {  # name, size, route_coef
  # Separate declarations deliberately: bash makes every name in one `local`
  # local-and-unset before evaluating any of the assignments, so referring to
  # $name in the same statement that declares it trips `set -u`.
  local name="$1" size="$2" coef="$3"
  local out="$WORK/runs/$name"
  if [ -f "$out/latest.pt" ]; then log "$name already trained — skipping"; return; fi
  log "arm $name: size=$size route_coef=$coef"
  python3 -m artemis.train --size "$size" --data "$DATA" --out "$out" \
    --steps "$STEPS" --batch "$BATCH" --lr "$LR" --seed "$SEED" \
    --route-coef "$coef" --eval-every 100 --eval-batches 20 --ckpt-every 500
}

run moe-sup   proto       0.1
run moe-unsup proto       0
run dense     proto-dense 0

log "comparison"
python3 - "$WORK/runs" <<'PY'
import json, math, sys
from pathlib import Path
rows = []
for name in ("moe-sup", "moe-unsup", "dense"):
    p = Path(sys.argv[1]) / name
    if not (p / "metrics.jsonl").exists():
        continue
    recs = [json.loads(l) for l in (p / "metrics.jsonl").open() if l.strip()]
    val = [r for r in recs if "val_loss" in r]
    cfg = json.loads((p / "run.json").read_text())
    # Val loss alone cannot distinguish an MoE that spread its traffic from one
    # that collapsed onto a single expert, and that distinction is the whole
    # question. exp(entropy) is the effective number of experts a token passes
    # through: 10 means uniform, 1 means the MoE has become dense.
    last = recs[-1]
    ent = last.get("router_entropy")
    eff = sum(math.exp(e) for e in ent) / len(ent) if ent else None
    load = last.get("expert_load")
    busiest = max(max(layer) for layer in load) if load else None
    rows.append((name, cfg["active_params"], min(r["val_loss"] for r in val),
                 val[-1]["val_loss"], recs[-1]["step"], eff, busiest))
w = max(len(r[0]) for r in rows)
print(f"{'arm':<{w}}  {'active':>10}  {'best val':>9}  {'final val':>9}  "
      f"{'eff experts':>11}  {'busiest':>7}  steps")
for n, a, b, f, s, eff, busy in rows:
    e = f"{eff:>11.2f}" if eff else f"{'dense':>11}"
    bu = f"{busy:>7.1%}" if busy else f"{'-':>7}"
    print(f"{n:<{w}}  {a:>10,}  {b:>9.4f}  {f:>9.4f}  {e}  {bu}  {s}")
print(f"\n(eff experts: exp(mean router entropy) — 10.00 is uniform across the "
      f"ten experts,\n 1.00 means every token takes the same one and the MoE "
      f"has become a dense model.\n busiest: largest share of routing slots any "
      f"single expert received.)")
# The claim under test is a comparison, so state the gap, not just the numbers.
d = {r[0]: r[2] for r in rows}
if {"moe-sup", "dense"} <= d.keys():
    g = d["dense"] - d["moe-sup"]
    print(f"\nsupervised MoE vs dense: {g:+.4f} "
          f"({'MoE better' if g > 0 else 'dense better'})")
if {"moe-sup", "moe-unsup"} <= d.keys():
    g = d["moe-unsup"] - d["moe-sup"]
    print(f"routing supervision is worth: {g:+.4f}")
PY
