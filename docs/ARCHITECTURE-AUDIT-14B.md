# Artemis architecture audit and 14B proposal

Written against the repository as it stands at commit `a9c9354`, by reading the
code and re-running checks — not from the previous summary. Where an earlier
claim of mine was wrong or overstated, it is corrected here explicitly.

---

## 1. Evidence audit

### Files that matter

| concern | path | lines |
| --- | --- | --- |
| model / architecture | `gateway/artemis/model.py` | 316 |
| training loop | `gateway/artemis/train.py` | 242 |
| tokenise + split + dedup | `gateway/artemis/data.py` | 123 |
| corpus filter + domain labels | `gateway/artemis/code_corpus.py` | 252 |
| checkpoint format | `gateway/artemis/checkpoint.py` | 178 |
| expert/routing evaluation | `gateway/artemis/evaluate.py` | 150 |
| size configs | `gateway/configs/models.yaml` | — |
| routing evidence | `docs/MOE-ROUTING-ABLATION.md` | — |
| budget | `docs/PRETRAIN-BUDGET-80B.md` | — |

There is no single "architecture blueprint" file. The authoritative description
of the architecture is the `model.py` module docstring plus `models.yaml`;
`docs/CUTLINE-BLUEPRINT.md` is a business document, not an architecture spec.

### Measured, extrapolated, untested

**Directly measured** on the ~100M CPU run (shard 00000, vocab 32000, seq 2048):

- 126,925 rows → 55,728 kept (43.9%); 35.6% rejected on licence.
- 241,146,886 characters kept.
- **70,702,756 tokens** from that one shard through Artemis's own tokenizer.
- Loss 9.52 → 8.74, val 8.68 → 8.17, from a random-init baseline of
  ln(32000) = 10.37.
- Checkpoint 1.84 GB, format v2, arch `artemis-prime-moe`, optimizer + RNG
  present. **Resume continued at step 7, not step 1.**
- Token dtype **uint16**, domain-label dtype **uint8** — inferred from file
  sizes (141,097,500 B / 70,548,750 B for the same token count), not assumed.

**Extrapolated, and labelled as such from here on:**

- "62.2B unique corpus tokens" = 880 × 70,702,756. **This was one shard
  multiplied by the shard count.** SINCE SUPERSEDED: four shards have now been
  measured (00000/00200/00500/00800), giving a mean of 71,995,701 tokens with a
  1.25% standard deviation and a corrected projection of **63.36B (band
  61.77–64.94B)**. The original figure was low by 1.8%. Cross-shard exact
  duplication measured 0 in 170,528 documents, so duplicates do not erode the
  ceiling; near-duplicates remain unmeasured. Still a projection from 4 of 880
  shards, but now a bounded one.
- Every tokens/second, hour and dollar figure anywhere in this repo.

**Untested, on GPU or at scale:**

- Any GPU execution whatsoever. No GPU has ever run this code.
- Measured MFU, tokens/second, or multi-GPU scaling efficiency.
- bf16 numerics (the CPU run was fp32; `--amp-dtype` autocast never engaged).
- FSDP/ZeRO sharding, which 14B requires. IMPLEMENTED since this audit (`--shard fsdp`), but validated only on CPU with gloo — see the note below.
- Anything at 1B parameters or above.

**What the dry run proves:** the pipeline executes end to end on real data and
the loss moves in the right direction over nine steps. **What it does not
prove:** general capability, convergence behaviour, or readiness at any larger
scale. Nine steps is a smoke test.

---

## 2. The architecture, resolved

### It is additive MoE on a dense backbone — not a replacement MoE

`Block.forward` (`model.py`):

```python
x = x + self.attn(self.n1(x), cos, sin)
h = self.n2(x)
if self.moe is None:
    return x + self.ffn(h), None
routed, balance, z, supervised, stats = self.moe(h, domains)
return x + self.ffn(h) + routed, (balance, z, supervised, stats)
```

At an MoE layer the token passes through **both** the dense feed-forward and
the top-2 experts; the expert output is *added* to the residual stream.
Mixtral and Switch Transformer *replace* the FFN with the expert mixture. This
difference drives everything below.

**Consequence, measured on the `8b` config shape at d=4096/L=48:**

