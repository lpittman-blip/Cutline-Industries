import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { startServer } from "../server/index.ts";
import { signPayload, verifySignature } from "../server/webhooks.ts";
import { makeFixture, readSse, testServerConfig, waitFor } from "./helpers.ts";

let srv: Awaited<ReturnType<typeof startServer>>;
let admin: string;
let ws: string;
const api = (p: string, init: RequestInit & { key?: string | null; json?: unknown } = {}) =>
  fetch(srv.url + p, {
    ...init,
    method: init.method ?? (init.json !== undefined ? "POST" : "GET"),
    headers: { ...(init.key === null ? {} : { authorization: `Bearer ${init.key ?? admin}` }), ...(init.json !== undefined ? { "content-type": "application/json" } : {}), ...(init.headers as any) },
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });

// Webhook receiver that fails the first delivery to exercise retries.
const received: { headers: Headers; body: string }[] = [];
let failFirst = true;
const receiver = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = await req.text();
    if (failFirst) { failFirst = false; return new Response("try again", { status: 503 }); }
    received.push({ headers: req.headers, body });
    return new Response("ok");
  },
});

beforeAll(async () => {
  ws = makeFixture();
  srv = await startServer({ port: 0, config: testServerConfig(path.dirname(ws)), quiet: true });
  admin = srv.bootstrapKey!;
});
afterAll(() => { srv.stop(); receiver.stop(true); });

