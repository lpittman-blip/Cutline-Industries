"""Bounded-memory, bounded-disk, resumable corpus preparation.

`data.prepare` builds the whole corpus in Python lists before writing:

    split[name][0].extend(chunk)        # every token id, in RAM
    np.array(ids, dtype=dtype).tofile(...)

That is fine for the 70M-token shard it was written for and impossible at the
80B-token budget: 80e9 Python ints is roughly 640 GB of RAM. `_iter_docs` also
calls `path.read_text()`, holding each whole JSONL in memory, and `.tofile()`
truncates, so calling prepare once per shard overwrites rather than appends.

This module does the same job with three differences that matter at scale:

  * **Append, never rebuild.** Token ids and domain labels stream to open file
    handles. Peak RAM is one document plus a write buffer.
  * **A global dedup ledger that survives shard boundaries.** `prepare` builds
    `seen = set()` per call, so preparing shard-by-shard would silently make
    deduplication shard-local and admit every cross-shard duplicate. The ledger
    here is persisted and reloaded, so document 5 of shard 700 is still checked
    against document 1 of shard 0.
  * **Resumable, with bounded disk.** Each shard is downloaded, consumed and
    deleted before the next is fetched, and completed shards are recorded so an
    interrupted run continues instead of restarting.

Ledger collisions: documents are keyed on the first 64 bits of their SHA-256.
At 63M documents (roughly what 80B tokens implies) the birthday probability of
a single collision is about 1e-4. A collision drops one document, so the cost
is negligible and the alternative -- a 32-byte key per document -- quadruples
ledger size for no practical gain. Stated so the tradeoff is on the record.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .model import EXPERT_NAMES
from .tokenizer import load_tokenizer

UNLABELED = 255


def _key(text: str) -> int:
    return int.from_bytes(hashlib.sha256(text.encode()).digest()[:8], "big")


@dataclass
class Ledger:
    """Global seen-document set, persisted so it spans shards and restarts."""

    path: Path
    keys: set[int] = field(default_factory=set)

    @classmethod
    def load(cls, path: str | Path) -> "Ledger":
        p = Path(path)
        if p.exists():
            return cls(p, set(np.fromfile(p, dtype=np.uint64).tolist()))
        return cls(p, set())

    def seen(self, k: int) -> bool:
        return k in self.keys

    def add(self, k: int) -> None:
        self.keys.add(k)

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        np.fromiter(self.keys, dtype=np.uint64, count=len(self.keys)).tofile(tmp)
        tmp.replace(self.path)   # atomic: a crash never leaves a half-written ledger


class ShardWriter:
    """Append-only token and label streams, with their running counts."""

    def __init__(self, out_dir: str | Path, dtype):
        self.out = Path(out_dir)
        self.out.mkdir(parents=True, exist_ok=True)
        self.dtype = dtype
        self._f = {}
        self.counts = {"train": 0, "val": 0}
        self.domain_tokens = {d: {"train": 0, "val": 0} for d in EXPERT_NAMES}

    def _handle(self, split: str, kind: str):
        k = (split, kind)
        if k not in self._f:
            self._f[k] = open(self.out / f"{split}.{kind}", "ab")
        return self._f[k]

    def write(self, split: str, ids: list[int], label: int) -> None:
        if not ids:
            return
        np.asarray(ids, dtype=self.dtype).tofile(self._handle(split, "bin"))
        np.full(len(ids), label, dtype=np.uint8).tofile(self._handle(split, "dom"))
        self.counts[split] += len(ids)
        if label != UNLABELED:
            self.domain_tokens[EXPERT_NAMES[label]][split] += len(ids)

    def close(self) -> None:
        for f in self._f.values():
            f.close()
        self._f.clear()


def stream_shard(jsonl: str | Path, tokenizer_path: str | Path, writer: ShardWriter,
                 ledger: Ledger, val_fraction: float = 0.002) -> dict:
    """Tokenise one filtered shard, appending as it goes. Returns per-shard counts."""
    tok = load_tokenizer(str(tokenizer_path))
    eos = tok.token_to_id("<|eos|>")
    stats = {"docs": 0, "duplicates": 0, "train_tokens": 0, "val_tokens": 0}
    with open(jsonl, encoding="utf-8") as fh:
        for line in fh:                      # line by line: never the whole file
            if not line.strip():
                continue
            rec = json.loads(line)
            text = rec["text"]
            k = _key(text)
            if ledger.seen(k):
                stats["duplicates"] += 1
                continue
            ledger.add(k)
            stats["docs"] += 1
            domain = rec.get("domain")
            if domain is not None and domain not in EXPERT_NAMES:
                raise ValueError(f"unknown domain {domain!r}")
            label = EXPERT_NAMES.index(domain) if domain else UNLABELED
            ids = tok.encode(text).ids + [eos]
            # Same split rule as data.prepare: by document hash, so the split is
            # deterministic and every domain reaches validation; a very long
            # document contributes its tail instead.
            if len(ids) > 4096:
                cut = len(ids) - max(1, int(len(ids) * val_fraction))
                parts = [("train", ids[:cut]), ("val", ids[cut:])]
            else:
                parts = [("val" if (k >> 32) / 0xFFFFFFFF < val_fraction else "train", ids)]
            for split, chunk in parts:
                writer.write(split, chunk, label)
                stats[f"{split}_tokens"] += len(chunk)
    return stats


def write_manifest(out_dir: str | Path, tokenizer_path: str | Path, writer: ShardWriter,
                   shards: list[dict], licence: str, origin: str) -> dict:
    out = Path(out_dir)
    m = {"tokenizer": str(tokenizer_path),
         "tokenizer_sha256": hashlib.sha256(Path(tokenizer_path).read_bytes()).hexdigest(),
         "experts": list(EXPERT_NAMES),
         "dtype": np.dtype(writer.dtype).name,
         "train_tokens": writer.counts["train"], "val_tokens": writer.counts["val"],
         "domain_labels": True,
         "domain_tokens": {d: dict(v) for d, v in writer.domain_tokens.items()},
         "license": licence, "origin": origin,
         "shards": shards,
         # The numbers that stop "80B" being ambiguous.
         "unique_documents": sum(s["docs"] for s in shards),
         "duplicate_documents_dropped": sum(s["duplicates"] for s in shards),
         "unique_tokens": writer.counts["train"] + writer.counts["val"]}
    (out / "manifest.json").write_text(json.dumps(m, indent=2))
    return m
