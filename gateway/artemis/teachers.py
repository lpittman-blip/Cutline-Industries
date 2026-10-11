"""Synthetic chat SFT data from open-weight teachers Artemis is allowed to learn from.

WHY THIS EXISTS. Pretraining on permissively-licensed human code teaches Artemis
syntax and structure, and `selfplay` sharpens whatever it can already do. Neither
teaches it to hold a conversation: self-improvement amplifies a signal and cannot
create one, and code self-play produces no general chat education at all. That gap
is normally closed with supervised fine-tuning on high-quality conversations, and
the cheapest honest source of those at this scale is a stronger open-weight model
generating answers to human-written prompts.

WHY NOT A HOSTED API. Blueprint Decisions 5 and 12 keep external models out of
Artemis's own reasoning, and the provenance rule extends that to training data.
The amendment (2026-10-11) is narrow: a teacher is permitted only if its LICENCE
grants the right to train on its output. That is a property of the licence, not of
the vendor's reputation. Every major hosted provider forbids exactly this use --
xAI's terms prohibit "using the Service or any Output, to develop models or
services that compete with xAI", and Artemis is sold as a competing service. A
breach there would sit inside the asset being sold, so hosted providers stay out
regardless of how good the model is.

WHAT IS PERMITTED. Apache-2.0 and MIT grant unrestricted use of output, including
training. Weights run on our own hardware, so there is no terms-of-service layer
on top of the licence. Licences that carve out model training are refused by name
rather than silently omitted, so the error says why.

PROVENANCE. Every generated row records the teacher, its licence and the source of
the seed prompt. `sft.load_records` refuses any row that cannot name those, which
is what stops an unlabelled corpus from drifting in later.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from pathlib import Path

#: Teachers whose licence permits training on their output. Verified 2026-10-11
#: against the Hugging Face model API (`cardData.license`); re-check with
#: `python -m artemis.teachers --verify` before a run, because a model card can
#: be relicensed after release.
TEACHERS: dict[str, str] = {
    "Qwen/Qwen2.5-32B-Instruct": "apache-2.0",
    "Qwen/Qwen2.5-Coder-32B-Instruct": "apache-2.0",
    "mistralai/Mistral-Small-24B-Instruct-2501": "apache-2.0",
    "allenai/OLMo-2-1124-13B-Instruct": "apache-2.0",
}

#: Refused by name, with the reason, so a future reader does not "helpfully" add
#: one back. The first three are licence problems; the rest are terms-of-service
#: problems that no amount of local hardware fixes.
REFUSED: dict[str, str] = {
    "Qwen/Qwen2.5-72B-Instruct":
        "qwen licence, not Apache-2.0: adds a monthly-active-user threshold. "
        "The 32B sibling is Apache-2.0 and is the one to use.",
    "meta-llama/*":
        "the Llama community licence forbids using output to train non-Llama models.",
    "google/gemma-*":
        "the Gemma acceptable-use policy restricts competitive distillation.",
    "deepseek-ai/DeepSeek-R1":
        "MIT, so the licence permits it, but 671B does not fit 8x80GB. "
        "Use an MIT-licensed R1 distill if reasoning traces are wanted.",
    "grok|openai|anthropic|gemini|cohere":
        "hosted providers forbid training competing models on their output, and "
        "Artemis is sold as a competing service. Blueprint Decisions 5 and 12.",
}

#: Generated text that is not worth training on. A refusal or a bare apology
#: teaches Artemis to refuse; an empty answer teaches it nothing and produces a
#: row with no supervised tokens.
REFUSAL = re.compile(
    r"^\s*(i\s+(?:can(?:no|')t|am\s+unable|won'?t)|as\s+an\s+ai\b|i'?m\s+sorry[,.]?\s+(?:but|i))",
    re.I)

MIN_ANSWER_CHARS = 40
MAX_ANSWER_CHARS = 8000


class TeacherRefused(ValueError):
    """A teacher outside the allowlist was requested."""


def assert_permitted(model_id: str) -> str:
    """Return the teacher's licence, or raise with the reason it is refused.

    Called before anything is loaded or generated, so a disallowed teacher costs
    an error message rather than a GPU-hour and a tainted corpus.
    """
    if model_id in TEACHERS:
        return TEACHERS[model_id]
    low = model_id.lower()
    for pattern, reason in REFUSED.items():
        stem = pattern.split("*")[0].lower()
        if (pattern.endswith("*") and low.startswith(stem)) or pattern.lower() == low \
                or any(part and part in low for part in pattern.lower().split("|") if "/" not in part):
            raise TeacherRefused(f"{model_id} is not a permitted teacher: {reason}")
    raise TeacherRefused(
        f"{model_id} is not in the verified allowlist. Add it only after reading its "
        f"LICENCE and confirming it grants the right to train on model output. "
        f"Permitted today: {', '.join(sorted(TEACHERS))}")


def verify_licences(models: list[str] | None = None, timeout: float = 20.0) -> dict:
    """Re-check the allowlist against the Hugging Face model API.

    The hardcoded table is what the build trusts; this says whether it has gone
    stale. Network failure is reported as `unknown`, never silently as a pass.
    """
    import urllib.error
    import urllib.request

    out = {}
    for model_id in models or sorted(TEACHERS):
        expected = TEACHERS.get(model_id)
        try:
            req = urllib.request.Request(f"https://huggingface.co/api/models/{model_id}")
            with urllib.request.urlopen(req, timeout=timeout) as r:
                card = json.load(r).get("cardData", {}) or {}
            actual = card.get("license")
            out[model_id] = {"expected": expected, "actual": actual,
                             "ok": actual == expected,
                             "license_name": card.get("license_name") or ""}
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, KeyError) as e:
            out[model_id] = {"expected": expected, "actual": None, "ok": None,
                             "error": f"{type(e).__name__}: {e}"}
    return out


def load_seed_prompts(path: Path) -> list[dict]:
    """Read human-written seed prompts.

    Seeds must be human-written. Generating prompts with a model as well turns
    the corpus into a model talking to itself, which narrows the distribution
    instead of widening it -- the one failure mode synthetic data is known for.
    Each row needs `prompt` and `source`; `allowed_tools` is optional.
    """
    seeds, seen = [], set()
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        row = json.loads(line)
        prompt, source = row.get("prompt"), row.get("source")
        if not isinstance(prompt, str) or not prompt.strip():
            raise ValueError(f"{path}:{lineno} has no prompt")
        if not isinstance(source, str) or not source.strip():
            raise ValueError(f"{path}:{lineno} has no source; seeds must name where they came from")
        key = " ".join(prompt.lower().split())
        if key in seen:          # exact-duplicate seeds buy nothing and skew the mix
            continue
        seen.add(key)
        seeds.append({"prompt": prompt, "source": source,
                      "allowed_tools": row.get("allowed_tools", []),
                      "domain": row.get("domain")})
    if not seeds:
        raise ValueError(f"{path} contained no usable seed prompts")
    return seeds


def acceptable(answer: str) -> tuple[bool, str]:
    """Judge a generated answer on shape alone, before anything expensive."""
    text = (answer or "").strip()
    if len(text) < MIN_ANSWER_CHARS:
        return False, "too short"
    if len(text) > MAX_ANSWER_CHARS:
        return False, "too long"
    if REFUSAL.match(text):
        return False, "refusal"
    # A teacher that loops the same line is degenerate output, not an answer.
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if len(lines) > 6 and len(set(lines)) <= max(2, len(lines) // 8):
        return False, "repetitive"
    return True, ""


def build_row(seed: dict, answer: str, model_id: str, licence: str) -> dict:
    """One SFT record, carrying everything `sft` needs to accept it."""
    return {
        "messages": [{"role": "user", "content": seed["prompt"]},
                     {"role": "assistant", "content": answer.strip()}],
        "allowed_tools": seed.get("allowed_tools", []),
        "domain": seed.get("domain"),
        "synthetic": True,
        "teacher": model_id,
        "teacher_license": licence,
        "prompt_source": seed["source"],
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


def generate(seeds: list[dict], model_id: str, out_path: Path, *,
             max_new_tokens: int = 1024, temperature: float = 0.7,
             tensor_parallel: int = 1, batch_size: int = 64) -> dict:
    """Run one teacher over the seeds and append accepted rows to `out_path`.

    vLLM offline batching, because this is throughput-bound and the teachers run
    on the same 8xH100 box as training -- there is no API, no rate limit and no
    per-token bill. The import is lazy so the allowlist and the record format stay
    testable on a machine with neither vLLM nor a GPU.
    """
    licence = assert_permitted(model_id)
    from vllm import LLM, SamplingParams

    llm = LLM(model=model_id, tensor_parallel_size=tensor_parallel,
              trust_remote_code=False)
    sampling = SamplingParams(temperature=temperature, top_p=0.95,
                              max_tokens=max_new_tokens)
    stats = {"teacher": model_id, "license": licence, "seeds": len(seeds),
             "kept": 0, "rejected": {}}

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("a", encoding="utf-8") as sink:
        for start in range(0, len(seeds), batch_size):
            batch = seeds[start:start + batch_size]
            chats = [[{"role": "user", "content": s["prompt"]}] for s in batch]
            for seed, completion in zip(batch, llm.chat(chats, sampling)):
                answer = completion.outputs[0].text if completion.outputs else ""
                ok, why = acceptable(answer)
                if not ok:
                    stats["rejected"][why] = stats["rejected"].get(why, 0) + 1
                    continue
                sink.write(json.dumps(build_row(seed, answer, model_id, licence)) + "\n")
                stats["kept"] += 1
            print(f"  {model_id}: {stats['kept']} kept of {start + len(batch)}", flush=True)
    return stats


def dedupe(path: Path) -> dict:
    """Drop rows whose answer duplicates one already kept.

    An ensemble of teachers given the same seeds agrees often, and training on
    the same answer four times just reweights it. Keeps the first occurrence, so
    teacher order in the ensemble decides ties.
    """
    seen, kept, dropped = set(), [], 0
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        answer = row["messages"][-1]["content"]
        key = hashlib.sha256(" ".join(answer.lower().split()).encode()).hexdigest()
        if key in seen:
            dropped += 1
            continue
        seen.add(key)
        kept.append(row)
    path.write_text("".join(json.dumps(r) + "\n" for r in kept), encoding="utf-8")
    return {"kept": len(kept), "dropped": dropped}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--verify", action="store_true",
                    help="re-check the allowlist against Hugging Face and exit")
    ap.add_argument("--seeds", type=Path, help="JSONL of human-written seed prompts")
    ap.add_argument("--out", type=Path, help="JSONL to append generated rows to")
    ap.add_argument("--teachers", nargs="*", default=sorted(TEACHERS),
                    help="teacher model ids; every one must be in the allowlist")
    ap.add_argument("--max-new-tokens", type=int, default=1024)
    ap.add_argument("--temperature", type=float, default=0.7)
    ap.add_argument("--tensor-parallel", type=int, default=1)
    args = ap.parse_args(argv)

    if args.verify:
        report = verify_licences()
        for model_id, r in report.items():
            mark = {True: "ok", False: "CHANGED", None: "unknown"}[r["ok"]]
            print(f"{mark:8} {model_id}  expected={r['expected']} actual={r['actual']}")
        stale = [m for m, r in report.items() if r["ok"] is False]
        if stale:
            print(f"\nallowlist is stale for: {', '.join(stale)}", file=sys.stderr)
            return 1
        return 0

    if not args.seeds or not args.out:
        ap.error("--seeds and --out are required unless --verify is given")

    # Refuse every teacher up front: a bad id should not surface three hours into
    # an ensemble run with two teachers' output already on disk.
    licences = {m: assert_permitted(m) for m in args.teachers}
    seeds = load_seed_prompts(args.seeds)
    print(f"{len(seeds)} seed prompts, {len(licences)} teachers")

    summary = []
    for model_id in args.teachers:
        summary.append(generate(seeds, model_id, args.out,
                                max_new_tokens=args.max_new_tokens,
                                temperature=args.temperature,
                                tensor_parallel=args.tensor_parallel))
    merged = dedupe(args.out)
    print(json.dumps({"teachers": summary, "after_dedupe": merged}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
