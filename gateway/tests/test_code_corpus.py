"""Licence filtering and domain labelling for the pretraining code corpus.

The licence check is the one that carries legal weight: Artemis is trained to
be sold, and the upstream dataset mixes copyleft rows in with permissive ones.
"""
import json

import pytest

from artemis.code_corpus import (CONTENT_SIGNALS, PERMISSIVE, build, classify,
                                 classify_content, is_permissive)
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


@pytest.mark.parametrize("code,expected", [
    # One library-specific name is enough, because only telemetry uses it.
    ("import structlog\nlog = structlog.get_logger()\n", "observability"),
    ("from prometheus_client import Counter\nc = Counter('x', 'y')\n", "observability"),
    ("import hashlib\nh = hashlib.sha256(pw).hexdigest()\n", "security"),
    ("const jwt = require('jsonwebtoken'); jwt.verify(t, k)\n", "security"),
    ("import redis\nr = redis.Redis()\nr.get('k')\n", "memory"),
    ("cur.execute('SELECT id FROM users WHERE x = ?')\n", "memory"),
    ("stripe.Charge.create(amount=500, currency='usd')\n", "cost"),
])
def test_content_signals_label_their_domain(code, expected):
    assert classify_content(code) == expected


@pytest.mark.parametrize("code,why", [
    # Every one of these was a REAL false positive found by sampling the corpus.
    # They are the reason the strong tier is library names and nothing else.
    ("obs.observe(function (changes) { render(changes); });",
     "observe( is RxJS/MobX, not a metrics observation"),
    ("class RayTracer { trace(scene) { return this.tracer.cast(ray); } }",
     "a ray tracer is not a distributed tracer"),
    ("img_hist = cv2.calcHist([img], [0], None, [256], [0, 256])  # histogram",
     "histogram is image processing here"),
    ("<label>Name</label><input/>  // .labels( in a UI",
     "UI labels are not prometheus labels"),
    # Numerical code: `cost` means a loss function, `price` a simulation input.
    ("def cost(theta, X, y):\n    return ((X @ theta - y) ** 2).mean()\n",
     "cost is a loss function in ML code"),
    ("prices = [random.gauss(100, 5) for _ in range(1000)]\n",
     "price in a simulation is not billing"),
    # Thin evidence of any kind stays unlabelled rather than being guessed.
    ("logger = logging.getLogger(__name__)\n",
     "a bare logger line is in nearly every file"),
    ("", "empty input"),
])
def test_weak_evidence_is_left_unlabelled(code, why):
    assert classify_content(code) is None, why


def test_a_file_about_two_things_equally_is_left_unlabelled():
    """The margin rule: no label beats a wrong one when the evidence is split."""
    from artemis.code_corpus import _score_content
    both = "import hashlib\nimport redis\n"
    scores = _score_content(both)
    assert scores["security"] == scores["memory"], "the fixture must actually tie"
    assert classify_content(both) is None


def test_the_margin_only_protects_a_near_tie():
    """What the margin does NOT do, stated so the limit is not mistaken for safety.

    MARGIN is 1.5 on small integer scores, so it separates a tie from a clear
    winner and little else. A file with real evidence of two domains still gets
    labelled once one side is half again ahead — here crypto imports lose to a
    heavier database signal. That is a deliberate accepted cost, not a bug: the
    alternative is leaving most mixed files unlabelled, which is the shortage
    this change exists to fix.
    """
    from artemis.code_corpus import _score_content
    mixed = ("import hashlib, hmac\nfrom cryptography.fernet import Fernet\n"
             "import redis, sqlalchemy\nsession.query(User).all()\n"
             "cur.execute('SELECT * FROM users')\n")
    s = _score_content(mixed)
    assert s["memory"] >= 1.5 * s["security"], "fixture no longer demonstrates the point"
    assert classify_content(mixed) == "memory"


def test_path_rules_outrank_content():
    """A test that exercises crypto is still test work."""
    assert classify("tests/test_crypto.py", "Python",
                    "import hashlib\nhashlib.sha256(b'x')\n") == "test"
    assert classify("Dockerfile", "Dockerfile", "import redis\nredis.Redis()\n") == "deploy"


def test_content_outranks_the_build_catch_all():
    assert classify("src/auth.py", "Python",
                    "import jwt, hashlib\njwt.verify(tok)\n") == "security"
    # ...but a file with no distinguishing content still falls through to build.
    assert classify("src/util.py", "Python", "def add(a, b):\n    return a + b\n") == "build"


def test_classify_without_code_keeps_the_original_behaviour():
    """Callers holding only a path must be unaffected by content labelling."""
    assert classify("src/server.py", "Python") == "build"
    assert classify("tests/t.py", "Python") == "test"
    assert classify("README.md", "Markdown") is None


def test_unreachable_experts_are_never_assigned():
    """intent, architecture and planning have no code signal and must not be guessed.

    Source files evidence what code does, not why it was written or how it was
    meant to fit together. A file containing the word "architecture" is not
    architecture work, and labelling it so would reintroduce the failure that
    docs/MOE-ROUTING-ABLATION.md measured.
    """
    unreachable = {"intent", "architecture", "planning"}
    assert unreachable.isdisjoint(CONTENT_SIGNALS)
    tempting = [
        "# Architecture: this module is the planning layer for user intent.\n",
        "class ArchitecturePlanner:\n    '''Plans intent.'''\n",
    ]
    for code in tempting:
        assert classify_content(code) not in unreachable


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
