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

# --- content signals ----------------------------------------------------------
# Paths evidence three experts. The ablation in docs/MOE-ROUTING-ABLATION.md
# measured what that costs: supervising 3 of 10 experts under top-2 routing
# drove 85.7% of labelled tokens to one expert, killed the other seven outright,
# and made the supervised MoE 0.046 WORSE than the same model with supervision
# switched off. Widening the labels is the fix; turning route_coef off is the
# workaround.
#
# These read the file's contents, which is weaker evidence than a path, so the
# bar is higher rather than lower. A domain is assigned only when several
# DISTINCT signals fire and no rival domain comes close — see _score_content.
# Distinct patterns are counted, never occurrences, so a long file cannot
# out-vote a short one by repeating itself.
#
# Three experts are deliberately absent. `intent`, `architecture` and `planning`
# describe why code was written and how it was meant to fit together. Source
# files do not carry that; a comment saying "architecture" is not architecture
# work. Guessing them would reintroduce exactly the failure this is fixing, so
# they stay unlabelled until a corpus that actually evidences them exists.
_STRONG, _WEAK = 2, 1
CONTENT_SIGNALS: dict[str, list[tuple[str, int]]] = {
    "security": [
        (r"\b(hashlib|hmac|bcrypt|scrypt|argon2|pbkdf2)", _STRONG),
        (r"\b(?:import|from|require\()\s*['\"]?(?:cryptography|crypto/(?:aes|rsa|tls)|openssl|nacl)", _STRONG),
        (r"\b(jsonwebtoken|jwt\.(?:sign|verify|decode)|oauth2?[._]client)\b", _STRONG),
        (r"\b(csrf|xss|sql[\s_]*injection|clickjacking)\b", _STRONG),
        (r"\bsecrets\.(?:token_|choice)|\bos\.urandom\b", _STRONG),
        (r"\b(x509|ssl_context|tlsconfig|certificate[\s_]signing)\b", _STRONG),
        (r"\b(authenticate|authoriz(?:e|ation)|access[\s_]control)\b", _WEAK),
        (r"\b(sanitiz(?:e|ation)|escape_html)\b", _WEAK),
        (r"\b(encrypt|decrypt|cipher)\w*\b", _WEAK),
        (r"\b(nonce|salt_?round|constant_time)\b", _WEAK),
    ],
    # Observability has the worst vocabulary collisions in the whole set, and
    # sampling real files proved it: `observe(` is RxJS and MobX, `tracer.` is a
    # ray tracer in graphics code, `histogram` is image processing, `.labels(`
    # is a UI. Each of those matched a file with nothing to do with telemetry.
    # So the strong tier is restricted to names that belong to a telemetry
    # library and nothing else; everything ambiguous is weak and must pair up.
    "observability": [
        (r"\b(prometheus|opentelemetry|open_telemetry|statsd|datadog|sentry_sdk|structlog)", _STRONG),
        (r"\b(start_span|trace_id|span_id|span\.set_|tracer\.start)\w*", _STRONG),
        (r"\b(alertmanager|pagerduty|grafana|opsgenie)\b", _STRONG),
        (r"\blogging\.getLogger|\blogger\s*=|\blog\.(?:info|warn|warning|error|debug)\b", _WEAK),
        (r"\b(counter\.inc|gauge\.set|histogram)\b", _WEAK),
        (r"\b(metrics?|telemetry)\b", _WEAK),
        (r"\b(health_?check|readiness|liveness)\b", _WEAK),
    ],
    "memory": [
        (r"\b(redis|memcached|sqlalchemy|psycopg2?|mongoose|mongodb|dynamodb|sqlite3)", _STRONG),
        (r"\b(CREATE\s+TABLE|INSERT\s+INTO|ALTER\s+TABLE|SELECT\s+[\w*,\s]+\s+FROM)\b", _STRONG),
        (r"\b(session\.(?:query|add|commit)|\.save\(\)|objects\.filter\()", _STRONG),
        (r"\b(cache\.(?:get|set)|lru_cache|memoize)\b", _WEAK),
        (r"\b(persist|serializ(?:e|ation)|deserializ(?:e|ation))\w*\b", _WEAK),
        (r"\b(migration|schema_version|primary_key|foreign_key)\b", _WEAK),
    ],
    # "cost" is the easiest domain to get wrong: in numerical and ML code `cost`
    # means a loss function, and `price` appears in simulations. Only payment
    # and metering vocabulary counts here — no bare `cost`, no bare `price`.
    "cost": [
        (r"\b(stripe|braintree|paypal|chargebee|paddle)", _STRONG),
        (r"\b(invoice|billing_?(?:account|period|cycle)|subscription_?id|price_?id)\b", _STRONG),
        (r"\b(payment_?(?:intent|method)|charge_?amount|checkout_?session)\b", _STRONG),
        (r"\b(quota|metered_?usage|usage_?record|billable)\b", _WEAK),
        (r"\b(currency|usd|cents|amount_due)\b", _WEAK),
    ],
}

_COMPILED: dict[str, list[tuple[re.Pattern, int]]] = {
    d: [(re.compile(p, re.I), w) for p, w in sigs] for d, sigs in CONTENT_SIGNALS.items()
}

# A domain needs this much distinct evidence, and this much more than its
# nearest rival, before it is assigned. Both thresholds matter: the first stops
# an incidental `logger =` from labelling a file `observability`, the second
# stops a file that is equally about two things from being filed under either.
MIN_SCORE = 2
MARGIN = 1.5
# Signals live in imports, handlers and queries, which are not evenly spread
# through a 40 000-character file. Scanning a bounded prefix keeps the pass
# cheap without changing what it finds in practice.
SCAN_CHARS = 20_000


def _score_content(code: str) -> dict[str, int]:
    """Distinct-signal score per domain. Occurrences are ignored by design."""
    head = code[:SCAN_CHARS]
    return {d: sum(w for pat, w in sigs if pat.search(head))
            for d, sigs in _COMPILED.items()}


def classify_content(code: str) -> str | None:
    """Domain evidenced by a file's contents, or None when the evidence is thin."""
    if not code:
        return None
    scores = _score_content(code)
    ranked = sorted(scores.items(), key=lambda kv: -kv[1])
    top, top_score = ranked[0]
    runner_up = ranked[1][1] if len(ranked) > 1 else 0
    if top_score < MIN_SCORE:
        return None
    if runner_up and top_score < MARGIN * runner_up:
        return None
    return top


def classify(path: str, language: str, code: str | None = None) -> str | None:
    """Domain for a source file, or None to leave it unlabelled.

    `code` is optional so a caller with only a path keeps the original
    behaviour; given the contents, four more experts become reachable.
    """
    if TEST_PATH.search(path or ""):
        return "test"
    if DEPLOY_PATH.search(path or "") or language == "Dockerfile":
        return "deploy"
    if code:
        # Content outranks the `build` catch-all but not the path rules above:
        # a test that exercises crypto is still test work.
        found = classify_content(code)
        if found:
            return found
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
                    domain = classify(d.get("path", [""] * n)[i], lang, code)
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
