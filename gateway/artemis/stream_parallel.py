"""Tokenise with every core, without weakening deduplication.

`stream_corpus` is correct and single-threaded. Tokenisation is the expensive
part -- BPE encoding dominates the wall clock -- so on an 8-core box it leaves
seven cores idle and a full corpus takes days instead of hours.

The obvious parallelisation is wrong. Give each worker its own shards and each
worker gets its own dedup ledger, so a document appearing in shard 0 and again
in shard 700 is caught only if both landed on the same worker. Deduplication
silently becomes per-worker, and the corpus quietly gains duplicates -- the
exact failure `stream_prepare` was written to prevent, reintroduced by the
speedup.

PARTITION BY DOCUMENT HASH, NOT BY SHARD. Every copy of a document has the
same SHA-256, so `key % workers` sends every copy to the same worker. That
worker's local ledger is therefore globally exact for its slice, with no shared
state, no locks, and no cross-process coordination on the hot path.

One process reads and parses the JSONL (cheap, and keeps shard order
deterministic); workers tokenise and write their own bins. At the end the bins
are concatenated. Concatenation order does not matter: `TokenStream` samples
random windows, so the corpus is a bag of documents either way.

MEASURED, not estimated. 4 shards of real CommitPack Python at vocab 32000 on
a 4-core box: 15.7s sequential, 6.7s with 4 workers, 7,222,546 tokens either
way. That is 2.35x, not 4x, and the gap is structural: one core is spent in
the parent parsing JSON and routing documents, and every document crosses a
process boundary. Expect scaling to flatten further as workers grow, since the
single parser becomes the ceiling -- roughly 4-5x on 8 cores, not 8x. If the
parser ever becomes the bottleneck outright, the fix is to parse in the
workers and route raw lines, at the cost of hashing each line twice.

CALLERS MUST BE IMPORTABLE. The "spawn" start method re-imports the parent
module in each worker, so driving this from a heredoc or `python -` fails with
`FileNotFoundError: .../<stdin>`. Run it from a real file or module, and guard
the entry point with `if __name__ == "__main__":`. "spawn" is not negotiable
here: the tokenizers library runs its own threads, and forking a threaded
process deadlocks the child.

Resume commits at shard boundaries. After each shard the parent barriers on
every worker, collects their committed token counts, and records them. On
restart each worker's bins are truncated back to its own committed counts --
the same arithmetic `stream_corpus.rollback` uses, applied per worker.
"""
from __future__ import annotations

import json
import multiprocessing as mp
import os
from pathlib import Path

import numpy as np

from .stream_prepare import EXPERT_NAMES, UNLABELED, Ledger, ShardWriter, _key

# Compared by VALUE, never by identity. A queue pickles what it carries, so
# the object a worker receives is a different object from the one the parent
# sent: `item is STOP` is always False, the sentinel falls through to the
# document loop, and iterating b"stop" yields ints. None is the exception --
# it survives pickling as the singleton -- but relying on that for one
# sentinel and not the other is a trap, so both are explicit.
SENTINEL = "__shard_done__"   # commit point: report counts, keep going
STOP = "__stop__"             # no more shards, shut down


def _worker(wid: int, workers: int, out: Path, tokenizer_path: str,
            val_fraction: float, inbox: "mp.Queue", outbox: "mp.Queue") -> None:
    """Own one hash slice of every shard: dedup it, tokenise it, write it."""
    from .tokenizer import load_tokenizer
    tok = load_tokenizer(str(tokenizer_path))
    eos = tok.token_to_id("<|eos|>")
    ledger = Ledger.load(out / f"ledger-{wid}.u64")
    writer = ShardWriter(out / f"part-{wid}", np.uint16)
    stats = {"docs": 0, "duplicates": 0}
    while True:
        item = inbox.get()
        if isinstance(item, str) and item == STOP:
            break
        if isinstance(item, str) and item == SENTINEL:   # shard boundary: commit
            ledger.save()                          # ledger first, always: a
            writer.flush()                         # saved count must never
            outbox.put((wid, dict(stats), dict(writer.counts)))   # outrun it
            continue
        for key, text, domain in item:
            if ledger.seen(key):
                stats["duplicates"] += 1
                continue
            ledger.add(key)
            stats["docs"] += 1
            label = EXPERT_NAMES.index(domain) if domain else UNLABELED
            ids = tok.encode(text).ids + [eos]
            if len(ids) > 4096:
                cut = len(ids) - max(1, int(len(ids) * val_fraction))
                parts = [("train", ids[:cut]), ("val", ids[cut:])]
            else:
                split = "val" if (key >> 32) / 0xFFFFFFFF < val_fraction else "train"
                parts = [(split, ids)]
            for sp, chunk in parts:
                writer.write(sp, chunk, label)
    ledger.save()
    writer.close()
    outbox.put((wid, dict(stats), dict(writer.counts)))


