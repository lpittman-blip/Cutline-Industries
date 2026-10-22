# Does the MoE specialise? Measured at compute-optimal scale

**Short answer: barely, and the three data-less experts are actively harmful.**

## The run

`proto` trained to its Chinchilla budget on real licensed data, 2026-10-22.

| | |
| --- | ---: |
| config | `proto` — 8,235,776 total / 5,876,480 active, 6 layers, MoE on layers 1/3/5 |
| experts | 10, top-2, `route_coef` 0 |
| corpus | 2 shards `codeparrot/github-code-clean`, licence-filtered, vocab 4096 trained on it |
| corpus size | 175,493,136 tokens, 113,283 documents, 0 duplicates |
| trained | 14,343 steps x 8,192 tokens = **117,529,600 tokens** (20 x active params) |
| wall clock | 7.4 h on 4 CPU cores |
| final | **val_loss 2.6164**, train loss ~1.92 |

This is the first Artemis model trained to a compute-optimal budget. The
earlier 100m run saw 1.2M tokens — 0.06% of its budget — so its "0 of 10
specialised" said nothing. This one can be read.

## Result

`evaluate.py`'s test is strict: an expert is specialised when removing it
raises its own domain's loss by more than twice the mean rise across other
domains, AND its own domain is hurt more by its removal than by any other
expert's. **1 of 10 passes** (`cost`).

The weaker, more informative test — for each domain, which expert's removal
hurts it most — gives **2 of 7 domains that have any data** (`build`, `cost`):

| domain | tokens in eval | most damaging removal |
| --- | ---: | --- |
| build | 109,916 | **build** |
| test | 25,802 | build |
| memory | 23,657 | deploy |
| security | 1,341 | build |
| observability | 1,793 | memory |
| cost | 1,242 | **cost** |
| deploy | 89 | cost |

Restricting to the three domains with enough tokens to measure reliably —
`build`, `test`, `memory` — **only one is served by its own expert.**

`deploy` has 89 tokens in the evaluation sample. Nothing about it is
measurable; it is listed for completeness, not evidence.

## The finding that matters most

The three experts with zero training data are not merely idle. **Removing them
IMPROVES loss on nearly every domain:**

```
removed expert   build    test   deploy  memory  security  observ.   cost
planning       -0.0740 -0.0707 -0.1339 -0.0106  -0.2145  -0.0653 -0.1169
architecture    0.0584 -0.0036 -0.1282  0.0258  -0.1533  -0.0348 -0.0217
```

Every negative number is a domain that got *better* when the expert was taken
out of routing. The load-balance loss forces traffic through all ten experts;
three of them have no coherent function to apply, so the tokens routed to them
come back worse than if they had gone elsewhere.

At the proposed 14B configuration the eight non-active experts hold roughly
7.86B parameters, about 983M each. Three of them, **~2.95B parameters and
21.5% of the model**, would be doing this.

## `build` is a generalist, not a specialist

The `build` expert is the most damaging removal for `build`, `test` AND
`security`. That is what a shared trunk looks like, not a specialist. It is
also what the corpus implies: `build` is 71.6% of it, so the expert that
serves it learned general code and everything leans on it.

## Proportion

Every effect is small. The largest single number in the matrix is 0.1324 nats
against a val loss of 2.6164 — about 5%. No expert is load-bearing. An MoE
whose experts can each be deleted for a few percent is not routing work to
specialists; it is a slightly irregular dense model.

## What this does and does not establish

**Does:** at compute-optimal scale on this corpus, routed experts do not
specialise by domain, and experts without domain data actively hurt.

**Does not:** rule out specialisation at larger scale. `proto` has 5.9M active
parameters; emergent behaviour at 14B cannot be inferred from it. Nor does it
separate "the architecture does not specialise" from "the corpus offers little
to specialise into" — 71.6% of it is one domain and three domains are empty.
Those two explanations predict the same measurement here.

## Recommendation

Do not buy ten experts' worth of parameters on the strength of the current
corpus. Two defensible paths:

1. **Cut the expert count** to the domains the data supports. On this evidence
   that is three with real volume, seven with any at all. This removes ~2.95B
   parameters that measurably make output worse.
2. **Fix the corpus first, then re-measure.** If a second source supplies
   `intent`, `architecture` and `planning` with real volume, this experiment
   can be re-run before any decision about model size is locked in. It costs
   7.4 hours of CPU and nothing else.

Doing (2) and then (1) is the cheap order. What is not defensible is scaling to
14B with ten named experts while three of them are measured, at the only scale
we have tested, to be worse than absent.

## Reproducing

```
python3 -m artemis.stream_corpus --work <dir> --shards 2 --vocab 4096 --tokenizer-shards 2
python3 -m artemis.train --size proto --data <dir>/data --out <dir>/run \
  --steps 14343 --batch 32 --accum 1 --lr 6e-4 --warmup 287 --seed 1337 \
  --route-coef 0 --eval-every 500 --eval-batches 20 --ckpt-every 1000
python3 -m artemis.evaluate --checkpoint <dir>/run/latest.pt --data <dir>/data \
  --out <dir>/eval.json --batch 16 --batches 40
```

Loss here is **not** comparable to the 3.5732 in `MOE-ROUTING-ABLATION.md`: a
different corpus and a vocabulary trained on it mean the losses are measured
against different token distributions. Only the structural results compare.
