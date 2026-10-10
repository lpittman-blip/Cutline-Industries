"""Durable generation records with a bounded, single-process worker pool and replayable events."""
from __future__ import annotations

import json
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from .backends import ArtemisServerBackend, LocalBackend
from .business import PaymentRequired, RateLimited
from .conversations import ChatError, Conversations, uid
from .orchestrator import Artemis, ToolAccess
from .tools import session_id
from .chat_format import clean


class GenerationStopped(Exception): pass


class _Brainless:
    """Adapts an added-service backend to the brain-indexed signature used here.

    Artemis's own backends take a brain (a vLLM adapter, or a line in the system
    prompt). A third-party model has no brains, so the id is accepted and dropped
    rather than smuggled into the request as if the provider understood it.
    """

    accepts_metadata_sink = True

    def __init__(self, inner):
        self.inner = inner

    def generate(self, brain, system, messages, max_tokens=512, metadata_sink=None):
        return self.inner.generate(system, messages, max_tokens, metadata_sink=metadata_sink)

    def stream(self, brain, system, messages, max_tokens=512, metadata_sink=None):
        yield from self.inner.stream(system, messages, max_tokens, metadata_sink=metadata_sink)


class RecordingBackend:
    def __init__(self, jobs, request, backend=None):
        self.jobs, self.request, self.backend = jobs, request, backend or jobs.app.backend
        self.context_ids = [m["id"] for m in jobs.records.context(request["owner"], request["id"])]
        self.metadata = {}
        self.lock = threading.Lock()

    def _call(self, brain, system, messages, max_tokens, streaming):
        self.jobs.check_cancelled(self.request["id"])
        system = clean(system)
        messages = [{"role": m["role"], "content": clean(m["content"])} for m in messages]
        if isinstance(self.backend, LocalBackend):
            count = len(self.backend.model.prompt_ids(messages, brain, system))
            limit = self.backend.model.model.cfg.max_seq_len
        else:
            # A conservative byte bound, not a claim to know a novel checkpoint's tokenizer.
            count = len((system + "".join(m["content"] for m in messages)).encode()) + 256
            limit = self.jobs.context_limit
        if count + max_tokens > limit:
            raise ChatError(422, "context_limit", "This branch exceeds the configured model context limit. Start a shorter branch; saved messages are retained.")
        call_id, now = uid(), time.time()
        settings = {"max_tokens": max_tokens, "stream": streaming, "context_message_ids": self.context_ids,
                    "chat_template_kwargs": {"brain": brain},
                    "context_count": count, "context_count_method": "tokenizer" if isinstance(self.backend, LocalBackend) else "conservative_utf8_bytes"}
        self.jobs.db.execute("INSERT INTO chat_model_calls VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)",
            (call_id, self.request["id"], brain, self.jobs.redact(system), json.dumps(self.jobs.redact(messages)),
             json.dumps(settings), self.request["model"], "", "{}", "generating", now))
        metadata, output = {}, []
        def capture(data):
            for key, value in data.items():
                if value is not None: metadata[key] = value
        try:
            if streaming:
                if isinstance(self.backend, ArtemisServerBackend) or getattr(self.backend, "accepts_metadata_sink", False):
                    iterator = self.backend.stream(brain, system, messages, max_tokens, metadata_sink=capture)
                elif hasattr(self.backend, "stream"):
                    iterator = self.backend.stream(brain, system, messages, max_tokens)
                else:
                    iterator = iter([self.backend.generate(brain, system, messages, max_tokens)])
                try:
                    for piece in iterator:
                        self.jobs.check_cancelled(self.request["id"])
                        output.append(piece)
                        self.jobs.db.execute("UPDATE chat_model_calls SET output=? WHERE id=?", (self.jobs.redact("".join(output)), call_id))
                        yield piece
                finally:
                    close = getattr(iterator, "close", None)
                    if close: close()
            else:
                reply = (self.backend.generate(brain, system, messages, max_tokens, metadata_sink=capture)
                         if isinstance(self.backend, ArtemisServerBackend) or getattr(self.backend, "accepts_metadata_sink", False)
                         else self.backend.generate(brain, system, messages, max_tokens))
                self.jobs.check_cancelled(self.request["id"])
                output.append(reply); yield reply
            state = "completed"
        except BaseException:
            state = "failed"
            raise
        finally:
            self.jobs.db.execute("UPDATE chat_model_calls SET output=?,metadata=?,state=?,ended=? WHERE id=?",
                (self.jobs.redact("".join(output)), json.dumps(metadata), locals().get("state", "failed"), time.time(), call_id))
            with self.lock: self.metadata = metadata

    def generate(self, brain, system, messages, max_tokens=512):
        return "".join(self._call(brain, system, messages, max_tokens, False))

    def stream(self, brain, system, messages, max_tokens=512):
        yield from self._call(brain, system, messages, max_tokens, True)


