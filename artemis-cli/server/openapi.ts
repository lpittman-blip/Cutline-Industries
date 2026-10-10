/** Hand-written OpenAPI 3.1 description of the Artemis API (served at /v1/openapi.json). */
const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
const json = (schema: unknown, description = "OK") => ({ description, content: { "application/json": { schema } } });
const errors = {
  "400": { $ref: "#/components/responses/BadRequest" },
  "401": { $ref: "#/components/responses/Unauthorized" },
  "403": { $ref: "#/components/responses/Forbidden" },
  "429": { $ref: "#/components/responses/RateLimited" },
};
const idParam = (name = "id") => ({ name, in: "path", required: true, schema: { type: "string" } });
const op = (o: { tags: string[]; summary: string; operationId: string; scope?: string; body?: unknown; ok?: unknown; okCode?: string; params?: unknown[]; description?: string }) => ({
  tags: o.tags,
  summary: o.summary,
  operationId: o.operationId,
  ...(o.description ? { description: o.description } : {}),
  ...(o.scope ? { "x-artemis-scope": o.scope } : {}),
  ...(o.params ? { parameters: o.params } : {}),
  ...(o.body ? { requestBody: { required: true, content: { "application/json": { schema: o.body } } } } : {}),
  responses: { [o.okCode ?? "200"]: o.ok ?? json({ type: "object" }), ...errors },
});
const list = (item: unknown) => ({ type: "object", properties: { data: { type: "array", items: item } }, required: ["data"] });

