# Does the MoE earn its parameters? — proto routing ablation

Status: **running**. Prediction below was written before any arm finished;
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

_Appended when the arms finish._
