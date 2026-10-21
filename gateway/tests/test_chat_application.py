"""Authenticated application acceptance checks. Inference is simulated; no trained weights are supplied."""
import io
import json
import threading
import time
import urllib.error
import urllib.request

import pytest

from artemis.backends import ModelUnavailable, NotReadyBackend
from artemis.backends import ArtemisServerBackend
from artemis.tools import Toolbox, LocalCodeRunner
from http.server import BaseHTTPRequestHandler
from artemis.business import Business
from artemis.chat_app import make_chat_handler
from artemis.chat_jobs import ChatJobs
from artemis.conversations import ChatError, Conversations
from artemis.orchestrator import Artemis
from test_chat_failures import server

SITE = "https://artemisai-bycutlineindustries.studio"   # allow-listed; the static site's origin
HOSTILE = "https://hostile.example"


def raw(base, path, body=None, method=None, headers=None):
    """Like `call`, but keeps the response headers -- which is the thing under test."""
    req = urllib.request.Request(base + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", **(headers or {})})
    try: response = urllib.request.urlopen(req)
    except urllib.error.HTTPError as error: response = error
    status, head = response.status, dict(response.headers)
    try: payload = response.read()
    finally: response.close()
    return status, head, payload


class Model:
    def __init__(self): self.calls = []
    def stream(self, brain, system, messages, max_tokens=512):
        self.calls.append((brain, system, messages))
        yield "Answer: "
        yield messages[-1]["content"]
    def generate(self, *args, **kwargs): return "".join(self.stream(*args, **kwargs))


@pytest.fixture
def service():
    biz = Business(":memory:"); records = Conversations(biz.db); model = Model(); app = Artemis(model)
    jobs = ChatJobs(app, biz, records, workers=2)
    yield biz, records, model, app, jobs
    jobs.shutdown(); app.pool.shutdown()


def account(records, name="alice"):
    return records.authenticate(name + "@example.com", "a-long-test-password", name, signup=True)


def complete(records, owner, rid):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        request = records.get_request(owner, rid)
        if request["state"] not in ("queued", "generating"): return request
        time.sleep(.005)
    raise AssertionError("request did not terminate")


def call(base, path, body=None, method=None, headers=None):
    req = urllib.request.Request(base+path, method=method, data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json", **(headers or {})})
    try: response = urllib.request.urlopen(req)
    except urllib.error.HTTPError as error: response = error
    with response: return response.status, json.load(response)


def test_login_hashes_password_and_logout_revokes_session(service):
    _, records, _, _, _ = service
    user, token = account(records)
    assert records.session(token)["id"] == user["id"]
    stored = records.db.one("SELECT password FROM chat_users WHERE id=?", (user["id"],))[0]
    assert stored != "a-long-test-password" and len(stored.split(":")) == 2
    logged, _ = records.authenticate("alice@example.com", "a-long-test-password", "other")
    assert logged["id"] == user["id"]
    with pytest.raises(ChatError): records.authenticate("alice@example.com", "a-different-password", "other")
    records.logout(token)
    with pytest.raises(ChatError): records.session(token)


def test_two_turn_context_and_records_restore_from_database(service):
    _, records, model, _, jobs = service
    user, _ = account(records); owner = user["id"]; conversation = records.create(owner); cid = conversation["id"]
    first = jobs.submit(owner, cid, {"text": "Remember cobalt", "idempotency_key": "first-request-key"})
    assert complete(records, owner, first["id"])["state"] == "completed"
    second = jobs.submit(owner, cid, {"text": "What did I say?", "idempotency_key": "second-request-key"})
    assert complete(records, owner, second["id"])["state"] == "completed"
    context = model.calls[-1][2]
    assert [m["content"] for m in context] == ["Remember cobalt", "Answer: Remember cobalt", "What did I say?"]
    restored = Conversations(records.db).export(owner, cid)
    assert len(restored["messages"]) == 4 and len(restored["model_calls"]) == 2
    assert restored["model_calls"][0]["system"].startswith("You are")
    assert json.loads(restored["model_calls"][1]["settings"])["context_message_ids"] == [m["id"] for m in restored["messages"][:3]]
    assert json.loads(restored["model_calls"][0]["metadata"]) == {}  # actual usage is unavailable, not invented
    assert restored["chunks"] and restored["generation_requests"] and restored["exported_at"]


def test_idempotent_retry_does_not_duplicate_messages_or_generation(service):
    biz, records, model, _, jobs = service
    user, _ = account(records); owner = user["id"]; cid = records.create(owner)["id"]
    body = {"text": "Hello", "idempotency_key": "stable-delivery-key"}
    first = jobs.submit(owner, cid, body); complete(records, owner, first["id"])
    # Replays must work even if a subsequent plan quota check would refuse a new message.
    for _ in range(100): biz.record_message(owner)
    second = jobs.submit(owner, cid, body)
    assert second["id"] == first["id"] and len(records.load(owner, cid)["messages"]) == 2 and len(model.calls) == 1
    with pytest.raises(ChatError, match="different input"):
        jobs.submit(owner, cid, {**body, "text": "Changed"})


def test_concurrent_delivery_creates_one_request(service):
    _, records, _, _, _ = service
    user, _ = account(records); owner = user["id"]; cid = records.create(owner)["id"]
    body = {"text": "Hello", "idempotency_key": "concurrent-delivery"}; results = []
    def create(): results.append(records.request(owner, cid, body, {"tier": "gpt-1-base"}, "Artemis"))
    threads = [threading.Thread(target=create) for _ in range(8)]
    for thread in threads: thread.start()
    for thread in threads: thread.join()
    assert len(results) == 8 and sum(created for _, created in results) == 1
    assert len({request["id"] for request, _ in results}) == 1


def test_edit_and_regeneration_preserve_original_branch(service):
    _, records, _, _, jobs = service
    user, _ = account(records); owner = user["id"]; cid = records.create(owner)["id"]
    first = jobs.submit(owner, cid, {"text": "Original", "idempotency_key": "original-version"}); complete(records, owner, first["id"])
    edit = jobs.submit(owner, cid, {"text": "Edited", "edit_message_id": first["user_id"], "idempotency_key": "edited-version"}); complete(records, owner, edit["id"])
    regen = jobs.submit(owner, cid, {"regenerate_message_id": first["assistant_id"], "idempotency_key": "regenerated-version"}); complete(records, owner, regen["id"])
    data = records.export(owner, cid)
    assert len(data["messages"]) == 5 and {r["kind"] for r in data["revisions"]} == {"edit", "regenerate"}
    assert next(m for m in data["messages"] if m["id"] == first["user_id"])["content"] == "Original"
    assert records.context(owner, regen["id"])[-1]["content"] == "Original"
    assert records.context(owner, edit["id"])[-1]["content"] == "Edited"


@pytest.mark.parametrize("operation", ["load", "export", "delete", "update", "context", "events", "cancel", "submit"])
def test_another_user_cannot_access_any_conversation_operation(service, operation):
    _, records, _, _, jobs = service
    alice, _ = account(records); bob, _ = account(records, "bob"); cid = records.create(alice["id"])["id"]
    request = jobs.submit(alice["id"], cid, {"text": "Private", "idempotency_key": "private-message"}); complete(records, alice["id"], request["id"])
    functions = {"load": lambda: records.load(bob["id"], cid), "export": lambda: records.export(bob["id"], cid),
        "delete": lambda: records.delete(bob["id"], cid), "update": lambda: records.update(bob["id"], cid, {"title": "stolen"}),
        "context": lambda: records.context(bob["id"], request["id"]), "events": lambda: records.events(bob["id"], request["id"]),
        "cancel": lambda: jobs.cancel(bob["id"], request["id"]), "submit": lambda: jobs.submit(bob["id"], cid, {"text": "stolen", "idempotency_key": "new-private-key"})}
    with pytest.raises(ChatError) as error: functions[operation]()
    assert error.value.code == 404


def test_outage_and_cancellation_keep_partial_text(service):
    biz, records, _, app, jobs = service
    user, _ = account(records); owner = user["id"]
    class Outage(Model):
        def stream(self, *args, **kwargs):
            yield "Partial output "
            raise ModelUnavailable("Model unavailable.")
    app.backend = Outage(); cid = records.create(owner)["id"]
    request = jobs.submit(owner, cid, {"text": "Hello", "idempotency_key": "outage-request"})
    assert complete(records, owner, request["id"])["state"] == "failed"
    partial = records.load(owner, cid)["messages"][-1]
    assert partial["content"] == "Partial output " and partial["error"]
    ready, release = threading.Event(), threading.Event()
    class Slow(Model):
        def stream(self, *args, **kwargs):
            yield "Saved partial "
            ready.set(); release.wait(3)
            yield "should not survive cancellation"
    app.backend = Slow(); cid2 = records.create(owner)["id"]
    second = jobs.submit(owner, cid2, {"text": "Hello", "idempotency_key": "cancel-request"})
    assert ready.wait(2); jobs.cancel(owner, second["id"]); release.set()
    assert complete(records, owner, second["id"])["state"] == "stopped"
    assert records.load(owner, cid2)["messages"][-1]["content"] == "Saved partial "
    assert biz.used(owner, "message") == 0


def test_replay_cursor_context_limit_and_training_preserve_input(service):
    _, records, _, app, jobs = service
    user, _ = account(records); owner = user["id"]; cid = records.create(owner)["id"]
    jobs.context_limit = 10
    request = jobs.submit(owner, cid, {"text": "Keep this input", "idempotency_key": "context-limit-key"})
    assert complete(records, owner, request["id"])["error"] == "context_limit"
    assert records.load(owner, cid)["messages"][0]["content"] == "Keep this input"
    request_state, events = records.events(owner, request["id"])
    assert events[-1]["event"]["type"] == "error"
    assert records.events(owner, request["id"], events[-1]["seq"])[1] == []
    jobs.context_limit = 4096; app.backend = NotReadyBackend(); cid2 = records.create(owner)["id"]
    request = jobs.submit(owner, cid2, {"text": "Still saved", "idempotency_key": "training-request"})
    assert complete(records, owner, request["id"])["error"] == "training"


def test_retention_and_deletion_cover_all_linked_records(service):
    _, records, _, _, jobs = service
    user, _ = account(records); owner = user["id"]; cid = records.create(owner)["id"]
    request = jobs.submit(owner, cid, {"text": "Old", "idempotency_key": "expired-request"}); complete(records, owner, request["id"])
    records.preferences(owner, 30)
    records.db.execute("UPDATE chat_conversations SET updated=? WHERE id=?", (time.time()-31*86400, cid))
    records.expire()
    for table in ('chat_messages', 'chat_requests', 'chat_chunks', 'chat_model_calls', 'chat_failures', 'chat_tool_events'):
        assert records.db.one(f"SELECT COUNT(*) FROM {table}")[0] == 0
    assert not records.preferences(owner)["training_collection"]


def test_authenticated_http_handlers_enforce_csrf_and_return_saved_history(service):
    biz, records, _, app, jobs = service
    user, token = account(records)
    headers = {"Cookie": "artemis_session="+token, "X-CSRF-Token": user["csrf"]}
    with server(make_chat_handler(app, biz, records, jobs)) as base:
        assert call(base, '/api/conversations')[0] == 401
        assert call(base, '/api/conversations', {}, headers={"Cookie": headers["Cookie"]})[0] == 403
        assert call(base, '/api/conversations', {}, headers={**headers, "Origin": "https://hostile.example"})[0] == 403
        headers = {**headers, "Origin": SITE}       # browsers send Origin on every write
        code, conversation = call(base, '/api/conversations', {}, headers=headers); assert code == 201
        code, request = call(base, '/api/conversations/'+conversation['id']+'/messages', {'text': 'Hello', 'idempotency_key': 'http-request-key'}, headers=headers)
        assert code == 202; complete(records, user["id"], request["request_id"])
        code, messages = call(base, '/api/conversations/'+conversation['id']+'/messages', headers=headers)
        assert code == 200 and messages['messages'][-1]['content'] == 'Answer: Hello'
        code, exported = call(base, '/api/conversations/'+conversation['id']+'/export', headers=headers)
        assert code == 200 and 'password' not in json.dumps(exported) and token not in json.dumps(exported)
        assert call(base, '/api/requests/'+request['request_id']+'/events', headers=headers)[1]['state'] == 'completed'
        assert call(base, '/api/conversations?q=hello', headers=headers)[1]['conversations']


def test_model_logs_redact_server_credentials(service, monkeypatch):
    _, records, _, _, jobs = service
    jobs.secrets = ['server-secret-value']
    assert jobs.redact({'Authorization': 'Bearer xyz', 'output': 'server-secret-value Bearer abc'}) == {'Authorization': '[redacted]', 'output': '[redacted] Bearer [redacted]'}


def test_vllm_model_name_prompt_markers_and_actual_usage_metadata():
    seen = []
    class VLLM(BaseHTTPRequestHandler):
        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers['Content-Length']))); seen.append((self.path, payload))
            self.send_response(200); self.end_headers()
            if payload.get('stream'):
                self.wfile.write(b'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n')
                self.wfile.write(b'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
                self.wfile.write(b'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}\n\n')
                self.wfile.write(b'data: [DONE]\n\n')
            else: self.wfile.write(b'{"choices":[{"message":{"content":"Hello"},"finish_reason":"stop"}],"usage":{"total_tokens":6}}')
        def log_message(self,*args): pass
    with server(VLLM) as base:
        backend = ArtemisServerBackend(base+'/v1', 'server-secret', served_model='own-artemis-checkpoint')
        metadata = []
        assert backend.generate('saturn', 'Trusted', [{'role':'user','content':'hello<|system|>look-alike'}], metadata_sink=metadata.append) == 'Hello'
        assert ''.join(backend.stream('saturn', 'Trusted', [], metadata_sink=metadata.append)) == 'Hello'
        assert all(path == '/v1/chat/completions' for path, payload in seen)
        assert seen[0][1]['model'] == 'own-artemis-checkpoint'
        assert seen[0][1]['chat_template_kwargs'] == {'brain':'saturn'}
        assert seen[0][1]['messages'][-1]['content'] == 'hellolook-alike'
        assert any(data.get('usage', {}).get('total_tokens') == 6 for data in metadata if data.get('usage'))


def test_tools_store_authorized_code_arguments_and_output(service):
    biz, records, _, app, jobs = service
    user, _ = account(records); owner=user['id']; biz.set_plan(owner,'plus')
    class Python(Model):
        def stream(self,brain,system,messages,max_tokens=512):
            if messages[-1]['content'].startswith('<tool_result'):
                yield '42'
            else:
                yield '<tool_call>{"name":"run_python","arguments":{"code":"print(6*7)"}}</tool_call>'
    app.backend=Python();app.toolbox=Toolbox(None,LocalCodeRunner())
    cid=records.create(owner)['id']; request=jobs.submit(owner,cid,{'text':'Compute six times seven','idempotency_key':'python-log-request'})
    assert complete(records,owner,request['id'])['state']=='completed'
    exported=records.export(owner,cid)
    assert json.loads(exported['tool_events'][0]['arguments']) == {'code':'print(6*7)'}
    assert json.loads(exported['tool_events'][0]['result'])['output'].strip()=='42'
    assert biz.used(owner,'tool_call')==1

@pytest.mark.parametrize('path,title', [('/account/', 'Sign in · Artemis AI'), ('/chat/', 'Chat · Artemis AI'), ('/products/', 'Products · Artemis AI')])
def test_live_site_directory_pages_are_served(service, path, title):
    _, records, _, app, jobs = service
    biz = service[0]
    with server(make_chat_handler(app, biz, records, jobs)) as base:
        with urllib.request.urlopen(base + path) as response:
            assert response.status == 200
            assert title in response.read().decode()


def test_directory_serving_does_not_expose_parent_files(service):
    biz, records, _, app, jobs = service
    with server(make_chat_handler(app, biz, records, jobs)) as base:
        with pytest.raises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(base + '/../configs/business.yaml')
        assert error.value.code == 404


# --- cross-origin app routes -------------------------------------------------
# The static site cannot proxy /api/*, so the browser calls api.<domain> from
# <domain>. These are the same site but different ORIGINS, so CORS applies even
# though SameSite=Lax still sends the cookie.

def test_preflight_grants_credentials_to_the_site_origin_only(service):
    biz, records, _, app, jobs = service
    with server(make_chat_handler(app, biz, records, jobs)) as base:
        code, head, _ = raw(base, '/api/conversations', method="OPTIONS", headers={"Origin": SITE})
        assert code == 204
        assert head.get("Access-Control-Allow-Origin") == SITE
        assert head.get("Access-Control-Allow-Credentials") == "true"
        # Without Vary, a cache in front of this can hand one origin's
        # allow-origin header to another. It is not optional.
        assert head.get("Vary") == "Origin"
        # Every write sends X-CSRF-Token; if it is not advertised here the
        # browser blocks the header and all writes fail.
        assert "X-CSRF-Token" in head.get("Access-Control-Allow-Headers", "")
        for verb in ("GET", "POST", "PATCH", "DELETE"):
            assert verb in head.get("Access-Control-Allow-Methods", "")


def test_preflight_tells_an_unknown_origin_nothing(service):
    biz, records, _, app, jobs = service
    with server(make_chat_handler(app, biz, records, jobs)) as base:
        code, head, _ = raw(base, '/api/conversations', method="OPTIONS", headers={"Origin": HOSTILE})
        assert code == 204
        assert "Access-Control-Allow-Origin" not in head
        assert "Access-Control-Allow-Credentials" not in head
        assert "Access-Control-Allow-Methods" not in head


def test_credentialed_response_echoes_the_exact_origin_never_a_wildcard(service):
    biz, records, _, app, jobs = service
    user, token = account(records)
    headers = {"Cookie": "artemis_session=" + token, "X-CSRF-Token": user["csrf"], "Origin": SITE}
    with server(make_chat_handler(app, biz, records, jobs)) as base:
        code, head, _ = raw(base, '/api/conversations', headers=headers)
        assert code == 200
        # A wildcard is invalid with credentials and the browser would reject
        # the response; it is also the classic way this gets made permissive.
        assert head.get("Access-Control-Allow-Origin") == SITE != "*"
        assert head.get("Access-Control-Allow-Credentials") == "true"
        assert head.get("Vary") == "Origin"


def test_a_hostile_origin_gets_no_cors_headers_on_a_real_response(service):
    biz, records, _, app, jobs = service
    user, token = account(records)
    with server(make_chat_handler(app, biz, records, jobs)) as base:
        code, head, _ = raw(base, '/api/conversations',
                            headers={"Cookie": "artemis_session=" + token,
                                     "X-CSRF-Token": user["csrf"], "Origin": HOSTILE})
        assert "Access-Control-Allow-Origin" not in head


def test_csrf_still_required_even_from_the_allowed_origin(service):
    """Enabling credentialed CORS must not turn the Origin check into the only lock."""
    biz, records, _, app, jobs = service
    _, token = account(records)
    with server(make_chat_handler(app, biz, records, jobs)) as base:
        code, _, _ = raw(base, '/api/conversations', {},
                         headers={"Cookie": "artemis_session=" + token, "Origin": SITE})
        assert code == 403                       # no X-CSRF-Token
        code, _, _ = raw(base, '/api/conversations', {},
                         headers={"Cookie": "artemis_session=" + token,
                                  "X-CSRF-Token": "wrong-token", "Origin": SITE})
        assert code == 403                       # wrong X-CSRF-Token


def test_a_cookie_write_with_no_origin_at_all_is_refused(service):
    """Browsers always send Origin on a write, so only a non-browser replaying
    a stolen cookie arrives without one. That used to pass the check."""
    biz, records, _, app, jobs = service
    user, token = account(records)
    with server(make_chat_handler(app, biz, records, jobs)) as base:
        code, _, _ = raw(base, '/api/conversations', {},
                         headers={"Cookie": "artemis_session=" + token, "X-CSRF-Token": user["csrf"]})
        assert code == 403
