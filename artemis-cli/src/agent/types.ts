/** OpenAI-compatible chat message shapes (subset Artemis uses). */
export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: Role;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolSchema {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
}

export interface CompletionResult {
  content: string;
  toolCalls: ToolCall[];
  usage?: Usage;
  finishReason?: string;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  tools: ToolSchema[];
  signal?: AbortSignal;
  /** Called with each streamed text delta. */
  onDelta?: (text: string) => void;
}

export interface Provider {
  readonly name: string;
  readonly model: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

export type Mode = "confirm" | "auto" | "read_only";

export interface ConfirmRequest {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  /** Human-readable preview: the command, or a diff-ish summary of a write/edit. */
  preview: string;
}

export type { PlanStep } from "../tools/index.ts";
import type { PlanStep } from "../tools/index.ts";

/**
 * Agent loop states. PLANNING = waiting on the model to decide the next move;
 * ANALYZING = read-only tools (glob/grep/read/list); EXECUTING = write/edit/shell.
 */
export type Phase = "idle" | "planning" | "analyzing" | "awaiting_approval" | "executing" | "done" | "error" | "cancelled";

export type AgentEvent =
  | { type: "phase"; phase: Phase; from: Phase }
  | { type: "plan"; steps: PlanStep[]; source: "model" | "auto" }
  | { type: "run_start"; task: string; model: string; provider: string; mode: Mode; root: string }
  | { type: "step"; step: number; maxSteps: number }
  | { type: "assistant_delta"; text: string }
  | { type: "assistant_message"; text: string }
  | { type: "tool_start"; callId: string; name: string; args: Record<string, unknown> }
  | { type: "approval_required"; request: ConfirmRequest }
  | { type: "approval_resolved"; callId: string; approved: boolean }
  | { type: "review"; callId: string; tool: string; approved: boolean; rule?: string; critique: string; source: "rules" | "model" | "unavailable" }
  | {
      type: "tool_end";
      callId: string;
      name: string;
      ok: boolean;
      summary: string;
      output: string;
      durationMs: number;
    }
  | { type: "usage"; promptTokens: number; completionTokens: number; limit: number }
  | { type: "done"; summary: string; steps: number }
  | { type: "error"; message: string }
  | { type: "cancelled" };
