"""Where brain replies come from.

Every backend here runs Artemis's own weights except two, and both are deliberate:

  AzureAIBackend - "Artemis 0", an explicitly-opted-in bootstrap for standing the
    orchestrator, experts and tools up before the first checkpoint passes evaluation.
    Never selected by default, and meant to be removed once LocalBackend or
    ArtemisServerBackend can serve.

  GrokBackend - a third-party model a plan may include as an added service, reached
    only when a customer selects it for their own message.

Blueprint Decisions 5 and 12 keep both out of Artemis's OWN reasoning: neither is
chosen by default, each announces itself as external in readiness(), and each marks
every reply external to its metadata sink so nothing downstream can present its
output as Artemis's work.
"""
from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request
from typing import Iterator, Protocol
from .chat_format import clean


class ModelNotReady(RuntimeError):
    """Raised while Artemis's own model has not yet passed evaluation."""


class ModelUnavailable(RuntimeError):
    """A configured inference service failed; this does not mean it is training."""


class Backend(Protocol):
    def generate(self, brain: str, system: str, messages: list[dict], max_tokens: int = 512) -> str: ...

    def stream(self, brain: str, system: str, messages: list[dict], max_tokens: int = 512) -> Iterator[str]: ...


class NotReadyBackend:
    """Used until the first Artemis model passes its evaluation gate."""

    def readiness(self):
        return {"configured": False, "serving": False, "status": "training", "quality": "unverified"}

    def generate(self, brain, system, messages, max_tokens=512):
        raise ModelNotReady("Artemis is still training; chat opens when the first model passes evaluation.")

    def stream(self, brain, system, messages, max_tokens=512):
        raise ModelNotReady("Artemis is still training; chat opens when the first model passes evaluation.")


class LocalBackend:
    """Artemis's own checkpoint loaded in this process (artemis/infer.py): the Prime Core and its experts run here."""

    def __init__(self, checkpoint_path: str, tokenizer_path: str):
        from .infer import LocalModel  # torch is only needed when a checkpoint is configured
        self.model = LocalModel(checkpoint_path, tokenizer_path)

    def generate(self, brain, system, messages, max_tokens=512):
        return self.model.generate(messages, brain, system, max_tokens)

    def stream(self, brain, system, messages, max_tokens=512):
        yield from self.model.stream(messages, brain, system, max_tokens)

    def readiness(self):
        return {"configured": True, "serving": True, "status": "loaded", "quality": "unverified"}


