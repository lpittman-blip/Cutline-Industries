/**
 * The type gate.
 *
 * This is `tsc --noEmit`, not a Language Server. An LSP client means a JSON-RPC
 * handshake, id-matched reads against interleaved notifications, and the push/pull
 * diagnostics split — where `textDocument/diagnostic` returns nothing at all from a
 * server that publishes diagnostics instead, so broken code reads as clean. A gate
 * that silently always passes is worse than no gate. The compiler's exit code cannot
 * lie that way.
 */
import { join } from "node:path";
import { existsSync } from "node:fs";

export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
}

export interface TypeCheckResult {
  /** False only when the compiler actually reported errors. */
  ok: boolean;
  diagnostics: Diagnostic[];
  /** Set when the check could not run at all; `ok` is then meaningless, not true. */
  unavailable?: string;
  durationMs: number;
}

/** `src/a.ts(12,5): error TS2304: Cannot find name 'x'.` */
const LINE = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/;

export function parseDiagnostics(output: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const raw of output.split("\n")) {
    const m = LINE.exec(raw.trim());
    if (!m) continue;
    out.push({
      file: m[1] as string,
      line: Number(m[2]),
      column: Number(m[3]),
      code: m[4] as string,
      message: (m[5] as string).trim(),
    });
  }
  return out;
}

export function hasTypeScript(root: string): boolean {
  return existsSync(join(root, "tsconfig.json"));
}

/**
 * Runs the compiler over the whole project.
 *
 * Whole-project on purpose: type errors are not local. Changing an exported
 * signature breaks callers in files the change never touched, so checking only the
 * edited files would miss precisely the errors worth catching.
 */
export async function typeCheck(root: string, timeoutMs = 120_000): Promise<TypeCheckResult> {
  const started = Date.now();
  if (!hasTypeScript(root)) {
    return { ok: true, diagnostics: [], unavailable: "no tsconfig.json; nothing to type-check", durationMs: 0 };
  }
  const proc = Bun.spawn(["bunx", "tsc", "--noEmit", "--pretty", "false"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });

  // A compiler that hangs must not hang the commit. The timeout reports unavailable
  // rather than clean: not knowing is not the same as passing.
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  let code: number;
  let stdout = "";
  let stderr = "";
  try {
    [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
  } finally {
    clearTimeout(timer);
  }
  const durationMs = Date.now() - started;
  const diagnostics = parseDiagnostics(stdout + "\n" + stderr);

  if (code !== 0 && diagnostics.length === 0) {
    // Non-zero with nothing parseable is the compiler failing to run - a missing
    // dependency, a broken tsconfig - not a clean bill of health.
    const detail = (stderr || stdout).trim().split("\n")[0] ?? `tsc exited ${code}`;
    return { ok: false, diagnostics: [], unavailable: detail, durationMs };
  }
  return { ok: diagnostics.length === 0, diagnostics, durationMs };
}

/** One line per diagnostic, capped, because a thousand errors scroll the first away. */
export function formatDiagnostics(diagnostics: Diagnostic[], limit = 20): string {
  const shown = diagnostics.slice(0, limit)
    .map((d) => `  ${d.file}:${d.line}:${d.column}  ${d.code}  ${d.message}`);
  if (diagnostics.length > limit) shown.push(`  … ${diagnostics.length - limit} more`);
  return shown.join("\n");
}
