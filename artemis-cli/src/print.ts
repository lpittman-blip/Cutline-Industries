import { Agent, type RunResult } from "./agent/loop.ts";
import type { AgentEvent, Mode, Provider } from "./agent/types.ts";
import { argSummary, fmtMs } from "./ui/theme.ts";

/** Non-interactive runner for `--print` (and non-TTY stdin). Plain text to stdout. */
export async function runPrint(opts: {
  provider: Provider;
  root: string;
  mode: Mode;
  maxSteps: number;
  task: string;
  json?: boolean;
  connection: string;
  target: string;
  out?: (s: string) => void;
  tokenBudget?: number;
  review?: boolean;
}): Promise<RunResult> {
  const out = opts.out ?? ((s: string) => process.stdout.write(s));
  const useColor = !opts.out && process.stdout.isTTY && !process.env.NO_COLOR;
  const col = (hex: string, s: string) => {
    if (!useColor) return s;
    const n = parseInt(hex.slice(1), 16);
    return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m${s}\x1b[0m`;
  };
  let streaming = false;
  const onEvent = (e: AgentEvent) => {
    if (opts.json) { if (e.type !== "assistant_delta") out(JSON.stringify(e) + "\n"); return; }
    if (e.type === "phase") return;
    switch (e.type) {
      case "run_start":
        out(col("#4c8dff", "◆ ARTEMIS CLI") + ` · ${e.model} via ${opts.connection} ${opts.target} · mode ${e.mode} · root ${e.root}\n`);
        out(col("#2f6fed", "❯ ") + e.task + "\n");
        break;
      case "step":
        out(col("#5b6475", `── step ${e.step}/${e.maxSteps}\n`));
        break;
      case "assistant_delta":
        if (!streaming) { out(col("#4c8dff", "  ◆ ")); streaming = true; }
        out(e.text);
        break;
      case "assistant_message":
        if (streaming) { out("\n"); streaming = false; } else out(col("#4c8dff", "  ◆ ") + e.text + "\n");
        break;
      case "plan":
        if (e.source === "model" && e.steps.length) {
          out(col("#5b6475", "  ☰ plan  ") + e.steps.map((s) => (s.status === "done" ? col("#3dbe78", "✓ " + s.title) : s.status === "current" ? col("#f5c542", "▸ " + s.title) : col("#5b6475", "○ " + s.title))).join(col("#5b6475", " · ")) + "\n");
        }
        break;
      case "tool_start":
        if (e.name === "update_plan") break;
        if (streaming) { out("\n"); streaming = false; }
        out(`  ${col("#4c8dff", "▸")} ${e.name} ${argSummary(e.name, e.args)}\n`);
        break;
      case "review":
        out(col(e.approved ? "#f5c542" : "#ef5b5b", `  ${e.approved ? "!" : "\u2715"} review ${e.approved ? "skipped" : `blocked by ${e.rule ?? "review"}`}: ${e.critique}\n`));
        break;
      case "approval_required":
        out(col("#f08a3c", `    ▲ ${e.request.tool} needs approval (re-run with --yes to allow)\n`));
        break;
      case "tool_end":
        if (e.name === "update_plan") break;
        out(`    ${e.ok ? col("#3dbe78", "✓") : col("#ef5b5b", "✗")} ${e.summary} ${col("#5b6475", fmtMs(e.durationMs))}\n`);
        break;
      case "usage":
        break;
      case "done":
        out(col("#3dbe78", `\n✓ Done in ${e.steps} steps\n`) + e.summary + "\n");
        break;
      case "error":
        out(col("#ef5b5b", `✗ ${e.message}\n`));
        break;
      case "cancelled":
        out("⊘ cancelled\n");
        break;
    }
  };
  const agent = new Agent({
    provider: opts.provider,
    root: opts.root,
    mode: opts.mode,
    maxSteps: opts.maxSteps,
    review: opts.review,
    onEvent,
    // No interactive approval in print mode: deny unless --yes/--auto set mode=auto.
    confirm: async () => false,
  });
  const ac = new AbortController();
  const onSig = () => ac.abort();
  process.once("SIGINT", onSig);
  if (opts.tokenBudget) agent.tokenBudget = opts.tokenBudget;
  const res = await agent.run(opts.task, ac.signal);
  process.off("SIGINT", onSig);
  if (!opts.json) out(col("#5b6475", `tokens ${res.usage.promptTokens}↑ ${res.usage.completionTokens}↓ · ${res.steps} steps · ${res.status}\n`));
  return res;
}