| component | params | always active? |
| --- | --- | --- |
| embedding (tied with head) | 0.13B | yes |
| attention | 2.01B | yes |
| dense FFN, every layer | 8.46B | **yes** |
| experts (10 × 24 layers) | 3.02B | only 2/10 → 0.60B |

Experts are 22.2% of parameters, so the sparsity knob barely moves: **82.3%
active**. The MoE adds capacity; it does not save compute.

### The Prime Core is a trained neural component, not an orchestrator

The Prime Core is the whole decoder-only transformer: tied embedding/head,
grouped-query attention with RoPE, RMSNorm, and a dense SwiGLU FFN in **every**
layer. It is trained by the next-token loss like any transformer. It is not a
router and not an external agent role. `orchestrator.py` and `brains.py` are
product-layer agent code and contain **no** neural weights — they must not be
counted as experts.

### The ten specialists are real trainable modules

`ExpertMixture` holds `nn.ModuleList` of ten SwiGLU `FeedForward` modules plus a
`nn.Linear` router. Per token: router logits → softmax → top-2 → weights
renormalised to sum to 1 → selected experts run → weighted sum added back.

**Gradient flow.** Experts receive gradient only through tokens routed to them
(`index_add_` on selected rows), so an expert with no traffic gets a zero
gradient that step — visible in the dry run's `router_expert_grad_norms`, where
`intent`, `architecture`, `planning`, `memory`, `security`, `observability` and
`cost` all read `0.0`. The router receives gradient from the LM loss through
`top_w`, plus the balance and z losses, plus supervision when enabled.

**Shared weights.** `head.weight is embed.weight` — verified `True`. Nothing
else is shared; each expert and each layer is independent.

### Exact counts for the current `100m` rung

Formula verified against a real instantiation: `param_count()` and the sum over
`nn.Parameter` agree **exactly** (delta 0), tied head counted once.

| | |
| --- | --- |
| total = trainable | 153,222,912 (153.2M) |
| active per token | 110,768,640 (110.8M) |
| layers / d_model / heads / kv | 12 / 768 / 12 / 4 |
| vocab / context | 32,000 / 2,048 |
| experts | 10, top-2, at 6 of 12 layers |

### Proposed 14B configuration

```yaml
14b: {vocab_size: 32000, d_model: 3584, n_layers: 34, n_heads: 28, n_kv_heads: 8,
      ffn_mult: 2.0, max_seq_len: 8192, moe_every: 2, expert_ffn_mult: 1.5}
```

| | |
| --- | --- |
| **total parameters** | **13,685,059,584 (13.69B)** |
| **active per token** | **5,823,815,680 (5.82B)** |
| active fraction | 42.6% |
| head_dim | 128 (3584 / 28) |
| MoE layers | 17 of 34 |
| expert inner dim | 5,376 |

The deliberate change is `expert_ffn_mult` 0.25 → 1.5 with `ffn_mult` 3.5 → 2.0:
it moves capacity out of the always-on dense FFN and into the sparse experts,
taking the active fraction from 82% to 43%. That is what makes it an MoE rather
than a dense model with ornaments — and it preserves exactly ten named experts.

**Tradeoff against a dense baseline.** A dense model matched on *active* params
is ~5.8B and will cost the same per token. The 14B MoE has 2.35× the capacity
for that price. The bet is that the extra capacity converts into quality; it is
a bet, and the proto ablation is the only in-repo evidence for it (MoE beat a
matched dense baseline by 0.046 val loss *when routing was unsupervised*). That
result is at 8.2M parameters and does not automatically carry to 14B.

**Existing weights cannot be reused.** 100m is d=768/L=12; 14b is d=3584/L=34.
Every tensor changes shape, and `checkpoint.read` rejects a config mismatch
outright. 14B requires fresh initialisation. The 100m checkpoint remains useful
as a pipeline artifact and a baseline to beat — not as a starting point.

---

## 3. Routing and specialisation

### Correction: what `route_coef=0` actually disables

I previously wrote that an absent `route_loss` "confirms the production setting
behaves correctly". That was imprecise. Measured directly:

| at `route_coef=0` | status |
| --- | --- |
| router linear + softmax + top-2 dispatch | **still runs** — full cost |
| `balance_coef * balance` (0.01) | **still in the loss** |
| `router_z_coef * z` (0.001) | **still in the loss** |
| supervision term added to loss | disabled — this is the *only* thing off |
| supervision term **computed** | **was still computed and discarded** |

