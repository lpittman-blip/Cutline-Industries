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

### Standing limits

The limits stated before the run still apply and are not softened by the
result: 1.7 tokens per active parameter against a Chinchilla-optimal 20,
108,398 validation tokens, three of ten experts labelled, and proto scale
(5.9M active, `d_model` 256, seq 256). A ranking at this scale and budget is
evidence about 8b, not proof. The mechanism — supervision collapsing the router
onto the labelled experts — is scale-independent arithmetic and travels better
than the loss numbers do.
