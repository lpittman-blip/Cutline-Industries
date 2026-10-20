# Artemis pretraining budget: 80B tokens

Decision: **80,000,000,000 training tokens**, counted with Artemis's own
tokenizer after licence filtering, cleaning and exact-duplicate removal.
Validation and test tokens are held out and are NOT part of the 80B.

The budget is a DATA budget. It does not change model size: the `100m` rung is
153.2M total / **110.8M active** parameters and stays that way. 80B tokens on
110.8M active params is 36x the Chinchilla-optimal 2.2B — a deliberate
over-train, which is now standard for small models kept cheap at inference
(TinyLlama: 1.1B params on 3T tokens). Stated here so it is a choice on the
record rather than an accident.

## The constraint that shapes everything: 80B > the dataset

Measured on shard 00000 of `codeparrot/github-code-clean`, end to end through
Artemis's own tokenizer at vocab 32000:

| | |
| --- | --- |
| tokens per shard, after licence filter + dedup | **70,702,756** |
| constant assumed project-wide until now | 70,400,000 |
| ratio measured / assumed | **1.004** |

The constant every cost estimate rests on is correct to 0.4%. But:

| | |
| --- | --- |
| shards in the dataset | 880 |
| **unique token ceiling** | **62.2B** |
| target | 80B |
| target / ceiling | **1.29x** |

**80B is 1.29 times the entire filtered corpus.** 17.8B tokens cannot be unique
and must come from one of:

1. **Repeated exposure** — 1.29 epochs over the full corpus. Simplest, and at
   this scale defensible; the second pass sees 29% of the data twice.
2. **Additional corpora** — a second permissively-licensed source. This also
   fixes the dead-domain problem below, so it is the better answer if the
   licence review is affordable.

Either way `train.py` must report unique tokens separately from total tokens
trained, so "80B" never silently means "62.2B seen 1.29 times" without saying
so.

## Storage: the tokenised corpus does not fit anywhere local

| | |
| --- | --- |
| `train.bin` (uint16) | 160 GB |
| `train.dom` (uint8) | 80 GB |
| **total** | **240 GB** |

Against 6 GB free in the agent container. Two consequences:

- Shard preparation **must stream**: download one shard, filter, tokenise,
  append, delete the raw file, repeat. Never hold the corpus on disk at once.
- The GPU box needs **≥300 GB** of disk, not the 150 GB the current preflight
  asks for. A box provisioned for a 3B-token run will die partway through an
  80B one.

## Time and cost for 80B tokens

6 x 110.8e6 x 80e9 = **5.318e19 FLOPs**, at 30% MFU:

| hardware | wall clock | cost |
| --- | --- | --- |
| 1x T4 | 757.6 h (31.6 d) | $401.53 |
| 1x RTX 3090 (Vast) | 693.6 h (28.9 d) | $117.91 |
| **1x A100 40GB (Vast)** | **157.8 h (6.6 d)** | **$76.23** |
| 1x H100 (Vast) | 49.7 h (2.1 d) | $109.73 |
| 8x H100 | 6.2 h | $223.84 |

A100 is the cheapest per run; H100 is the cheapest per day of waiting. The T4
that the Azure quota request asks for would take **a month** — fine for a 3B
validation run, wrong for 80B.

These are estimates from peak FLOPs at an assumed 30% MFU. **The measured
tokens/second on the actual GPU replaces them before any paid run starts.**

## Pre-launch checks — status

Verified on CPU against real data from shard 00000, at production vocab 32000
and sequence length 2048:

| check | result |
| --- | --- |
| licence filter + domain labels | 126,925 rows -> 55,728 kept (43.9%) |
| tokenizer train, vocab 32000 | OK, on 241.1M characters |
| tokenise + hold out val | OK, 70,702,756 tokens |
| exact-duplicate removal | **already implemented** (`data.py`, sha256 per doc) |
| val holdout | **already implemented**, by document hash — deterministic, domain-balanced, not a tail slice |
| forward + backward, 100m, real data | OK, loss 9.52 -> 8.74 (random init = ln 32000 = 10.37) |
| optimizer step | OK, grad_norm finite and falling |
| checkpoint save | OK, 1.84 GB, format v2, arch `artemis-prime-moe`, optimizer + RNG included |
| **checkpoint resume** | **OK — resumed at step 7, not step 1** |
| `route_coef=0` behaviour | OK, `route_loss` absent from metrics |
| GPU tokens/second | **NOT DONE — needs a GPU** |

## The dead domains: not a bug, and not safe to "fix" by guessing

Token-level counts from the real tokenised shard:

| domain | train tokens | share |
| --- | --- | --- |
| `build` | 50,657,726 | 71.7% |
| `test` | 10,636,660 | 15.0% |
| `memory` | 7,402,424 | 10.5% |
| `security` | 801,369 | 1.1% |
| `cost` | 565,141 | 0.8% |
| `observability` | 349,438 | 0.5% |
| `deploy` | 135,992 | 0.2% |
| `intent`, `architecture`, `planning` | **0** | **0%** |

The root cause is upstream of the classifier: `CODE_LANGUAGES` admits twenty
executable languages and **no Markdown**. ADRs, RFCs, `ARCHITECTURE.md` and
design docs — the only artifacts in a repository that actually evidence intent,
architecture or planning — are rejected at the language gate before
`classify()` ever runs.

So the three domains are empty because the corpus contains nothing that could
fill them, exactly as `code_corpus.py` documents:

> Guessing them would reintroduce exactly the failure this is fixing, so they
> stay unlabelled until a corpus that actually evidences them exists.

**And at the production setting this costs nothing.** `ROUTE_COEF=0` means
routing is unsupervised; the ablation measured 8.03 effective experts and zero
dead experts in that configuration. Domain labels only steer the router when
`route_coef > 0`, which two independent ablations measured as worse: 0.046
validation loss, and seven of ten experts killed.

Two honest ways to give the three domains real signal, neither of which is
pattern-matching source code:

1. **Admit Markdown and add PATH-based signals** for genuine artifacts
   (`docs/adr/*`, `rfc*`, `ARCHITECTURE.md`, `DESIGN.md`). Real evidence, not
   a guess — but it changes the corpus mix for a code model and needs its own
   licence review.
2. **Get them from stage `sft`**, the chat corpus, where intent, architecture
   and planning actually occur. This is what the design already intends and is
   where routing supervision is worth re-testing.

Until one of those lands, `ROUTE_COEF` stays 0 and the three experts are
trained by unsupervised routing like the other seven.