That last row was a real defect: `ExpertMixture.forward` built an `F.nll_loss`
once per MoE layer per step and threw it away. Measured 3 calls per forward on
a 3-MoE-layer model.

**Fixed** in `model.py`: `ArtemisLM.forward` now passes `domains=None` down when
`route_coef` is zero. `domains` has no other use inside `ExpertMixture`, so the
skip is exact. Verified: 3 → 0 calls at `route_coef=0`, still 3 with
`route_loss` logged at 0.1, balance and z unaffected. Regression test added
(`tests/test_neural_core.py`).

### Still unverified about routing

The ablation numbers in `docs/MOE-ROUTING-ABLATION.md` were produced earlier in
this project and I have **not** re-run them. "8.03 effective experts, 0 dead"
needs its definition restated and re-measured before it is quoted again:
`evaluate.py` is 150 lines and defines these metrics; it has not been exercised
against the 100m checkpoint. Not yet tracked at all: **token dropping**
(no capacity factor exists in this implementation — every token is routed, so
drop rate is structurally zero, which is itself worth stating), routing
stability across steps, and specialisation measured on held-out tasks rather
than on training-set load.

### Dead domains — do not manufacture labels

`intent`, `architecture` and `planning` have zero tokens because
`CODE_LANGUAGES` admits twenty executable languages and **no Markdown**, so
ADRs, RFCs and design docs are rejected at the language gate before
`classify()` runs. Pattern-matching source code for "planning" would fabricate
labels, which is precisely the failure the ablation measured. Legitimate
sources — Markdown ADRs/RFCs/design docs with path-based signals, and the
stage-`sft` conversation corpus — must each be **tested as an ingestion change
with a measured before/after**, not adopted on argument.

---

## 4. Data accounting — corrections

**"62.2B unique tokens" is a single-shard extrapolation and must stop being
quoted as a measurement.** It is 880 × 70,702,756 from shard 00000 alone.

**Deduplication is call-scoped, not globally guaranteed.** `prepare()` builds
`seen = set()` at entry and dedups across every source in *that call*. One call
over the whole corpus is global; **a streaming design that calls `prepare()`
per shard makes dedup shard-local and silently admits cross-shard duplicates.**
This is a trap the 80B streaming pipeline must avoid by design.

**Exact SHA-256 dedup does not remove near-duplicates** — vendored libraries,
forks and generated files differing by one line all survive. Near-duplicate
detection (MinHash/SimHash) is absent.

**Split contamination is unaudited.** `prepare()` assigns val by document hash,
which is deterministic and domain-balanced, but hashing is per-document: two
near-identical files from forked repositories can land on opposite sides of the
split. No benchmark-contamination audit exists.

**Required before the 80B claim means anything:** measure tokens across a
representative sample of shards (not one), aggregate real counts, define
"unique" explicitly, and report retained-after-filter, unique, exposures,
repetitions and epochs as separate numbers.

**Is 80B adequate for 14B?** Chinchilla-optimal for 5.82B *active* is ~116B
tokens, so 80B is **0.69× optimal — under-trained**, the opposite of the 100m
case. Treat 80B as an initial budget and extend based on measured learning
curves, not as a target.

---

## 5. Hardware, storage, time, cost — recomputed for 14B

**The A100/H100/T4 table in `PRETRAIN-BUDGET-80B.md` describes the 100M model
and must not be reused for 14B.** Recomputed: 6 × 5.82B active × 80B tokens =
**2.796e21 FLOPs**, ~53× the 100m figure.

| cluster | @35% MFU | @25% | @15% |
| --- | --- | --- | --- |
| 1× H100 | 2,241 h | 3,138 h | 5,229 h |
| 8× A100 | 1,046 h | 1,464 h | 2,440 h |
| **8× H100** | **330 h** | **461 h** | **769 h** |
| 16× H100 | 180 h | 251 h | 419 h |

Assumes 0.85 scaling at 8 GPUs, 0.78 at 16. MoE all-to-all is worse than dense.
**All of this is arithmetic, not measurement.** At 8×H100 and 25% MFU — the
realistic planning figure — that is **~19 days and roughly $8k–17k** depending
on provider. Single-GPU is infeasible: 131 days on one H100.

**Memory. 28 GB of bf16 weights is not the requirement.**

