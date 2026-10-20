# What size should Artemis be, and what does that cost?

Written after measuring the real tokens-per-shard and validating the pipeline
end to end. The short version: **80B tokens and the `100m` rung are mismatched
by 36x, and the data ceiling rules out the top of the ladder entirely.**

## The ladder, measured from `configs/models.yaml`

| rung | total params | active params | Chinchilla budget | 80B is | checkpoint (fp32+Adam) |
| --- | --- | --- | --- | --- | --- |
| `proto` | 8.2M | 5.9M | 0.1B | 680x | 0.1 GB |
| `100m` | 153.2M | 110.8M | 2.2B | **36x** | 2.5 GB |
| `1b` | 1,308.4M | 1,056.7M | 21.1B | 3.8x | 20.9 GB |
| `3b` | 4,172.6M | 3,379.9M | 67.6B | **1.2x** | 66.8 GB |
| `8b` | 10,248.8M | 8,436.8M | 168.7B | 0.5x | 164.0 GB |

Active params matter, not total: these are MoE, one expert per token per MoE
layer, so FLOPs scale with active while VRAM scales with total.

## 80B tokens is compute-optimal for a ~4B model

Chinchilla says params = tokens / 20. For 80B that is **4.0B active
parameters** — almost exactly the `3b` rung (3.38B active, optimal budget
67.6B). So the 80B figure is a well-chosen budget *for a model Artemis is not
currently configured to train*.

Spending it on `100m` is not wasted — over-training small models is standard
practice when inference has to stay cheap (TinyLlama: 1.1B params, 3T tokens).
But it buys 36x more tokens than the model can efficiently absorb.

## The data ceiling decides the top of the ladder

The filtered corpus holds **62.2B unique tokens** (880 shards x 70,702,756
measured). Against each rung's optimal budget:

| rung | optimal tokens | vs 62.2B unique |
| --- | --- | --- |
| `100m` | 2.2B | 3.5% of it — trivially covered |
| `1b` | 21.1B | 34% — comfortable, single epoch |
| `3b` | 67.6B | **109% — already over the ceiling** |
| `8b` | 168.7B | **271% — needs ~3x more data** |

**`1b` is the largest rung this corpus can train properly.** `3b` is marginal
and `8b` is out of reach without substantially more licensed data. Any plan
targeting 8b is a data-acquisition project before it is a training project.

## Cost of spending 80B on each rung (30% MFU)

| rung | FLOPs | A100 @$0.483 | H100 @$2.21 | 8xH100 @$36 |
| --- | --- | --- | --- | --- |
| `100m` | 5.32e19 | 158 h / **$76** | 50 h / $110 | 6 h / $224 |
| `1b` | 5.07e20 | 1,505 h / $727 | 474 h / $1,047 | 59 h / $2,135 |
| `3b` | 1.62e21 | 4,815 h / $2,325 | 1,517 h / $3,347 | 190 h / $6,828 |
| `8b` | 4.05e21 | 12,018 h / $5,805 | 3,788 h / $8,355 | 473 h / $17,044 |

And each rung at **its own** optimal budget, which is the honest comparison:

| rung | tokens | A100 hours | cost |
| --- | --- | --- | --- |
| `100m` | 2.2B | 4.4 h | **$2.11** |
| `1b` | 21.1B | 398 h (17 d) | **$192** |
| `3b` | 67.6B | 4,068 h (170 d) | $1,965 |
| `8b` | 168.7B | 25,349 h (2.9 y) | $12,244 |

Single-GPU hours become absurd past `1b`; `3b` and up are multi-GPU projects.

## Recommendation: a three-step ladder, not one leap

**Step 1 — `100m` at 2.2B tokens. $2.11, 4.4 hours on one A100.**
This is its compute-optimal budget. It produces a real, servable checkpoint
(1.84 GB measured) and proves the entire chain on hardware. At two dollars it
is cheaper than arguing about it. Do this the moment any GPU is available.

**Step 2 — `1b` at 21.1B tokens. $192, ~17 days on one A100 or ~50 h on
8xH100.** This is the first Artemis worth selling access to: the largest rung
the corpus supports at a proper token budget, and it fits a single 24 GB card
at inference in bf16 (1.31B total x 2 bytes = 2.6 GB of weights).

**Step 3 — `3b`+ only after acquiring more licensed data.** Not a training
decision; a corpus decision. Revisit when there is a second permissively
licensed source.

### If the 80B figure is firm

Then the model should move to `1b` and 80B becomes a 3.8x over-train — a
defensible choice that costs $727 on an A100 or $2,135 on 8xH100, and needs
1.29 epochs over the corpus. What should NOT happen is 80B tokens into `100m`:
$76 and 158 hours for a model that reached its efficient limit at 2.2B.

## Serving cost, because this is a product

| rung | weights (bf16) | fits | realistic serving |
| --- | --- | --- | --- |
| `100m` | 0.31 GB | anything, CPU included | free tier, high volume |
| `1b` | 2.6 GB | any 8 GB+ GPU | one small GPU per replica |
| `3b` | 8.3 GB | 16 GB+ GPU | one mid GPU per replica |
| `8b` | 20.5 GB | 24 GB+ GPU | one large GPU per replica |

For a product sold per seat or per call, `1b` is the sweet spot: good enough to
be worth money, cheap enough that a single GPU serves many customers. The MoE
design helps here — compute follows active params while quality follows total.

## What this does not change

`ROUTE_COEF` stays 0 at every rung. The routing-supervision result is about the
label distribution, not model size, and the labels do not improve with scale.
