"""Supervised chat tuning of Artemis's own weights, with provenance enforced at the door.

Pretraining teaches syntax; `selfplay` sharpens code Artemis can already write.
Neither produces a model that answers a customer. This stage does, by training on
conversations whose every row can say where it came from.

TWO ADMISSIBLE PROVENANCES, and nothing else:

  human     a real conversation, with `consent: true` and a recorded `license`.
  synthetic a teacher's answer to a human-written prompt, where the teacher is in
            `teachers.TEACHERS` -- an Apache-2.0 or MIT model whose licence grants
            the right to train on its output, run on our own hardware so no
            terms-of-service layer sits on top.

A row that cannot name one of those is a hard error, not a warning. The point of
the gate is that it holds months from now, when someone with a deadline has a
convenient JSONL of unknown origin: an unlabelled corpus is indistinguishable from
a hosted model's output, and Artemis is sold.

The training objective matches `selfplay.ArtemisPlayer.train` exactly -- answer
capacity reserved before truncation, labels shifted once because ArtemisLM applies
cross_entropy with no internal shift, prompt positions masked, and the result
checked AFTER the shift rather than before. Those four details are each a way to
produce rows that train on nothing while reporting a loss.
"""
from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

from .teachers import TEACHERS

#: Tools an SFT example may reference. Must match what `tools.Toolbox` exposes,
#: or the model learns to call something that does not exist.
KNOWN_TOOLS = frozenset({"web_search", "web_fetch", "run_python"})

MAX_RECORDS = 200_000


class ProvenanceError(ValueError):
    """A record could not say where it came from."""


def check_provenance(record: dict, where: str) -> str:
    """Return "human" or "synthetic", or raise saying what is missing."""
    if record.get("synthetic") is True:
        teacher = record.get("teacher")
        licence = record.get("teacher_license")
        if teacher not in TEACHERS:
            raise ProvenanceError(
                f"{where}: synthetic row names teacher {teacher!r}, which is not an "
                f"approved open-weight teacher. Approved: {', '.join(sorted(TEACHERS))}")
        if licence != TEACHERS[teacher]:
            raise ProvenanceError(
                f"{where}: teacher {teacher} is licensed {TEACHERS[teacher]!r} but the "
                f"row claims {licence!r}; regenerate rather than edit the label")
        if not record.get("prompt_source"):
            raise ProvenanceError(
                f"{where}: synthetic row has no prompt_source. Seed prompts must be "
                f"human-written and say where they came from")
        return "synthetic"
    if record.get("consent") is True and record.get("license"):
        return "human"
    raise ProvenanceError(
        f"{where}: row is neither a consented human conversation (consent + license) "
        f"nor a synthetic row from an approved teacher (synthetic + teacher + "
        f"teacher_license + prompt_source)")


def load_records(path: Path, limit: int = MAX_RECORDS) -> tuple[list[dict], dict]:
    """Read and validate an SFT corpus. Every row is checked; none are skipped."""
    records, counts = [], {"human": 0, "synthetic": 0}
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        where = f"{path}:{lineno}"
        record = json.loads(line)
        counts[check_provenance(record, where)] += 1

        messages = record.get("messages")
        if not isinstance(messages, list) or len(messages) < 2:
            raise ValueError(f"{where}: needs at least a user turn and an assistant turn")
        for m in messages:
            if m.get("role") not in {"user", "assistant"} or not isinstance(m.get("content"), str):
                raise ValueError(
                    f"{where}: roles must be user/assistant with string content. Encode "
                    f"tool results as user content using the product's result_block contract")
        if messages[-1]["role"] != "assistant":
            raise ValueError(f"{where}: the last turn must be the assistant's, or nothing is supervised")
        unknown = set(record.get("allowed_tools") or []) - KNOWN_TOOLS
        if unknown:
            raise ValueError(f"{where}: unknown tool(s) {sorted(unknown)}")

        records.append(record)
        if len(records) > limit:
            raise ValueError(f"{path}: more than {limit} records; split the corpus")
    if not records:
        raise ValueError(f"{path}: no usable records")
    return records, counts