| | |
| --- | --- |
| bf16 weights | 27.4 GB |
| bf16 gradients | 27.4 GB |
| fp32 master | 54.7 GB |
| Adam m, v (fp32) | 109.5 GB |
| **state total** | **219.0 GB** |
| sharded across 8 GPUs | 27.4 GB/GPU of 80 GB |
| activations (seq 8192, mb 1, recompute) | ~8 GB |

14B does not fit on one 80 GB card. FSDP or ZeRO-3 is **required**.

**Status update (after this audit).** `train.py` now takes `--shard fsdp` and
shards parameters, gradients and optimizer state. Four tests run it as two real
processes, and the decisive one loads the resulting checkpoint into an ordinary
unsharded `ArtemisLM` — the failure mode for sharded training is not a crash
but a checkpoint nothing can read back.

Implementing it exposed four bugs that DDP had been hiding, one of which was
never about sharding at all: `ExpertMixture` only *called* an expert when some
token selected it, so unselected experts received **no gradient**. DDP tolerated
that via `find_unused_parameters`; under FSDP it makes two ranks issue different
collectives and the job dies intermittently, data-dependently. Experts are now
always called.

**This is not proof.** The tests run on CPU over gloo, which exercises the
sharding logic, the gradient sync and the state-dict gathering — but not NCCL,
not CUDA kernels, and not memory behaviour at 13.7B parameters. Memory is the
whole reason FSDP is needed, and it is the one property these tests cannot
check. Budget time for the first real multi-GPU run to find things.

**Disk, from measured dtypes (uint16 / uint8):** 160 GB `train.bin` + 80 GB
`train.dom` = **240 GB** for 80B tokens, plus raw-shard and prep peaks, plus
**164 GB per checkpoint** (fp32 weights + two Adam moments). Keeping three
checkpoints is 493 GB. A training box needs **≥1 TB**, not the 150 GB the
preflight asks for.

---

## 6. Evidence-based plan

**Order matters: prove cheap things first.**

| # | experiment | cost | answers |
| --- | --- | --- | --- |
| 1 | `100m` at its own 2.2B budget, one GPU | ~$2 | does any of this converge on real hardware? |
| 2 | re-run the routing ablation at `100m` | ~$8 | does the proto routing result survive 19× scale? |
| 3 | additive vs replacement MoE at `100m`, matched active | ~$4 | is the additive design the right one before 14B? |
| 4 | expert_ffn_mult sweep at `100m` | ~$8 | does 43% active beat 82% at matched compute? |
| 5 | Markdown/ADR ingestion, before/after | ~$4 | do the three dead domains get real signal? |
| 6 | `1b` at 21B tokens | ~$192 | first genuinely useful checkpoint |
| 7 | `14b` | $8k–17k | only after 1–6 |

Experiments 1–5 cost under $30 combined and would settle the architecture
questions this document can only reason about.

**Evaluation must separate the model from the system.** The core checkpoint and
the retrieval/tool/agent stack are different artifacts with different failure
modes; a win from tool use is not a win for the weights. Build fresh held-out
suites for: repository repairs verified by tests; infrastructure tasks verified
in isolated environments; reasoning with checked answers; multi-step completion
and human-intervention rate; fabricated claims and false completion reports;
and cost and latency per *successful* task.

**On comparisons.** Pin exact competitor versions, give equivalent tools, task
budgets and time limits, report variance across repeated runs, and report
failures. A parameter count is not evidence of superiority and neither is one
benchmark. Superiority is a hypothesis to be tested per task family, and should
be stated as "better on X under conditions Y", never as a property of the model.

---

## 7. Status

**Changed in this pass:** `gateway/artemis/model.py` (skip discarded
supervision), `gateway/artemis/tests/test_neural_core.py` (regression test).
345 tests pass.

**Corrected claims:** the 62.2B unique-token figure is an extrapolation;
`route_coef=0` does not disable routing or the balance/z losses; the
A100/H100/T4 cost table applies to 100M only.

**Blockers:** no GPU credential of any kind. FSDP/ZeRO now present in `train.py`
but unproven on GPUs,
required for 14B. Streaming shard preparation not yet implemented. Near-duplicate
detection and contamination audit absent.

**Next executable step, no GPU needed:** implement bounded streaming shard
preparation with a *global* dedup ledger that survives per-shard calls, and
measure real token counts across a sample of shards to replace the
single-shard extrapolation.
