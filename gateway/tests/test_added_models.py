"""Grok as an added service: a customer-selectable model that is never Artemis.

Artemis is sold as a platform, so a plan may include a third-party model alongside our
own. Blueprint Decisions 5 and 12 still hold, and these tests pin the boundary:

  1. a request reaches an external model ONLY because a customer selected it;
  2. Artemis's own reasoning - planning, the ten experts, the audit - never calls one;
  3. nothing can present a third-party answer as Artemis's own work.
"""
import json
from urllib.error import URLError

import pytest

from artemis.backends import GrokBackend, ModelUnavailable
from artemis.business import Business, PaymentRequired
from artemis.orchestrator import Artemis
from artemis.server import added_model_system, added_models, make_handler
from test_chat_failures import events, request, server
from test_tools import ScriptedModel


# --------------------------------------------------------------- the backend

def make(**kw):
    return GrokBackend("test-key", **kw)


def test_request_uses_bearer_and_names_the_model_in_the_body(monkeypatch):
    """xAI is OpenAI-shaped: model in the body, Bearer auth - unlike Azure, which routes
    by deployment in the URL with an api-key header."""
    b = make(model="grok-4.20-non-reasoning")
    captured = {}
    monkeypatch.setattr("artemis.backends.urllib.request.urlopen", _fake({"choices": [{"message": {"content": "x"}}]}, captured))
    b.generate("sys", [{"role": "user", "content": "q"}])
    assert captured["url"] == "https://api.x.ai/v1/chat/completions"
    assert captured["headers"]["Authorization"] == "Bearer test-key"
    body = json.loads(captured["body"])
    assert body["model"] == "grok-4.20-non-reasoning"
    assert "chat_template_kwargs" not in body, "a vLLM extension; xAI rejects unknown fields"


def test_system_prompt_forbids_answering_as_artemis(monkeypatch):
    b = make()
    captured = {}
    monkeypatch.setattr("artemis.backends.urllib.request.urlopen", _fake({"choices": [{"message": {"content": "x"}}]}, captured))
    b.generate(added_model_system("Grok"), [{"role": "user", "content": "who are you?"}])
    system = json.loads(captured["body"])["messages"][0]["content"]
    assert "not Artemis" in system and "Grok" in system


def test_readiness_and_replies_are_marked_external(monkeypatch):
    b = make()
    monkeypatch.setattr("artemis.backends.urllib.request.urlopen", _fake({"choices": [{"message": {"content": "ok"}}]}))
    r = b.readiness()
    assert r["serving"] is True and r["provider"] == "xai" and r["external"] is True
    assert r["quality"] == "not-artemis", "must not inherit 'unverified', which reads as Artemis"
    assert r["model"] != "artemis"
    seen = {}
    b.generate("sys", [{"role": "user", "content": "q"}], metadata_sink=seen.update)
    assert seen["external"] is True and seen["provider"] == "xai"


def test_transport_failure_is_unavailable_not_a_crash(monkeypatch):
    b = make()
    monkeypatch.setattr("artemis.backends.urllib.request.urlopen", _boom)
    with pytest.raises(ModelUnavailable):
        b.generate("sys", [{"role": "user", "content": "q"}])
    assert b.readiness()["serving"] is False


def test_missing_key_is_refused_at_construction():
    with pytest.raises(ValueError, match="api_key"):
        GrokBackend("")


def test_registry_is_empty_without_a_key(monkeypatch):
    """No credentials must mean no external model offered - never a silent default."""
    monkeypatch.delenv("XAI_API_KEY", raising=False)
    monkeypatch.delenv("GROK_API_KEY", raising=False)
    assert added_models() == {}
    monkeypatch.setenv("XAI_API_KEY", "k")
    assert list(added_models()) == ["grok"]


# --------------------------------------------------------------- the request path

class FakeGrok:
    """Stands in for the real backend so these tests make no network call."""

    def __init__(self):
        self.calls = []

    def stream(self, system, messages, max_tokens=512, metadata_sink=None):
        self.calls.append({"system": system, "messages": [dict(m) for m in messages]})
        yield from ("Grok ", "here.")


#: Requests carry this key so they are billed to acct:x and get its plan; an
#: unauthenticated request is a guest and so always on the free plan.
AUTH = {"Authorization": "Bearer art-test"}