class ArtemisServerBackend:
    """Artemis's own inference server (vLLM serving the foundation plus one adapter per brain).

    vLLM exposes an OpenAI-compatible HTTP API; `model` selects the brain's adapter.
    """

    def __init__(self, base_url: str, api_key: str = "", timeout: float = 60.0, served_model: str | None = None):
        base = base_url.rstrip("/")
        self.base_url, self.api_key, self.timeout = (base[:-3] if base.endswith("/v1") else base), api_key, timeout
        self.served_model = served_model
        self._health_lock = threading.Lock()
        self._health = None
        self._health_at = 0.0

    def readiness(self):
        """Probe an actual generation, cached for 15 seconds. Availability is not a quality evaluation."""
        with self._health_lock:
            if self._health is not None and time.monotonic() - self._health_at < 15:
                return dict(self._health)
            probe = ArtemisServerBackend(self.base_url, self.api_key, min(self.timeout, 5.0), self.served_model)
            try:
                reply = probe.generate("artemis", "Reply briefly.", [{"role": "user", "content": "Hello"}], 8)
                available = isinstance(reply, str) and bool(reply.strip())
            except ModelUnavailable:
                available = False
            self._health = {"configured": True, "serving": available,
                            "status": "available" if available else "unavailable", "quality": "unverified"}
            self._health_at = time.monotonic()
            return dict(self._health)

    def generate(self, brain, system, messages, max_tokens=512, metadata_sink=None):
        body = json.dumps({"model": self.served_model or brain, "max_tokens": max_tokens,
                           "chat_template_kwargs": {"brain": brain},
                           "messages": [{"role": "system", "content": clean(system)},
                                        *[{"role": m["role"], "content": clean(m["content"])} for m in messages]]}).encode()
        req = urllib.request.Request(f"{self.base_url}/v1/chat/completions", data=body,
                                     headers={"Content-Type": "application/json",
                                              **({"Authorization": f"Bearer {self.api_key}"} if self.api_key else {})})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                data = json.load(r)
                content = data["choices"][0]["message"]["content"]
                if not isinstance(content, str):
                    raise ValueError("invalid inference content")
                if metadata_sink:
                    metadata_sink({"usage": data.get("usage"), "finish_reason": data["choices"][0].get("finish_reason")})
                return content
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, KeyError, IndexError, TypeError) as e:
            raise ModelUnavailable("Artemis inference service is unavailable; please retry later.") from e

    def stream(self, brain, system, messages, max_tokens=512, metadata_sink=None):
        body = json.dumps({"model": self.served_model or brain, "max_tokens": max_tokens, "stream": True,
                           "stream_options": {"include_usage": True},
                           "chat_template_kwargs": {"brain": brain},
                           "messages": [{"role": "system", "content": clean(system)},
                                        *[{"role": m["role"], "content": clean(m["content"])} for m in messages]]}).encode()
        req = urllib.request.Request(f"{self.base_url}/v1/chat/completions", data=body,
                                     headers={"Content-Type": "application/json",
                                              **({"Authorization": f"Bearer {self.api_key}"} if self.api_key else {})})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                finished = False
                for raw in r:
                    line = raw.decode().strip()
                    if line == "data: [DONE]":
                        finished = True
                        break
                    if not line.startswith("data:"):
                        continue
                    data = json.loads(line[5:])
                    if "error" in data:
                        raise ModelUnavailable("Artemis inference service returned an error; please retry later.")
                    choices = data.get("choices", [])
                    if metadata_sink and (data.get("usage") or any(c.get("finish_reason") for c in choices)):
                        metadata_sink({"usage": data.get("usage"), "finish_reason": choices[0].get("finish_reason") if choices else None})
                    if not choices:  # optional usage-only chunk
                        continue
                    piece = choices[0].get("delta", {}).get("content")
                    if piece:
                        if not isinstance(piece, str):
                            raise ValueError("invalid inference content")
                        yield piece
                if not finished:
                    raise ModelUnavailable("Artemis inference stream ended early; please retry later.")
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, KeyError, IndexError, TypeError) as e:
            raise ModelUnavailable("Artemis inference service is unavailable; please retry later.") from e


