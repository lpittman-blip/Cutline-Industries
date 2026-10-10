import type { ChatMessage, CompletionRequest, CompletionResult, Provider, ToolCall } from "./types.ts";

/**
 * Offline, deterministic provider. It is *stateless*: the next scripted turn is
 * chosen from the conversation so far (how many tool rounds happened since the
 * last user message, and what those tools returned). That lets the same mock
 * drive the CLI locally and the Artemis server's /v1/chat/completions.
 */
export interface MockTurn {
  content?: string;
  calls?: { name: string; args: Record<string, unknown> }[];
}

export interface MockContext {
  task: string;
  step: number;
  /** Tool results from this task, in order (name + content). */
  results: { name: string; content: string }[];
  canWrite: boolean;
}

export type MockScript = ((ctx: MockContext) => MockTurn)[];

export function mockContext(messages: ChatMessage[], toolNames: string[]): MockContext {
  let lastUser = -1;
  messages.forEach((m, i) => { if (m.role === "user") lastUser = i; });
  const since = messages.slice(lastUser + 1);
  const step = since.filter((m) => m.role === "assistant").length;
  const names = new Map<string, string>();
  for (const m of since) for (const tc of m.tool_calls ?? []) names.set(tc.id, tc.function.name);
  const results = since
    .filter((m) => m.role === "tool")
    .map((m) => ({ name: names.get(m.tool_call_id ?? "") ?? "?", content: m.content ?? "" }));
  return {
    task: lastUser >= 0 ? messages[lastUser]!.content ?? "" : "",
    step,
    results,
    canWrite: toolNames.includes("edit_file"),
  };
}

function firstGrepFile(ctx: MockContext): string | undefined {
  const g = [...ctx.results].reverse().find((r) => r.name === "grep");
  const line = g?.content.split("\n").find((l) => /^[^:]+:\d+:/.test(l));
  return line?.split(":")[0];
}

const PLAN = ["Map the codebase with glob", "Search for exported symbols", "Read the entry point", "Write survey notes", "Review and finalize the notes"];
/** update_plan call with steps < i done, step i current. */
function plan(i: number, readOnly = false) {
  const titles = readOnly ? PLAN.slice(0, 3) : PLAN;
  return { name: "update_plan", args: { steps: titles.map((title, k) => ({ title, status: k < i ? "done" : k === i ? "current" : "pending" })) } };
}

/** Default demo script: plan → map → search → read → write notes → edit → done. */
export const DEFAULT_SCRIPT: MockScript = [
  (ctx) => ({ content: "I'll map the codebase first with a glob, then narrow down with grep.", calls: [plan(0, !ctx.canWrite), { name: "glob", args: { pattern: "src/**/*.{ts,tsx}" } }] }),
  (ctx) => ({
    content: `Found ${ctx.results.find((r) => r.name === "glob")?.content.split("\n").filter(Boolean).length ?? 0} source files. Searching for exported functions and classes.`,
    calls: [plan(1, !ctx.canWrite), { name: "grep", args: { pattern: "^export (async function|function|class) ", path: "src", limit: 40 } }],
  }),
  (ctx) => {
    const file = firstGrepFile(ctx) ?? "package.json";
    return { content: `Reading the top of \`${file}\` to understand the entry points.`, calls: [plan(2, !ctx.canWrite), { name: "read_file", args: { path: file, start_line: 1, end_line: 30 } }] };
  },
  (ctx) => {
    if (!ctx.canWrite) return { calls: [{ name: "done", args: { summary: summarize(ctx, false) } }] };
    const grep = ctx.results.find((r) => r.name === "grep")?.content ?? "";
    const exportsList = grep.split("\n").filter((l) => /^[^:]+:\d+:/.test(l)).slice(0, 15).map((l) => {
      const [file, line, ...rest] = l.split(":");
      return `- \`${file}:${line}\` ${rest.join(":").trim().replace(/\s*\{?\s*$/, "")}`;
    });
    const content = `# Artemis CLI: code survey (mock run)\n\nStatus: draft\n\nTask: ${ctx.task}\n\n## Exported symbols\n${exportsList.join("\n") || "- (none found)"}\n`;
    return { content: "Writing my findings to docs/MOCK_NOTES.md.", calls: [plan(3), { name: "write_file", args: { path: "docs/MOCK_NOTES.md", content } }] };
  },
  () => ({ content: "Marking the notes as reviewed.", calls: [plan(4), { name: "edit_file", args: { path: "docs/MOCK_NOTES.md", old_string: "Status: draft", new_string: "Status: reviewed" } }] }),
  (ctx) => ({ calls: [plan(5), { name: "done", args: { summary: summarize(ctx, true) } }] }),
];

function summarize(ctx: MockContext, wrote: boolean): string {
  const glob = ctx.results.find((r) => r.name === "glob")?.content.split("\n").filter(Boolean).length ?? 0;
  const grep = ctx.results.find((r) => r.name === "grep")?.content.split("\n").filter((l) => /^[^:]+:\d+:/.test(l)).length ?? 0;
  return `Surveyed ${glob} source files and found ${grep} exported functions/classes via grep.` + (wrote ? " Wrote docs/MOCK_NOTES.md and marked it reviewed." : " Read-only mode: no files changed.");
}

export class MockProvider implements Provider {
  readonly name = "mock";
  readonly model = "artemis-mock";
  constructor(private script: MockScript = DEFAULT_SCRIPT, private delayMs = 12) {}

  turn(messages: ChatMessage[], toolNames: string[]): MockTurn {
    const ctx = mockContext(messages, toolNames);
    const fn = this.script[Math.min(ctx.step, this.script.length - 1)]!;
    const t = fn(ctx);
    // Plans are optional: drop update_plan if the caller didn't offer it.
    if (t.calls && !toolNames.includes("update_plan")) t.calls = t.calls.filter((c) => c.name !== "update_plan");
    // If the scripted tool isn't offered (read-only), finish instead of calling it.
    if (t.calls?.some((c) => !toolNames.includes(c.name))) {
      return { content: t.content, calls: [{ name: "done", args: { summary: summarize(ctx, false) } }] };
    }
    return t;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const t = this.turn(req.messages, req.tools.map((x) => x.function.name));
    const content = t.content ?? "";
    for (const piece of content.match(/\S+\s*/g) ?? []) {
      if (req.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      req.onDelta?.(piece);
      if (this.delayMs) await Bun.sleep(this.delayMs);
    }
    const step = mockContext(req.messages, []).step;
    const toolCalls: ToolCall[] = (t.calls ?? []).map((c, i) => ({
      id: `mock_${step}_${i}`,
      type: "function",
      function: { name: c.name, arguments: JSON.stringify(c.args) },
    }));
    const prompt = JSON.stringify(req.messages).length;
    return {
      content,
      toolCalls,
      usage: { prompt_tokens: Math.ceil(prompt / 4), completion_tokens: Math.ceil((content.length + JSON.stringify(t.calls ?? []).length) / 4) },
      finishReason: toolCalls.length ? "tool_calls" : "stop",
    };
  }
}
