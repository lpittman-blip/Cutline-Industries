# Domain coverage: the corpus cannot teach three of the ten experts

Measured 2026-10-21 on one full shard of `codeparrot/github-code-clean`
(shard 00001), licence-filtered and labelled by `artemis.code_corpus.classify`,
tokenised at vocab 32000. **74,105,053 training tokens, 57,555 documents,
100% labelled.**

## What was measured

| domain | train tokens | share |
| --- | ---: | ---: |
| `build` | 53,019,908 | 71.55% |
| `test` | 11,511,076 | 15.53% |
| `memory` | 7,637,310 | 10.31% |
| `security` | 870,582 | 1.17% |
| `cost` | 595,447 | 0.80% |
| `observability` | 327,393 | 0.44% |
| `deploy` | 143,337 | 0.19% |
| `intent` | **0** | **0.00%** |
| `architecture` | **0** | **0.00%** |
| `planning` | **0** | **0.00%** |

Three domains receive nothing. Four more are under 1.2%. One domain is 71.55%
of the corpus.

This is not a sampling artefact. It is the whole shard, and shard-to-shard
variation measured elsewhere in this project is ~1.25%, so there is no reason
to expect other shards to differ in kind.

## Why it happens

`classify` labels source files. `intent`, `architecture` and `planning` are not
properties of source files — they are properties of the discussion *around*
code: issues, design documents, RFCs, commit rationale, review threads. A
corpus of source files cannot carry them, and no improvement to `classify`
will invent a signal the input does not contain.

## What it costs at 14B

At the proposed 13,685,059,584 total / 5,823,815,680 active, the eight
non-active experts hold roughly 7.86B parameters — about 983M each. Three
experts with zero domain signal is therefore **~2.95B parameters, 21.5% of the
model**, named for domains the corpus cannot teach.

Those parameters are not wasted in the sense of being untrained: the
load-balance loss pushes traffic through every expert, so they learn generic
features and contribute capacity. The claim that fails is the *specialisation*
claim — that expert *i* is the `planning` expert. Routing supervision cannot
rescue it either, since `route_coef` needs labels that do not exist.

Note that this is a separate failure from "no expert has specialised yet",
which is the expected state of a 600-step run and says nothing about the
architecture.

## Options

1. **Reduce the expert count** to what the data supports. Cheapest, and makes
   every expert's name true. Three domains carry real volume (`build`, `test`,
   `memory`); seven if the thin ones are kept.
2. **Add a second licensed corpus** carrying design and planning language.
   GitHub issue and pull-request discussion is human-written and would
   plausibly label `intent`, `architecture` and `planning`. Each source needs
   its licence checked individually, and the no-external-model rule (Blueprint
   Decisions 5 and 12, extended to training data) means human-written only —
   no synthetic generation of the missing domains.
3. **Keep ten and say so plainly** — three are generic capacity with
   aspirational names.

Option 2 is recommended, because a second source is required regardless: this
dataset's 880 shards cap the corpus at ~63.4B unique tokens against an 80B
budget. One sourcing decision resolves both problems.

## Evidence

- Measurement: `manifest.json` written by `artemis.stream_corpus`
- Evaluation: `artemis.evaluate` on a 600-step 100m checkpoint, val_loss
  5.2142 (training reported 5.2085 — two independent paths agreeing)
- Specialisation at that checkpoint: **0 of 10**, ablation deltas within
  ±0.04. Expected at 1.2M tokens and not evidence about the architecture.
