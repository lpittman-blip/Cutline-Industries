"""Download, filter, tokenise and delete one shard at a time.

`stream_prepare` provides the primitives that make an 80B-token corpus possible
in bounded RAM. This is the driver that makes it possible in bounded *disk* and
bounded *patience*: the loop that fetches shard i, consumes it, deletes it, and
records that it is done before fetching shard i+1.

Without this, preparing 880 shards means either holding ~15 GB of parquet and
~11 GB of filtered JSONL at once, or calling `data.prepare` per shard -- which
truncates the output and resets the dedup set, silently producing a corpus that
is both shorter than reported and full of cross-shard duplicates.

Three properties are the whole point:

  * **Peak disk is one shard.** Parquet and filtered JSONL are removed as soon
    as their tokens are in the bins. Only the bins, the ledger and the state
    file grow.
  * **Resume is exact and append-safe.** `ShardWriter` appends, so re-consuming
    a shard would double-count its tokens. State records which shard indices
    are complete, and a completed shard is skipped. A shard interrupted
    *midway* is the harder case: its tokens are already in the bins but its
    documents never reached the saved ledger, so simply redoing it would append
    them twice. Committed token counts imply exact byte offsets -- uint16 ids
    and uint8 labels -- so the bins are truncated back to the last committed
    shard boundary before anything is appended.
  * **The manifest totals come from the state file, not the process.** A run
    resumed three times still reports the true cumulative token count, because
    per-shard stats are persisted as each shard finishes.

The tokenizer must exist before any shard is tokenised, and it cannot be
trained on data that has not been downloaded yet. So the first
`--tokenizer-shards` shards are fetched and filtered, the tokenizer is trained
on their text, and only then does tokenisation begin -- including of those
first shards, which are kept on disk until that point.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import numpy as np

from .code_corpus import build
from .stream_prepare import Ledger, ShardWriter, stream_shard, write_manifest

LICENCE = "permissive-only (filtered by artemis.code_corpus)"
ORIGIN = "codeparrot/github-code-clean, human-written source"


class State:
    """Which shards are done, and what they contributed. Survives a restart."""

    def __init__(self, path: Path, shards: dict[str, dict]):
        self.path, self.shards = path, shards

    @classmethod
    def load(cls, path: str | Path) -> "State":
        p = Path(path)
        if p.exists():
            return cls(p, json.loads(p.read_text())["shards"])
        return cls(p, {})

    def done(self, index: int) -> bool:
        return str(index) in self.shards

    def record(self, index: int, stats: dict) -> None:
        self.shards[str(index)] = stats
        # Atomic: a crash mid-write must not leave a state file claiming a shard
        # is done when its tokens are only half appended. Worst case the old
        # state survives and the shard is redone, which `rollback` makes safe.
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"shards": self.shards}, indent=2))
        os.replace(tmp, self.path)

    def ordered(self) -> list[dict]:
        return [self.shards[k] for k in sorted(self.shards, key=int)]

    def tokens(self) -> int:
        return sum(s["train_tokens"] + s["val_tokens"] for s in self.ordered())

    def committed(self, split: str) -> int:
        return sum(s[f"{split}_tokens"] for s in self.ordered())


def rollback(data: Path, state: State) -> None:
    """Truncate the bins to the last committed shard boundary.

    The state file records how many train and val tokens are COMMITTED. Each
    token is one uint16 in `<split>.bin` and one uint8 in `<split>.dom`, so the
    committed count fixes the exact correct length of all four files. Anything
    past it was appended by a shard that never finished, and must go before the
    next append or the corpus silently gains duplicated spans.
    """
    for split in ("train", "val"):
        n = state.committed(split)
        for kind, width in (("bin", 2), ("dom", 1)):
            f = data / f"{split}.{kind}"
            if not f.exists():
                continue
            want, have = n * width, f.stat().st_size
            if have > want:
                with open(f, "r+b") as fh:
                    fh.truncate(want)
                print(f"  rolled back {f.name}: {have-want} byte(s) from an "
                      f"interrupted shard", flush=True)
            elif have < want:
                raise SystemExit(
                    f"{f} is {have} bytes but state claims {want}. The bins and "
                    f"the state file disagree; refusing to append to a corpus "
                    f"whose contents cannot be accounted for.")


def domain_tokens_from_disk(data: Path) -> dict[str, dict[str, int]]:
    """Count tokens per domain by reading the label streams.

    The writer's own counters only cover what THIS process appended, so a
    resumed run would under-report. These numbers come from the bytes on disk,
    which is the corpus that training will actually read.
    """
    from .stream_prepare import EXPERT_NAMES, UNLABELED
    out = {d: {"train": 0, "val": 0} for d in EXPERT_NAMES}
    for split in ("train", "val"):
        f = data / f"{split}.dom"
        if not f.exists():
            continue
        with open(f, "rb") as fh:                      # chunked: never the whole
            while True:                                # label stream in RAM
                buf = np.fromfile(fh, dtype=np.uint8, count=1 << 24)
                if buf.size == 0:
                    break
                for label, n in enumerate(np.bincount(buf, minlength=256)):
                    if n and label != UNLABELED and label < len(EXPERT_NAMES):
                        out[EXPERT_NAMES[label]][split] += int(n)
    return out


def _fetch(repo: str, index: int, total: int, raw: Path) -> Path:
    from huggingface_hub import hf_hub_download
    name = f"data/train-{index:05d}-of-{total:05d}.parquet"
    return Path(hf_hub_download(repo, name, repo_type="dataset", local_dir=str(raw)))


def _filter(parquet: Path, out: Path) -> int:
    build([str(parquet)], out)
    parquet.unlink(missing_ok=True)
    return out.stat().st_size


def _train_tokenizer(jsonls: list[Path], vocab: int, out: Path, work: Path) -> None:
    from .tokenizer import train_tokenizer
    flat = work / "tokenizer-input.txt"
    n = 0
    with flat.open("w", encoding="utf-8") as f:
        for j in jsonls:
            with j.open(encoding="utf-8") as fh:
                for line in fh:
                    if line.strip():
                        f.write(json.loads(line)["text"].replace("\n", " ") + "\n")
                        n += 1
    print(f"  tokenizer input: {n:,} documents, {flat.stat().st_size/1e9:.2f} GB", flush=True)
    train_tokenizer([str(flat)], vocab, str(out))
    flat.unlink(missing_ok=True)


def main(argv=None) -> dict:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--work", required=True, help="directory for bins, ledger and state")
    ap.add_argument("--shards", type=int, required=True, help="how many shards to consume")
    ap.add_argument("--dataset", default="codeparrot/github-code-clean")
    ap.add_argument("--shards-total", type=int, default=880, help="shards in the dataset's filenames")
    ap.add_argument("--vocab", type=int, default=32000)
    ap.add_argument("--tokenizer-shards", type=int, default=2,
                    help="shards whose text trains the tokenizer before tokenising starts")
    ap.add_argument("--target-tokens", type=int, default=0,
                    help="stop once this many tokens are written (0 = consume every shard)")
    ap.add_argument("--val-fraction", type=float, default=0.002)
    args = ap.parse_args(argv)

    work = Path(args.work)
    raw, jsonl_dir, data = work / "raw", work / "filtered", work / "data"
    for d in (raw, jsonl_dir, data):
        d.mkdir(parents=True, exist_ok=True)
    tokenizer = work / "tokenizer.json"
    state = State.load(work / "prep-state.json")
    ledger = Ledger.load(work / "ledger.u64")
    rollback(data, state)          # BEFORE the writer opens its append handles
    writer = ShardWriter(data, np.uint16)

    if state.shards:
        print(f"resuming: {len(state.shards)} shard(s) already done, "
              f"{state.tokens():,} tokens on disk", flush=True)

    # Phase 1 -- the tokenizer, which everything downstream depends on.
    held: list[Path] = []
    if not tokenizer.exists():
        for i in range(args.tokenizer_shards):
            j = jsonl_dir / f"{i:05d}.jsonl"
            if not j.exists():
                print(f"[tok] shard {i}: downloading", flush=True)
                size = _filter(_fetch(args.dataset, i, args.shards_total, raw), j)
                print(f"[tok] shard {i}: filtered to {size/1e6:.0f} MB", flush=True)
            held.append(j)
        _train_tokenizer(held, args.vocab, tokenizer, work)
    print(f"tokenizer: {tokenizer}", flush=True)

    # Phase 2 -- tokenise, shard by shard, deleting as we go.
    for i in range(args.shards):
        if state.done(i):
            continue
        if args.target_tokens and state.tokens() >= args.target_tokens:
            print(f"target {args.target_tokens:,} tokens reached at shard {i}", flush=True)
            break
        j = jsonl_dir / f"{i:05d}.jsonl"
        if not j.exists():
            _filter(_fetch(args.dataset, i, args.shards_total, raw), j)
        st = stream_shard(j, tokenizer, writer, ledger, args.val_fraction)
        j.unlink(missing_ok=True)          # bounded disk: gone before the next
        ledger.save()                      # before state: a saved state must
        state.record(i, st)                # never outrun the dedup ledger
        print(f"shard {i}: {st['docs']:,} docs, {st['duplicates']:,} dup, "
              f"{st['train_tokens']+st['val_tokens']:,} tokens; "
              f"cumulative {state.tokens():,}", flush=True)

    writer.close()
    # Totals come from the state file so a resumed run reports the real corpus,
    # not just what this process happened to append.
    m = write_manifest(data, tokenizer, writer, state.ordered(), LICENCE, ORIGIN)
    m["train_tokens"] = sum(s["train_tokens"] for s in state.ordered())
    m["val_tokens"] = sum(s["val_tokens"] for s in state.ordered())
    m["unique_documents"] = sum(s["docs"] for s in state.ordered())
    m["duplicate_documents_dropped"] = sum(s["duplicates"] for s in state.ordered())
    m["unique_tokens"] = m["train_tokens"] + m["val_tokens"]
    m["domain_tokens"] = domain_tokens_from_disk(data)
    (data / "manifest.json").write_text(json.dumps(m, indent=2))
    print(f"\n{m['unique_tokens']:,} unique tokens from {m['unique_documents']:,} documents "
          f"({m['duplicate_documents_dropped']:,} duplicates dropped)", flush=True)
    return m


if __name__ == "__main__":
    main()
