"""Artemis preview: serve a partially trained Artemis checkpoint on CPU behind an OpenAI-style API.

This is Artemis's OWN weights (not an external model), but it is a PREVIEW: the first checkpoint
is a code-only pretrain (artemis-100m, step 5,250 of 22,533) with no chat tuning. It continues
text as source code. The gateway exposes it as the selectable "artemis-preview" model and labels
it that way; it is never the default.

  python -m artemis.preview_server --checkpoint /opt/artemis-preview/artemis-100m-step5250-bf16.pt \
      --tokenizer /opt/artemis-preview/tokenizer.json --port 8091

Endpoints (bind to 127.0.0.1 only; the gateway is the public face):
  GET  /health                  {"ok": true, "model": ..., "step": ...}  - no generation, cheap
  POST /v1/chat/completions     {"messages": [...], "max_tokens", "temperature", "top_p", "stream"}
"""
from __future__ import annotations

import argparse
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch

from . import checkpoint
from .tokenizer import load_tokenizer

MODEL_ID = "artemis-100m-step5250"
QUALITY = "preview, partially trained code model"
MAX_NEW_TOKENS = 200
MAX_PROMPT_CHARS = 2000
REPETITION_PENALTY = 1.15  # damps the loops a small, early checkpoint falls into


def build_prompt(messages: list[dict]) -> str:
    """The model was trained on source files only, so the user's message becomes a function docstring.

    Of the formats tried on the step-5,250 checkpoint (a "# Task:" comment, a module docstring, a
    comment followed by "def "), a docstring inside a function header kept the continuation on topic
    most often. Only the latest user message is used: the model has no notion of a conversation.
    """
    user = next((m.get("content", "") for m in reversed(messages) if m.get("role") == "user"), "")
    text = str(user)[-MAX_PROMPT_CHARS:].strip().replace('"""', "\'\'\'").replace("\\", "/")
    body = "\n    ".join(text.splitlines() or [""])
    if body.endswith('"'):
        body += " "  # a trailing quote would merge with the closing triple quote
    return f'def solution(*args):\n    """{body}"""\n'


class PreviewModel:
    def __init__(self, ckpt: str, tok: str, threads: int):
        torch.set_num_threads(threads)
        t = time.time()
        model, ck = checkpoint.load_model(ckpt)
        self.model = model.float().eval()  # bf16 on disk, fp32 compute (faster and exact on CPU)
        self.step = ck["step"]
        self.tok = load_tokenizer(tok)
        self.stop = {i for i in (self.tok.token_to_id("<|eos|>"), self.tok.token_to_id("<|end|>"),
                                 self.tok.token_to_id("<|bos|>")) if i is not None}
        self.lock = threading.Lock()
        self.load_seconds = round(time.time() - t, 2)

    @torch.no_grad()
    def stream(self, prompt: str, max_tokens: int, temperature: float, top_p: float, seed: int | None):
        """Yields (text_piece, finish_reason|None). One generation at a time."""
        max_tokens = max(1, min(int(max_tokens), MAX_NEW_TOKENS))
        temperature, top_p = max(float(temperature), 1e-3), min(max(float(top_p), 0.05), 1.0)
        gen = torch.Generator().manual_seed(seed if seed is not None else int(time.time() * 1000) % 2**31)
        with self.lock:
            idx = torch.tensor([self.tok.encode(prompt).ids])
            new, shown = [], ""
            yield "```python\n" + prompt, None
            for _ in range(max_tokens):
                logits, _ = self.model(idx[:, -self.model.cfg.max_seq_len:])
                last = logits[0, -1]
                if new:
                    seen = torch.tensor(sorted(set(new)))
                    vals = last[seen]
                    last[seen] = torch.where(vals > 0, vals / REPETITION_PENALTY, vals * REPETITION_PENALTY)
                probs = torch.softmax(last / temperature, -1)
                sp, si = torch.sort(probs, descending=True)
                sp = sp * ((torch.cumsum(sp, 0) - sp) < top_p)
                nxt = si[torch.multinomial(sp / sp.sum(), 1, generator=gen)]
                t = int(nxt)
                if t in self.stop:
                    yield "\n```", "stop"
                    return
                idx = torch.cat([idx, nxt.view(1, 1)], 1)
                new.append(t)
                text = self.tok.decode(new)
                if "\n\n\n" in text:  # two blank lines: the function ended; stop before an unrelated one
                    yield text[len(shown):text.index("\n\n\n")].rstrip() + "\n```", "stop"
                    return
                if len(text) > len(shown) and not text.endswith("\ufffd"):
                    yield text[len(shown):], None
                    shown = text
            yield "\n```", "length"


def make_handler(lm: PreviewModel):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            pass  # no request bodies in logs

        def _json(self, code, body):
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == "/health":
                return self._json(200, {"ok": True, "model": MODEL_ID, "step": lm.step, "quality": QUALITY,
                                        "load_seconds": lm.load_seconds, "busy": lm.lock.locked()})
            self._json(404, {"error": "not found"})

        def do_POST(self):
            if self.path != "/v1/chat/completions":
                return self._json(404, {"error": "not found"})
            try:
                n = int(self.headers.get("Content-Length", "0"))
                if n > 200_000:
                    return self._json(413, {"error": "too large"})
                req = json.loads(self.rfile.read(n) or b"{}")
                prompt = build_prompt(req.get("messages") or [])
                args = (prompt, req.get("max_tokens", MAX_NEW_TOKENS), req.get("temperature", 0.7),
                        req.get("top_p", 0.9), req.get("seed"))
            except (ValueError, TypeError, AttributeError):
                return self._json(400, {"error": "invalid request"})
            created, rid = int(time.time()), f"preview-{time.time_ns()}"
            if not req.get("stream"):
                parts, finish = [], "length"
                for piece, fin in lm.stream(*args):
                    parts.append(piece)
                    finish = fin or finish
                return self._json(200, {"id": rid, "object": "chat.completion", "created": created, "model": MODEL_ID,
                                        "choices": [{"index": 0, "finish_reason": finish,
                                                     "message": {"role": "assistant", "content": "".join(parts)}}]})
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            try:
                for piece, fin in lm.stream(*args):
                    chunk = {"id": rid, "object": "chat.completion.chunk", "created": created, "model": MODEL_ID,
                             "choices": [{"index": 0, "delta": {"content": piece} if piece else {},
                                          "finish_reason": fin}]}
                    self.wfile.write(b"data: " + json.dumps(chunk).encode() + b"\n\n")
                    self.wfile.flush()
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass

    return Handler


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", default=os.environ.get("ARTEMIS_PREVIEW_CHECKPOINT"))
    ap.add_argument("--tokenizer", default=os.environ.get("ARTEMIS_PREVIEW_TOKENIZER"))
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=int(os.environ.get("ARTEMIS_PREVIEW_PORT", "8091")))
    ap.add_argument("--threads", type=int, default=int(os.environ.get("ARTEMIS_PREVIEW_THREADS", "2")))
    a = ap.parse_args(argv)
    lm = PreviewModel(a.checkpoint, a.tokenizer, a.threads)
    print(f"artemis-preview: {MODEL_ID} step {lm.step} loaded in {lm.load_seconds}s on {a.host}:{a.port}", flush=True)
    ThreadingHTTPServer((a.host, a.port), make_handler(lm)).serve_forever()


if __name__ == "__main__":
    main()
