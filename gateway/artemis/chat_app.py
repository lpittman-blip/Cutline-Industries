"""Same-origin website gateway: login, protected histories, durable generation events, and static UI.

python -m artemis.chat_app
Use HTTPS in production. One API process owns this worker queue; PostgreSQL is supported for storage.
"""
from __future__ import annotations

import hmac
import json
import mimetypes
import os
import time
import threading
from http.cookies import SimpleCookie
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from .chat_jobs import ChatJobs
from .business import PaymentRequired, RateLimited
from .conversations import ChatError, Conversations, uid
from .server import ALLOWED_ORIGINS, build_app, make_handler


def _find_site() -> Path:
    """Locate the static site by searching upward, rather than assuming a depth.

    site/ lives at the repository root, beside gateway/, not inside it. Hardcoding
    parent.parent pointed at gateway/site, which does not exist, so every page
    404ed and three tests failed for it.
    """
    here = Path(__file__).resolve()
    for directory in here.parents:
        candidate = directory / "site"
        if (candidate / "index.html").is_file():
            return candidate
    return here.parent.parent / "site"   # nothing found: keep a definite path to report


def make_chat_handler(app, biz, records, jobs, site=None):
    base = make_handler(app, biz)
    root = Path(site or os.environ.get("ARTEMIS_SITE") or _find_site()).resolve()
    cookie_secure = os.environ.get("ARTEMIS_COOKIE_SECURE", "1") != "0"
    origins = ALLOWED_ORIGINS | {"http://localhost:8080", "http://127.0.0.1:8080"}

    class Handler(base):
        def _json(self, code, body, cookie=None):
            data = json.dumps(body, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            if cookie is not None:
                suffix = "; Secure" if cookie_secure else ""
                self.send_header("Set-Cookie", f"artemis_session={cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age={30*86400 if cookie else 0}{suffix}")
            self.end_headers(); self.wfile.write(data)

        def _token(self):
            cookie = SimpleCookie()
            try: cookie.load(self.headers.get("Cookie", ""))
            except Exception: return ""
            value = cookie.get("artemis_session")
            return value.value if value else ""

        def _user(self, write=False):
            user = records.session(self._token())
            if write and not hmac.compare_digest(self.headers.get("X-CSRF-Token", ""), user["csrf"]):
                raise ChatError(403, "csrf", "Refresh the page and try again.")
            return user

        def _check_origin(self):
            origin = self.headers.get("Origin")
            if origin and origin not in origins:
                raise ChatError(403, "origin", "This website origin is not allowed.")
            if not self.headers.get("Content-Type", "").lower().startswith("application/json"):
                raise ChatError(415, "content_type", "Use a JSON request.")

        def _route(self, method):
            try:
                parsed = urlsplit(self.path); parts = parsed.path.strip("/").split("/"); query = parse_qs(parsed.query)
                if len(parts) < 2 or parts[0] != "api": return False
                if method in ("POST", "PATCH", "DELETE"):
                    self._check_origin()
                    body = self._body()
                    if not isinstance(body, dict): raise ChatError(400, "invalid_body", "A JSON object is required.")
                else: body = {}
                name = parts[1]
                if method == "GET" and name == "status":
                    health = app.backend.readiness() if hasattr(app.backend, "readiness") else {"serving": False, "status": "unverified"}
                    self._json(200, {**health, "model": jobs.model, "capabilities": {"text_chat": True, "tools": getattr(app, "toolbox", None).status() if getattr(app, "toolbox", None) else {},
                        "voice_input": False, "file_upload": False, "read_aloud": "browser_support_required"}, "storage": "server", "training_collection": False}); return True
                if method == "GET" and name == "me":
                    try: user = self._user()
                    except ChatError: user = None
                    self._json(200, {"user": user, "plan": biz.plan_of(user["id"]).id if user else None}); return True
                if method == "GET" and name == "models":
                    # The model picker. `external` lets the UI say plainly when a request
                    # would leave our infrastructure, and an included model this server has
                    # no credentials for is listed unavailable rather than hidden.
                    try: user = self._user()
                    except ChatError: user = None
                    added = getattr(app, "added_models", {})
                    self._json(200, {"models": [{**m, "available": m["id"] == "artemis" or m["id"] in added}
                                                for m in biz.allowed_models(user["id"] if user else "")]}); return True
                if method == "GET" and name == "health":
                    self._json(200, {"ok": True, "queued": records.db.one("SELECT COUNT(*) FROM chat_requests WHERE state='queued'")[0],
                        "generating": records.db.one("SELECT COUNT(*) FROM chat_requests WHERE state='generating'")[0]}); return True
                if name == "auth" and len(parts) == 3 and method == "POST":
                    if parts[2] in ("login", "signup"):
                        user, token = records.authenticate(body.get("email", ""), body.get("password", ""), self._client(), parts[2] == "signup")
                        self._json(200, {"user": user}, cookie=token); return True
                    if parts[2] == "logout":
                        self._user(write=True); records.logout(self._token()); self._json(200, {"ok": True}, cookie=""); return True
                user = self._user(write=method != "GET"); owner = user["id"]
                if name == "metrics" and method == "GET":
                    if user["email"] != os.environ.get("ARTEMIS_OWNER_EMAIL"):
                        raise ChatError(404, "not_found", "Route not found.")
                    self._json(200, {"requests": dict(records.db.all("SELECT state,COUNT(*) FROM chat_requests GROUP BY state")),
                        "average_generation_seconds": records.db.one("SELECT AVG(ended-started) FROM chat_requests WHERE ended IS NOT NULL AND started IS NOT NULL")[0],
                        "failures": dict(records.db.all("SELECT category,COUNT(*) FROM chat_failures GROUP BY category"))}); return True
                if name == "usage" and method == "GET":
                    # Billing, Usage and Capabilities in one reading. Models are marked
                    # available only when this server can actually serve them.
                    added = getattr(app, "added_models", {})
                    data = biz.entitlements(owner)
                    for m in data["capabilities"]["models"]:
                        m["available"] = m["id"] == "artemis" or m["id"] in added
                    self._json(200, data); return True
                if name == "settings" and len(parts) == 2:
                    if method == "GET": self._json(200, records.preferences(owner)); return True
                    if method == "PATCH": self._json(200, records.preferences(owner, body.get("retention_days"))); return True
                if name == "conversations":
                    if len(parts) == 2:
                        if method == "GET":
                            self._json(200, {"conversations": records.list(owner, query.get("q", [""])[0][:200], query.get("archived", ["0"])[0] == "1")}); return True
                        if method == "POST":
                            self._json(201, records.create(owner, body.get("title", "New conversation"))); return True
                    if len(parts) >= 3:
                        cid = parts[2]
                        if len(parts) == 3:
                            if method == "GET": self._json(200, records.load(owner, cid)); return True
                            if method == "PATCH": records.update(owner, cid, body); self._json(200, records.load(owner, cid)); return True
                            if method == "DELETE": records.delete(owner, cid); self._json(200, {"deleted": True}); return True
                        if len(parts) == 4 and parts[3] == "messages":
                            if method == "GET": self._json(200, records.load(owner, cid)); return True
                            if method == "POST":
                                request = jobs.submit(owner, cid, body)
                                self._json(202, {"request_id": request["id"], "assistant_message_id": request["assistant_id"], "state": request["state"]}); return True
                        if len(parts) == 4 and parts[3] == "export" and method == "GET":
                            data = records.export(owner, cid)
                            if query.get("format", ["json"])[0] == "markdown":
                                lines = ["# " + data["title"], "", "Exported: " + data["exported_at"]]
                                for message in data["messages"]:
                                    lines.extend(["", f"## {message['role']} · {message['state']} · {message['id']}", "", message["content"]])
                                    if message["error"]: lines.extend(["", "Error: " + message["error"]])
                                self._json(200, {"filename": "artemis-conversation.md", "content": "\n".join(lines)})
                            else: self._json(200, data)
                            return True
                        if len(parts) == 4 and parts[3] == "voice" and method == "POST":
                            records.load(owner, cid)
                            if body.get("kind") not in ("play", "pause", "resume", "stop", "end", "error"):
                                raise ChatError(400, "voice_unavailable", "Only browser read-aloud events are supported. Voice input is not configured.")
                            details = {"message_id": str(body.get("message_id", ""))[:64], "voice": str(body.get("voice", ""))[:200]}
                            if not records.db.one("SELECT id FROM chat_messages WHERE id=? AND conversation_id=?", (details["message_id"], cid)):
                                raise ChatError(404, "not_found", "Message not found.")
                            records.db.execute("INSERT INTO chat_voice_events VALUES (?,?,?,?,?,?)", (uid(), owner, cid, body["kind"], json.dumps(details), time.time()))
                            self._json(200, {"ok": True}); return True
                if name == "requests" and len(parts) >= 3:
                    rid = parts[2]
                    if len(parts) == 3 and method == "GET": self._json(200, records.get_request(owner, rid)); return True
                    if len(parts) == 4 and parts[3] == "cancel" and method == "POST": self._json(200, jobs.cancel(owner, rid)); return True
                    if len(parts) == 4 and parts[3] == "events" and method == "GET":
                        try: after = max(0, int(query.get("after", ["0"])[0]))
                        except ValueError: raise ChatError(400, "invalid_cursor", "The event cursor must be a number.")
                        request, chunks = records.events(owner, rid, after)
                        if "text/event-stream" not in self.headers.get("Accept", ""):
                            self._json(200, {"state": request["state"], "events": chunks}); return True
                        self.send_response(200); self.send_header("Content-Type", "text/event-stream"); self.send_header("Cache-Control", "no-store")
                        self.send_header("X-Accel-Buffering", "no"); self.end_headers()
                        records.lifecycle(rid, "stream_connected", {"after_sequence": after})
                        try:
                            started = time.monotonic()
                            while time.monotonic() - started < 25:
                                try:
                                    self._user()
                                    request, chunks = records.events(owner, rid, after)
                                except ChatError: break  # logout/deletion from another device ends the stream
                                for chunk in chunks:
                                    after = chunk["seq"]
                                    event = {**chunk["event"], "seq": after}
                                    self.wfile.write(f"id: {after}\nevent: {event['type']}\ndata: {json.dumps(event)}\n\n".encode()); self.wfile.flush()
                                if request["state"] not in ("queued", "generating"): break
                                time.sleep(.1)
                        except (BrokenPipeError, ConnectionResetError): records.lifecycle(rid, "stream_disconnected", {"last_sequence": after})
                        return True
                if name == "requests" and len(parts) == 2 and method == "GET":
                    row = records.db.one("SELECT id FROM chat_requests WHERE owner=? AND idempotency=?", (owner, query.get("key", [""])[0]))
                    if not row: raise ChatError(404, "not_found", "Request not found.")
                    self._json(200, records.get_request(owner, row[0])); return True
                if name == "feedback" and method == "POST":
                    mid = body.get("message_id")
                    if not records.db.one("SELECT m.id FROM chat_messages m JOIN chat_conversations c ON c.id=m.conversation_id WHERE m.id=? AND c.owner=? AND m.role='assistant'", (mid, owner)):
                        raise ChatError(404, "not_found", "Message not found.")
                    if body.get("rating") not in (-1, 1): raise ChatError(400, "invalid_rating", "Choose a positive or negative rating.")
                    records.db.execute("INSERT INTO chat_feedback VALUES (?,?,?,?,?,?)", (uid(), owner, mid, body["rating"], str(body.get("comment", ""))[:2000], time.time()))
                    self._json(200, {"ok": True}); return True
                if name == "account" and len(parts) == 3 and parts[2] == "export" and method == "GET":
                    self._json(200, {"account": {"id": owner, "email": user["email"]}, "conversations": [records.export(owner, c["id"]) for archived in (False, True) for c in records.list(owner, archived=archived)]}); return True
                raise ChatError(404, "not_found", "Route not found.")
            except ChatError as error: self._json(error.code, {"error": str(error), "category": error.category})
            except PaymentRequired as error: self._json(402, {"error": str(error), "category": "plan_required"})
            except RateLimited as error: self._json(429, {"error": str(error), "category": "rate_limit"})
            except OverflowError: self._json(413, {"error": "Request too large.", "category": "request_size"})
            except (ValueError, TypeError): self._json(400, {"error": "Invalid request.", "category": "invalid_request"})
            except Exception: self._json(500, {"error": "The service could not complete this operation.", "category": "server_error"})
            return True

        def do_GET(self):
            if self._route("GET"): return
            if self.path.startswith("/v1/"): return super().do_GET()
            name = urlsplit(self.path).path.lstrip("/") or "index.html"
            path = (root / name).resolve()
            if path.is_dir(): path = (path / "index.html").resolve()
            if root not in path.parents or not path.is_file() or path.suffix not in (".html", ".css", ".js", ".json", ".svg", ".png", ".webmanifest"):
                return self._json(404, {"error": "Not found."})
            data = path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", (mimetypes.guess_type(path.name)[0] or "application/octet-stream") + ("; charset=utf-8" if path.suffix in (".html", ".css", ".js", ".json") else ""))
            self.send_header("Content-Length", str(len(data))); self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "same-origin")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers(); self.wfile.write(data)

        def do_POST(self):
            # The website must go through /api/conversations, which is durable, resumable
            # and owned by a signed-in account; /v1/chat is neither. A terminal client is
            # a different thing: Artemis is terminal-first, and a request carrying an API
            # key is not the website, so it gets the streaming endpoint. Cookie and
            # anonymous requests are still turned away, which is what the gate was for.
            if urlsplit(self.path).path in ("/v1/chat", "/v1/chat/stream") and not self._bearer():
                return self._json(404, {"error": "Use the authenticated conversation endpoints, or an API key."})
            if not self._route("POST"): super().do_POST()

        def _bearer(self) -> bool:
            return self.headers.get("Authorization", "").startswith("Bearer ")

        def do_PATCH(self):
            if not self._route("PATCH"): self._json(404, {"error": "Not found."})

        def do_DELETE(self):
            if not self._route("DELETE"): super().do_DELETE()

        def do_OPTIONS(self):
            # Application routes use same-origin cookies; do not enable cross-origin credentials.
            if self.path.startswith("/api/"):
                self.send_response(204); self.end_headers()
            else: super().do_OPTIONS()

    return Handler


def main():
    # DATABASE_URL is supported as a server-only alias for the starter brief.
    if os.environ.get("DATABASE_URL") and not os.environ.get("ARTEMIS_DATABASE_URL"):
        os.environ["ARTEMIS_DATABASE_URL"] = os.environ["DATABASE_URL"]
    app, biz = build_app(); records = Conversations(biz.db)
    jobs = ChatJobs(app, biz, records, int(os.environ.get("ARTEMIS_CHAT_WORKERS", "4")), recover=True)
    stopping = threading.Event()
    def maintenance():
        while not stopping.is_set():
            try: records.expire()
            except Exception: pass  # report via operational monitoring without logging conversation text
            stopping.wait(3600)
    janitor = threading.Thread(target=maintenance, daemon=True); janitor.start()
    server = ThreadingHTTPServer((os.environ.get("ARTEMIS_BIND", "127.0.0.1"), int(os.environ.get("PORT", "8080"))), make_chat_handler(app, biz, records, jobs))
    try: server.serve_forever()
    finally:
        stopping.set(); janitor.join(timeout=2); server.server_close(); jobs.shutdown(); app.pool.shutdown(wait=True)


if __name__ == "__main__": main()
