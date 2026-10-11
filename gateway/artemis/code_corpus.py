"""Build a permissively-licensed, domain-labelled code corpus for pretraining.

Two jobs, both of which a naive download gets wrong.

LICENCE. `codeparrot/github-code-clean` is published under Apache-2.0 as a
dataset, but each row carries the licence of the repository it came from, and
copyleft licences are present. Artemis is trained to be sold, so only
permissive rows are kept and the rejected ones are counted, not silently
dropped.

DOMAINS. `route_coef` supervises routing only on tokens that carry a domain
label, and a plain text corpus has none — which is why the proto MoE learned
no useful routing and lost to a dense baseline of the same compute. Paths are
strong evidence for three of the ten experts: a file under tests/ is `test`
work, a CI or container file is `deploy` work, other source is `build` work.
Anything weaker than that is left unlabelled rather than guessed at, because a
wrong label is worse than none.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

# SPDX-ish identifiers as they appear in the dataset's `license` column.
PERMISSIVE = frozenset({
    "mit", "apache-2.0", "bsd-3-clause", "bsd-2-clause", "isc",
    "unlicense", "cc0-1.0", "0bsd", "mit-0", "zlib", "postgresql",
})

# Languages worth training on. Markdown and data formats are in the dataset
# but teach syntax we do not want Artemis to imitate as code.
CODE_LANGUAGES = frozenset({
    "Python", "JavaScript", "TypeScript", "Go", "Rust", "Java", "C", "C++",
    "C#", "Ruby", "Shell", "PHP", "Scala", "Kotlin", "Swift", "Lua", "Perl",
    "Haskell", "SQL", "Dockerfile",
})

TEST_PATH = re.compile(r"(^|/)(tests?|spec|__tests__)(/|$)|(^|/)test_[^/]*$|_test\.[a-z]+$|\.spec\.[a-z]+$", re.I)
DEPLOY_PATH = re.compile(
    r"(^|/)\.github/workflows/|(^|/)(Dockerfile|docker-compose[^/]*|Makefile)$"
    r"|(^|/)(k8s|kubernetes|helm|charts|deploy|terraform|ansible)(/|$)"
    r"|\.(tf|tfvars)$|(^|/)\.gitlab-ci\.yml$|(^|/)Jenkinsfile$", re.I)


def classify(path: str, language: str) -> str | None:
    """Domain for a source file, or None to leave it unlabelled."""
    if TEST_PATH.search(path or ""):
        return "test"
    if DEPLOY_PATH.search(path or "") or language == "Dockerfile":
        return "deploy"
    if language in CODE_LANGUAGES:
        return "build"
    return None


def is_permissive(license_id: str | None) -> bool:
    return (license_id or "").strip().lower() in PERMISSIVE


def build(parquet_paths, out_jsonl: Path, *, min_chars: int = 200,
          max_chars: int = 40_000, languages=None) -> dict:
    """Stream parquet shards into a labelled JSONL corpus for data.prepare.

    Returns counts so the caller can see what was kept and why, rather than
    discovering a mostly-empty corpus after tokenisation.
    """
    import pyarrow.parquet as pq

    keep_langs = frozenset(languages) if languages else CODE_LANGUAGES
    out_jsonl = Path(out_jsonl)
    out_jsonl.parent.mkdir(parents=True, exist_ok=True)
    stats = {"rows": 0, "kept": 0, "chars": 0, "rejected_license": 0,
             "rejected_language": 0, "rejected_size": 0, "domains": {}}

    with out_jsonl.open("w", encoding="utf-8") as fh:
        for p in parquet_paths:
            pf = pq.ParquetFile(str(p))
            cols = set(pf.schema_arrow.names)
            want = [c for c in ("code", "path", "language", "license") if c in cols]
            for batch in pf.iter_batches(batch_size=2000, columns=want):
                d = batch.to_pydict()
                n = len(d.get("code", []))
                for i in range(n):
                    stats["rows"] += 1
                    if not is_permissive(d.get("license", [None] * n)[i]):
                        stats["rejected_license"] += 1
                        continue
                    lang = d.get("language", [""] * n)[i]
                    if lang not in keep_langs:
                        stats["rejected_language"] += 1
                        continue
                    code = d["code"][i] or ""
                    if not (min_chars <= len(code) <= max_chars):
                        stats["rejected_size"] += 1
                        continue
                    domain = classify(d.get("path", [""] * n)[i], lang)
                    rec = {"text": code}
                    if domain:
                        rec["domain"] = domain
                        stats["domains"][domain] = stats["domains"].get(domain, 0) + 1
                    fh.write(json.dumps(rec) + "\n")
                    stats["kept"] += 1
                    stats["chars"] += len(code)
    return stats


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description="Build a permissive, labelled code corpus")
    ap.add_argument("--out", required=True)
    ap.add_argument("parquet", nargs="+")
    ap.add_argument("--min-chars", type=int, default=200)
    ap.add_argument("--max-chars", type=int, default=40_000)
    a = ap.parse_args(argv)
    s = build(a.parquet, Path(a.out), min_chars=a.min_chars, max_chars=a.max_chars)
    print(json.dumps(s, indent=2))
    return s


if __name__ == "__main__":
    main()