def supervised_rows(player, record: dict, system_prompt: str,
                    max_len: int, min_prompt_tokens: int = 64) -> list[tuple[list, list]]:
    """Turn one conversation into training rows, one per assistant turn.

    Each assistant turn is supervised against the conversation that precedes it,
    so a four-turn chat teaches four things rather than one.
    """
    from .tools import Toolbox

    # Render tool instructions through the product's own code. A second copy here
    # would drift from what inference actually sends, and the model would be tuned
    # on a prompt it never sees again.
    allowed = record.get("allowed_tools") or []
    context = [{"role": "system", "content": system_prompt + Toolbox().instructions(allowed)}]
    rows = []
    for message in record["messages"]:
        if message["role"] != "assistant":
            context.append(message)
            continue

        p_ids = player.tok.encode(player.format_chat(context) + "<|assistant|>").ids
        t_ids = player.tok.encode(message["content"]).ids + player.stop[:1]

        # Reserve room for the answer BEFORE truncating. Keeping the first
        # max_len tokens of prompt+answer silently yields rows that are all
        # prompt: every label masked, nothing supervised, loss over an empty set.
        keep_target = min(len(t_ids), max(1, max_len - min_prompt_tokens))
        t_ids = t_ids[:keep_target]
        room = max_len - len(t_ids)
        if room >= 1:
            p_ids = p_ids[-room:]           # keep the tail: the latest turn matters most
            ids = p_ids + t_ids
            if len(ids) >= 2:
                xs = ids[:-1]
                ys = [t if i + 1 >= len(p_ids) else -100 for i, t in enumerate(ids[1:])]
                if not all(y == -100 for y in ys):   # verified after the shift
                    rows.append((xs, ys))
        context.append(message)
    return rows


def tune(checkpoint: str, tokenizer: str, records_path: Path, out_path: Path,
         system_prompt: str, *, epochs: int = 2, lr: float = 2e-5,
         max_len: int = 768, seed: int = 0) -> dict:
    """Fine-tune Artemis's own weights on a validated chat corpus."""
    if epochs < 1 or not (lr > 0):
        raise ValueError("epochs must be >= 1 and lr must be positive")
    if Path(out_path).exists():
        raise ValueError(f"{out_path} exists; refusing to overwrite a checkpoint")

    from .selfplay import ArtemisPlayer

    records, counts = load_records(Path(records_path))
    player = ArtemisPlayer(checkpoint, tokenizer)
    torch = player.torch

    rows, dropped = [], 0
    for record in records:
        made = supervised_rows(player, record, system_prompt, max_len)
        if not made:
            dropped += 1
        rows.extend(made)
    if not rows:
        raise ValueError("no record produced a supervised row; check max_len against the corpus")

    params = [p for p in player.model.parameters() if p.requires_grad]
    opt = torch.optim.AdamW(params, lr=lr, weight_decay=0.0)
    player.model.train()
    rng = random.Random(seed)
    steps, last, nonfinite = 0, float("nan"), 0
    for _ in range(epochs):
        rng.shuffle(rows)
        for xs, ys in rows:
            _logits, loss = player.model(torch.tensor([xs], device=player.device),
                                         torch.tensor([ys], device=player.device))
            # A non-finite loss poisons every weight the moment it is stepped,
            # and the damage is invisible afterwards.
            if not torch.isfinite(loss):
                opt.zero_grad(set_to_none=True)
                nonfinite += 1
                continue
            loss.backward()
            gnorm = torch.nn.utils.clip_grad_norm_(params, 1.0)
            if not torch.isfinite(gnorm):
                opt.zero_grad(set_to_none=True)
                nonfinite += 1
                continue
            opt.step()
            opt.zero_grad(set_to_none=True)
            steps, last = steps + 1, float(loss.detach())
    player.model.eval()
    player.save(Path(out_path))

    report = {"checkpoint": str(out_path), "base": checkpoint,
              "records": len(records), "provenance": counts,
              "rows": len(rows), "records_without_rows": dropped,
              "epochs": epochs, "lr": lr, "max_len": max_len,
              "steps": steps, "final_loss": round(last, 4), "nonfinite": nonfinite}
    Path(out_path).with_suffix(".sft.json").write_text(
        json.dumps(report, indent=2), encoding="utf-8")
    return report


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--checkpoint", required=True, help="stage-1 checkpoint to tune")
    ap.add_argument("--tokenizer", required=True)
    ap.add_argument("--records", required=True, type=Path, help="validated SFT JSONL")
    ap.add_argument("--out", required=True, type=Path, help="checkpoint to write")
    ap.add_argument("--system", default="", help="base system prompt used at inference")
    ap.add_argument("--epochs", type=int, default=2)
    ap.add_argument("--lr", type=float, default=2e-5)
    ap.add_argument("--max-len", type=int, default=768)
    ap.add_argument("--check-only", action="store_true",
                    help="validate provenance and exit without loading the model")
    args = ap.parse_args(argv)

    if args.check_only:
        _records, counts = load_records(args.records)
        print(json.dumps(counts, indent=2))
        return 0
    print(json.dumps(tune(args.checkpoint, args.tokenizer, args.records, args.out,
                          args.system, epochs=args.epochs, lr=args.lr,
                          max_len=args.max_len), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