export function buildOpenApi(serverUrl?: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Artemis API",
      version: "1.0.0",
      summary: "Autonomous coding agent, OpenAI-compatible chat, agentic search, sessions and webhooks.",
      description: "The Artemis AI backend. The Artemis CLI talks to it, and so can your apps. Authenticate with `Authorization: Bearer art_...`. Every response carries `x-request-id`; authenticated routes are rate-limited per key and return `x-ratelimit-*` headers.",
    },
    servers: [{ url: serverUrl ?? "http://127.0.0.1:7777" }],
    security: [{ bearerAuth: [] }],
    tags: [
      { name: "System" }, { name: "Chat" }, { name: "Agent" }, { name: "Search" }, { name: "Sessions" }, { name: "Webhooks" }, { name: "Keys" },
    ],
    paths: {
      "/v1/health": { get: { ...op({ tags: ["System"], summary: "Liveness check (no auth)", operationId: "getHealth", ok: json(ref("Health")) }), security: [] } },
      "/v1/status": { get: op({ tags: ["System"], summary: "Server, model backend and core status", operationId: "getStatus", ok: json(ref("Status")) }) },
      "/v1/openapi.json": { get: { ...op({ tags: ["System"], summary: "This OpenAPI document (no auth)", operationId: "getOpenApi" }), security: [] } },
      "/v1/models": { get: op({ tags: ["Chat"], summary: "List models", operationId: "listModels", scope: "chat", ok: json(list({ type: "object", properties: { id: { type: "string" }, object: { const: "model" }, owned_by: { type: "string" } } })) }) },
      "/v1/chat/completions": {
        post: op({
          tags: ["Chat"], summary: "OpenAI-compatible chat completions (streaming + tool calling)", operationId: "createChatCompletion", scope: "chat",
          description: "Drop-in for OpenAI `/chat/completions`. `model: \"artemis\"` uses the server's configured provider; `artemis-mock` is an offline deterministic model. With `stream: true` the response is `text/event-stream` of `chat.completion.chunk` objects ending in `data: [DONE]`.",
          body: ref("ChatCompletionRequest"),
          ok: { description: "Completion (JSON) or SSE stream", content: { "application/json": { schema: ref("ChatCompletion") }, "text/event-stream": { schema: { type: "string" } } } },
        }),
      },
      "/v1/agent/runs": {
        post: op({ tags: ["Agent"], summary: "Start an autonomous agent run", operationId: "createRun", scope: "agent", body: ref("CreateRunRequest"), ok: json(ref("Run"), "Run created"), okCode: "201" }),
        get: op({ tags: ["Agent"], summary: "List recent runs", operationId: "listRuns", scope: "agent", params: [{ name: "limit", in: "query", schema: { type: "integer" } }], ok: json(list(ref("Run"))) }),
      },
      "/v1/agent/runs/{id}": { get: op({ tags: ["Agent"], summary: "Get a run", operationId: "getRun", scope: "agent", params: [idParam()], ok: json(ref("Run")) }) },
      "/v1/agent/runs/{id}/events": {
        get: op({
          tags: ["Agent"], summary: "Stream run events (SSE)", operationId: "streamRunEvents", scope: "agent",
          description: "Server-Sent Events. Replays stored events (resume with `Last-Event-ID` or `?after=seq`), then streams live: `run_start`, `phase`, `plan`, `step`, `assistant_delta` (not persisted), `assistant_message`, `tool_start`, `approval_required`, `approval_resolved`, `tool_end`, `usage`, `done`, `error`, `cancelled`, `run_finished`, then `end`.",
          params: [idParam(), { name: "after", in: "query", schema: { type: "integer" } }, { name: "Last-Event-ID", in: "header", schema: { type: "string" } }],
          ok: { description: "SSE stream", content: { "text/event-stream": { schema: ref("RunEvent") } } },
        }),
      },
      "/v1/agent/runs/{id}/approve": { post: op({ tags: ["Agent"], summary: "Approve or deny the pending write/edit/shell call", operationId: "approveRun", scope: "agent", params: [idParam()], body: ref("ApprovalRequest"), ok: json(ref("Run")) }) },
      "/v1/agent/runs/{id}/cancel": { post: op({ tags: ["Agent"], summary: "Cancel a run", operationId: "cancelRun", scope: "agent", params: [idParam()], ok: json(ref("Run")) }) },
      "/v1/search": { post: op({ tags: ["Search"], summary: "Agentic search primitives: glob or grep over a workspace", operationId: "search", scope: "search", body: ref("SearchRequest"), ok: json(ref("SearchResponse")) }) },
      "/v1/sessions": {
        get: op({ tags: ["Sessions"], summary: "List sessions", operationId: "listSessions", scope: "sessions", ok: json(list(ref("Session"))) }),
        post: op({ tags: ["Sessions"], summary: "Create a session", operationId: "createSession", scope: "sessions", body: { type: "object", properties: { title: { type: "string" }, metadata: { type: "object" } } }, ok: json(ref("Session"), "Created"), okCode: "201" }),
      },
      "/v1/sessions/{id}": {
        get: op({ tags: ["Sessions"], summary: "Get a session with notes and runs", operationId: "getSession", scope: "sessions", params: [idParam()], ok: json(ref("SessionDetail")) }),
        delete: op({ tags: ["Sessions"], summary: "Delete a session", operationId: "deleteSession", scope: "sessions", params: [idParam()] }),
      },
      "/v1/sessions/{id}/notes": {
        get: op({ tags: ["Sessions"], summary: "List memory notes", operationId: "listNotes", scope: "sessions", params: [idParam()], ok: json(list(ref("Note"))) }),
        post: op({ tags: ["Sessions"], summary: "Add a memory note (injected into runs that use this session)", operationId: "createNote", scope: "sessions", params: [idParam()], body: { type: "object", required: ["content"], properties: { content: { type: "string" }, tags: { type: "array", items: { type: "string" } } } }, ok: json(ref("Note"), "Created"), okCode: "201" }),
      },
      "/v1/sessions/{id}/notes/{noteId}": { delete: op({ tags: ["Sessions"], summary: "Delete a note", operationId: "deleteNote", scope: "sessions", params: [idParam(), idParam("noteId")] }) },
      "/v1/webhooks": {
        get: op({ tags: ["Webhooks"], summary: "List webhooks", operationId: "listWebhooks", scope: "webhooks", ok: json(list(ref("Webhook"))) }),
        post: op({
          tags: ["Webhooks"], summary: "Register a webhook", operationId: "createWebhook", scope: "webhooks",
          description: "Events: `run.completed`, `run.needs_approval` (or `*`). Each POST carries `Artemis-Event`, `Artemis-Delivery` and `Artemis-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + \".\" + body)>`. Non-2xx responses are retried with exponential backoff. The secret is returned only once.",
          body: { type: "object", required: ["url"], properties: { url: { type: "string", format: "uri" }, events: { type: "array", items: { type: "string", enum: ["run.completed", "run.needs_approval", "*"] } }, description: { type: "string" } } },
          ok: json({ allOf: [ref("Webhook"), { type: "object", properties: { secret: { type: "string" } } }] }, "Created"), okCode: "201",
        }),
      },
      "/v1/webhooks/{id}": { delete: op({ tags: ["Webhooks"], summary: "Delete a webhook", operationId: "deleteWebhook", scope: "webhooks", params: [idParam()] }) },
      "/v1/webhooks/{id}/deliveries": { get: op({ tags: ["Webhooks"], summary: "Recent delivery attempts", operationId: "listDeliveries", scope: "webhooks", params: [idParam()] }) },
      "/v1/keys": {
        get: op({ tags: ["Keys"], summary: "List API keys (no secrets)", operationId: "listKeys", scope: "admin", ok: json(list(ref("ApiKey"))) }),
        post: op({ tags: ["Keys"], summary: "Create an API key (secret returned once)", operationId: "createKey", scope: "admin", body: { type: "object", properties: { name: { type: "string" }, scopes: { type: "array", items: ref("Scope") } } }, ok: json({ allOf: [ref("ApiKey"), { type: "object", properties: { key: { type: "string" } } }] }, "Created"), okCode: "201" }),
      },
      "/v1/keys/{id}": { delete: op({ tags: ["Keys"], summary: "Revoke an API key", operationId: "revokeKey", scope: "admin", params: [idParam()] }) },
    },
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", description: "Artemis API key (art_...)" } },
      responses: {
        BadRequest: json(ref("Error"), "Invalid request"),
        Unauthorized: json(ref("Error"), "Missing or invalid API key"),
        Forbidden: json(ref("Error"), "Key lacks the required scope"),
        RateLimited: json(ref("Error"), "Rate limit exceeded"),
      },
      schemas: {
        Error: { type: "object", properties: { error: { type: "object", properties: { type: { type: "string" }, message: { type: "string" }, request_id: { type: "string" } }, required: ["type", "message"] } } },
        Health: { type: "object", properties: { status: { const: "ok" }, version: { type: "string" }, time: { type: "string", format: "date-time" } } },
        Status: { type: "object", properties: { status: { type: "string" }, version: { type: "string" }, uptime_s: { type: "integer" }, model_backend: { type: "object" }, core: { type: ["object", "null"] }, runs: { type: "object" } } },
        Scope: { type: "string", enum: ["chat", "agent", "search", "sessions", "webhooks", "admin"] },
        ApiKey: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, prefix: { type: "string" }, scopes: { type: "array", items: ref("Scope") }, created_at: { type: "string" }, last_used_at: { type: ["string", "null"] }, revoked_at: { type: ["string", "null"] } } },
        ChatMessage: { type: "object", required: ["role"], properties: { role: { enum: ["system", "user", "assistant", "tool"] }, content: { type: ["string", "null"] }, tool_calls: { type: "array", items: ref("ToolCall") }, tool_call_id: { type: "string" } } },
        ToolCall: { type: "object", properties: { id: { type: "string" }, type: { const: "function" }, function: { type: "object", properties: { name: { type: "string" }, arguments: { type: "string" } } } } },
        ChatCompletionRequest: { type: "object", required: ["messages"], properties: { model: { type: "string", default: "artemis" }, messages: { type: "array", items: ref("ChatMessage") }, tools: { type: "array", items: { type: "object" } }, tool_choice: {}, stream: { type: "boolean" }, temperature: { type: "number" } } },
        ChatCompletion: { type: "object", properties: { id: { type: "string" }, object: { const: "chat.completion" }, model: { type: "string" }, choices: { type: "array", items: { type: "object", properties: { index: { type: "integer" }, message: ref("ChatMessage"), finish_reason: { type: "string" } } } }, usage: { type: "object" } } },
        CreateRunRequest: {
          type: "object", required: ["task"],
          properties: {
            task: { type: "string", description: "What the agent should do." },
            workspace: { type: "string", description: "Directory relative to the server's ARTEMIS_WORKSPACES_ROOT (default '.')." },
            repo: { type: "string", description: "https git URL to shallow-clone instead (server must enable ARTEMIS_ALLOW_CLONE)." },
            mode: { enum: ["confirm", "auto", "read_only"], default: "confirm", description: "confirm = writes/edits/shell wait for POST /approve." },
            model: { type: "string", default: "artemis" },
            max_steps: { type: "integer", default: 25, maximum: 100 },
            session_id: { type: "string", description: "Inject this session's memory notes into the run." },
          },
        },
        Run: {
          type: "object",
          properties: {
            id: { type: "string" }, task: { type: "string" },
            status: { enum: ["queued", "running", "needs_approval", "completed", "failed", "cancelled"] },
            mode: { enum: ["confirm", "auto", "read_only"] }, workspace: { type: "string" }, model: { type: "string" }, session_id: { type: ["string", "null"] },
            max_steps: { type: "integer" }, steps: { type: "integer" }, summary: { type: ["string", "null"] }, stop_reason: { type: ["string", "null"] },
            pending_approval: { oneOf: [{ type: "null" }, ref("ApprovalPrompt")] },
            usage: { type: "object", properties: { prompt_tokens: { type: "integer" }, completion_tokens: { type: "integer" } } },
            created_at: { type: "string" }, updated_at: { type: "string" }, finished_at: { type: ["string", "null"] },
          },
        },
        ApprovalPrompt: { type: "object", properties: { callId: { type: "string" }, tool: { type: "string" }, args: { type: "object" }, preview: { type: "string" } } },
        ApprovalRequest: { type: "object", properties: { approved: { type: "boolean", default: true }, always: { type: "boolean", description: "Approve this and all later actions in the run." }, call_id: { type: "string" } } },
        RunEvent: { type: "object", properties: { seq: { type: "integer" }, type: { type: "string" }, created_at: { type: "string" } }, additionalProperties: true },
        SearchRequest: { type: "object", required: ["pattern"], properties: { type: { enum: ["glob", "grep"], default: "grep" }, pattern: { type: "string" }, workspace: { type: "string" }, path: { type: "string" }, glob: { type: "string" }, ignore_case: { type: "boolean" }, limit: { type: "integer" } } },
        SearchResponse: { type: "object", properties: { type: { type: "string" }, pattern: { type: "string" }, workspace: { type: "string" }, count: { type: "integer" }, summary: { type: "string" }, results: { type: "array", items: { type: "object", properties: { file: { type: "string" }, line: { type: "integer" }, text: { type: "string" } } } } } },
        Session: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, metadata: { type: "object" }, created_at: { type: "string" }, updated_at: { type: "string" } } },
        SessionDetail: { allOf: [ref("Session"), { type: "object", properties: { notes: { type: "array", items: ref("Note") }, runs: { type: "array", items: { type: "object" } } } }] },
        Note: { type: "object", properties: { id: { type: "string" }, session_id: { type: "string" }, content: { type: "string" }, tags: { type: "array", items: { type: "string" } }, created_at: { type: "string" } } },
        Webhook: { type: "object", properties: { id: { type: "string" }, url: { type: "string" }, events: { type: "array", items: { type: "string" } }, description: { type: ["string", "null"] }, created_at: { type: "string" } } },
      },
    },
  };
}
