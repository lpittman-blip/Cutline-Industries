import type { CompletionRequest, CompletionResult, Provider, ToolCall } from "./types.ts";

export interface OpenAIProviderOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Label for the UI, e.g. "artemis" or "xai". */
  label?: string;
  extraHeaders?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

/** Parse an SSE byte stream into `data:` payloads. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx).replace(/^\r?\n\r?\n/, "");
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) yield data;
    }
  }
  const tail = buf.trim();
  if (tail.startsWith("data:")) yield tail.slice(5).trim();
}

/** OpenAI-compatible streaming chat completions client with tool calling. */
export class OpenAIProvider implements Provider {
  readonly name: string;
  readonly model: string;
  constructor(private opts: OpenAIProviderOptions) {
    this.name = opts.label ?? "openai-compatible";
    this.model = opts.model;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const f = this.opts.fetchImpl ?? fetch;
    const res = await f(`${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: req.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.opts.apiKey}`,
        ...this.opts.extraHeaders,
      },
      body: JSON.stringify({
        model: this.model,
        messages: req.messages,
        tools: req.tools,
        tool_choice: "auto",
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`Model request failed (${res.status}): ${text.slice(0, 500)}`);
    }
    let content = "";
    let finishReason: string | undefined;
    let usage: CompletionResult["usage"];
    const calls: { id: string; name: string; args: string }[] = [];
    for await (const data of sseData(res.body)) {
      if (data === "[DONE]") break;
      let chunk: any;
      try { chunk = JSON.parse(data); } catch { continue; }
      if (chunk.error) throw new Error(`Model error: ${JSON.stringify(chunk.error).slice(0, 300)}`);
      if (chunk.usage) usage = { prompt_tokens: chunk.usage.prompt_tokens ?? 0, completion_tokens: chunk.usage.completion_tokens ?? 0 };
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const d = choice.delta ?? choice.message ?? {};
      if (typeof d.content === "string" && d.content) {
        content += d.content;
        req.onDelta?.(d.content);
      }
      for (const tc of d.tool_calls ?? []) {
        const i = typeof tc.index === "number" ? tc.index : calls.length;
        calls[i] ??= { id: "", name: "", args: "" };
        if (tc.id) calls[i]!.id = tc.id;
        if (tc.function?.name) calls[i]!.name += tc.function.name;
        if (tc.function?.arguments) calls[i]!.args += tc.function.arguments;
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
    const toolCalls: ToolCall[] = calls
      .filter(Boolean)
      .map((c, i) => ({ id: c.id || `call_${Date.now()}_${i}`, type: "function", function: { name: c.name, arguments: c.args || "{}" } }));
    return { content, toolCalls, usage, finishReason };
  }
}