describe("system + auth", () => {
  test("health is public and carries a request id", async () => {
    const r = await api("/v1/health", { key: null, headers: { "x-request-id": "req_test123" } });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-request-id")).toBe("req_test123");
    expect((await r.json()).status).toBe("ok");
  });
  test("protected routes require a valid bearer key", async () => {
    const r = await api("/v1/status", { key: null });
    expect(r.status).toBe(401);
    const j = await r.json();
    expect(j.error.type).toBe("unauthorized");
    expect(j.error.request_id).toStartWith("req_");
    expect((await api("/v1/status", { key: "art_wrong" })).status).toBe(401);
    const st = await (await api("/v1/status")).json();
    expect(st.model_backend.kind).toBe("mock");
  });
  test("keys: create (hashed, shown once), scope enforcement, list, revoke", async () => {
    const created = await (await api("/v1/keys", { json: { name: "search-only", scopes: ["search"] } })).json();
    expect(created.key).toStartWith("art_");
    const row: any = srv.db.query("SELECT hash FROM api_keys WHERE id=?").get(created.id);
    expect(row.hash).not.toContain(created.key);
    expect(row.hash).toHaveLength(64);
    const forbidden = await api("/v1/agent/runs", { key: created.key, json: { task: "x" } });
    expect(forbidden.status).toBe(403);
    expect((await api("/v1/search", { key: created.key, json: { type: "glob", pattern: "*.json", workspace: path.basename(ws) } })).status).toBe(200);
    const list = await (await api("/v1/keys")).json();
    expect(list.data.some((k: any) => k.id === created.id && !("key" in k) && !("hash" in k))).toBe(true);
    expect((await api(`/v1/keys/${created.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await api("/v1/search", { key: created.key, json: { pattern: "x" } })).status).toBe(401);
    expect((await api("/v1/keys", { json: { scopes: ["root"] } })).status).toBe(400);
  });
  test("rate limiting returns 429 with headers", async () => {
    const s2 = await startServer({ port: 0, config: testServerConfig(ws, { rateLimitPerMin: 3 }), quiet: true });
    const h = { authorization: `Bearer ${s2.bootstrapKey}` };
    const codes: number[] = [];
    let last: Response | undefined;
    for (let i = 0; i < 5; i++) { last = await fetch(`${s2.url}/v1/status`, { headers: h }); codes.push(last.status); }
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    expect(last!.headers.get("x-ratelimit-remaining")).toBe("0");
    expect(last!.headers.get("retry-after")).toBeTruthy();
    s2.stop();
  });
  test("OpenAPI 3.1 spec and docs", async () => {
    const spec = await (await api("/v1/openapi.json", { key: null })).json();
    expect(spec.openapi).toBe("3.1.0");
    for (const p of ["/v1/chat/completions", "/v1/agent/runs", "/v1/agent/runs/{id}/events", "/v1/agent/runs/{id}/approve", "/v1/search", "/v1/sessions", "/v1/webhooks", "/v1/keys", "/v1/health", "/v1/status"]) expect(spec.paths[p]).toBeDefined();
    const docs = await (await api("/docs", { key: null })).text();
    expect(docs).toContain("Artemis");
    expect(docs).toContain("/v1/agent/runs/{id}/approve");
  });
});

describe("chat completions (OpenAI-compatible)", () => {
  const tools = [{ type: "function", function: { name: "glob", description: "", parameters: {} } }];
  test("non-streaming returns a tool call", async () => {
    const j = await (await api("/v1/chat/completions", { json: { model: "artemis", messages: [{ role: "user", content: "survey" }], tools } })).json();
    expect(j.object).toBe("chat.completion");
    expect(j.choices[0].message.tool_calls[0].function.name).toBe("glob");
    expect(j.choices[0].finish_reason).toBe("tool_calls");
  });
  test("streaming emits chunks, tool-call deltas, usage and [DONE]", async () => {
    const r = await api("/v1/chat/completions", { json: { stream: true, messages: [{ role: "user", content: "survey" }], tools } });
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    const ev = await readSse(r);
    expect(ev.at(-1)!.data).toBe("[DONE]");
    const chunks = ev.filter((e) => e.data !== "[DONE]").map((e) => e.data);
    expect(chunks.every((c) => c.object === "chat.completion.chunk")).toBe(true);
    const args = chunks.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? []).map((t: any) => t.function?.arguments ?? "").join("");
    expect(JSON.parse(args).pattern).toBe("src/**/*.{ts,tsx}");
    expect(chunks.some((c) => c.usage)).toBe(true);
  });
  test("rejects malformed bodies", async () => {
    expect((await api("/v1/chat/completions", { json: { messages: "hi" } })).status).toBe(400);
  });
});

describe("agent runs, SSE, approvals, webhooks", () => {
  test("auto run streams step and tool events over SSE to completion", async () => {
    const run = await (await api("/v1/agent/runs", { json: { task: "Survey", workspace: path.basename(ws), mode: "auto" } })).json();
    expect(run.id).toStartWith("run_");
    const ev = await readSse(await api(`/v1/agent/runs/${run.id}/events`));
    const types = ev.map((e) => e.event);
    expect(types).toContain("run_start");
    expect(types).toContain("step");
    expect(types.filter((t) => t === "tool_start").length).toBeGreaterThanOrEqual(5);
    expect(types).toContain("run_finished");
    expect(types.at(-1)).toBe("end");
    const final = await (await api(`/v1/agent/runs/${run.id}`)).json();
    expect(final.status).toBe("completed");
    expect(final.summary).toContain("MOCK_NOTES");
    expect(readFileSync(path.join(ws, "docs/MOCK_NOTES.md"), "utf8")).toContain("Status: reviewed");
    // resume from a sequence number
    const seq = ev.find((e) => e.event === "tool_end")!.data.seq;
    const resumed = await readSse(await api(`/v1/agent/runs/${run.id}/events`, { headers: { "last-event-id": String(seq) } }));
    expect(resumed[0]!.data.seq).toBe(seq + 1);
  });

  test("confirm mode: needs_approval → webhook → approve → completed webhook (signed, retried)", async () => {
    const hook = await (await api("/v1/webhooks", { json: { url: `http://127.0.0.1:${receiver.port}/hook`, events: ["run.completed", "run.needs_approval"] } })).json();
    expect(hook.secret).toStartWith("whsec_");
    const ws2 = makeFixture();
    const s3 = await startServer({ port: 0, config: { ...testServerConfig(path.dirname(ws2)), dbPath: srv.cfg.dbPath }, quiet: true });
    const run = await (await fetch(`${s3.url}/v1/agent/runs`, { method: "POST", headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" }, body: JSON.stringify({ task: "Survey", workspace: path.basename(ws2) }) })).json();
    await waitFor(() => s3.runs.get(run.id)?.status === "needs_approval");
    const pending = s3.runs.get(run.id)!.pending_approval!;
    expect(pending.tool).toBe("write_file");
    // Wrong call id is rejected
    const wrong = await fetch(`${s3.url}/v1/agent/runs/${run.id}/approve`, { method: "POST", headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" }, body: JSON.stringify({ call_id: "nope" }) });
    expect(wrong.status).toBe(409);
    const ok = await fetch(`${s3.url}/v1/agent/runs/${run.id}/approve`, { method: "POST", headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" }, body: JSON.stringify({ call_id: pending.callId, approved: true, always: true }) });
    expect(ok.status).toBe(200);
    await s3.runs.finished(run.id);
    expect(s3.runs.get(run.id)!.status).toBe("completed");
    await waitFor(() => received.some((r) => r.headers.get("artemis-event") === "run.completed"), 5000);
    const needs = received.find((r) => r.headers.get("artemis-event") === "run.needs_approval")!;
    const done = received.find((r) => r.headers.get("artemis-event") === "run.completed")!;
    for (const d of [needs, done]) expect(verifySignature(hook.secret, d.body, d.headers.get("artemis-signature")!)).toBe(true);
    expect(verifySignature(hook.secret, done.body + " ", done.headers.get("artemis-signature")!)).toBe(false);
    expect(JSON.parse(done.body).data.run.id).toBe(run.id);
    const deliveries = await (await api(`/v1/webhooks/${hook.id}/deliveries`)).json();
    expect(deliveries.data.some((d: any) => d.attempts === 2 && d.status === "delivered")).toBe(true); // first attempt got 503
    await api(`/v1/webhooks/${hook.id}`, { method: "DELETE" });
    s3.stop();
  });

  test("deny + cancel", async () => {
    const run = await (await api("/v1/agent/runs", { json: { task: "Survey", workspace: path.basename(ws), mode: "confirm" } })).json();
    await waitFor(() => srv.runs.get(run.id)?.status === "needs_approval");
    await api(`/v1/agent/runs/${run.id}/approve`, { json: { approved: false } });
    await waitFor(() => srv.runs.get(run.id)?.status === "needs_approval" || srv.runs.get(run.id)?.status === "completed");
    const c = await (await api(`/v1/agent/runs/${run.id}/cancel`, { json: {} })).json();
    expect(["cancelled", "completed"]).toContain(c.status);
    expect((await api(`/v1/agent/runs/${run.id}/cancel`, { json: {} })).status).toBe(409);
    const events = srv.runs.events(run.id).map((e) => e.type);
    expect(events).toContain("approval_resolved");
  });

  test("workspace sandbox: cannot target directories outside the workspaces root", async () => {
    const r = await api("/v1/agent/runs", { json: { task: "x", workspace: "../../etc" } });
    expect(r.status).toBe(400);
    expect((await r.json()).error.type).toBe("sandbox_violation");
    expect((await api("/v1/agent/runs", { json: { task: "x", repo: "https://github.com/a/b" } })).status).toBe(403);
  });

  test("signPayload/verifySignature reject stale timestamps", () => {
    const old = Math.floor(Date.now() / 1000) - 3600;
    expect(verifySignature("s", "{}", signPayload("s", "{}", old))).toBe(false);
  });
});

describe("search + sessions", () => {
  test("glob and grep", async () => {
    const g = await (await api("/v1/search", { json: { type: "glob", pattern: "src/**/*.ts", workspace: path.basename(ws) } })).json();
    expect(g.results.map((r: any) => r.file)).toContain("src/math.ts");
    const s = await (await api("/v1/search", { json: { type: "grep", pattern: "a - b", workspace: path.basename(ws) } })).json();
    expect(s.results[0]).toMatchObject({ file: "src/math.ts", line: 2 });
    expect((await api("/v1/search", { json: { type: "fuzzy", pattern: "x" } })).status).toBe(400);
  });
  test("sessions with memory notes feed runs", async () => {
    const ses = await (await api("/v1/sessions", { json: { title: "Fixture work", metadata: { team: "core" } } })).json();
    const note = await (await api(`/v1/sessions/${ses.id}/notes`, { json: { content: "Prefer minimal diffs", tags: ["style"] } })).json();
    expect(note.tags).toEqual(["style"]);
    const run = await (await api("/v1/agent/runs", { json: { task: "Survey", workspace: path.basename(ws), mode: "read_only", session_id: ses.id } })).json();
    await srv.runs.finished(run.id);
    const detail = await (await api(`/v1/sessions/${ses.id}`)).json();
    expect(detail.notes).toHaveLength(1);
    expect(detail.runs[0].id).toBe(run.id);
    expect((await (await api("/v1/sessions")).json()).data.length).toBeGreaterThan(0);
    expect((await api(`/v1/sessions/${ses.id}/notes/${note.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await api(`/v1/sessions/nope`)).status).toBe(404);
  });
});
