"""The shard-at-a-time driver: bounded disk, and a resume that cannot double-count."""
import json
import sysconfig
from pathlib import Path

import numpy as np
import pytest

from artemis import stream_corpus
from artemis.data import TokenStream
from artemis.stream_corpus import State, domain_tokens_from_disk, rollback
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


def fake_dataset(monkeypatch, docs_per_shard):
    """Replace download+filter with a generator, so no network and no parquet.

    Each shard gets distinct text, so any duplication in the output bins is a
    bug in the driver rather than a property of the corpus.
    """
    def _filter(parquet, out):
        i = int(Path(out).stem)
        with open(out, "w", encoding="utf-8") as fh:
            for d in range(docs_per_shard):
                fh.write(json.dumps({
                    "text": f"def shard_{i}_doc_{d}():\n" + f"    return {d}\n" * 30,
                    "domain": "build" if d % 2 else "test",
                }) + "\n")
        return out.stat().st_size

    monkeypatch.setattr(stream_corpus, "_fetch", lambda repo, i, total, raw: raw / f"{i}.parquet")
    monkeypatch.setattr(stream_corpus, "_filter", _filter)


def run(work, tok, shards, **kw):
    return stream_corpus.main(["--work", str(work), "--shards", str(shards),
                               "--tokenizer-shards", "1", *sum(
                                   ([f"--{k.replace('_','-')}", str(v)] for k, v in kw.items()), [])])


def test_consumes_every_shard_and_leaves_no_raw_files(tmp_path, tok, monkeypatch):
    fake_dataset(monkeypatch, 8)
    (tmp_path / "tokenizer.json").write_bytes(Path(tok).read_bytes())
    m = run(tmp_path, tok, 3)

    assert len(m["shards"]) == 3
    assert m["unique_documents"] == 24
    assert m["unique_tokens"] > 0
    # Bounded disk is the whole point: nothing downloaded or filtered survives.
    assert list((tmp_path / "filtered").iterdir()) == []
    assert not any((tmp_path / "raw").glob("*.parquet"))


def test_resume_skips_finished_shards_without_reappending(tmp_path, tok, monkeypatch):
    fake_dataset(monkeypatch, 8)
    (tmp_path / "tokenizer.json").write_bytes(Path(tok).read_bytes())
    first = run(tmp_path, tok, 2)
    size_after_two = (tmp_path / "data" / "train.bin").stat().st_size

    again = run(tmp_path, tok, 2)          # same range: everything already done
    assert (tmp_path / "data" / "train.bin").stat().st_size == size_after_two
    assert again["unique_tokens"] == first["unique_tokens"]

    extended = run(tmp_path, tok, 4)       # two more shards, appended once each
    assert extended["unique_tokens"] > first["unique_tokens"]
    assert extended["unique_documents"] == 32


def test_an_interrupted_shard_is_truncated_not_counted_twice(tmp_path, tok, monkeypatch):
    fake_dataset(monkeypatch, 8)
    (tmp_path / "tokenizer.json").write_bytes(Path(tok).read_bytes())
    clean = run(tmp_path, tok, 2)
    data = tmp_path / "data"
    good = {f: (data / f).stat().st_size for f in
            ("train.bin", "train.dom", "val.bin", "val.dom") if (data / f).exists()}

    # Simulate a crash partway through shard 2: tokens appended, state never
    # updated. This is exactly what a preemption or an OOM leaves behind.
    with open(data / "train.bin", "ab") as fh:
        np.full(5000, 7, dtype=np.uint16).tofile(fh)
    with open(data / "train.dom", "ab") as fh:
        np.full(5000, 3, dtype=np.uint8).tofile(fh)

    resumed = run(tmp_path, tok, 2)
    assert resumed["unique_tokens"] == clean["unique_tokens"]
    for f, size in good.items():
        assert (data / f).stat().st_size == size, f"{f} kept bytes from the crashed shard"


def test_bins_shorter_than_the_state_claims_is_refused(tmp_path, tok, monkeypatch):
    fake_dataset(monkeypatch, 8)
    (tmp_path / "tokenizer.json").write_bytes(Path(tok).read_bytes())
    run(tmp_path, tok, 2)
    data = tmp_path / "data"
    with open(data / "train.bin", "r+b") as fh:        # lose committed tokens
        fh.truncate(fh.seek(0, 2) - 1000)
    with pytest.raises(SystemExit, match="cannot be accounted for"):
        rollback(data, State.load(tmp_path / "prep-state.json"))


def test_domain_counts_come_from_disk_so_a_resumed_run_reports_the_whole_corpus(
        tmp_path, tok, monkeypatch):
    fake_dataset(monkeypatch, 8)
    (tmp_path / "tokenizer.json").write_bytes(Path(tok).read_bytes())
    run(tmp_path, tok, 1)
    m = run(tmp_path, tok, 2)             # second process appends only shard 1

    counts = m["domain_tokens"]
    assert counts["build"]["train"] > 0 and counts["test"]["train"] > 0
    # The totals must cover BOTH shards, not just the ones this process wrote.
    assert domain_tokens_from_disk(tmp_path / "data") == counts
    labelled = sum(v["train"] + v["val"] for v in counts.values())
    assert labelled == m["unique_tokens"]


def test_output_is_loadable_with_labels_aligned(tmp_path, tok, monkeypatch):
    fake_dataset(monkeypatch, 8)
    (tmp_path / "tokenizer.json").write_bytes(Path(tok).read_bytes())
    run(tmp_path, tok, 2)
    s = TokenStream(tmp_path / "data" / "train.bin", "uint16", seq_len=64)
    x, y, dom = s.batch(4, with_domains=True)
    assert x.shape == y.shape == (4, 64) and dom.shape == (4, 64)


def test_target_tokens_stops_early(tmp_path, tok, monkeypatch):
    fake_dataset(monkeypatch, 8)
    (tmp_path / "tokenizer.json").write_bytes(Path(tok).read_bytes())
    one = run(tmp_path, tok, 1)
    m = run(tmp_path, tok, 6, target_tokens=one["unique_tokens"])
    assert len(m["shards"]) == 1          # budget already met; no shard 1
