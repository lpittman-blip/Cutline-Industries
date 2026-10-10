import { executeTool, MUTATING_TOOLS, previewFor, toolSchemasFor, type PlanStep, type ToolName, type ToolResult } from "../tools/index.ts";
import { actionForTool, review, type Verdict } from "../audit/review.ts";
import type { AgentEvent, ChatMessage, ConfirmRequest, Mode, Phase, Provider } from "./types.ts";

export type ConfirmFn = (req: ConfirmRequest) => Promise<boolean | "always">;

export interface AgentOptions {
  provider: Provider;
  root: string;
  mode: Mode;
  maxSteps?: number;
  /** Total prompt+completion tokens allowed per task (default 200k). */
  tokenBudget?: number;
  confirm?: ConfirmFn;
  onEvent?: (e: AgentEvent) => void;
  forceJsGrep?: boolean;
  shellTimeoutMs?: number;
  /**
   * Ask the model for a second opinion on mutating actions. Off by default: it
   * costs a round trip and tokens per action. The deterministic rules run either
   * way, because they cost neither.
   */
  review?: boolean;
  systemPromptExtra?: string;
}

export interface RunResult {
  status: "done" | "max_steps" | "budget" | "cancelled" | "error";
  summary: string;
  steps: number;
  usage: { promptTokens: number; completionTokens: number };
}

export const DEFAULT_TOKEN_BUDGET = 200_000;

/**
 * Legal transitions of the operational loop. Every phase change goes through
 * `transition()`, so an illegal jump is a bug that throws in tests.
 *
 *   idle → planning ⇄ analyzing
 *              ↓  ↑       ↓
 *   awaiting_approval → executing
 *   any active phase → done | error | cancelled
 */
export const TRANSITIONS: Record<Phase, Phase[]> = {
  idle: ["planning", "cancelled", "error"],
  planning: ["analyzing", "executing", "awaiting_approval", "done", "error", "cancelled"],
  analyzing: ["planning", "analyzing", "executing", "awaiting_approval", "done", "error", "cancelled"],
  awaiting_approval: ["executing", "analyzing", "planning", "done", "error", "cancelled"],
  executing: ["planning", "analyzing", "executing", "awaiting_approval", "done", "error", "cancelled"],
  done: ["planning"],
  error: ["planning"],
  cancelled: ["planning"],
};

export function systemPrompt(root: string, mode: Mode, extra = ""): string {
  return `You are Artemis, the autonomous codebase agent from Artemis AI, running in the user's terminal.
Project root: ${root}
Mode: ${mode}${mode === "read_only" ? " (you cannot modify files or run shell commands)" : ""}

Work autonomously: plan, call tools, inspect results, and keep going over multiple steps until the task is complete. Do not ask the user for step-by-step guidance.

Start by calling update_plan with 3-7 short steps, and call it again whenever a step completes so the user sees live progress.

Context retrieval is agentic search, not RAG:
1. Map the codebase with glob (e.g. "**/*.ts", "src/**").
2. Locate symbols, strings and call sites with grep (regex).
3. Read only the relevant line ranges with read_file.
Repeat and refine searches as you learn more.

When changing code: read before editing, use edit_file with an exact, unique old_string, keep changes minimal, and verify with run_shell (tests, typecheck) when available.
All paths are relative to the project root; you cannot touch files outside it.
Keep prose short. When finished, call the done tool exactly once with a concise summary of what you found or changed.${extra ? "\n\n" + extra : ""}`;
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : { value: v };
  } catch {
    return { __parse_error: raw };
  }
}

const READ_TOOLS = new Set(["glob", "grep", "read_file", "list_dir"]);

function autoTitle(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "glob": return `Map files: ${args.pattern}`;
    case "grep": return `Search: /${args.pattern}/`;
    case "read_file": return `Read ${args.path}`;
    case "list_dir": return `List ${args.path ?? "."}`;
    case "write_file": return `Write ${args.path}`;
    case "edit_file": return `Edit ${args.path}`;
    case "run_shell": return `Run: ${String(args.command).slice(0, 50)}`;
    default: return name;
  }
}

/** The autonomous agent loop: a state machine driving model ⇄ tools until `done`, a cap, or abort. */
export class Agent {
  readonly messages: ChatMessage[];
  mode: Mode;
  maxSteps: number;
  tokenBudget: number;
  phase: Phase = "idle";
  plan: PlanStep[] = [];
  planSource: "model" | "auto" = "auto";
  usage = { promptTokens: 0, completionTokens: 0 };

