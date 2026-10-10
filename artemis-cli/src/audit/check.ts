/**
 * `artemis check` — the pre-flight gate. No model, no API key, no network.
 *
 * It answers one question: would this change compile? Cheap enough to run on every
 * commit, which is the only reason a gate like this survives contact with a team.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { AuditCache } from "./cache.ts";
import { formatDiagnostics, hasTypeScript, typeCheck, type Diagnostic } from "./typecheck.ts";

export interface CheckOptions {
  root: string;
  stagedOnly?: boolean;
  noCache?: boolean;
  json?: boolean;
}

export interface CheckReport {
  ok: boolean;
  checked: string[];
  cached: string[];
  diagnostics: Diagnostic[];
  unavailable?: string;
  durationMs: number;
}

async function git(root: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return code === 0 ? stdout.trim() : "";
}

export async function stagedFiles(root: string): Promise<string[]> {
  // ACMR: added, copied, modified, renamed. Deleted files have nothing to check.
  const out = await git(root, ["diff", "--cached", "--name-only", "--diff-filter=ACMR"]);
  return out ? out.split("\n").filter((f) => /\.(ts|tsx|mts|cts)$/.test(f)) : [];
}

export async function runCheck(options: CheckOptions): Promise<CheckReport> {
  const started = Date.now();
  const { root } = options;
  const files = options.stagedOnly ? await stagedFiles(root) : [];

  if (options.stagedOnly && files.length === 0) {
    return { ok: true, checked: [], cached: [], diagnostics: [], durationMs: Date.now() - started };
  }
  if (!hasTypeScript(root)) {
    return {
      ok: true, checked: [], cached: [], diagnostics: [],
      unavailable: "no tsconfig.json; nothing to type-check", durationMs: Date.now() - started,
    };
  }

  const cache = options.noCache ? null : new AuditCache(root);
  const cached: string[] = [];
  const toCheck: string[] = [];

  for (const file of files) {
    let contents: Buffer;
    try {
      contents = readFileSync(join(root, file));
    } catch {
      continue;   // staged then removed between the two commands
    }
    const hit = cache?.lookup(file, contents);
    if (hit?.clean) cached.push(file);
    else toCheck.push(file);
  }

  // Every staged file was already known good, and the compiler runs project-wide
  // anyway, so there is nothing left that this run could discover.
  if (options.stagedOnly && toCheck.length === 0) {
    return { ok: true, checked: [], cached, diagnostics: [], durationMs: Date.now() - started };
  }

  const result = await typeCheck(root);

  if (cache && options.stagedOnly) {
    // Only a file with no diagnostics of its own is recorded clean. A file that the
    // compiler complained about must be re-checked next time even if untouched.
    const broken = new Set(result.diagnostics.map((d) => d.file.replace(/^\.\//, "")));
    for (const file of toCheck) {
      let contents: Buffer;
      try { contents = readFileSync(join(root, file)); } catch { continue; }
      const bad = broken.has(file);
      cache.record(file, contents, !bad && !result.unavailable, bad ? "type errors" : undefined);
    }
    // An unavailable compiler teaches nothing; do not write a cache from it.
    if (!result.unavailable) cache.save();
  }

  return {
    ok: result.ok && !result.unavailable,
    checked: toCheck,
    cached,
    diagnostics: result.diagnostics,
    ...(result.unavailable ? { unavailable: result.unavailable } : {}),
    durationMs: Date.now() - started,
  };
}

export function formatReport(report: CheckReport, colour = true): string {
  const c = (code: string, text: string) => (colour ? `\u001b[${code}m${text}\u001b[0m` : text);
  const lines: string[] = [];
  if (report.unavailable) {
    lines.push(`${c("33", "!")} check could not run: ${report.unavailable}`);
    return lines.join("\n");
  }
  if (report.ok) {
    const skipped = report.cached.length ? `, ${report.cached.length} cached` : "";
    lines.push(`${c("32", "✓")} types clean (${report.durationMs}ms${skipped})`);
    return lines.join("\n");
  }
  lines.push(`${c("31", "✕")} ${report.diagnostics.length} type error(s)`);
  lines.push(formatDiagnostics(report.diagnostics));
  return lines.join("\n");
}
