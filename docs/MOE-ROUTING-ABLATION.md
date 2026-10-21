# Does the MoE earn its parameters? — proto routing ablation

Status: **complete**. Prediction below was written before any arm finished;
results are appended underneath, whichever way they fall.

## Why the earlier answer does not count

The 8b architecture decision rests on one comparison: proto MoE at val 3.9429
against proto-dense at val 3.9397, matched on compute. Dense won, narrowly.

That number is real. What it measured is not what it was taken to measure. The
corpus had no domain labels, so `manifest.domain_labels` was false, every token
arrived at the router with domain `-1`, `ExpertMixture.forward` left
`supervised` as `None`, and `route_coef` multiplied nothing
(`gateway/artemis/model.py:179`, `:262`). The run compared a dense model
against an MoE whose router learned from the load-balance and z-loss terms
alone. Routing supervision — the mechanism the whole ten-expert design is built
on — was never in the experiment.

## The three arms

Two arms cannot settle it. If a supervised MoE beats dense, that could be the
architecture or simply the extra gradient signal, and nothing distinguishes
them. So:

| arm | size | `route_coef` | isolates |
| --- | --- | --- | --- |
| `moe-sup` | `proto` | 0.1 | architecture + routing supervision |
| `moe-unsup` | `proto` | 0 | architecture alone |
| `dense` | `proto-dense` | — | neither |

`proto` is 8.2M total / 5.9M active; `proto-dense` is 5.9M, with the same depth,
width, attention and sequence length. Compute per token is matched, so the
question is where the parameters went, not how many there are. Tokenizer,
token shards, seed, steps, batch and LR schedule are identical across arms.

## The corpus, and the problem visible in it

Two shards of `codeparrot/github-code-clean`, filtered by
`artemis.code_corpus`:

| | |
| --- | --- |
| rows read | 253,850 |
| kept | 113,283 |
| rejected, non-permissive licence | 88,964 (35.0%) |
| rejected, language | 41,478 |
| rejected, size | 10,125 |

35.0% non-permissive is consistent with the 36% measured independently
earlier, which is a useful check on the licence filter.

Every kept document carries a domain label. That is the good news. The rest is
not: `classify()` can only label three of the ten experts, and the mix is
badly lopsided. Of 10,194,667 train tokens —

| domain | train tokens | share |
| --- | --- | --- |
| `build` | 8,731,852 | 85.7% |
| `test` | 1,441,422 | 14.1% |
| `deploy` | 21,393 | 0.2% |

Seven experts — `intent`, `architecture`, `planning`, `memory`, `security`,
`observability`, `cost` — receive no supervision at all, because a path and a
language cannot evidence them. `code_corpus` says so in its own docstring and
leaves them unlabelled rather than guessing, which is the right call and also
the reason this corpus can only partly test the design.

### After widening `classify()`: measured on a full shard

The numbers above predate the content-signal work in `e4f3962` / `06ccdab`,
which was meant to reach more experts. It did. Re-measured on the whole of
`data/train-00000-of-00880.parquet` (355 MB, 126,925 rows, ~1m55s on 4 cores):

| | |
| --- | --- |
| rows read | 126,925 |
| kept | 55,728 (43.9%) |
| rejected, non-permissive licence | 45,232 (35.6%) |
| rejected, language | 20,820 |
| rejected, size | 5,145 |
| characters kept | 241,146,886 |

35.6% non-permissive matches the 35.0% and 36% measured before, on different
data — the licence filter is stable. 241.1M chars against the documented
70.4M tokens/shard implies 3.43 chars/token, so that constant holds too.

Widening moved the labelled expert count from three to **seven**. But running
the same shard with `--no-residual-build` separates real labels from the
catch-all, and the distribution is worse than the headline suggests:

| domain | documents | share of labelled | share of corpus |
| --- | --- | --- | --- |
| `test` | 8,171 | 64.6% | 14.7% |
| `memory` | 3,589 | 28.4% | 6.4% |
| `security` | 312 | 2.5% | 0.6% |
| `cost` | 262 | 2.1% | 0.5% |
| `deploy` | 182 | 1.4% | 0.3% |
| `observability` | 123 | 1.0% | 0.2% |
| **labelled total** | **12,639** | 100% | **22.7%** |
| unlabelled (becomes `build`) | 43,089 | — | 77.3% |
| `intent`, `architecture`, `planning` | **0** | 0% | 0% |

Three things follow, and they matter for the architecture rather than for this
ablation alone.

**77.3% of the corpus carries no real label.** With the residual on, all of it
becomes `build`, so `build` is not a domain here — it is "everything we could
not identify". The 85.7% `build` share in the earlier table was the same
artifact at a different scale.