class AzureAIBackend(ArtemisServerBackend):
    """Artemis 0: the full stack on a hosted Azure AI Services model, pending Artemis's own.

    THIS IS NOT ARTEMIS. It runs an external provider's model, which Blueprint Decisions 5
    and 12 forbid for product code and Artemis decisions. It exists so the orchestrator, the
    ten experts, the tools and the decision engine can be exercised end to end while the real
    model trains, and it is wired so nothing can mistake it for the real thing:

      - never chosen unless ARTEMIS_BOOTSTRAP_AZURE=1 is set explicitly
      - readiness() reports model="external" and quality="not-artemis"
      - every reply carries `external: True` to any metadata sink

    Azure AI Services speaks the OpenAI chat-completions API, so only the URL shape, the auth
    header and the deployment-name mapping differ from ArtemisServerBackend.
    """

    #: Azure routes by DEPLOYMENT name, not by brain. One deployment serves every brain, so
    #: the brain survives in the system prompt rather than in `model` as vLLM adapters do.
    def __init__(self, endpoint: str, api_key: str, deployment: str,
                 api_version: str = "2024-10-21", timeout: float = 60.0):
        if not api_key:
            raise ValueError("AzureAIBackend needs an api_key; read it from Key Vault, never hardcode it")
        super().__init__(endpoint, api_key, timeout, served_model=deployment)
        self.deployment = deployment
        self.api_version = api_version

    def _url(self) -> str:
        return (f"{self.base_url}/openai/deployments/{self.deployment}"
                f"/chat/completions?api-version={self.api_version}")

    def _headers(self) -> dict:
        # Azure uses api-key, not Authorization: Bearer.
        return {"Content-Type": "application/json", "api-key": self.api_key}

    def _body(self, brain, system, messages, max_tokens, stream=False) -> bytes:
        # No chat_template_kwargs: that is a vLLM extension and Azure rejects unknown fields.
        body = {"max_tokens": max_tokens,
                "messages": [{"role": "system", "content": clean(f"You are the {brain} brain of Artemis.\n{system}")},
                             *[{"role": m["role"], "content": clean(m["content"])} for m in messages]]}
        if stream:
            body["stream"] = True
        return json.dumps(body).encode()

    def readiness(self):
        """Probe this backend, cached for 15 seconds.

        Deliberately does NOT call super().readiness(): the parent builds its probe as
        ArtemisServerBackend(...), hardcoding its own class, so an inherited probe would
        hit the vLLM URL with a Bearer header against an Azure endpoint and always report
        serving=False while generate() worked fine. Observed live before this override.
        """
        with self._health_lock:
            if self._health is not None and time.monotonic() - self._health_at < 15:
                return dict(self._health)
            probe = AzureAIBackend(self.base_url, self.api_key, self.deployment,
                                   api_version=self.api_version, timeout=min(self.timeout, 5.0))
            try:
                reply = probe.generate("artemis", "Reply briefly.",
                                       [{"role": "user", "content": "Hello"}], 8)
                available = isinstance(reply, str) and bool(reply.strip())
            except ModelUnavailable:
                available = False
            self._health = {"configured": True, "serving": available,
                            "status": "available" if available else "unavailable",
                            "model": "external", "provider": "azure-ai-services",
                            "deployment": self.deployment, "quality": "not-artemis",
                            "bootstrap": True}
            self._health_at = time.monotonic()
            return dict(self._health)

    def generate(self, brain, system, messages, max_tokens=512, metadata_sink=None):
        req = urllib.request.Request(self._url(), data=self._body(brain, system, messages, max_tokens),
                                     headers=self._headers())
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                data = json.load(r)
                content = data["choices"][0]["message"]["content"]
                if not isinstance(content, str):
                    raise ValueError("invalid inference content")
                if metadata_sink:
                    metadata_sink({"usage": data.get("usage"), "external": True,
                                   "finish_reason": data["choices"][0].get("finish_reason")})
                return content
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, KeyError, IndexError, TypeError) as e:
            raise ModelUnavailable("Artemis 0 bootstrap backend is unavailable; please retry later.") from e

    def stream(self, brain, system, messages, max_tokens=512, metadata_sink=None):
        req = urllib.request.Request(self._url(), data=self._body(brain, system, messages, max_tokens, stream=True),
                                     headers=self._headers())
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                for raw in r:
                    line = raw.decode().strip()
                    if line == "data: [DONE]":
                        break
                    if not line.startswith("data:"):
                        continue
                    data = json.loads(line[5:])
                    if "error" in data:
                        raise ModelUnavailable("Artemis 0 bootstrap backend returned an error; please retry later.")
                    for c in data.get("choices", []):
                        piece = (c.get("delta") or {}).get("content")
                        if piece:
                            yield piece
                if metadata_sink:
                    metadata_sink({"external": True})
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, KeyError, IndexError, TypeError) as e:
            raise ModelUnavailable("Artemis 0 bootstrap backend is unavailable; please retry later.") from e


#: The Grok model id, in ONE place. It was previously spelled three different
#: ways - "grok-4.20-non-reasoning" here and in server.py, "grok-4-fast-non-reasoning"
#: in artemis-cli - which is a transcription slip, not three deliberate choices.
#: A wrong id does not fail loudly: readiness() probes, the probe 404s, and the
#: status endpoint reports "unavailable", which reads as an outage rather than a
#: typo.
#:
#: UNVERIFIED. No live call has ever succeeded against xAI from this repo (see
#: artemis-cli/README.md: both keys on the build machine were rejected 400/401),
#: so neither spelling is confirmed. Settle it with a valid key and:
#:
#:     curl -sS https://api.x.ai/v1/models -H "Authorization: Bearer $XAI_API_KEY"
#:
#: then change this constant and configs/business.yaml together - a test asserts
#: they match, because the catalogue entry is what customers are shown.
GROK_DEFAULT_MODEL = "grok-4-fast-non-reasoning"


