"""Licence filtering and domain labelling for the pretraining code corpus.

The licence check is the one that carries legal weight: Artemis is trained to
be sold, and the upstream dataset mixes copyleft rows in with permissive ones.
"""
import json

import pytest

from artemis.code_corpus import PERMISSIVE, build, classify, is_permissive
from artemis.model import EXPERT_NAMES

pa = pytest.importorskip("pyarrow")
import pyarrow.parquet as pq  # noqa: E402


def write_parquet(path, rows):
    cols = {k: [r[k] for r in rows] for k in ("code", "path", "language", "license")}
    pq.write_table(pa.table(cols), str(path))
    return path


def test_copyleft_is_rejected():
    for bad in ("gpl-2.0", "gpl-3.0", "agpl-3.0", "lgpl-2.1", "GPL-3.0", None, ""):
        assert not is_permissive(bad), f"{bad!r} must not be treated as permissive"
    for good in ("mit", "MIT", "apache-2.0", "bsd-3-clause", "isc"):
        assert is_permissive(good)


def test_permissive_set_contains_no_copyleft():
    assert not [x for x in PERMISSIVE if "gpl" in x]


@pytest.mark.parametrize("path,lang,expected", [
    ("tests/test_api.py", "Python", "test"),
    ("src/__tests__/thing.js", "JavaScript", "test"),
    ("pkg/server_test.go", "Go", "test"),
    ("app/foo.spec.ts", "TypeScript", "test"),
    (".github/workflows/ci.yml", "YAML", "deploy"),
    ("Dockerfile", "Dockerfile", "deploy"),
    ("infra/terraform/main.tf", "HCL", "deploy"),
    ("src/server.py", "Python", "build"),
    ("lib/util.rs", "Rust", "build"),
    ("README.md", "Markdown", None),          # not guessed at
    ("data/notes.txt", "Text", None),
])
def test_domain_classification(path, lang, expected):
    assert classify(path, lang) == expected


def test_every_assigned_domain_is_a_real_expert():
    for path, lang in [("tests/t.py", "Python"), ("Dockerfile", "Dockerfile"), ("a.py", "Python")]:
        d = classify(path, lang)
        assert d in EXPERT_NAMES


def test_build_filters_and_labels(tmp_path):
    src = write_parquet(tmp_path / "s.parquet", [
        {"code": "x" * 500, "path": "src/a.py", "language": "Python", "license": "mit"},
        {"code": "y" * 500, "path": "tests/test_a.py", "language": "Python", "license": "apache-2.0"},
        {"code": "z" * 500, "path": "Dockerfile", "language": "Dockerfile", "license": "isc"},
        {"code": "g" * 500, "path": "src/b.py", "language": "Python", "license": "gpl-3.0"},   # copyleft
        {"code": "m" * 500, "path": "README.md", "language": "Markdown", "license": "mit"},    # not code
        {"code": "s" * 10, "path": "src/c.py", "language": "Python", "license": "mit"},        # too small
    ])
    out = tmp_path / "corpus.jsonl"
    stats = build([src], out)

    assert stats["kept"] == 3
    assert stats["rejected_license"] == 1
    assert stats["rejected_language"] == 1
    assert stats["rejected_size"] == 1
    assert stats["domains"] == {"build": 1, "test": 1, "deploy": 1}

    rows = [json.loads(l) for l in out.read_text().splitlines() if l.strip()]
    assert len(rows) == 3
    assert all(r["domain"] in EXPERT_NAMES for r in rows)
    # the GPL row must not be present in any form
    assert not any(r["text"].startswith("g") for r in rows)


def test_corpus_feeds_route_supervision(tmp_path):
    """The point of the labels: prepare() emits the .dom sidecar route_coef reads."""
    from artemis.data import prepare
    from artemis.tokenizer import train_tokenizer

    src = write_parquet(tmp_path / "s.parquet", [
        {"code": f"def f{i}():\n    return {i}\n" + "# pad\n" * 60,
         "path": f"src/m{i}.py", "language": "Python", "license": "mit"}
        for i in range(40)
    ])
    corpus = tmp_path / "c.jsonl"
    build([src], corpus)

    flat = tmp_path / "flat.txt"
    flat.write_text("\n".join(json.loads(l)["text"] for l in corpus.read_text().splitlines()))
    tok = tmp_path / "tok.json"
    train_tokenizer([str(flat)], 512, tok)

    m = prepare([{"path": str(corpus), "license": "permissive-filtered",
                  "origin": "codeparrot/github-code-clean"}], str(tok), str(tmp_path / "data"))
    assert m["domain_labels"] is True
    assert (tmp_path / "data" / "train.dom").exists()
