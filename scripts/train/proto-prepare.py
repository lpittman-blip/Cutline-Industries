#!/usr/bin/env python3
"""Tokenise a slice of the labelled code corpus at proto scale.

Run from gateway/:
    python3 ../scripts/train/proto-prepare.py <corpus.jsonl> <workdir> [target_tokens]

WHY A SLICE. artemis.data.prepare reads the whole JSONL with read_text() and
accumulates every token id in Python lists, so a full 525 MB corpus needs
several gigabytes of RAM for a run that consumes 6 M tokens. Taking every Nth
document keeps the label mix intact (the dataset is not ordered by domain)
while bringing the working set down to proto scale.

WHY A SEPARATE TOKENIZER. proto is vocab 4096, not the 32000 the GPU sizes use.
A 32000-vocab tokenizer on a 4096-embedding model would index out of range, so
the slice gets its own tokenizer and the manifest records its hash.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "gateway"))
from artemis.data import prepare                      # noqa: E402
from artemis.tokenizer import train_tokenizer         # noqa: E402

CHARS_PER_TOKEN = 3.0      # measured ~2.9 at vocab 4096 on this corpus
VOCAB = 4096


def main() -> None:
    src = Path(sys.argv[1])
    work = Path(sys.argv[2])
    target = int(sys.argv[3]) if len(sys.argv) > 3 else 10_000_000
    work.mkdir(parents=True, exist_ok=True)

    want_chars = int(target * CHARS_PER_TOKEN)
    total_chars = src.stat().st_size
    stride = max(1, total_chars // want_chars)
    print(f"corpus {total_chars/1e6:.0f} MB, want ~{want_chars/1e6:.0f} MB "
          f"for ~{target/1e6:.0f}M tokens -> every {stride}th document")

    # Stream: never hold the whole corpus. Count domains on the way through so
    # the slice's label mix can be compared against the full corpus's.
    slice_path = work / "corpus-slice.jsonl"
    kept = chars = 0
    domains: dict[str, int] = {}
    with src.open(encoding="utf-8") as fin, slice_path.open("w", encoding="utf-8") as fout:
        for i, line in enumerate(fin):
            if i % stride or not line.strip():
                continue
            rec = json.loads(line)
            fout.write(line)
            kept += 1
            chars += len(rec["text"])
            d = rec.get("domain") or "unlabelled"
            domains[d] = domains.get(d, 0) + 1
    print(f"slice: {kept:,} documents, {chars/1e6:.1f}M chars")
    for d, n in sorted(domains.items(), key=lambda kv: -kv[1]):
        print(f"  {d:<12} {n:>8,}  {100*n/kept:5.1f}%")

    flat = work / "corpus-slice.txt"
    with flat.open("w", encoding="utf-8") as f:
        for line in slice_path.open(encoding="utf-8"):
            if line.strip():
                f.write(json.loads(line)["text"].replace("\n", " ") + "\n")
    tok_path = work / "tokenizer.json"
    print("training tokenizer")
    train_tokenizer([str(flat)], VOCAB, str(tok_path))

    print("tokenising")
    m = prepare([{"path": str(slice_path),
                  "license": "permissive-only (filtered by artemis.code_corpus)",
                  "origin": "codeparrot/github-code-clean, human-written source"}],
                str(tok_path), str(work / "data"), val_fraction=0.01)
    print(f"train {m['train_tokens']:,} val {m['val_tokens']:,} "
          f"domain_labels={m['domain_labels']}")
    if not m["domain_labels"]:
        raise SystemExit("domain_labels false — the ablation would repeat the old result")
    for d, v in m["domain_tokens"].items():
        if v["train"]:
            print(f"  {d:<14} train {v['train']:>10,}  val {v['val']:>8,}")


if __name__ == "__main__":
    main()