  constructor(private opts: AgentOptions) {
    this.mode = opts.mode;
    this.maxSteps = opts.maxSteps ?? 25;
    this.tokenBudget = opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    this.messages = [{ role: "system", content: systemPrompt(opts.root, opts.mode, opts.systemPromptExtra) }];
  }

  private emit(e: AgentEvent) {
    this.opts.onEvent?.(e);
  }

  transition(to: Phase) {
    if (to === this.phase) return;
    if (!TRANSITIONS[this.phase].includes(to)) throw new Error(`Illegal agent phase transition ${this.phase} → ${to}`);
    const from = this.phase;
    this.phase = to;
    this.emit({ type: "phase", phase: to, from });
  }

  private setPlan(steps: PlanStep[], source: "model" | "auto") {
    this.plan = steps;
    this.planSource = source;
    this.emit({ type: "plan", steps: steps.map((s) => ({ ...s })), source });
  }

  /** Without a model-published plan, mirror tool calls as an automatic checklist. */
  private autoPlanStart(name: string, args: Record<string, unknown>) {
    if (this.planSource === "model" || name === "done" || name === "update_plan") return;
    this.setPlan([...this.plan.map((s) => (s.status === "current" ? { ...s, status: "done" as const } : s)), { title: autoTitle(name, args), status: "current" }], "auto");
  }
  private autoPlanFinish() {
    if (this.planSource === "model") return;
    if (this.plan.some((s) => s.status === "current")) this.setPlan(this.plan.map((s) => (s.status === "current" ? { ...s, status: "done" as const } : s)), "auto");
  }
  private completePlan() {
    if (this.plan.some((s) => s.status !== "done")) this.setPlan(this.plan.map((s) => ({ ...s, status: "done" as const })), this.planSource);
  }

  private async callTool(name: string, args: Record<string, unknown>, callId: string, signal?: AbortSignal): Promise<ToolResult> {
    const { root } = this.opts;
    const ctx = { root, forceJsGrep: this.opts.forceJsGrep, shellTimeoutMs: this.opts.shellTimeoutMs, signal };
    if (signal?.aborted) return { ok: false, output: "Error: cancelled", summary: "cancelled" };
    if (args.__parse_error !== undefined) return { ok: false, output: `Error: arguments were not valid JSON: ${String(args.__parse_error).slice(0, 200)}`, summary: "invalid JSON arguments" };
    const mutating = MUTATING_TOOLS.has(name as ToolName);
    if (mutating && this.mode === "read_only") return { ok: false, output: "Error: read-only mode; this tool is disabled.", summary: "blocked (read-only)" };

    // Pre-flight review, in front of the approval gate and never instead of it.
    let verdict: Verdict | null = null;
    if (mutating) {
      const action = actionForTool(name, args);
      if (action) {
        verdict = await review(action, {
          root,
          // Deterministic rules always; the model only when asked to pay for it.
          ...(this.opts.review && this.opts.provider ? { provider: this.opts.provider } : {}),
          ...(signal ? { signal } : {}),
        });
        if (!verdict.approved || verdict.source === "unavailable") {
          this.emit({
            type: "review", callId, tool: name, approved: verdict.approved,
            ...(verdict.rule ? { rule: verdict.rule } : {}),
            critique: verdict.critique, source: verdict.source,
          });
        }
        // A hard rule holds in EVERY mode, --yes included. `rm -rf /` is not a
        // preference the user turns off by asking for fewer prompts. A soft
        // finding - `any`, a vector-store import - is a judgement call: it reaches
        // the human in the preview, and never halts an unattended run on its own.
        if (!verdict.approved && verdict.hard) {
          return {
            ok: false,
            output: `Error: blocked by ${verdict.rule}: ${verdict.critique}${verdict.suggestedFix ? `\nTry instead: ${verdict.suggestedFix}` : ""}`,
            summary: `blocked (${verdict.rule})`,
          };
        }
      }
    }

    if (mutating && this.mode === "confirm") {
      // The critique rides along in the preview, so the human approving this sees
      // what the reviewer objected to at the moment they decide.
      const note = verdict && !verdict.approved
        ? `\n\n⚠ review (${verdict.rule ?? "model"}): ${verdict.critique}${verdict.suggestedFix ? `\n  suggested: ${verdict.suggestedFix}` : ""}`
        : "";
      const request: ConfirmRequest = { callId, tool: name, args, preview: previewFor(name, args, root) + note };
      this.transition("awaiting_approval");
      this.emit({ type: "approval_required", request });
      const answer = this.opts.confirm ? await this.opts.confirm(request) : false;
      if (answer === "always") this.mode = "auto";
      const approved = answer !== false;
      this.emit({ type: "approval_resolved", callId, approved });
      if (!approved) return { ok: false, output: "The user denied this action. Do not retry it; adjust your approach or finish.", summary: "denied by user" };
      if (signal?.aborted) return { ok: false, output: "Error: cancelled", summary: "cancelled" };
    }
    this.transition(mutating ? "executing" : READ_TOOLS.has(name) ? "analyzing" : this.phase === "awaiting_approval" ? "planning" : this.phase);
    return executeTool(name, args, ctx);
  }