**`test` and `memory` are 93.0% of all genuine labels.** `observability` is one
document in 103 labelled, one in 453 of the corpus. A router cannot learn a
useful decision boundary from 123 documents, and the load-balance loss will
fight to send it traffic it has no basis for.

**Three of ten experts are not merely unlabelled, they are unlabelable from
this corpus.** `intent`, `architecture` and `planning` are properties of a
conversation or a design discussion, not of a source file; no amount of
widening the path and content heuristics will find them in GitHub code.

This is independent corroboration of the ablation's result rather than a new
one. Supervising a router against labels where one synthetic catch-all holds
77%, two real classes hold 93% of the remainder, and three classes are
permanently empty cannot help — and `route_coef=0.1` losing 0.046 validation
loss while killing seven of ten experts is exactly what that predicts. The
`ROUTE_COEF=0` default in `stages.sh` is not a tuning preference; it is the
only setting this corpus supports.

What would change it is chat and design data — the stage `sft` corpus, where
`intent`, `architecture` and `planning` actually occur. Routing supervision is
worth re-testing there, and nowhere else.

## Prediction, written in advance

The supervision term and the load-balance term want opposite things, and the
arithmetic says which one wins. With ten experts, `balance_coef` 0.01 and
`route_coef` 0.1:

| router behaviour | balance penalty | supervision penalty |
| --- | --- | --- |
| uniform | 0.0100 | 0.2303 |
| obeys the labels fully | 0.0741 | 0.0000 |

Obeying the labels costs 0.0641 in extra balance penalty and saves 0.2303 in
supervision — a net gain of **+0.1662**. So the router should collapse onto the
label distribution, which sends **84.8% of tokens through a single expert** and
leaves the other nine nearly idle.

**Therefore I expect `moe-sup` to be no better than `dense`, and plausibly
worse** — a supervised MoE that routes 85% of its traffic to one expert is a
dense model carrying nine sets of unused parameters, and `proto-dense` spends
the same compute on one wider shared path. I expect `moe-unsup` to land close
to the original 3.9429, since that arm reproduces the original conditions.

If that is what happens, the finding is not "MoE loses". It is that
**`classify()` is too coarse to supervise a ten-expert router**, and the
architecture question stays open until the labels cover more than three
experts with a less lopsided mix. That is a fixable data problem, not a verdict
on the design.

Early signal, 20 steps into `moe-sup`: `route_loss` 0.985 against 2.303 for a
uniform router, and per-layer router entropy 0.938 / 1.231 / 1.996 against
2.303 uniform. The router is already collapsing, as predicted.

## What this run cannot tell us

Honest limits, stated before the numbers arrive so they cannot be chosen to
suit them:

- **Undertrained by design.** 2500 steps x 4096 tokens is 10.2M tokens for a
  5.9M-active-parameter model — about 1.7 tokens per parameter against a
  Chinchilla-optimal 20. One pass over the pool, no repeats. A ranking at 1.7
  tokens/param need not hold at 20.
- **Small validation set.** 108,398 val tokens. Evaluation uses deterministic
  non-overlapping windows, so every arm sees exactly the same ones and the
  comparison is fair, but differences smaller than a few thousandths are noise.
- **Three of ten experts.** Nothing here tests whether `security` or `cost`
  routing works, because no token is labelled with either.
- **Proto scale.** 5.9M active parameters, `d_model` 256, 6 layers, seq 256.
  MoE benefits are generally held to grow with scale; a null result here is
  weak evidence about 8b.

## Results

All three arms ran the full 2500 steps on identical data, tokenizer, seed and
schedule. Validation loss recomputed from the final checkpoints over the same
deterministic windows, at two eval sizes, because the in-run figure is rounded
to four decimals and two arms collided on it.

| arm | active params | val (20 batches) | val (100 batches) | eff. experts | busiest |
| --- | --- | --- | --- | --- | --- |
| `moe-sup` | 5,876,480 | 3.622228 | 3.623671 | 1.35 | 50.0% |
| `moe-unsup` | 5,876,480 | **3.573236** | **3.577771** | 8.03 | 13.4% |
| `dense` | 5,868,800 | 3.622172 | 3.624134 | — | — |

| comparison | 20 batches | 100 batches | verdict |
| --- | --- | --- | --- |
| `moe-sup` vs `dense` | −0.000056 | +0.000463 | **tie — the sign flips** |
| `moe-unsup` vs `dense` | +0.048936 | +0.046363 | MoE better, stable |
| `moe-unsup` vs `moe-sup` | +0.048992 | +0.045900 | supervision hurts, stable |

