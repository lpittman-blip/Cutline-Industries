import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { MockProvider } from "../src/agent/mock.ts";
import { resolveInRoot, SandboxError } from "../src/tools/sandbox.ts";
import { executeTool } from "../src/tools/index.ts";
import type { ChatMessage, Mode } from "../src/agent/types.ts";
import { authenticate, createKey, hasScope, listKeys, revokeKey, SCOPES, type ApiKeyRecord, type Scope } from "./auth.ts";
import { newId, nowIso, openDb } from "./db.ts";
import { docsHtml } from "./docs.ts";
import { buildOpenApi } from "./openapi.ts";
import { pickBackend, probeCore, providerFor, type ProviderSettings } from "./providers.ts";
import { RateLimiter } from "./ratelimit.ts";
import { RunManager, TERMINAL, type StoredEvent } from "./runs.ts";
import { WEBHOOK_EVENTS, Webhooks } from "./webhooks.ts";

export const VERSION = "1.0.0";

export interface ServerConfig {
  dbPath: string;
  dataDir: string;
  providers: ProviderSettings;
  /** Agent runs and /v1/search may only target directories inside this root. */
  workspacesRoot: string;
  allowRepoClone: boolean;
  rateLimitPerMin: number;
  webhook: { maxAttempts: number; retryBaseMs: number };
  publicUrl?: string;
}

type Env = { Variables: { key: ApiKeyRecord; requestId: string } };

class HttpError extends Error {
  constructor(public status: number, public type: string, message: string) { super(message); }
}

const bad = (msg: string) => new HttpError(400, "invalid_request", msg);

