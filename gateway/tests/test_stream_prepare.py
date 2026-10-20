"""Streaming preparation: bounded memory, append-only, and dedup that spans shards."""
import json
import sysconfig
from pathlib import Path

import numpy as np
import pytest

from artemis.data import TokenStream
from artemis.stream_prepare import Ledger, ShardWriter, stream_shard, write_manifest
from artemis.tokenizer import train_tokenizer


@pytest.fixture(scope="module")
def tok(tmp_path_factory):
    stdlib = Path(sysconfig.get_paths()["stdlib"])
    text = "\n".join(p.read_text(errors="ignore") for p in sorted(stdlib.glob("*.py"))[:40])
    d = tmp_path_factory.mktemp("tok")
    f = d / "c.txt"
    f.write_text(text)
    out = d / "tok.json"
    train_tokenizer([str(f)], 2048, out)
    return out


def _shard(path: Path, docs):
    path.write_text("\n".join(json.dumps(d) for d in docs))
    return path


def test_dedup_spans_shards(tok, tmp_path):
    """The property data.prepare cannot have: a duplicate in a LATER shard is caught.

    prepare() builds `seen = set()` per call, so preparing shard-by-shard makes
    deduplication shard-local and silently admits every cross-shard duplicate.
    """
    led = Ledger.load(tmp_path / "ledger.u64")
    w = ShardWriter(tmp_path / "data", np.uint16)
    a = _shard(tmp_path / "a.jsonl", [{"text": "alpha " * 50, "domain": "build"},
                                      {"text": "beta " * 50, "domain": "test"}])
    b = _shard(tmp_path / "b.jsonl", [{"text": "alpha " * 50, "domain": "build"},   # dup of shard a
                                      {"text": "gamma " * 50, "domain": "test"}])
    s1 = stream_shard(a, tok, w, led)
    s2 = stream_shard(b, tok, w, led)
    w.close()
    assert s1 == {**s1, "docs": 2, "duplicates": 0}
    assert s2["docs"] == 1 and s2["duplicates"] == 1, f"cross-shard duplicate not caught: {s2}"


def test_ledger_survives_a_restart(tok, tmp_path):
    """An interrupted run must not forget what it has already ingested."""
    led = Ledger.load(tmp_path / "l.u64")
    w = ShardWriter(tmp_path / "d", np.uint16)
    a = _shard(tmp_path / "a.jsonl", [{"text": "unique-doc " * 40}])
    stream_shard(a, tok, w, led)
    w.close()
    led.save()

    reloaded = Ledger.load(tmp_path / "l.u64")          # fresh process would do this
    assert len(reloaded.keys) == len(led.keys) == 1
    w2 = ShardWriter(tmp_path / "d", np.uint16)
    again = stream_shard(a, tok, w2, reloaded)
    w2.close()
    assert again["docs"] == 0 and again["duplicates"] == 1


def test_appends_rather_than_truncating(tok, tmp_path):
    """.tofile() truncates; two shards must accumulate, not overwrite."""
    led = Ledger.load(tmp_path / "l.u64")
    w = ShardWriter(tmp_path / "d", np.uint16)
    one = stream_shard(_shard(tmp_path / "a.jsonl", [{"text": "aaa " * 200}]), tok, w, led)
    size_after_one = (tmp_path / "d" / "train.bin").stat().st_size
    two = stream_shard(_shard(tmp_path / "b.jsonl", [{"text": "bbb " * 200}]), tok, w, led)
    w.close()
    size_after_two = (tmp_path / "d" / "train.bin").stat().st_size
    assert size_after_two > size_after_one
    total = one["train_tokens"] + two["train_tokens"]
    assert size_after_two == total * 2, "uint16 ids: two bytes per token"
    assert (tmp_path / "d" / "train.dom").stat().st_size == total, "uint8 labels: one byte per token"


def test_output_is_loadable_and_labels_line_up(tok, tmp_path):
    led = Ledger.load(tmp_path / "l.u64")
    w = ShardWriter(tmp_path / "d", np.uint16)
    docs = [{"text": f"def f{i}(): return {i}\n" * 80, "domain": "build"} for i in range(40)]
    stream_shard(_shard(tmp_path / "a.jsonl", docs), tok, w, led)
    w.close()
    m = write_manifest(tmp_path / "d", tok, w, [{"docs": 40, "duplicates": 0}], "MIT", "test")

    ids = np.fromfile(tmp_path / "d" / "train.bin", dtype=np.uint16)
    dom = np.fromfile(tmp_path / "d" / "train.dom", dtype=np.uint8)
    assert len(ids) == len(dom), "one label per token"
    assert m["unique_tokens"] == m["train_tokens"] + m["val_tokens"]
    assert m["domain_tokens"]["build"]["train"] > 0
    stream = TokenStream(tmp_path / "d" / "train.bin", "uint16", seq_len=16, seed=0)
    x, y, d = stream.batch(2, with_domains=True)
    assert x.shape == y.shape == d.shape == (2, 16)
