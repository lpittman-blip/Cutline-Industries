/**
 * Adversarial review: a second opinion before a mutating action runs.
 *
 * It sits IN FRONT of the existing approval gate, never in place of it. A model
 * reviewing another model is a quality filter, not an authority — if it were the
 * last line of defence, one persuasive diff would be enough.
 *
 * Order matters: the deterministic rules run first and a hard hit is final, because
 * a regex cannot be argued out of its answer. Only what survives that goes to the
 * model, and only for judgement calls.
 *
 * It FAILS OPEN. A reviewer that blocks work whenever the provider is slow, rate
 * limited or offline gets switched off within a week, and then nothing is reviewed
 * at all. An unreachable reviewer reports that it could not run and the human gate
 * still stands behind it. Hard deterministic hits do not fail open — they need no
 * network to decide.
 */
import type { Provider } from "../agent/types.ts";
import { checkContent, checkShell, type RuleHit, type RuleId } from "./rules.ts";

export interface ProposedAction {
  kind: "shell" | "write";
  /** The command, for shell; the path, for a write. */
  target: string;
  /** File contents, for a write. */
  contents?: string;
}

export interface Verdict {
  approved: boolean;
  rule?: RuleId;
  critique: string;
  suggestedFix?: string;
  /** How it was decided, so a log can distinguish a regex from an opinion. */
  source: "rules" | "model" | "unavailable";
}

const SYSTEM = `You review one proposed action in a Bun + TypeScript codebase before it runs.

Reject only for a concrete, nameable problem. A reviewer that objects to everything
is ignored, and the action still has to pass a human after you.

Rules, in the order they matter:
  DESTRUCTIVE_SHELL    irreversible or out-of-scope effects, missing a timeout, writing outside the project
  SECRET_EXPOSURE      a key, token or private key in a command or file
  DEPENDENCY_DRIFT     a new third-party dependency where the project's own tools would do
  STATE_INVERSION      a vector store, embedding index or RAG layer; retrieval here is glob and grep
  TYPESCRIPT_VIOLATION \`any\`, @ts-ignore, or an unchecked assertion
  CLEAN_CODE           no validation on input that clearly needs it

Reply with ONLY this JSON object and nothing else:
{"approved": true}
or
{"approved": false, "rule": "<one rule id>", "critique": "<one or two sentences>", "suggested_fix": "<the corrected command or code, or omit>"}`;

export function describe(action: ProposedAction): string {
  return action.kind === "shell"
    ? `shell command:\n${action.target}`
    : `write to ${action.target}:\n${(action.contents ?? "").slice(0, 4000)}`;
}

/** Pulls the JSON object out of a reply that may be fenced or have prose around it. */
export function parseVerdict(reply: string): Verdict | null {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(reply);
  const body = (fenced ? fenced[1] : reply) ?? "";
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const v = parsed as { approved?: unknown; rule?: unknown; critique?: unknown; suggested_fix?: unknown };
  if (typeof v.approved !== "boolean") return null;
  return {
    approved: v.approved,
    ...(typeof v.rule === "string" ? { rule: v.rule as RuleId } : {}),
    critique: typeof v.critique === "string" ? v.critique : "",
    ...(typeof v.suggested_fix === "string" && v.suggested_fix ? { suggestedFix: v.suggested_fix } : {}),
    source: "model" as const,
  };
}

export function deterministic(action: ProposedAction, root: string): RuleHit[] {
  return action.kind === "shell"
    ? checkShell(action.target, root)
    : checkContent(action.target, action.contents ?? "");
}

export interface ReviewOptions {
  root: string;
  /** Omit to run the deterministic rules only — no network, no tokens. */
  provider?: Provider;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function review(action: ProposedAction, options: ReviewOptions): Promise<Verdict> {
  const hits = deterministic(action, options.root);
  const hard = hits.find((h) => h.hard);
  if (hard) {
    // Settled without asking anyone. No network, no tokens, no argument.
    return { approved: false, rule: hard.rule, critique: hard.critique, source: "rules" };
  }

  if (!options.provider) {
    const soft = hits[0];
    return soft
      ? { approved: false, rule: soft.rule, critique: soft.critique, source: "rules" }
      : { approved: true, critique: "no rule matched", source: "rules" };
  }

  const noted = hits.length
    ? `\n\nStatic analysis already flagged: ${hits.map((h) => `${h.rule} (${h.critique})`).join("; ")}`
    : "";
  try {
    const result = await Promise.race([
      options.provider.complete({
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: `Review this action.${noted}\n\n${describe(action)}` },
        ],
        tools: [],
        ...(options.signal ? { signal: options.signal } : {}),
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("review timed out")), options.timeoutMs ?? 20_000)),
    ]);
    const verdict = parseVerdict(result.content ?? "");
    if (verdict) return verdict;
    // An unparseable verdict is not a rejection. Treating garbage as "blocked" makes
    // every provider hiccup look like a policy violation.
    return { approved: true, critique: "the reviewer did not return a usable verdict", source: "unavailable" };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { approved: true, critique: `the reviewer could not run: ${why}`, source: "unavailable" };
  }
}

/** Terminal lines for a verdict. Returns nothing at all when it passed cleanly. */
export function renderVerdict(verdict: Verdict, colour = true): string[] {
  const c = (code: string, text: string) => (colour ? `\u001b[${code}m${text}\u001b[0m` : text);
  if (verdict.approved && verdict.source !== "unavailable") return [];
  if (verdict.approved) return [`${c("33", "!")} review skipped — ${verdict.critique}`];
  const lines = [`${c("31", "✕")} ${c("1", verdict.rule ?? "REJECTED")} ${c("2", `(${verdict.source})`)}`];
  lines.push(`  ${verdict.critique}`);
  if (verdict.suggestedFix) {
    lines.push(`  ${c("32", "suggested:")} ${verdict.suggestedFix.split("\n")[0]}`);
  }
  return lines;
}