def wire(plan=None):
    biz = Business(":memory:")
    if plan:
        biz.set_plan("acct:x", plan)
    biz.db.execute("INSERT INTO api_keys VALUES (?, ?, ?, 0)", (biz._hash("art-test"), "acct:x", 0))
    model = ScriptedModel(["draft", "Artemis answer."])
    app = Artemis(model)
    grok = FakeGrok()
    app.added_models = {"grok": grok}
    return biz, app, model, grok


def test_default_is_artemis_and_never_touches_the_added_model():
    biz, app, model, grok = wire("pro")
    with server(make_handler(app, biz)) as base:
        code, body = request(base, "/v1/chat", {"message": "hello", "tier": "gpt-2-sft"}, AUTH)
    assert code == 200 and grok.calls == [], "no model field must mean Artemis, never an external model"
    assert model.seen, "Artemis's own backend should have answered"


def test_selecting_grok_answers_as_a_passthrough_marked_external():
    biz, app, model, grok = wire("pro")
    with server(make_handler(app, biz)) as base:
        code, body = request(base, "/v1/chat/stream", {"message": "hello", "model": "grok"}, AUTH)
    assert code == 200
    evs = events(body)
    done = next(e for e in evs if e["type"] == "done")
    assert done["answer"] == "Grok here."
    assert done["external"] is True and done["model"] == "grok" and done["provider"] == "xai"
    assert done["brains"] == [] and done["audit"] is None, "an added service answers for itself"
    assert model.seen == [], "Artemis's own reasoning must not run for a passthrough"
    assert grok.calls[0]["messages"][-1]["content"] == "hello"


def test_every_streamed_event_says_which_model_replied():
    biz, app, model, grok = wire("pro")
    with server(make_handler(app, biz)) as base:
        _, body = request(base, "/v1/chat/stream", {"message": "hi", "model": "grok"}, AUTH)
    for ev in (e for e in events(body) if e["type"] in ("plan", "done")):
        assert ev["model"] == "grok" and ev["external"] is True


def test_a_plan_without_grok_is_refused_with_an_upgrade_path():
    biz, app, model, grok = wire()           # free plan: artemis only
    with server(make_handler(app, biz)) as base:
        code, body = request(base, "/v1/chat", {"message": "hello", "model": "grok"})
    assert code == 402 and "not included" in json.loads(body)["error"]
    assert json.loads(body)["upgrade"] == "/v1/plans"
    assert grok.calls == [], "an unpaid request must not reach the provider at all"


def test_an_unknown_model_is_refused_rather_than_silently_served():
    biz, app, model, grok = wire("enterprise")   # grants the whole catalogue
    with server(make_handler(app, biz)) as base:
        code, _ = request(base, "/v1/chat", {"message": "hello", "model": "gpt-9"}, AUTH)
    assert code == 402 and grok.calls == []


def test_an_included_model_with_no_credentials_fails_loudly():
    """Silently answering as Artemis instead would bill for a service not delivered."""
    biz, app, model, grok = wire("pro")
    app.added_models = {}
    with server(make_handler(app, biz)) as base:
        code, body = request(base, "/v1/chat", {"message": "hello", "model": "grok"}, AUTH)
    assert code == 400 and "not configured" in json.loads(body)["error"]
    assert model.seen == [], "must not fall back to Artemis and charge for Grok"


def test_model_picker_lists_the_plan_and_marks_what_is_external():
    biz, app, model, grok = wire("pro")
    with server(make_handler(app, biz)) as base:
        code, body = request(base, "/v1/models", None, AUTH)
    listed = {m["id"]: m for m in json.loads(body)["models"]}
    assert code == 200 and set(listed) == {"artemis", "grok"}
    assert listed["artemis"]["external"] is False and listed["artemis"]["available"] is True
    assert listed["grok"]["external"] is True and listed["grok"]["display"] == "Grok"


def test_picker_shows_an_included_model_as_unavailable_rather_than_hiding_it():
    biz, app, model, grok = wire("pro")
    app.added_models = {}
    with server(make_handler(app, biz)) as base:
        _, body = request(base, "/v1/models", None, AUTH)
    grok_row = next(m for m in json.loads(body)["models"] if m["id"] == "grok")
    assert grok_row["available"] is False


def test_the_free_picker_offers_artemis_only():
    biz, app, model, grok = wire()
    with server(make_handler(app, biz)) as base:
        code, body = request(base, "/v1/models")
    assert code == 200 and [m["id"] for m in json.loads(body)["models"]] == ["artemis"]


# --------------------------------------------------------------- Blueprint 5 and 12

