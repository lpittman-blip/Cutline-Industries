"""Parallel tokenisation must not change the corpus -- only the wall clock.

The risk being tested is not a crash. It is a speedup that silently weakens
deduplication: give each worker its own shards and a document repeated across
shards is only caught when both copies happen to land on the same worker.
So the property under test is equality with the single-process path, on a
corpus built to contain cross-shard duplicates.
"""
import json
import sysconfig
from pathlib import Path

import numpy as np
import pytest

from artemis.data import TokenStream
from artemis.stream_parallel import concatenate, stream_shards_parallel
from artemis.stream_prepare import Ledger, ShardWriter, stream_shard
from artemis.tokenizer import train_tokenizer


@pytest.fixture(scope="module")
def tok(tmp_path_factory):
    stdlib = Path(sysconfig.get_paths()["stdlib"])
    text = "\n".join(p.read_text(errors="ignore") for p in sorted(stdlib.glob("*.py"))[:40])
    d = tmp_path_factory.mktemp("tok")
    f = d / "c.txt"; f.write_text(text)
    out = d / "tok.json"
    train_tokenizer([str(f)], 2048, out)
    return out


def corpus(root: Path, shards: int = 4, per: int = 40) -> list[tuple[int, Path]]:
    """Shards whose LAST 10 documents repeat shard 0's first 10 verbatim.

    Those repeats are the whole point: they can only be caught by a ledger
    that spans shards, and under a naive per-worker split they would survive.
    """
    root.mkdir(parents=True, exist_ok=True)
    first = [f"def fn_{i}():\n" + f"    return {i}\n" * 20 for i in range(10)]
    out = []
    for s in range(shards):
        p = root / f"{s:05d}.jsonl"
        with p.open("w", encoding="utf-8") as fh:
            for d in range(per):
                fh.write(json.dumps({"text": f"# shard {s} doc {d}\n" + f"x = {d}\n" * 25,
                                     "domain": "build" if d % 2 else "test"}) + "\n")
            if s > 0:
                for t in first:
                    fh.write(json.dumps({"text": t, "domain": "build"}) + "\n")
            else:
                for t in first:
                    fh.write(json.dumps({"text": t, "domain": "build"}) + "\n")
        out.append((s, p))
    return out


def sequential(shard_list, tok, out: Path) -> dict:
    led = Ledger.load(out / "led.u64")
    w = ShardWriter(out / "seq", np.uint16)
    docs = dups = 0
    for _, p in shard_list:
        st = stream_shard(p, tok, w, led)
        docs += st["docs"]; dups += st["duplicates"]
    w.close(); led.save()
    return {"docs": docs, "duplicates": dups, **w.counts}


def test_parallel_matches_sequential_exactly(tmp_path, tok):
    shards = corpus(tmp_path / "raw")
    seq = sequential(shards, tok, tmp_path / "s")
    par = stream_shards_parallel(shards, tok, tmp_path / "p", workers=3)

    pdocs = sum(s["docs"] for s in par["shards"].values())
    pdups = sum(s["duplicates"] for s in par["shards"].values())
    assert pdocs == seq["docs"], f"parallel kept {pdocs} docs, sequential {seq['docs']}"
    assert pdups == seq["duplicates"], (
        f"parallel dropped {pdups} duplicates, sequential {seq['duplicates']} -- "
        "dedup weakened by parallelism")
    assert par["totals"]["train"] == seq["train"]
    assert par["totals"]["val"] == seq["val"]


def test_cross_shard_duplicates_are_actually_present_and_caught(tmp_path, tok):
    """Guards the test itself: if the fixture stopped producing duplicates,
    the equality test above would pass trivially and prove nothing."""
    shards = corpus(tmp_path / "raw")
    par = stream_shards_parallel(shards, tok, tmp_path / "p", workers=3)
    dups = sum(s["duplicates"] for s in par["shards"].values())
    assert dups == 30, f"expected 30 cross-shard duplicates (10 x 3 shards), got {dups}"


def test_labels_stay_aligned_with_tokens_after_concatenation(tmp_path, tok):
    """.bin and .dom are concatenated separately; a mismatched order would
    attach every label to the wrong token and nothing would crash."""
    shards = corpus(tmp_path / "raw")
    stream_shards_parallel(shards, tok, tmp_path / "p", workers=3)
    for split in ("train", "val"):
        b = (tmp_path / "p" / f"{split}.bin").stat().st_size // 2
        d = (tmp_path / "p" / f"{split}.dom").stat().st_size
        assert b == d, f"{split}: {b} tokens but {d} labels"


def test_output_is_loadable(tmp_path, tok):
    shards = corpus(tmp_path / "raw")
    stream_shards_parallel(shards, tok, tmp_path / "p", workers=3)
    s = TokenStream(tmp_path / "p" / "train.bin", "uint16", seq_len=64)
    x, y, dom = s.batch(4, with_domains=True)
    assert x.shape == y.shape == dom.shape == (4, 64)


def test_one_worker_is_still_correct(tmp_path, tok):
    """The degenerate case must not be a special case."""
    shards = corpus(tmp_path / "raw")
    seq = sequential(shards, tok, tmp_path / "s")
    par = stream_shards_parallel(shards, tok, tmp_path / "p", workers=1)
    assert par["totals"]["train"] == seq["train"]
    assert sum(s["duplicates"] for s in par["shards"].values()) == seq["duplicates"]
