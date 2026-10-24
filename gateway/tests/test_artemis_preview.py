"""artemis-preview: Artemis's own partially trained checkpoint, selectable per message, never the default."""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from artemis.backends import ArtemisPreviewBackend
from artemis.preview_server import build_prompt
from artemis.server import added_models


class _Fake(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        data = json.dumps({"ok": True, "step": 5250}).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.send_response(200); self.end_headers()
        if body.get("stream"):
            for piece in ("def ", "f():"):
                self.wfile.write(b"data: " + json.dumps({"choices": [{"delta": {"content": piece}}]}).encode() + b"\n\n")
            self.wfile.write(b"data: " + json.dumps({"choices": [{"delta": {}, "finish_reason": "stop"}]}).encode() + b"\n\n")
            self.wfile.write(b"data: [DONE]\n\n")
        else:
            self.wfile.write(json.dumps({"choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}]}).encode())


def _serve():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _Fake)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"


def test_only_wired_when_configured(monkeypatch):
    monkeypatch.delenv("ARTEMIS_PREVIEW_URL", raising=False)
    monkeypatch.delenv("XAI_API_KEY", raising=False); monkeypatch.delenv("GROK_API_KEY", raising=False)
    assert "artemis-preview" not in added_models()
    monkeypatch.setenv("ARTEMIS_PREVIEW_URL", "http://127.0.0.1:8091")
    assert isinstance(added_models()["artemis-preview"], ArtemisPreviewBackend)


def test_labels_are_honest_and_streaming_works():
    srv, base = _serve()
    try:
        b = ArtemisPreviewBackend(base)
        r = b.readiness()
        assert r["serving"] and r["external"] is False and r["quality"] == "preview, partially trained code model"
        meta = {}
        assert "".join(b.stream("sys", [{"role": "user", "content": "q"}], 50, metadata_sink=meta.update)) == "def f():"
        assert meta["provider"] == "artemis-preview" and meta["finish_reason"] == "stop"
    finally:
        srv.shutdown()


def test_unreachable_server_reports_unavailable():
    r = ArtemisPreviewBackend("http://127.0.0.1:9").readiness()
    assert r["serving"] is False and r["status"] == "unavailable"


def test_prompt_is_a_docstring_of_the_latest_user_message():
    p = build_prompt([{"role": "user", "content": "old"}, {"role": "assistant", "content": "x"},
                      {"role": "user", "content": 'say """hi"'}])
    assert p.startswith("def solution(*args):\n    \"\"\"say '''hi\" \"\"\"") and "old" not in p