export function createServer(cfg: ServerConfig, db: Database = openDb(cfg.dbPath)) {
  const webhooks = new Webhooks(db, cfg.webhook);
  const runs = new RunManager(db, webhooks);
  const limiter = new RateLimiter(cfg.rateLimitPerMin);
  const startedAt = Date.now();
  const app = new Hono<Env>();

  // ---- request id + error envelope
  app.use("*", async (c, next) => {
    const rid = c.req.header("x-request-id")?.slice(0, 100) || newId("req");
    c.set("requestId", rid);
    c.header("x-request-id", rid);
    await next();
  });
  app.onError((err, c) => {
    const status = err instanceof HttpError ? err.status : err instanceof SandboxError ? 400 : 500;
    const type = err instanceof HttpError ? err.type : err instanceof SandboxError ? "sandbox_violation" : "internal_error";
    if (status === 500) console.error(`[${c.get("requestId")}]`, err);
    return c.json({ error: { type, message: err.message, request_id: c.get("requestId") } }, status as any);
  });
  app.notFound((c) => c.json({ error: { type: "not_found", message: `No route for ${c.req.method} ${c.req.path}`, request_id: c.get("requestId") } }, 404));

  // ---- public routes (IP rate-limited)
  const ipOf = (c: Context) => c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const limit = (c: Context, id: string) => {
    const r = limiter.hit(id);
    c.header("x-ratelimit-limit", String(limiter.limit));
    c.header("x-ratelimit-remaining", String(r.remaining));
    c.header("x-ratelimit-reset", String(Math.ceil(r.resetMs / 1000)));
    if (!r.allowed) {
      c.header("retry-after", String(Math.ceil(r.resetMs / 1000)));
      throw new HttpError(429, "rate_limited", "Too many requests. Slow down and retry after the reset.");
    }
  };

  app.get("/", (c) => c.redirect("/docs"));
  app.get("/docs", (c) => { limit(c, `ip:${ipOf(c)}`); return c.html(docsHtml(buildOpenApi(cfg.publicUrl))); });
  app.get("/v1/openapi.json", (c) => { limit(c, `ip:${ipOf(c)}`); return c.json(buildOpenApi(cfg.publicUrl)); });
  app.get("/v1/health", (c) => c.json({ status: "ok", version: VERSION, time: nowIso() }));

  // ---- auth for everything else under /v1
  app.use("/v1/*", async (c, next) => {
    const key = authenticate(db, c.req.header("authorization"));
    if (!key) throw new HttpError(401, "unauthorized", "Missing or invalid API key. Send `Authorization: Bearer art_...`.");
    c.set("key", key);
    limit(c, key.id);
    await next();
  });
  const need = (c: Context<Env>, s: Scope) => {
    if (!hasScope(c.get("key"), s)) throw new HttpError(403, "forbidden", `This key lacks the "${s}" scope.`);
  };
  const body = async (c: Context): Promise<any> => {
    try { return await c.req.json(); } catch { throw bad("Request body must be JSON."); }
  };

  // ---- status
  app.get("/v1/status", async (c) => {
    const p = cfg.providers;
    if (p.core && (!p.core.probe || Date.now() - Date.parse(p.core.probe.checked_at) > 5 * 60_000)) p.core.probe = await probeCore(p.core.url, p.core.key);
    const backend = pickBackend(p);
    const count = (sql: string) => (db.query(sql).get() as any).n as number;
    return c.json({
      status: "ok",
      version: VERSION,
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
      key: { id: c.get("key").id, name: c.get("key").name, scopes: c.get("key").scopes },
      model_backend: { kind: backend.kind, model: backend.kind === "mock" ? "artemis-mock" : "model" in backend ? backend.model : null, base_url: "baseUrl" in backend ? backend.baseUrl : null },
      core: p.core?.probe ?? null,
      runs: { active: runs.activeCount(), total: count("SELECT COUNT(*) n FROM runs") },
      sessions: count("SELECT COUNT(*) n FROM sessions"),
      webhooks: count("SELECT COUNT(*) n FROM webhooks"),
      rate_limit_per_min: cfg.rateLimitPerMin,
    });
  });

  // ---- models + chat completions (OpenAI-compatible)
  app.get("/v1/models", (c) => {
    need(c, "chat");
    const created = Math.floor(startedAt / 1000);
    const ids = ["artemis", "artemis-mock", ...(cfg.providers.upstream.apiKey ? [cfg.providers.upstream.model] : [])];
    return c.json({ object: "list", data: ids.map((id) => ({ id, object: "model", created, owned_by: "artemis-ai" })) });
  });

  app.post("/v1/chat/completions", async (c) => {
    need(c, "chat");
    const req = await body(c);
    if (!Array.isArray(req.messages)) throw bad("`messages` must be an array.");
    const backend = pickBackend(cfg.providers, req.model);
    if (backend.kind === "none") throw new HttpError(503, "provider_unavailable", backend.reason);
    if (backend.kind === "mock") return mockCompletion(c, req);
    const upstreamBody = { ...req, model: backend.model };
    const res = await fetch(`${backend.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(backend.apiKey ? { authorization: `Bearer ${backend.apiKey}` } : {}) },
      body: JSON.stringify(upstreamBody),
      signal: c.req.raw.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new HttpError(502, "upstream_error", `Model provider returned ${res.status}: ${text.slice(0, 400)}`);
    }
    return new Response(res.body, {
      status: 200,
      headers: { "content-type": res.headers.get("content-type") ?? "application/json", "cache-control": "no-cache", "x-request-id": c.get("requestId"), "x-artemis-backend": backend.kind },
    });
  });

  // ---- workspaces
  const resolveWorkspace = async (b: any): Promise<string> => {
    if (b.repo) {
      if (!cfg.allowRepoClone) throw new HttpError(403, "forbidden", "Repo cloning is disabled on this server (ARTEMIS_ALLOW_CLONE=1 to enable).");
      if (typeof b.repo !== "string" || !/^https:\/\/[\w.-]+\/[\w./-]+$/.test(b.repo)) throw bad("`repo` must be an https git URL.");
      const dest = path.join(cfg.dataDir, "repos", newId("ws"));
      mkdirSync(path.dirname(dest), { recursive: true });
      const p = Bun.spawn(["git", "clone", "--depth", "1", "--", b.repo, dest], { stdout: "ignore", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
      const timer = setTimeout(() => p.kill(), 120_000);
      const code = await p.exited;
      clearTimeout(timer);
      if (code !== 0) throw bad(`git clone failed: ${(await new Response(p.stderr).text()).slice(0, 300)}`);
      return dest;
    }
    const ws = typeof b.workspace === "string" ? b.workspace : ".";
    const abs = resolveInRoot(cfg.workspacesRoot, ws);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) throw bad(`Workspace not found: ${ws}`);
    return abs;
  };

  // ---- search
  app.post("/v1/search", async (c) => {
    need(c, "search");
    const b = await body(c);
    const type = b.type ?? "grep";
    if (type !== "glob" && type !== "grep") throw bad("`type` must be glob or grep.");
    if (typeof b.pattern !== "string" || !b.pattern) throw bad("`pattern` is required.");
    const root = await resolveWorkspace({ workspace: b.workspace });
    const r = await executeTool(type, { pattern: b.pattern, path: b.path, glob: b.glob, ignore_case: b.ignore_case, limit: b.limit }, { root });
    if (!r.ok) throw bad(r.output.replace(/^Error: /, ""));
    const lines = r.output.startsWith("(no ") ? [] : r.output.split("\n").filter(Boolean);
    const results = type === "glob"
      ? lines.map((file) => ({ file }))
      : lines.filter((l) => /^.+?:\d+:/.test(l)).map((l) => { const m = /^(.+?):(\d+):(.*)$/.exec(l)!; return { file: m[1], line: Number(m[2]), text: m[3] }; });
    return c.json({ type, pattern: b.pattern, workspace: path.relative(cfg.workspacesRoot, root) || ".", count: results.length, summary: r.summary, results });
  });

  // ---- agent runs
  app.post("/v1/agent/runs", async (c) => {
    need(c, "agent");
    const b = await body(c);
    if (typeof b.task !== "string" || !b.task.trim()) throw bad("`task` is required.");
    const mode: Mode = b.mode === "auto" ? "auto" : b.mode === "read_only" ? "read_only" : b.mode === undefined || b.mode === "confirm" ? "confirm" : (() => { throw bad("`mode` must be confirm, auto or read_only."); })();
    const backend = pickBackend(cfg.providers, b.model);
    if (backend.kind === "none") throw new HttpError(503, "provider_unavailable", backend.reason);
    let memory = "";
    if (b.session_id) {
      if (!db.query("SELECT 1 FROM sessions WHERE id=?").get(b.session_id)) throw new HttpError(404, "not_found", "Session not found.");
      memory = (db.query("SELECT content FROM notes WHERE session_id=? ORDER BY created_at").all(b.session_id) as any[]).map((n) => `- ${n.content}`).join("\n");
    }
    const workspace = await resolveWorkspace(b);
    const maxSteps = Math.min(Math.max(Number(b.max_steps) || 25, 1), 100);
    const run = runs.start({ task: b.task, workspace, mode, maxSteps, provider: providerFor(backend), sessionId: b.session_id ?? null, memory, createdBy: c.get("key").id });
    return c.json(run, 201);
  });
  app.get("/v1/agent/runs", (c) => { need(c, "agent"); return c.json({ data: runs.list(Number(c.req.query("limit")) || 50) }); });
  const getRun = (id: string) => { const r = runs.get(id); if (!r) throw new HttpError(404, "not_found", "Run not found."); return r; };
  app.get("/v1/agent/runs/:id", (c) => { need(c, "agent"); return c.json(getRun(c.req.param("id"))); });

  app.get("/v1/agent/runs/:id/events", (c) => {
    need(c, "agent");
    const id = c.req.param("id");
    getRun(id);
    const after = Number(c.req.header("last-event-id") ?? c.req.query("after") ?? 0) || 0;
    return streamSSE(c, async (stream) => {
      const queue: StoredEvent[] = [];
      let wake: (() => void) | null = null;
      const unsub = runs.subscribe(id, (e) => { queue.push(e); wake?.(); });
      let last = after;
      const send = async (e: StoredEvent, persisted = true) => {
        if (persisted) {
          if (e.seq <= last) return;
          last = e.seq;
          await stream.writeSSE({ id: String(e.seq), event: e.type, data: JSON.stringify({ seq: e.seq, type: e.type, ...e.data, created_at: e.created_at }) });
        } else {
          await stream.writeSSE({ event: e.type, data: JSON.stringify({ type: e.type, ...e.data }) });
        }
      };
      for (const e of runs.events(id, after)) await send(e);
      if (!unsub || TERMINAL.includes(runs.get(id)!.status)) {
        unsub?.();
        await stream.writeSSE({ event: "end", data: JSON.stringify({ status: runs.get(id)!.status }) });
        return;
      }
      const hb = setInterval(() => { stream.writeSSE({ event: "ping", data: "{}" }).catch(() => {}); }, 15_000);
      stream.onAbort(() => { unsub(); clearInterval(hb); wake?.(); });
      try {
        while (!stream.aborted) {
          while (queue.length) {
            const e = queue.shift()!;
            await send(e, e.type !== "assistant_delta");
            if (e.type === "run_finished") {
              await stream.writeSSE({ event: "end", data: JSON.stringify({ status: e.data.status }) });
              return;
            }
          }
          await new Promise<void>((r) => (wake = r));
          wake = null;
        }
      } finally {
        unsub();
        clearInterval(hb);
      }
    });
  });

  app.post("/v1/agent/runs/:id/approve", async (c) => {
    need(c, "agent");
    const id = c.req.param("id");
    const b = await c.req.json().catch(() => ({}));
    const run = getRun(id);
    if (b.call_id && run.pending_approval && b.call_id !== run.pending_approval.callId) throw new HttpError(409, "conflict", `Pending approval is for call ${run.pending_approval.callId}, not ${b.call_id}.`);
    const r = runs.approve(id, b.approved !== false, Boolean(b.always));
    if (r !== "ok") throw new HttpError(409, "conflict", "This run is not waiting for approval.");
    await Bun.sleep(0);
    return c.json(runs.get(id));
  });
  app.post("/v1/agent/runs/:id/cancel", async (c) => {
    need(c, "agent");
    const id = c.req.param("id");
    const r = runs.cancel(id);
    if (r === "not_found") throw new HttpError(404, "not_found", "Run not found.");
    if (r === "finished") throw new HttpError(409, "conflict", "Run already finished.");
    await runs.finished(id);
    return c.json(runs.get(id));
  });

  // ---- sessions + memory notes
  const toSession = (r: any) => ({ id: r.id, title: r.title, metadata: JSON.parse(r.metadata), created_at: r.created_at, updated_at: r.updated_at });
  const toNote = (r: any) => ({ id: r.id, session_id: r.session_id, content: r.content, tags: JSON.parse(r.tags), created_at: r.created_at });
  const getSession = (id: string) => { const r = db.query("SELECT * FROM sessions WHERE id=?").get(id); if (!r) throw new HttpError(404, "not_found", "Session not found."); return toSession(r); };

  app.get("/v1/sessions", (c) => { need(c, "sessions"); return c.json({ data: db.query("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 200").all().map(toSession) }); });
  app.post("/v1/sessions", async (c) => {
    need(c, "sessions");
    const b = await c.req.json().catch(() => ({}));
    const id = newId("ses");
    const ts = nowIso();
    db.query("INSERT INTO sessions (id,title,metadata,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(id, String(b.title ?? "Untitled session").slice(0, 200), JSON.stringify(b.metadata ?? {}), c.get("key").id, ts, ts);
    return c.json(getSession(id), 201);
  });
  app.get("/v1/sessions/:id", (c) => {
    need(c, "sessions");
    const s = getSession(c.req.param("id"));
    const notes = db.query("SELECT * FROM notes WHERE session_id=? ORDER BY created_at").all(s.id).map(toNote);
    const sessionRuns = db.query("SELECT id,task,status,created_at FROM runs WHERE session_id=? ORDER BY created_at DESC").all(s.id);
    return c.json({ ...s, notes, runs: sessionRuns });
  });
  app.delete("/v1/sessions/:id", (c) => {
    need(c, "sessions");
    if (db.query("DELETE FROM sessions WHERE id=?").run(c.req.param("id")).changes === 0) throw new HttpError(404, "not_found", "Session not found.");
    return c.json({ deleted: true });
  });
  app.get("/v1/sessions/:id/notes", (c) => {
    need(c, "sessions");
    const s = getSession(c.req.param("id"));
    return c.json({ data: db.query("SELECT * FROM notes WHERE session_id=? ORDER BY created_at").all(s.id).map(toNote) });
  });
  app.post("/v1/sessions/:id/notes", async (c) => {
    need(c, "sessions");
    const s = getSession(c.req.param("id"));
    const b = await body(c);
    if (typeof b.content !== "string" || !b.content.trim()) throw bad("`content` is required.");
    const id = newId("note");
    db.query("INSERT INTO notes (id,session_id,content,tags,created_at) VALUES (?,?,?,?,?)").run(id, s.id, b.content.slice(0, 10_000), JSON.stringify(Array.isArray(b.tags) ? b.tags.map(String) : []), nowIso());
    db.query("UPDATE sessions SET updated_at=? WHERE id=?").run(nowIso(), s.id);
    return c.json(toNote(db.query("SELECT * FROM notes WHERE id=?").get(id)), 201);
  });
  app.delete("/v1/sessions/:id/notes/:noteId", (c) => {
    need(c, "sessions");
    if (db.query("DELETE FROM notes WHERE id=? AND session_id=?").run(c.req.param("noteId"), c.req.param("id")).changes === 0) throw new HttpError(404, "not_found", "Note not found.");
    return c.json({ deleted: true });
  });

  // ---- webhooks
  app.get("/v1/webhooks", (c) => { need(c, "webhooks"); return c.json({ data: webhooks.list() }); });
  app.post("/v1/webhooks", async (c) => {
    need(c, "webhooks");
    const b = await body(c);
    if (typeof b.url !== "string" || !/^https?:\/\//.test(b.url)) throw bad("`url` must be an http(s) URL.");
    const events: string[] = Array.isArray(b.events) && b.events.length ? b.events : [...WEBHOOK_EVENTS];
    for (const e of events) if (e !== "*" && !(WEBHOOK_EVENTS as readonly string[]).includes(e)) throw bad(`Unknown event ${e}. Valid: ${WEBHOOK_EVENTS.join(", ")}.`);
    const { webhook, secret } = webhooks.create(b.url, events, b.description);
    return c.json({ ...webhook, secret }, 201);
  });
  app.delete("/v1/webhooks/:id", (c) => {
    need(c, "webhooks");
    if (!webhooks.delete(c.req.param("id"))) throw new HttpError(404, "not_found", "Webhook not found.");
    return c.json({ deleted: true });
  });
  app.get("/v1/webhooks/:id/deliveries", (c) => {
    need(c, "webhooks");
    if (!webhooks.get(c.req.param("id"))) throw new HttpError(404, "not_found", "Webhook not found.");
    return c.json({ data: webhooks.deliveries(c.req.param("id")) });
  });

  // ---- API keys (admin)
  app.get("/v1/keys", (c) => { need(c, "admin"); return c.json({ data: listKeys(db) }); });
  app.post("/v1/keys", async (c) => {
    need(c, "admin");
    const b = await c.req.json().catch(() => ({}));
    const scopes: Scope[] = Array.isArray(b.scopes) && b.scopes.length ? b.scopes : ["chat", "agent", "search", "sessions"];
    for (const s of scopes) if (!(SCOPES as readonly string[]).includes(s)) throw bad(`Unknown scope ${s}. Valid: ${SCOPES.join(", ")}.`);
    const { key, record } = createKey(db, String(b.name ?? "unnamed").slice(0, 100), scopes);
    return c.json({ ...record, key }, 201);
  });
  app.delete("/v1/keys/:id", (c) => {
    need(c, "admin");
    if (c.req.param("id") === c.get("key").id) throw new HttpError(409, "conflict", "You cannot revoke the key you are using.");
    if (!revokeKey(db, c.req.param("id"))) throw new HttpError(404, "not_found", "Key not found or already revoked.");
    return c.json({ revoked: true });
  });

  return { app, db, runs, webhooks, cfg };
}

/** OpenAI-compatible completion (JSON or SSE) from the offline mock. */
function mockCompletion(c: Context<Env>, req: any): Response | Promise<Response> {
  const messages: ChatMessage[] = req.messages;
  const toolNames: string[] = (req.tools ?? []).map((t: any) => t.function?.name).filter(Boolean);
  const mock = new MockProvider(undefined, 0);
  const turn = mock.turn(messages, toolNames);
  const id = `chatcmpl-${newId("mock").slice(5)}`;
  const created = Math.floor(Date.now() / 1000);
  const step = messages.length;
  const toolCalls = (turn.calls ?? []).map((tc, i) => ({ id: `call_${step}_${i}`, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.args) } }));
  const content = turn.content ?? "";
  const usage = { prompt_tokens: Math.ceil(JSON.stringify(messages).length / 4), completion_tokens: Math.ceil((content.length + JSON.stringify(toolCalls).length) / 4) };
  const finish = toolCalls.length ? "tool_calls" : "stop";
  if (!req.stream) {
    return c.json({ id, object: "chat.completion", created, model: "artemis-mock", choices: [{ index: 0, message: { role: "assistant", content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: finish }], usage });
  }
  return streamSSE(c, async (stream) => {
    const chunk = (delta: any, finish_reason: string | null = null, extra: any = {}) =>
      stream.writeSSE({ data: JSON.stringify({ id, object: "chat.completion.chunk", created, model: "artemis-mock", choices: [{ index: 0, delta, finish_reason }], ...extra }) });
    await chunk({ role: "assistant", content: "" });
    for (const piece of content.match(/\S+\s*/g) ?? []) { await chunk({ content: piece }); await Bun.sleep(4); }
    for (const [i, tc] of toolCalls.entries()) {
      await chunk({ tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: "" } }] });
      const a = tc.function.arguments;
      for (let k = 0; k < a.length; k += 48) await chunk({ tool_calls: [{ index: i, function: { arguments: a.slice(k, k + 48) } }] });
    }
    await chunk({}, finish);
    await stream.writeSSE({ data: JSON.stringify({ id, object: "chat.completion.chunk", created, model: "artemis-mock", choices: [], usage }) });
    await stream.writeSSE({ data: "[DONE]" });
  });
}
