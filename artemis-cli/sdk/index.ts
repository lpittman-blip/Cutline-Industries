/**
 * @artemis-ai/sdk — typed client for the Artemis API.
 * Hand-written from /v1/openapi.json. Works in Bun, Node 18+, Deno and browsers (fetch + Web Crypto).
 */

export type Scope = "chat" | "agent" | "search" | "sessions" | "webhooks" | "admin";
export type RunMode = "confirm" | "auto" | "read_only";
export type RunStatus = "queued" | "running" | "needs_approval" | "completed" | "failed" | "cancelled";

export interface ApprovalPrompt { callId: string; tool: string; args: Record<string, unknown>; preview: string }
export interface Run {
  id: string; task: string; status: RunStatus; mode: RunMode; workspace: string; model: string; session_id: string | null;
  max_steps: number; steps: number; summary: string | null; stop_reason: string | null; pending_approval: ApprovalPrompt | null;
  usage: { prompt_tokens: number; completion_tokens: number }; created_at: string; updated_at: string; finished_at: string | null;
}
export interface CreateRunParams { task: string; workspace?: string; repo?: string; mode?: RunMode; model?: string; max_steps?: number; session_id?: string }
export interface RunEvent { seq?: number; type: string; created_at?: string; [k: string]: unknown }

export interface ChatMessage { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string }
export interface ToolCall { id: string; type: "function"; function: { name: string; arguments: string } }
export interface ChatCompletionParams { model?: string; messages: ChatMessage[]; tools?: unknown[]; tool_choice?: unknown; temperature?: number; [k: string]: unknown }
export interface ChatCompletion { id: string; object: "chat.completion"; model: string; choices: { index: number; message: ChatMessage; finish_reason: string }[]; usage?: { prompt_tokens: number; completion_tokens: number } }
export interface ChatCompletionChunk { id: string; object: "chat.completion.chunk"; model: string; choices: { index: number; delta: Partial<ChatMessage> & { tool_calls?: (Partial<ToolCall> & { index: number; function?: { name?: string; arguments?: string } })[] }; finish_reason: string | null }[]; usage?: { prompt_tokens: number; completion_tokens: number } }

export interface SearchParams { type?: "glob" | "grep"; pattern: string; workspace?: string; path?: string; glob?: string; ignore_case?: boolean; limit?: number }
export interface SearchResult { type: string; pattern: string; workspace: string; count: number; summary: string; results: { file: string; line?: number; text?: string }[] }
export interface Session { id: string; title: string; metadata: Record<string, unknown>; created_at: string; updated_at: string }
export interface Note { id: string; session_id: string; content: string; tags: string[]; created_at: string }
export interface Webhook { id: string; url: string; events: string[]; description: string | null; created_at: string }
export interface ApiKey { id: string; name: string; prefix: string; scopes: Scope[]; created_at: string; last_used_at: string | null; revoked_at: string | null }
export interface Status { status: string; version: string; uptime_s: number; model_backend: { kind: string; model: string | null; base_url: string | null }; core: unknown; runs: { active: number; total: number } }

export class ArtemisError extends Error {
  constructor(public status: number, public type: string, message: string, public requestId?: string) {
    super(message);
    this.name = "ArtemisError";
  }
}

export interface ClientOptions { baseUrl?: string; apiKey: string; fetch?: typeof fetch; headers?: Record<string, string> }

async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string; id?: string }> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.search(/\r?\n\r?\n/)) !== -1) {
      const block = buf.slice(0, i);
      buf = buf.slice(i).replace(/^\r?\n\r?\n/, "");
      let event = "message", id: string | undefined;
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        else if (line.startsWith("id:")) id = line.slice(3).trim();
      }
      if (data.length) yield { event, data: data.join("\n"), id };
    }
  }
}

export class Artemis {
  readonly baseUrl: string;
  private apiKey: string;
  private f: typeof fetch;
  private headers: Record<string, string>;

  constructor(opts: ClientOptions) {
    this.baseUrl = (opts.baseUrl ?? "http://127.0.0.1:7777").replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.f = opts.fetch ?? fetch;
    this.headers = opts.headers ?? {};
  }

