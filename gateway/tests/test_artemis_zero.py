"""Artemis 0: the external-model bootstrap backend.

This backend calls an external provider, which Blueprint Decisions 5 and 12 otherwise
forbid in product code. It exists only to exercise the orchestrator, experts, tools and
decision engine before Artemis's own checkpoint passes evaluation.

The two things that must never break:
  1. it is unreachable unless explicitly opted into, so a missing env var or a typo can
     never silently route users to an outside model;
  2. it never reports itself as Artemis, so nothing downstream can claim Artemis is
     serving when an external provider is.
"""
import json
from urllib.error import URLError

import pytest

from artemis.backends import (
    ArtemisServerBackend,
    AzureAIBackend,
    ModelUnavailable,
    NotReadyBackend,
)

ENDPOINT = "https://artm89.cognitiveservices.azure.com/"
DEPLOYMENT = "artemis0"


def make(**kw):
    return AzureAIBackend(ENDPOINT, "test-key", DEPLOYMENT, **kw)


# --------------------------------------------------------------- honest reporting

def test_readiness_never_claims_to_be_artemis(monkeypatch):
    b = make()
    monkeypatch.setattr("artemis.backends.urllib.request.urlopen",
                        _fake_urlopen({"choices": [{"message": {"content": "ok"}}]}))
    r = b.readiness()
    assert r["model"] == "external"
    assert r["provider"] == "azure-ai-services"
    assert r["bootstrap"] is True
    assert r["quality"] == "not-artemis", "must not inherit 'unverified', which reads as Artemis"


def test_readiness_probes_as_itself_not_as_the_parent(monkeypatch):
    """Regression: inherited readiness() built an ArtemisServerBackend probe.

    The parent hardcodes its own class when probing, so an inherited readiness()
    sent a vLLM-shaped request with a Bearer header to an Azure endpoint. It always
    came back serving=False while generate() worked perfectly - observed against the
    real artemis0 deployment. The probe must use the Azure URL and api-key header.
    """
    b = make()
    captured = {}
    monkeypatch.setattr("artemis.backends.urllib.request.urlopen",
                        _fake_urlopen({"choices": [{"message": {"content": "ok"}}]}, captured))
    r = b.readiness()
    assert r["serving"] is True, "a working deployment must not report serving=False"
    assert "/openai/deployments/" in captured["url"], "probe used the parent's vLLM URL"
    assert captured["headers"].get("api-key"), "probe used Bearer instead of api-key"


def test_readiness_reports_unavailable_when_the_probe_fails(monkeypatch):
    b = make()

    def boom(*a, **k):
        raise URLError("down")

    monkeypatch.setattr("artemis.backends.urllib.request.urlopen", boom)
    r = b.readiness()
    assert r["serving"] is False and r["status"] == "unavailable"
    assert r["quality"] == "not-artemis", "still must not read as Artemis when down"


def test_generate_marks_every_reply_external(monkeypatch):
    b = make()
    seen = {}
    payload = {"choices": [{"message": {"content": "hi"}, "finish_reason": "stop"}],
               "usage": {"total_tokens": 5}}
    monkeypatch.setattr("artemis.backends.urllib.request.urlopen", _fake_urlopen(payload))
    out = b.generate("apollo", "sys", [{"role": "user", "content": "q"}], metadata_sink=seen.update)
    assert out == "hi"
    assert seen["external"] is True, "callers must be able to tell this was not Artemis"


# --------------------------------------------------------------- request shape

def test_uses_azure_url_and_api_key_header(monkeypatch):
    b = make(api_version="2024-10-21")
    captured = {}
    monkeypatch.setattr("artemis.backends.urllib.request.urlopen",
                        _fake_urlopen({"choices": [{"message": {"content": "x"}}]}, captured))
    b.generate("mercury", "sys", [{"role": "user", "content": "q"}])
    assert f"/openai/deployments/{DEPLOYMENT}/chat/completions" in captured["url"]
    assert "api-version=2024-10-21" in captured["url"]
    assert captured["headers"]["api-key"] == "test-key"
    assert "Authorization" not in captured["headers"], "Azure uses api-key, not Bearer"