class GrokBackend:
    """Grok (xAI), offered to customers as an added service - never as Artemis.

    Artemis is sold as a platform, and a plan may include a third-party model alongside
    our own. That is a product decision, not a change to Blueprint Decisions 5 and 12:
    this backend is only ever reached when a CUSTOMER explicitly selects the grok model
    for their own message. Nothing in Artemis's own reasoning - planning, the ten
    experts, the Venus audit, the decision engine - may call it, which is why the server
    routes a grok request straight here instead of through the orchestrator.

    xAI speaks the OpenAI chat-completions API: `model` goes in the body (unlike Azure,
    which routes by deployment in the URL) and auth is `Authorization: Bearer` (unlike
    Azure's `api-key`). chat_template_kwargs is a vLLM extension and is rejected here,
    so it is omitted as it is for Azure.
    """

    def __init__(self, api_key: str, model: str = GROK_DEFAULT_MODEL,
                 base_url: str = "https://api.x.ai", timeout: float = 60.0):
        if not api_key:
            raise ValueError("GrokBackend needs an api_key; read it from Key Vault, never hardcode it")
        base = base_url.rstrip("/")
        self.base_url = base[:-3].rstrip("/") if base.endswith("/v1") else base
        self.api_key, self.model, self.timeout = api_key, model, timeout
        self._health_lock = threading.Lock()
        self._health = None
        self._health_at = 0.0

    def _url(self) -> str:
        return f"{self.base_url}/v1/chat/completions"

    def _headers(self) -> dict:
        return {"Content-Type": "application/json", "Authorization": f"Bearer {self.api_key}"}

    def _body(self, system: str, messages: list[dict], max_tokens: int, stream: bool = False) -> bytes:
        body = {"model": self.model, "max_tokens": max_tokens,
                "messages": [{"role": "system", "content": clean(system)},
                             *[{"role": m["role"], "content": clean(m["content"])} for m in messages]]}
        if stream:
            body["stream"] = True
        return json.dumps(body).encode()

    def readiness(self):
        """Probe a real generation, cached for 15 seconds.

        `model` is the provider's id, never "artemis", and quality is "not-artemis":
        nothing downstream may present a Grok answer as Artemis's own work.
        """
        with self._health_lock:
            if self._health is not None and time.monotonic() - self._health_at < 15:
                return dict(self._health)
            probe = GrokBackend(self.api_key, self.model, self.base_url, min(self.timeout, 5.0))
            try:
                reply = probe.generate("Reply briefly.", [{"role": "user", "content": "Hello"}], 8)
                available = isinstance(reply, str) and bool(reply.strip())
            except ModelUnavailable:
                available = False
            self._health = {"configured": True, "serving": available,
                            "status": "available" if available else "unavailable",
                            "model": self.model, "provider": "xai", "external": True,
                            "quality": "not-artemis"}
            self._health_at = time.monotonic()
            return dict(self._health)

    def generate(self, system: str, messages: list[dict], max_tokens: int = 512, metadata_sink=None) -> str:
        req = urllib.request.Request(self._url(), data=self._body(system, messages, max_tokens),
                                     headers=self._headers())
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                data = json.load(r)
                content = data["choices"][0]["message"]["content"]
                if not isinstance(content, str):
                    raise ValueError("invalid inference content")
                if metadata_sink:
                    metadata_sink({"usage": data.get("usage"), "external": True, "provider": "xai",
                                   "model": self.model,
                                   "finish_reason": data["choices"][0].get("finish_reason")})
                return content
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, KeyError, IndexError, TypeError) as e:
            raise ModelUnavailable("Grok is unavailable right now; please retry later.") from e

    def stream(self, system: str, messages: list[dict], max_tokens: int = 512, metadata_sink=None):
        req = urllib.request.Request(self._url(), data=self._body(system, messages, max_tokens, stream=True),
                                     headers=self._headers())
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                for raw in r:
                    line = raw.decode().strip()
                    if line == "data: [DONE]":
                        break
                    if not line.startswith("data:"):
                        continue
                    data = json.loads(line[5:])
                    if "error" in data:
                        raise ModelUnavailable("Grok returned an error; please retry later.")
                    for c in data.get("choices", []):
                        piece = (c.get("delta") or {}).get("content")
                        if piece:
                            if not isinstance(piece, str):
                                raise ValueError("invalid inference content")
                            yield piece
                if metadata_sink:
                    metadata_sink({"external": True, "provider": "xai", "model": self.model})
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, KeyError, IndexError, TypeError) as e:
            raise ModelUnavailable("Grok is unavailable right now; please retry later.") from e