def rollback_parts(out: Path, committed: dict[int, dict[str, int]]) -> None:
    """Truncate each worker's bins to the counts it last committed.

    Same reasoning as the single-process path: one uint16 id and one uint8
    label per token, so a committed count fixes the exact correct file length.
    Anything past it belongs to a shard that never finished.
    """
    for wid, counts in committed.items():
        for split in ("train", "val"):
            n = counts.get(split, 0)
            for kind, width in (("bin", 2), ("dom", 1)):
                f = out / f"part-{wid}" / f"{split}.{kind}"
                if not f.exists():
                    continue
                want, have = n * width, f.stat().st_size
                if have > want:
                    with open(f, "r+b") as fh:
                        fh.truncate(want)
                elif have < want:
                    raise SystemExit(
                        f"{f} is {have} bytes but {want} were committed; refusing "
                        f"to append to a corpus that cannot be accounted for.")


def concatenate(out: Path, workers: int) -> dict[str, int]:
    """Join the per-worker bins into the single pair TokenStream reads.

    Order is irrelevant -- windows are sampled at random -- but `.bin` and
    `.dom` must be concatenated in the SAME worker order or every label is
    attached to the wrong token.
    """
    totals = {}
    for split in ("train", "val"):
        for kind in ("bin", "dom"):
            dst = out / f"{split}.{kind}"
            with open(dst, "wb") as w:
                for wid in range(workers):           # same order, both streams
                    src = out / f"part-{wid}" / f"{split}.{kind}"
                    if src.exists():
                        with open(src, "rb") as r:
                            while chunk := r.read(1 << 24):
                                w.write(chunk)
            if kind == "bin":
                totals[split] = dst.stat().st_size // 2
    return totals


def stream_shards_parallel(jsonls, tokenizer_path, out_dir, workers: int = 0,
                           val_fraction: float = 0.002, batch: int = 512,
                           committed: dict | None = None) -> dict:
    """Consume shards across `workers` processes. Returns per-shard stats.

    `jsonls` is an iterable of (index, path). `committed` carries the token
    counts each worker had written when the last shard finished, so an
    interrupted run can truncate back to them before appending.
    """
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    workers = workers or max(1, (os.cpu_count() or 2) - 1)
    if committed:
        rollback_parts(out, {int(k): v for k, v in committed.items()})

    ctx = mp.get_context("spawn")        # fork + tokenizers threads deadlock
    inboxes = [ctx.Queue(maxsize=8) for _ in range(workers)]
    outbox = ctx.Queue()
    procs = [ctx.Process(target=_worker,
                         args=(i, workers, out, str(tokenizer_path), val_fraction,
                               inboxes[i], outbox), daemon=True)
             for i in range(workers)]
    for p in procs:
        p.start()

    per_shard, counts = {}, {}
    try:
        for index, path in jsonls:
            pending = [[] for _ in range(workers)]
            with open(path, encoding="utf-8") as fh:
                for line in fh:                      # line by line: never the
                    if not line.strip():             # whole file in memory
                        continue
                    rec = json.loads(line)
                    text = rec["text"]
                    domain = rec.get("domain")
                    if domain is not None and domain not in EXPERT_NAMES:
                        raise ValueError(f"unknown domain {domain!r}")
                    k = _key(text)
                    w = k % workers                  # every copy -> same worker
                    pending[w].append((k, text, domain))
                    if len(pending[w]) >= batch:
                        inboxes[w].put(pending[w]); pending[w] = []
            for w in range(workers):
                if pending[w]:
                    inboxes[w].put(pending[w])
                inboxes[w].put(SENTINEL)             # barrier: commit this shard
            got, docs, dups = 0, 0, 0
            while got < workers:                     # wait for every worker
                wid, st, cnt = outbox.get()
                counts[wid] = cnt
                docs += st["docs"]; dups += st["duplicates"]
                got += 1
            per_shard[index] = {"docs": docs, "duplicates": dups,
                                "train_tokens": sum(c.get("train", 0) for c in counts.values()),
                                "val_tokens": sum(c.get("val", 0) for c in counts.values()),
                                "committed": {str(k): v for k, v in counts.items()}}
    finally:
        for w in range(workers):
            try: inboxes[w].put(STOP)
            except Exception: pass
        for p in procs:
            p.join(timeout=60)

    # EVERY counter here is cumulative -- the ledgers and writers keep running
    # totals and report them at each barrier -- so all four become per-shard
    # deltas together. Converting only the token counts, and summing docs and
    # duplicates as if they were per-shard, double-counts them: four shards
    # reporting 0, 10, 20, 30 duplicates sum to 60 for 30 real ones.
    prev = {"docs": 0, "duplicates": 0, "train_tokens": 0, "val_tokens": 0}
    for i in sorted(per_shard):
        row = per_shard[i]
        for k in prev:
            row[k], prev[k] = row[k] - prev[k], row[k]
    totals = concatenate(out, workers)
    return {"shards": per_shard, "workers": workers, "totals": totals}