def test_body_omits_vllm_only_fields(monkeypatch):
    """chat_template_kwargs is a vLLM extension; Azure rejects unknown fields."""
    b = make()
    captured = {}
    monkeypatch.setattr("artemis.backends.urllib.request.urlopen",
                        _fake_urlopen({"choices": [{"message": {"content": "x"}}]}, captured))
    b.generate("venus", "sys", [{"role": "user", "content": "q"}])
    body = json.loads(captured["body"])
    assert "chat_template_kwargs" not in body
    assert "model" not in body, "Azure routes by deployment in the URL, not a model field"


def test_brain_survives_in_the_system_prompt(monkeypatch):
    """vLLM selects a brain via its adapter; Azure has one deployment, so the brain must
    reach the model some other way or every expert would behave identically."""
    b = make()
    captured = {}
    monkeypatch.setattr("artemis.backends.urllib.request.urlopen",
                        _fake_urlopen({"choices": [{"message": {"content": "x"}}]}, captured))
    b.generate("saturn", "be terse", [{"role": "user", "content": "q"}])
    system = json.loads(captured["body"])["messages"][0]
    assert system["role"] == "system"
    assert "saturn" in system["content"]
    assert "be terse" in system["content"]


def test_missing_key_is_refused_at_construction():
    with pytest.raises(ValueError, match="api_key"):
        AzureAIBackend(ENDPOINT, "", DEPLOYMENT)


def test_transport_failure_raises_model_unavailable(monkeypatch):
    b = make()

    def boom(*a, **k):
        raise URLError("down")

    monkeypatch.setattr("artemis.backends.urllib.request.urlopen", boom)
    with pytest.raises(ModelUnavailable):
        b.generate("earth", "sys", [{"role": "user", "content": "q"}])


# --------------------------------------------------------------- selection gating

def test_azure_is_the_last_branch_considered():
    """A real Artemis backend must always win; the external one is the final fallback."""
    from artemis import server
    import inspect
    src = inspect.getsource(server.build_app)
    i_url = src.index("if url:")
    i_ckpt = src.index("elif ckpt:")
    i_azure = src.index("ARTEMIS_BOOTSTRAP_AZURE")
    i_notready = src.index("NotReadyBackend()")
    assert i_url < i_ckpt < i_azure < i_notready, "Azure must be tried after every Artemis backend"


def test_azure_requires_an_explicit_flag():
    """Having the credentials present must NOT be enough to route users externally."""
    from artemis import server
    import inspect
    src = inspect.getsource(server.build_app)
    assert 'os.environ.get("ARTEMIS_BOOTSTRAP_AZURE") == "1"' in src


def test_incomplete_azure_config_fails_loudly_not_silently():
    from artemis import server
    import inspect
    src = inspect.getsource(server.build_app)
    assert "raise SystemExit" in src, "a half-configured external backend must not start"
    for v in ("AZURE_AI_ENDPOINT", "AZURE_AI_KEY", "AZURE_AI_DEPLOYMENT"):
        assert v in src


def test_default_is_still_not_ready():
    """With nothing configured, Artemis reports training - not an external model."""
    b = NotReadyBackend()
    assert b.readiness()["status"] == "training"


# --------------------------------------------------------------- helper

def _fake_urlopen(payload, captured=None):
    class R:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return json.dumps(payload).encode()

    def opener(req, timeout=None):
        if captured is not None:
            captured["url"] = req.full_url
            captured["body"] = req.data.decode()
            captured["headers"] = {k.title(): v for k, v in req.headers.items()}
            captured["headers"].setdefault("api-key", req.headers.get("Api-key"))
        return _JsonCtx(payload)

    return opener


class _JsonCtx:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return json.dumps(self.payload).encode()