ARTEMIS_PREVIEW_MODEL = "artemis-100m-step5250"
ARTEMIS_PREVIEW_QUALITY = "preview, partially trained code model"


class ArtemisPreviewBackend:
    """Artemis's OWN partially trained checkpoint, served by artemis/preview_server.py on CPU.

    Selectable as the "artemis-preview" model, never the default. It is a code-only pretrain
    (artemis-100m at step 5,250 of 22,533, no chat tuning), so it answers by continuing source
    code. readiness() and every reply's metadata say so: quality is
    "preview, partially trained code model", external is False (these are our weights).

    Same added-service signature as GrokBackend: generate/stream(system, messages, max_tokens).
    """

    def __init__(self, base_url: str, timeout: float = 180.0, model: str = ARTEMIS_PREVIEW_MODEL):
        base = base_url.rstrip("/")
        self.base_url = base[:-3].rstrip("/") if base.endswith("/v1") else base
        self.timeout, self.model = timeout, model
        self._health_lock = threading.Lock()
        self._health = None
        self._health_at = 0.0

    def _meta(self) -> dict:
        return {"external": False, "provider": "artemis-preview", "model": self.model,
                "quality": ARTEMIS_PREVIEW_QUALITY}

    def readiness(self):
        """GET /health on the preview server (no generation: CPU time is the scarce resource), cached 15 s."""
        with self._health_lock:
            if self._health is not None and time.monotonic() - self._health_at < 15:
                return dict(self._health)
            try:
                with urllib.request.urlopen(f"{self.base_url}/health", timeout=3) as r:
                    data = json.load(r)
                available = bool(data.get("ok"))
                step = data.get("step")
            except (urllib.error.URLError, TimeoutError, OSError, ValueError):
                available, step = False, None
            self._health = {"configured": True, "serving": available,
                            "status": "available" if available else "unavailable",
                            "step": step, **self._meta()}
            self._health_at = time.monotonic()
            return dict(self._health)

    def _request(self, messages: list[dict], max_tokens: int, stream: bool):
        body = {"model": self.model, "max_tokens": max_tokens, "stream": stream,
                "messages": [{"role": m["role"], "content": clean(m["content"])} for m in messages]}
        return urllib.request.Request(f"{self.base_url}/v1/chat/completions", data=json.dumps(body).encode(),
                                      headers={"Content-Type": "application/json"})

    def generate(self, system: str, messages: list[dict], max_tokens: int = 512, metadata_sink=None) -> str:
        try:
            with urllib.request.urlopen(self._request(messages, max_tokens, False), timeout=self.timeout) as r:
                data = json.load(r)
                content = data["choices"][0]["message"]["content"]
                if not isinstance(content, str):
                    raise ValueError("invalid inference content")
                if metadata_sink:
                    metadata_sink({**self._meta(), "finish_reason": data["choices"][0].get("finish_reason")})
                return content
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, KeyError, IndexError, TypeError) as e:
            raise ModelUnavailable("Artemis preview is unavailable right now; please retry later.") from e

    def stream(self, system: str, messages: list[dict], max_tokens: int = 512, metadata_sink=None):
        try:
            with urllib.request.urlopen(self._request(messages, max_tokens, True), timeout=self.timeout) as r:
                finish = None
                for raw in r:
                    line = raw.decode().strip()
                    if line == "data: [DONE]":
                        break
                    if not line.startswith("data:"):
                        continue
                    data = json.loads(line[5:])
                    for c in data.get("choices", []):
                        finish = c.get("finish_reason") or finish
                        piece = (c.get("delta") or {}).get("content")
                        if piece:
                            if not isinstance(piece, str):
                                raise ValueError("invalid inference content")
                            yield piece
                if metadata_sink:
                    metadata_sink({**self._meta(), "finish_reason": finish})
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, KeyError, IndexError, TypeError) as e:
            raise ModelUnavailable("Artemis preview is unavailable right now; please retry later.") from e
