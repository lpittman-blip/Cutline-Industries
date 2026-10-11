# Synthetic chat data: which teachers Artemis may learn from

Decided 2026-10-11. This amends the provenance rule — narrowly, and for one
stage only. Read it before adding a teacher or a corpus.

## The gap this fills

Pretraining on permissively-licensed human code teaches Artemis syntax and
structure. `selfplay` sharpens code it can already write. Neither produces a
model that answers a customer, and that is not a tuning problem:
self-improvement amplifies a signal and cannot create one, and code self-play
supplies no general chat education at all.

Closing it needs supervised fine-tuning on good conversations. At this scale the
cheapest honest source is a stronger open-weight model answering human-written
prompts.

## The amendment

**Before:** no model-generated text in any corpus.

**After:** no model-generated text in the *pretraining* corpus. For chat SFT, a
teacher is permitted only if its **licence grants the right to train on its
output**, and the weights run on our own hardware.

That is a property of the licence, not of the vendor. It is deliberately a
narrow opening, and the gate in `artemis.sft.check_provenance` is what keeps it
narrow.

## Why no hosted API, including Grok

Every major hosted provider forbids this use. xAI's consumer terms prohibit
*"using the Service or any Output, to develop models or services that compete
with xAI"*, and the September 2024 Enterprise terms went further — no using
Output to train your own models at all. Artemis is sold as a competing service.

The problem is not the rule in the abstract. It is that a breach would sit
inside the asset being sold, invisible once the weights exist, and surface during
diligence. No amount of local hardware fixes a terms-of-service clause, because
the clause attaches to the Output, not to where it was computed.

## Approved teachers

Verified 2026-10-11 against the Hugging Face model API (`cardData.license`).
Re-check with `python -m artemis.teachers --verify`, which exits non-zero if a
model card has been relicensed.

| model | licence | bf16 footprint |
| --- | --- | --- |
| `Qwen/Qwen2.5-32B-Instruct` | apache-2.0 | ~64 GB |
| `Qwen/Qwen2.5-Coder-32B-Instruct` | apache-2.0 | ~64 GB |
| `mistralai/Mistral-Small-24B-Instruct-2501` | apache-2.0 | ~48 GB |
| `allenai/OLMo-2-1124-13B-Instruct` | apache-2.0 | ~26 GB |

All four fit the 8×H100 box with room to spare, so the default is to run the
whole ensemble. Teachers disagree, and disagreement is where the signal is —
`dedupe` keeps the first of any duplicated answer, so teacher order breaks ties.

## Refused, and why

| | |
| --- | --- |
| `Qwen/Qwen2.5-72B-Instruct` | qwen licence, not Apache-2.0: adds a monthly-active-user threshold. The 32B sibling is Apache-2.0 — use that. |
| Llama 3.x | the community licence forbids using output to train non-Llama models. |
| Gemma | the acceptable-use policy restricts competitive distillation. |
| `deepseek-ai/DeepSeek-R1` | MIT, so the *licence* permits it, but 671B does not fit 8×80GB. An MIT-licensed R1 distill is the way in if reasoning traces are wanted. |
| Grok, GPT, Claude, Gemini, Cohere | hosted providers forbid training competing models on their output. |

These are refused **by name** in `teachers.REFUSED`, with the reason, and pinned
by a test. Silence is how one creeps back in.

## Seeds must be human-written

`artemis.teachers` will not invent prompts, and neither should anyone else. A
model writing the questions as well as the answers is a model talking to itself:
the distribution narrows instead of widening, which is the one well-documented
failure mode of synthetic data. Every seed carries a `source`, and
`sft.check_provenance` rejects a synthetic row whose `prompt_source` is empty.

Workable seed sources, in rough order of value:

1. Real product questions from the chat database, with consent recorded.
2. Hand-written sets covering the ten expert domains.
3. A human-authored licensed corpus. Stack Exchange's dump is human-written and
   CC-BY-SA — usable, but the share-alike term needs a decision before it goes
   near a sold model, so treat it as a question for counsel rather than a
   default.

## Does this still make Artemis your own model?

Yes. The architecture is ours, the weights are trained from random
initialization, and the pretraining corpus stays human-written. Post-training on
synthetic data from permissively-licensed teachers is ordinary practice and
transfers no ownership.

What *would* undermine the claim is pretraining on another model's output. That
remains prohibited, and `data.prepare` is not fed teacher output anywhere in the
pipeline.

## Running it

```bash
# allowlist vs the live model cards; non-zero exit if anything was relicensed
python -m artemis.teachers --verify

# generate from every approved teacher, then dedupe
python -m artemis.teachers --seeds "$WORK/sft/seeds.jsonl" \
  --out "$WORK/sft/records.jsonl" --tensor-parallel 2

# validate provenance without loading a model
python -m artemis.sft --check-only --checkpoint "$CKPT" \
  --tokenizer "$TOKENIZER" --records "$WORK/sft/records.jsonl" --out /tmp/x.pt

# or the whole stage
STAGE=sft bash scripts/train/stages.sh
STAGE=all bash scripts/train/stages.sh    # pretrain, then sft, then selfplay
```

Chat tuning runs **before** self-play. `selfplay` fine-tunes the same weights, so
tuning afterwards would partly overwrite what the loop earned.

## What is not established

- No teacher has been run. The ensemble, the throughput and the yield after
  filtering are all unmeasured — the GPU box is still blocked on the service
  account's write permission.
- No seed set exists yet. That is the genuine input still needed, and it cannot
  be generated.
- Whether SFT on this data improves measured chat quality. That is what the
  separate evaluation corpus is for, and it has not been built either.