### Three findings

**1. Routing supervision costs about 0.046–0.049 validation loss.** Stable in
sign and magnitude across eval sizes. The ten-expert design trains *better*
with `route_coef` at 0 than at its default 0.1.

**2. The MoE architecture beats matched-compute dense by about the same
margin, once the router is left alone.** `moe-unsup` 3.5778 against `dense`
3.6241 at 100 batches. This reverses the original conclusion. The architecture
was never the problem; the supervision was, and the original run could not see
that because it had the supervision silently disabled *and* attributed the
result to the architecture.

**3. `moe-sup` and `dense` are indistinguishable.** The gap is 5e-5 to 5e-4 and
**changes sign** when the validation set grows from 20 to 100 batches, while
the other two gaps hold steady at ~0.046. A difference that reverses under more
evaluation is noise. Supervised, the MoE is exactly as good as a dense model —
which is what you would expect of a model that has become one.

### Why, mechanically

Final expert load, identical in all three MoE layers, for `moe-sup`:

```
intent 0.000   architecture 0.000   planning 0.000
build  0.500   test         0.497   deploy   0.004
memory 0.000   security     0.000   observability 0.000   cost 0.000
```

`experts_per_token` is 2, so 0.500/0.497 means `build` and `test` are in every
token's top-2. Routing became **constant** — the same two experts for every
token regardless of content — with seven experts dead and `deploy` at 0.004,
tracking its 0.2% share of the labels. That is a dense model carrying nine
unused parameter sets, and it scores exactly like one.

With supervision off, the same architecture spreads across 8.03 effective
experts, busiest at 13.4% against 10% for a perfectly even split, and balance
loss 1.0192 against a theoretical ideal of exactly 1.0. The router solves load
balancing by itself. It is supervision that breaks it.

The predicted incentive was right: obeying the labels saves 0.2303 in
supervision and costs 0.0641 in balance penalty, so the router obeys. The
prediction that `moe-sup` would be "no better than dense, plausibly worse" was
right on "no better" — it tied — but located the damage in the wrong
comparison. The cost is visible against the MoE control, not against dense.

### What to do about it

Do not read this as "turn routing supervision off and ship". It says the
supervision signal as currently built is harmful, and names three fixes, in the
order worth trying:

1. **Label more experts.** `classify()` labels 3 of 10 from paths and language,
   which genuinely cannot evidence `intent` or `architecture`. This is the real
   fix and the most work.
2. **Supervise a subset of tokens**, leaving the rest to balance-driven
   exploration so unlabelled experts stay reachable.
3. **Lower `route_coef`** so the balance term can compete — at 0.1 against
   `balance_coef` 0.01 it cannot.

Until one of those lands, a 1b or 8b run should set `--route-coef 0`. On this
evidence that is worth ~0.046 validation loss and the difference between ten
working experts and three.

---

# Second ablation: fixes 1 and 2, tested

Fixes 1 and 2 above were built and run. Both were measured; one helped a
little, one made things worse, and the recommendation did not change.

`classify()` was widened to read file contents, reaching `security`,
`observability`, `memory` and `cost` — 7 of 10 experts, up from 3. The residual
`build` label was made optional so supervision could be restricted to tokens
with positive evidence.

Two new arms. `dense`, `moe-unsup` and `moe-sup` were carried over, which is
sound only because none of them reads domain labels: `route_coef 0` never adds
the supervision term and `proto-dense` has no router. The carry-over was
asserted, not assumed — `sha256(train.bin)` and `sha256(val.bin)` matched
across label sets (`d8fdc434bce7…`, `cd5bdef6b794…`), as did `tokenizer.json`.
All five arms therefore share one token stream, one seed and one schedule.

## Results

| arm | setup | val | lm loss | balance | eff. experts | dead |
| --- | --- | --- | --- | --- | --- | --- |
| `moe-unsup` | route_coef 0 | **3.5732** | **3.1778** | **1.019** | **8.03** | **0** |
| `moe-wide` | 7 labels + build | 3.6115 | 3.2483 | 4.167 | 2.05 | 7 |
| `dense` | no MoE | 3.6222 | 3.2278 | — | — | — |
| `moe-sup` | 3 labels + build | 3.6222 | 3.2572 | 4.965 | 1.35 | 7 |
| `moe-nores` | 7 labels, no build | 3.6624 | 3.2951 | 3.289 | 3.01 | 4 |

### What the last two columns do and do not mean

Added after an audit found both were being quoted more confidently than their
definitions support. The val and loss columns are unaffected.