  async run(task: string, signal?: AbortSignal): Promise<RunResult> {
    const { provider, root } = this.opts;
    const tools = toolSchemasFor(this.mode === "read_only");
    this.messages.push({ role: "user", content: task });
    this.usage = { promptTokens: 0, completionTokens: 0 };
    this.plan = [];
    this.planSource = "auto";
    if (this.phase !== "idle") this.phase = "idle"; // new task: reset the machine
    this.emit({ type: "run_start", task, model: provider.model, provider: provider.name, mode: this.mode, root });
    this.emit({ type: "plan", steps: [], source: "auto" });
    let steps = 0;
    const finish = (status: RunResult["status"], summary: string): RunResult => {
      const terminal: Phase = status === "done" ? "done" : status === "cancelled" ? "cancelled" : "error";
      if (status === "done") this.completePlan();
      this.transition(terminal);
      return { status, summary, steps, usage: { ...this.usage } };
    };

    try {
      while (steps < this.maxSteps) {
        if (signal?.aborted) { this.emit({ type: "cancelled" }); return finish("cancelled", "Cancelled by user."); }
        if (this.usage.promptTokens + this.usage.completionTokens >= this.tokenBudget) {
          const msg = `Stopped: token budget of ${this.tokenBudget.toLocaleString()} reached.`;
          this.emit({ type: "error", message: msg });
          return finish("budget", msg);
        }
        steps++;
        this.transition("planning");
        this.emit({ type: "step", step: steps, maxSteps: this.maxSteps });
        const res = await provider.complete({
          messages: this.messages,
          tools,
          signal,
          onDelta: (text) => this.emit({ type: "assistant_delta", text }),
        });
        if (res.usage) {
          this.usage.promptTokens += res.usage.prompt_tokens;
          this.usage.completionTokens += res.usage.completion_tokens;
          this.emit({ type: "usage", ...this.usage, limit: this.tokenBudget });
        }
        if (res.content) this.emit({ type: "assistant_message", text: res.content });
        this.messages.push({ role: "assistant", content: res.content || null, ...(res.toolCalls.length ? { tool_calls: res.toolCalls } : {}) });

        if (res.toolCalls.length === 0) {
          const summary = res.content.trim() || "(no answer)";
          this.emit({ type: "done", summary, steps });
          return finish("done", summary);
        }

        let final: string | undefined;
        for (const call of res.toolCalls) {
          const name = call.function.name;
          const args = parseArgs(call.function.arguments);
          this.emit({ type: "tool_start", callId: call.id, name, args });
          this.autoPlanStart(name, args);
          const t0 = performance.now();
          const result = await this.callTool(name, args, call.id, signal);
          if (result.plan) this.setPlan(result.plan, "model");
          this.emit({ type: "tool_end", callId: call.id, name, ok: result.ok, summary: result.summary, output: result.output, durationMs: Math.round(performance.now() - t0) });
          if (name !== "update_plan" && name !== "done") this.autoPlanFinish();
          this.messages.push({ role: "tool", tool_call_id: call.id, content: result.output });
          if (result.final !== undefined) final = result.final;
        }
        if (final !== undefined) {
          this.emit({ type: "done", summary: final, steps });
          return finish("done", final);
        }
      }
      const msg = `Stopped after reaching the step limit (${this.maxSteps}).`;
      this.emit({ type: "error", message: msg });
      return finish("max_steps", msg);
    } catch (e) {
      const err = e as Error;
      if (err.name === "AbortError" || signal?.aborted) {
        this.emit({ type: "cancelled" });
        return finish("cancelled", "Cancelled by user.");
      }
      this.emit({ type: "error", message: err.message });
      return finish("error", err.message);
    }
  }
}
