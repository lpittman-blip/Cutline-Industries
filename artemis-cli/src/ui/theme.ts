/** Artemis landing-page palette. */
export const C = {
  blue: "#2f6fed",
  sky: "#4c8dff",
  green: "#3dbe78",
  orange: "#f08a3c",
  red: "#ef5b5b",
  yellow: "#f5c542",
  text: "#e8edf7",
  muted: "#8a94a6",
  faint: "#5b6475",
} as const;

export const TOOL_ICONS: Record<string, string> = {
  glob: "⌕",
  grep: "≡",
  read_file: "▤",
  list_dir: "▦",
  write_file: "✎",
  edit_file: "✐",
  run_shell: "❯",
  update_plan: "☰",
  done: "◆",
};

export function argSummary(name: string, args: Record<string, unknown>, max = 64): string {
  const full = argSummaryFull(name, args);
  return full.length > max ? full.slice(0, max - 1) + "…" : full;
}

function argSummaryFull(name: string, args: Record<string, unknown>): string {
  const s = (v: unknown) => String(v ?? "");
  switch (name) {
    case "glob": return s(args.pattern) + (args.path ? ` in ${s(args.path)}` : "");
    case "grep": return `/${s(args.pattern)}/` + (args.glob ? ` ${s(args.glob)}` : "") + (args.path ? ` in ${s(args.path)}` : "");
    case "read_file": return s(args.path) + (args.start_line ? `:${s(args.start_line)}-${s(args.end_line ?? "")}` : "");
    case "list_dir": return s(args.path || ".");
    case "write_file":
    case "edit_file": return s(args.path);
    case "run_shell": return s(args.command);
    case "done": return "";
    case "update_plan": return `${Array.isArray(args.steps) ? args.steps.length : 0} steps`;
    default: return JSON.stringify(args).slice(0, 80);
  }
}

export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
export function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

import type { Mode, Phase } from "../agent/types.ts";

export const PHASE_BADGE: Record<Phase, { label: string; color: string }> = {
  idle: { label: "READY", color: C.green },
  planning: { label: "PLANNING", color: C.sky },
  analyzing: { label: "ANALYZING", color: C.blue },
  awaiting_approval: { label: "AWAITING APPROVAL", color: C.orange },
  executing: { label: "EXECUTING", color: C.orange },
  done: { label: "DONE", color: C.green },
  error: { label: "ERROR", color: C.red },
  cancelled: { label: "ABORTED", color: C.muted },
};

export const SAFETY: Record<Mode, { label: string; color: string; hint: string }> = {
  confirm: { label: "SANDBOXED", color: C.sky, hint: "writes & shell need approval" },
  auto: { label: "AUTO", color: C.orange, hint: "no approvals" },
  read_only: { label: "READ-ONLY", color: C.green, hint: "no writes or shell" },
};
