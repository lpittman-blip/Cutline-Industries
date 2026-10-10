"""Billing, Usage and Capabilities: one honest reading of what a plan grants and spends.

A settings screen that guesses is worse than none, so the rules pinned here are:
every number is a real meter reading, unlimited is unlimited rather than a large
number, and a model the server cannot actually serve is never shown as ready.
"""
import json

import pytest

from artemis.business import Business

from test_added_models import AUTH, FakeGrok, wire
from test_chat_failures import request, server
from artemis.server import make_handler


def test_usage_is_a_real_meter_not_an_estimate():
    biz = Business(":memory:")
    biz.set_plan("acct:x", "plus")
    for _ in range(3):
        biz.record_message("acct:x")
    biz.record_tool("acct:x", "web_search")
    data = biz.entitlements("acct:x")
    used = {u["id"]: u for u in data["usage"]}
    assert used["messages"]["used"] == 3 and used["messages"]["limit"] == 500
    assert used["tool_calls"]["used"] == 1 and used["tool_calls"]["limit"] == 300


def test_unlimited_is_null_not_a_big_number():
    """A huge integer would render as a real cap and quietly alarm a Pro customer."""
    biz = Business(":memory:")
    biz.set_plan("acct:x", "pro")
    data = biz.entitlements("acct:x")
    assert all(u["limit"] is None for u in data["usage"])
    assert json.dumps(data), "the payload must be JSON-serialisable; infinity is not"


def test_an_unknown_account_reads_as_the_free_plan():
    data = Business(":memory:").entitlements("guest:1")
    assert data["plan"]["id"] == "free" and data["plan"]["price_usd_month"] == 0
    assert [m["id"] for m in data["capabilities"]["models"]] == ["artemis"]


def test_capabilities_match_the_plan_grants():
    biz = Business(":memory:")
    biz.set_plan("acct:x", "pro")
    caps = biz.entitlements("acct:x")["capabilities"]
    assert {m["id"] for m in caps["models"]} == {"artemis", "grok"}
    assert "run_python" in caps["tools"]
    assert len(caps["brains"]) > 3, "pro grants every brain, not the free three"


def test_price_follows_the_plan_shape():
    biz = Business(":memory:")
    biz.set_plan("acct:x", "team")
    plan = biz.entitlements("acct:x")["plan"]
    assert plan["price_usd_seat_month"] == 30 and plan["price_usd_month"] is None


def test_endpoint_marks_a_model_the_server_cannot_serve():
    biz, app, model, grok = wire("pro")
    app.added_models = {}
    with server(make_handler(app, biz)) as base:
        code, body = request(base, "/v1/models", None, AUTH)
    assert code == 200
    listed = {m["id"]: m for m in json.loads(body)["models"]}
    assert listed["grok"]["available"] is False, "included in the plan, but not servable"
    assert listed["artemis"]["available"] is True


# --------------------------------------------------------------- over HTTP

from artemis.chat_app import make_chat_handler                      # noqa: E402
from test_added_models import app_service                           # noqa: E402
from test_chat_application import account, call                     # noqa: E402


def signed_in(records):
    # app_service already registered "alice"; this is a second, distinct account.
    user, token = account(records, "bob")
    return user, {"Cookie": "artemis_session=" + token, "X-CSRF-Token": user["csrf"]}


def test_usage_endpoint_requires_a_session():
    biz, records, jobs, app, model, grok, owner = app_service("pro")
    with server(make_chat_handler(app, biz, records, jobs)) as base:
        assert call(base, "/api/usage")[0] == 401
    jobs.shutdown(); app.pool.shutdown()


def test_usage_endpoint_reports_the_plan_and_what_today_spent():
    biz, records, jobs, app, model, grok, owner = app_service()
    user, headers = signed_in(records)
    biz.set_plan(user["id"], "plus")
    biz.record_message(user["id"])
    with server(make_chat_handler(app, biz, records, jobs)) as base:
        code, data = call(base, "/api/usage", headers=headers)
    assert code == 200 and data["plan"]["id"] == "plus"
    messages = next(u for u in data["usage"] if u["id"] == "messages")
    assert messages["used"] == 1 and messages["limit"] == 500
    jobs.shutdown(); app.pool.shutdown()


def test_usage_endpoint_marks_an_unservable_model_unavailable():
    biz, records, jobs, app, model, grok, owner = app_service()
    user, headers = signed_in(records)
    biz.set_plan(user["id"], "pro")
    app.added_models = {}
    with server(make_chat_handler(app, biz, records, jobs)) as base:
        code, data = call(base, "/api/usage", headers=headers)
    listed = {m["id"]: m for m in data["capabilities"]["models"]}
    assert code == 200 and listed["grok"]["available"] is False and listed["artemis"]["available"] is True
    jobs.shutdown(); app.pool.shutdown()


# --------------------------------------------------------------- the terminal client

def test_the_website_is_still_pushed_to_the_durable_endpoints():
    """/v1/chat has no history, no resume and no owner; the site must not use it."""
    biz, records, jobs, app, model, grok, owner = app_service()
    _, headers = signed_in(records)
    with server(make_chat_handler(app, biz, records, jobs)) as base:
        for path in ("/v1/chat", "/v1/chat/stream"):
            code, body = call(base, path, {"message": "hi"}, headers=headers)
            assert code == 404 and "conversation endpoints" in body["error"]
    jobs.shutdown(); app.pool.shutdown()


def test_an_api_key_client_reaches_the_streaming_endpoint():
    """Artemis is terminal-first: a request carrying an API key is not the website."""
    biz, records, jobs, app, model, grok, owner = app_service()
    biz.db.execute("INSERT INTO api_keys VALUES (?, ?, ?, 0)", (biz._hash("art-cli"), "acct:cli", 0))
    with server(make_chat_handler(app, biz, records, jobs)) as base:
        code, body = call(base, "/v1/chat", {"message": "hi"}, headers={"Authorization": "Bearer art-cli"})
    assert code == 200 and body["answer"], "the terminal must get an answer, not a 404"
    jobs.shutdown(); app.pool.shutdown()


def test_an_anonymous_request_is_still_turned_away():
    biz, records, jobs, app, model, grok, owner = app_service()
    with server(make_chat_handler(app, biz, records, jobs)) as base:
        code, _ = call(base, "/v1/chat", {"message": "hi"})
    assert code == 404
    jobs.shutdown(); app.pool.shutdown()