  private async raw(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<Response> {
    const res = await this.f(`${this.baseUrl}${path}`, {
      method,
      ...init,
      headers: { authorization: `Bearer ${this.apiKey}`, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...this.headers, ...(init.headers as any) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const j: any = await res.json().catch(() => ({}));
      throw new ArtemisError(res.status, j?.error?.type ?? "http_error", j?.error?.message ?? `HTTP ${res.status}`, res.headers.get("x-request-id") ?? undefined);
    }
    return res;
  }
  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await (await this.raw(method, path, body)).json()) as T;
  }

  health() { return this.req<{ status: "ok"; version: string; time: string }>("GET", "/v1/health"); }
  status() { return this.req<Status>("GET", "/v1/status"); }
  openapi() { return this.req<Record<string, unknown>>("GET", "/v1/openapi.json"); }

  readonly chat = {
    completions: {
      create: (p: ChatCompletionParams) => this.req<ChatCompletion>("POST", "/v1/chat/completions", { model: "artemis", ...p, stream: false }),
      stream: async function* (this: Artemis, p: ChatCompletionParams): AsyncGenerator<ChatCompletionChunk> {
        const res = await this.raw("POST", "/v1/chat/completions", { model: "artemis", ...p, stream: true });
        for await (const e of sse(res.body!)) {
          if (e.data === "[DONE]") return;
          yield JSON.parse(e.data);
        }
      }.bind(this) as (p: ChatCompletionParams) => AsyncGenerator<ChatCompletionChunk>,
    },
  };

  readonly runs = {
    create: (p: CreateRunParams) => this.req<Run>("POST", "/v1/agent/runs", p),
    get: (id: string) => this.req<Run>("GET", `/v1/agent/runs/${id}`),
    list: (limit = 50) => this.req<{ data: Run[] }>("GET", `/v1/agent/runs?limit=${limit}`).then((r) => r.data),
    approve: (id: string, opts: { approved?: boolean; always?: boolean; call_id?: string } = {}) => this.req<Run>("POST", `/v1/agent/runs/${id}/approve`, { approved: true, ...opts }),
    deny: (id: string, call_id?: string) => this.req<Run>("POST", `/v1/agent/runs/${id}/approve`, { approved: false, call_id }),
    cancel: (id: string) => this.req<Run>("POST", `/v1/agent/runs/${id}/cancel`, {}),
    /** Async-iterate run events over SSE (replays history, then live, ends when the run finishes). */
    events: async function* (this: Artemis, id: string, opts: { after?: number; signal?: AbortSignal } = {}): AsyncGenerator<RunEvent> {
      const res = await this.raw("GET", `/v1/agent/runs/${id}/events${opts.after ? `?after=${opts.after}` : ""}`, undefined, { signal: opts.signal, headers: { accept: "text/event-stream" } });
      for await (const e of sse(res.body!)) {
        if (e.event === "ping") continue;
        if (e.event === "end") return;
        yield JSON.parse(e.data);
      }
    }.bind(this) as (id: string, opts?: { after?: number; signal?: AbortSignal }) => AsyncGenerator<RunEvent>,
    /** Follow a run to completion. `onApproval` decides pending write/edit/shell calls (default: deny). */
    wait: async (id: string, opts: { onEvent?: (e: RunEvent) => void; onApproval?: (p: ApprovalPrompt, run: Run) => boolean | Promise<boolean> } = {}): Promise<Run> => {
      for await (const e of this.runs.events(id)) {
        opts.onEvent?.(e);
        if (e.type === "approval_required") {
          const prompt = (e as any).request as ApprovalPrompt;
          const ok = opts.onApproval ? await opts.onApproval(prompt, await this.runs.get(id)) : false;
          await this.runs.approve(id, { approved: ok, call_id: prompt.callId });
        }
      }
      return this.runs.get(id);
    },
  };

  search(p: SearchParams) { return this.req<SearchResult>("POST", "/v1/search", p); }

  readonly sessions = {
    create: (p: { title?: string; metadata?: Record<string, unknown> } = {}) => this.req<Session>("POST", "/v1/sessions", p),
    list: () => this.req<{ data: Session[] }>("GET", "/v1/sessions").then((r) => r.data),
    get: (id: string) => this.req<Session & { notes: Note[]; runs: Pick<Run, "id" | "task" | "status" | "created_at">[] }>("GET", `/v1/sessions/${id}`),
    delete: (id: string) => this.req<{ deleted: true }>("DELETE", `/v1/sessions/${id}`),
    notes: {
      add: (sessionId: string, content: string, tags: string[] = []) => this.req<Note>("POST", `/v1/sessions/${sessionId}/notes`, { content, tags }),
      list: (sessionId: string) => this.req<{ data: Note[] }>("GET", `/v1/sessions/${sessionId}/notes`).then((r) => r.data),
      delete: (sessionId: string, noteId: string) => this.req<{ deleted: true }>("DELETE", `/v1/sessions/${sessionId}/notes/${noteId}`),
    },
  };

  readonly webhooks = {
    create: (p: { url: string; events?: ("run.completed" | "run.needs_approval" | "*")[]; description?: string }) => this.req<Webhook & { secret: string }>("POST", "/v1/webhooks", p),
    list: () => this.req<{ data: Webhook[] }>("GET", "/v1/webhooks").then((r) => r.data),
    delete: (id: string) => this.req<{ deleted: true }>("DELETE", `/v1/webhooks/${id}`),
    deliveries: (id: string) => this.req<{ data: { id: string; event: string; status: string; attempts: number; last_status_code: number | null }[] }>("GET", `/v1/webhooks/${id}/deliveries`).then((r) => r.data),
  };

  readonly keys = {
    create: (p: { name?: string; scopes?: Scope[] } = {}) => this.req<ApiKey & { key: string }>("POST", "/v1/keys", p),
    list: () => this.req<{ data: ApiKey[] }>("GET", "/v1/keys").then((r) => r.data),
    revoke: (id: string) => this.req<{ revoked: true }>("DELETE", `/v1/keys/${id}`),
  };
}

/**
 * Verify an `Artemis-Signature` header (`t=<unix>,v1=<hex>`), HMAC-SHA256 over `${t}.${rawBody}`.
 * Pass the raw request body string, not re-serialized JSON.
 */
export async function verifyWebhookSignature(secret: string, rawBody: string, header: string | null | undefined, toleranceSec = 300): Promise<boolean> {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=", 2)));
  const t = Number(parts.t);
  if (!parts.v1 || !Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${rawBody}`)));
  const expected = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  if (expected.length !== parts.v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ parts.v1.charCodeAt(i);
  return diff === 0;
}

export default Artemis;