def test_the_orchestrator_has_no_access_to_an_added_model():
    """Artemis's decisions must be unable to reach a third-party model, not merely
    configured not to: the orchestrator holds one backend, Artemis's own."""
    biz, app, model, grok = wire("pro")
    assert app.backend is model
    import inspect
    src = inspect.getsource(Artemis)
    assert "added_models" not in src and "Grok" not in src


def _fake(payload, captured=None):
    def opener(req, timeout=None):
        if captured is not None:
            captured["url"] = req.full_url
            captured["body"] = req.data.decode()
            captured["headers"] = dict(req.header_items())
            captured["headers"]["Authorization"] = req.headers.get("Authorization")
        class R:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self): return json.dumps(payload).encode()
        return R()
    return opener


def _boom(*a, **k):
    raise URLError("down")


# --------------------------------------------------------------- the conversation app
# The site talks to the conversation app (/api/conversations), not to /v1, so model
# selection has to hold there too: authorized, recorded, and routed as a passthrough.

from artemis.chat_jobs import ChatJobs                              # noqa: E402
from artemis.conversations import ChatError, Conversations           # noqa: E402
from test_chat_application import Model, account, complete           # noqa: E402


def app_service(plan=None):
    biz = Business(":memory:")
    records = Conversations(biz.db)
    model = Model()
    app = Artemis(model)
    grok = FakeGrok()
    app.added_models = {"grok": grok}
    jobs = ChatJobs(app, biz, records, workers=2)
    user = account(records)
    if plan:
        biz.set_plan(user[0]["id"], plan)
    return biz, records, jobs, app, model, grok, user[0]["id"]


def test_a_selected_model_answers_the_conversation_and_is_recorded_as_itself():
    biz, records, jobs, app, model, grok, owner = app_service("pro")
    cid = records.create(owner, "c")["id"]
    rid = jobs.submit(owner, cid, {"text": "hello", "model": "grok", "idempotency_key": "k" * 10})["id"]
    request = complete(records, owner, rid)
    assert request["state"] == "completed"
    reply = records.load(owner, cid)["messages"][-1]
    assert reply["content"] == "Grok here."
    assert "Grok" in request["model"] and "xai" in request["model"], "the record must name who replied"
    assert model.calls == [], "Artemis's own reasoning must not run for a passthrough"
    jobs.shutdown(); app.pool.shutdown()


def test_the_conversation_default_is_still_artemis():
    biz, records, jobs, app, model, grok, owner = app_service("pro")
    cid = records.create(owner, "c")["id"]
    rid = jobs.submit(owner, cid, {"text": "hello", "idempotency_key": "k" * 10})["id"]
    complete(records, owner, rid)
    assert grok.calls == [] and model.calls, "no model field must mean Artemis"
    jobs.shutdown(); app.pool.shutdown()


def test_a_plan_without_the_model_is_refused_before_anything_is_stored():
    biz, records, jobs, app, model, grok, owner = app_service()      # free plan
    cid = records.create(owner, "c")["id"]
    with pytest.raises(PaymentRequired):
        jobs.submit(owner, cid, {"text": "hello", "model": "grok", "idempotency_key": "k" * 10})
    assert records.load(owner, cid)["messages"] == [] and grok.calls == []
    jobs.shutdown(); app.pool.shutdown()


def test_an_included_model_with_no_credentials_is_refused_not_answered_by_artemis():
    biz, records, jobs, app, model, grok, owner = app_service("pro")
    app.added_models = {}
    cid = records.create(owner, "c")["id"]
    with pytest.raises(ChatError) as caught:
        jobs.submit(owner, cid, {"text": "hello", "model": "grok", "idempotency_key": "k" * 10})
    assert caught.value.category == "model_unavailable"
    assert model.calls == [], "must not silently charge for Grok and answer as Artemis"
    jobs.shutdown(); app.pool.shutdown()


def test_a_provider_failure_fails_the_request_with_its_name():
    biz, records, jobs, app, model, grok, owner = app_service("pro")

    class Broken:
        def stream(self, system, messages, max_tokens=512, metadata_sink=None):
            raise ModelUnavailable("down")
            yield ""   # pragma: no cover - makes this a generator

    app.added_models = {"grok": Broken()}
    cid = records.create(owner, "c")["id"]
    rid = jobs.submit(owner, cid, {"text": "hello", "model": "grok", "idempotency_key": "k" * 10})["id"]
    request = complete(records, owner, rid)
    assert request["state"] == "failed" and request["error"] == "model_unavailable"
    jobs.shutdown(); app.pool.shutdown()