class ChatJobs:
    def __init__(self, app, biz, records: Conversations, workers=4, recover=False):
        self.app, self.biz, self.records, self.db = app, biz, records, records.db
        self.context_limit = int(os.environ.get("ARTEMIS_CONTEXT_TOKENS", "4096"))
        self.pool = ThreadPoolExecutor(max_workers=workers)
        self.model = getattr(app.backend, "served_model", None) or ("Artemis local checkpoint" if isinstance(app.backend, LocalBackend) else "Artemis")
        self.secrets = [os.environ.get(k) for k in ("VLLM_API_KEY", "ARTEMIS_INFERENCE_KEY", "ARTEMIS_DATABASE_URL", "DATABASE_URL", "IDENTITY_HEADER") if os.environ.get(k)]
        if recover:
            # This deployment mode uses one API process. Do not run this recovery in active replicas.
            for row in self.db.all("SELECT id,owner,assistant_id FROM chat_requests WHERE state IN ('queued','generating')"):
                self.finish(row[0], row[2], "failed", "restart", "The server restarted before this reply completed. Partial output was retained.")

    def redact(self, value):
        if isinstance(value, dict):
            return {k: "[redacted]" if re.search(r"authorization|cookie|password|api.?key|access.?token|credential", k, re.I) else self.redact(v) for k, v in value.items()}
        if isinstance(value, list): return [self.redact(v) for v in value]
        if isinstance(value, str):
            for secret in self.secrets: value = value.replace(secret, "[redacted]")
            return re.sub(r"Bearer\s+[A-Za-z0-9._~-]+", "Bearer [redacted]", value, flags=re.I)
        return value

    def submit(self, owner, cid, body):
        previous = self.db.one("SELECT settings,model FROM chat_requests WHERE owner=? AND idempotency=?", (owner, body.get("idempotency_key", "")))
        if previous:
            request = self.records.request(owner, cid, body, json.loads(previous[0]), previous[1])[0]
            self.records.lifecycle(request["id"], "delivery_retry")
            return request
        tier = self.biz.authorize_chat(owner, None, None)
        model = self.select_model(owner, body.get("model"))
        settings = {"tier": tier, "max_tokens": 512, "context_limit": self.context_limit, "model": model}
        request, created = self.records.request(owner, cid, body, settings, self.model_label(model))
        if created:
            self.records.lifecycle(request["id"], "created")
            self.records.emit(request["id"], {"type": "state", "state": "queued", "request_id": request["id"]})
            self.pool.submit(self.run, request)
        return request

    def select_model(self, owner, requested):
        """Which model answers this message. Defaults to Artemis: never to a third party.

        A model the plan does not include raises PaymentRequired; one it includes but
        this server has no credentials for fails here rather than being answered by
        Artemis, which would bill for a service not delivered.
        """
        model = str(requested or "artemis")
        self.biz.authorize_model(owner, model)
        if model != "artemis" and model not in getattr(self.app, "added_models", {}):
            raise ChatError(503, "model_unavailable",
                            "That model is included in your plan but is not configured on this server.")
        return model

    def model_label(self, model):
        """What the record says answered, so a transcript never misattributes a reply."""
        if model == "artemis":
            return self.model
        spec = self.biz.model_spec(model)
        return f"{spec.get('display') or model} ({spec.get('provider') or 'third party'})"

    def check_cancelled(self, rid):
        row = self.db.one("SELECT cancelled FROM chat_requests WHERE id=?", (rid,))
        if not row or row[0]: raise GenerationStopped()

    def cancel(self, owner, rid):
        request = self.records.get_request(owner, rid)
        if request["state"] in ("queued", "generating"):
            self.db.execute("UPDATE chat_requests SET cancelled=1 WHERE id=? AND owner=?", (rid, owner))
            self.records.lifecycle(rid, "cancel_requested")
            self.records.emit(rid, {"type": "state", "state": "stopping"})
        return self.records.get_request(owner, rid)

    def reserve_tool(self, owner, name, allowed):
        if name not in allowed: raise PaymentRequired("This tool is not available for this request.")
        plan = self.biz.plan_of(owner)
        if name not in plan.tools: raise PaymentRequired("This tool is not included in your plan.")
        now, day = time.time(), self.biz._today()
        with self.db.transaction() as tx:
            # Serialize per-account reservations in PostgreSQL as well as SQLite.
            if self.db.postgres:
                tx.execute("SELECT pg_advisory_xact_lock(hashtext(?))", (owner,))
            used = tx.one("SELECT COALESCE(SUM(amount),0) FROM usage WHERE account=? AND day=? AND kind='tool_call'", (owner, day))[0]
            if used >= plan.tool_calls_per_day: raise RateLimited("Your daily tool limit has been reached.")
            tx.execute("INSERT INTO usage VALUES (?,?,?,?,?,?,?)", (owner, day, "tool_call", 1, name, 0.0, now))

    def finish(self, rid, assistant, state, category=None, detail=None, content=None, finish_reason=None):
        now = time.time()
        # Terminal record and terminal event commit together; reconnect never sees a terminal state without its event.
        with self.db.transaction() as tx:
            tx.execute("UPDATE chat_requests SET state=?,ended=?,error=?,finish_reason=? WHERE id=?", (state, now, category, finish_reason, rid))
            if content is None:
                tx.execute("UPDATE chat_messages SET state=?,error=? WHERE id=?", (state, detail, assistant))
            else:
                tx.execute("UPDATE chat_messages SET state=?,error=?,content=? WHERE id=?", (state, detail, content, assistant))
            if category:
                tx.execute("INSERT INTO chat_failures VALUES (?,?,?,?,?)", (uid(), rid, category, self.redact(detail or ""), now))
            row = tx.one("SELECT content FROM chat_messages WHERE id=?", (assistant,))
            event = {"type": "done" if state == "completed" else "error", "state": state, "status": "ok" if state == "completed" else category,
                     "answer": row[0] if row else "", "message": detail, "request_id": rid, "message_id": assistant}
            seq = tx.one("SELECT COALESCE(MAX(seq),0)+1 FROM chat_chunks WHERE request_id=?", (rid,))[0]
            tx.execute("INSERT INTO chat_chunks VALUES (?,?,?,?)", (rid, seq, json.dumps(event), now))

    def run(self, request):
        rid, assistant, owner = request["id"], request["assistant_id"], request["owner"]
        backend, child = None, None
        try:
            self.check_cancelled(rid)
            self.db.execute("UPDATE chat_requests SET state='generating',started=? WHERE id=?", (time.time(), rid))
            self.db.execute("UPDATE chat_messages SET state='generating' WHERE id=?", (assistant,))
            self.records.emit(rid, {"type": "state", "state": "generating", "request_id": rid})
            context = self.records.context(owner, rid)
            settings = json.loads(request["settings"])
            model = settings.get("model", "artemis")
            if model != "artemis":
                return self.run_added_model(request, model, context, settings)
            backend = RecordingBackend(self, request)
            child = Artemis(backend, brains=self.app.brains, use_model_router=self.app.use_model_router, memory=self.app.memory)
            toolbox = getattr(self.app, "toolbox", None)
            allowed = [name for name in self.biz.allowed_tools(owner) if toolbox and name in toolbox.available()]
            pending_tools = {}
            def trace_tool(call):
                if call["name"] in pending_tools:
                    self.db.execute("UPDATE chat_tool_events SET arguments=? WHERE id=?", (json.dumps(self.redact(call["arguments"])), pending_tools[call["name"]]))
            tools = ToolAccess(toolbox, allowed, session_id(owner), authorize=lambda name: self.reserve_tool(owner, name, allowed), trace=trace_tool) if toolbox else None
            messages = [{"role": m["role"], "content": m["content"]} for m in context]
            content = ""
            for event in child.handle_stream(messages[-1]["content"], settings["tier"], messages[:-1], account=owner, tools=tools):
                self.check_cancelled(rid)
                kind = event["type"]
                if kind == "token": content += event["text"]
                if kind == "replace": content = event["text"]
                if kind == "tool_call":
                    tid = uid(); pending_tools[event["name"]] = tid
                    self.db.execute("INSERT INTO chat_tool_events VALUES (?,?,?,?,?,NULL,?,NULL)",
                        (tid, rid, event["name"], "running", json.dumps(self.redact(event.get("arguments", {}))), time.time()))
                if kind == "tool_result" and event["name"] in pending_tools:
                    self.db.execute("UPDATE chat_tool_events SET state=?,result=?,ended=? WHERE id=?",
                        ("completed" if event["ok"] else "failed", json.dumps(self.redact(event)), time.time(), pending_tools.pop(event["name"])))
                if kind == "done":
                    if backend.metadata.get("finish_reason") == "length":
                        self.finish(rid, assistant, "failed", "reply_limit", "The model reached its reply limit. Partial output was retained.")
                    else:
                        self.finish(rid, assistant, "completed", content=event["answer"], finish_reason=backend.metadata.get("finish_reason") or "application_complete")
                        self.biz.record_message(owner)
                    return
                if kind in ("training", "error"):
                    self.finish(rid, assistant, "failed", event.get("status", "model_unavailable"), event.get("message", "The model is unavailable."))
                    return
                self.records.emit(rid, self.redact(event), assistant if kind in ("token", "replace") else None, content)
            self.finish(rid, assistant, "failed", "incomplete_stream", "Generation ended without a completed reply. Partial output was retained.")
        except GenerationStopped:
            self.finish(rid, assistant, "stopped", "cancelled", "Stopped. Partial output was retained.")
        except ChatError as error:
            self.finish(rid, assistant, "failed", error.category, str(error))
        except Exception:
            self.finish(rid, assistant, "failed", "generation_failed", "The request could not be completed. Your input and partial output were retained.")
        finally:
            self.db.execute("UPDATE chat_tool_events SET state='interrupted',ended=? WHERE request_id=? AND state='running'", (time.time(), rid))
            if child: child.pool.shutdown(wait=True, cancel_futures=True)

    def run_added_model(self, request, model, context, settings):
        """Answer with a third-party model the customer selected, as a straight passthrough.

        No plan, no specialists, no audit: an added service answers for itself. This is
        also what keeps Blueprint Decisions 5 and 12 intact - the orchestrator is never
        constructed here, so Artemis's own reasoning cannot reach an external model. The
        reply is recorded like any other, under a label naming the provider.
        """
        rid, assistant, owner = request["id"], request["assistant_id"], request["owner"]
        spec = self.biz.model_spec(model)
        system = (f"You are {spec.get('display') or model}, a third-party model offered through the "
                  f"Artemis platform as an added service. You are not Artemis and must not claim to "
                  f"be. Answer the user directly.")
        backend = RecordingBackend(self, request, backend=_Brainless(self.app.added_models[model]))
        messages = [{"role": m["role"], "content": m["content"]} for m in context]
        content = ""
        try:
            for piece in backend.stream(model, system, messages, settings.get("max_tokens", 512)):
                self.check_cancelled(rid)
                content += piece
                self.records.emit(rid, {"type": "token", "text": piece}, assistant, content)
        except GenerationStopped:
            raise
        except ChatError:
            raise
        except Exception:
            self.finish(rid, assistant, "failed", "model_unavailable",
                        f"{spec.get('display') or model} is unavailable right now. Partial output was retained.")
            return
        if not content.strip():
            self.finish(rid, assistant, "failed", "empty_response",
                        f"{spec.get('display') or model} returned no reply. Please retry.")
            return
        self.finish(rid, assistant, "completed", content=content,
                    finish_reason=backend.metadata.get("finish_reason") or "application_complete")
        self.biz.record_message(owner)

    def shutdown(self):
        self.pool.shutdown(wait=True, cancel_futures=True)