**`eff. experts`** is the mean across MoE layers of `exp(that layer's router
entropy)` — not `exp(mean entropy)`, which the script's caption used to claim.
It is read from **one** metrics record: the routers at a single training step,
not an average over evaluation batches. Per-layer entropy moves a lot between
adjacent evaluations — on the 100m run, layer 0 went 2.12 → 1.86 → 1.38 → 1.70
→ 1.47 across 200 steps — so **8.03 does not carry two significant decimals**.
Read it as "most of the ten experts are carrying traffic", which is the claim
the ablation actually needs, and nothing finer.

**`dead`** counted experts receiving under 0.05% of routing slots **in the
first MoE layer only**. The figures in this table were produced that way, so
"0 dead" means no starved expert in layer 0, not across the model — one layer
of six on a 12-layer `moe_every: 2` config. `proto-label-ablation.sh` now
requires an expert to be starved in *every* layer before calling it dead;
re-running these arms would be needed to restate the column on that basis.

Neither metric is computed by `artemis.evaluate`. For any claim about *which*
expert serves *which* domain — the question these numbers are usually invoked
to answer — the routing matrix and the ablation specialisation test in
`artemis.evaluate` are the measurements that actually bear on it, and they are
per-domain rather than aggregate.

| comparison | gap |
| --- | --- |
| widening the labels 3 → 7 | **+0.0107** (helps; 22% of the penalty) |
| dropping the `build` residual | **−0.0509** (hurts) |
| best supervised vs no supervision | **−0.0892** (no supervision wins) |

## The finding that was not expected

Dropping the residual did exactly what was predicted to the ROUTER and the
opposite of what was predicted to the MODEL. Every routing metric improved —
effective experts 2.05 → 3.01, dead experts 7 → 4, balance loss 4.167 → 3.289
— and validation loss got **worse** by 0.051, the worst arm in the set.

**Expert utilisation is not a proxy for quality.** That assumption was being
made implicitly while the runs were in flight, reading "more live experts" as
progress. It is false here: the arm with the second-highest utilisation
performs worst. The `lm_loss` column locates the damage — 3.2951, the highest
of any arm. Routing supervision does not merely fail to help; it competes with
next-token prediction for the same gradient, and spreading it across more
experts spreads the damage rather than diluting it.

That also explains why widening helped only 22%. More labels reduce how
cheaply the router can obey (route_loss rose 0.146 → 0.922 at step 1000), which
loosens the collapse, but the supervision term is still pulling against the
objective that validation measures.

Thin labels never earned an expert either. `security` (1.1% of tokens), `cost`
(0.8%), `observability` (0.6%) and `deploy` (0.2%) stayed at 0.000 load in
`moe-wide`. Under top-2 routing a label covering under ~1% of tokens loses to
whatever is larger, every time. Widening changed WHICH experts won — `memory`
displaced `test` for the second slot — not HOW MANY.

## Conclusion

Tested four ways, the ranking is unambiguous: **`route_coef 0` wins on every
measure** — best validation loss, best lm loss, balance loss 1.019 against a
theoretical ideal of exactly 1.0, all ten experts live, none dead. The router
solves load balancing better alone than with any supervision signal
constructible from this corpus.

**Set `--route-coef 0` for the 1b and 8b runs.** This is now the conclusion of
two independent experiments rather than one, and the second was built
specifically to overturn it and failed to.

The labelling work is not wasted. It is worth 0.0107 if supervision is ever
wanted, and `classify()` reaching 7 of 10 experts is needed for per-expert
EVALUATION regardless of whether it is used for training. What it is not is a
fix for the supervision penalty.

Fix 3 — lowering `route_coef` so the balance term can compete — remains
untested. Given that the damage is to `lm_loss` rather than to routing, the
expected result is that lowering `route_coef` approaches `moe-unsup` from
below and never beats it, with the best value being 0. That is a prediction,
not a measurement.

## Limits, unchanged

Everything in the first ablation's limits section still applies and is not
softened by these results: 1.7 tokens per active parameter against a
Chinchilla-optimal 20, 108,398 validation tokens, proto scale (5.9M active,
`d_model` 256, seq 256), and three of ten experts that no corpus of source
code can evidence. The mechanism — a supervision term competing with the
language-model objective — is scale-independent; the loss numbers are not.

### Standing limits

The limits stated before the run still apply and are not softened by the
result: 1.7 tokens per active parameter against a Chinchilla-optimal 20,
108,398 validation tokens, three of ten experts labelled, and proto scale
(5.9M active, `d_model` 256, seq 256). A ranking at this scale and budget is
evidence about 8b, not proof. The mechanism — supervision collapsing the router
onto the labelled experts — is scale-independent arithmetic and travels better
than the loss numbers do.
