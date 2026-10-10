import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { relToRoot, resolveInRoot, SandboxError } from "./sandbox.ts";
import type { ToolSchema } from "../agent/types.ts";

export const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".turbo", "coverage"]);
const MAX_OUTPUT = 16_000;

export interface ToolContext {
  root: string;
  /** Force the JS grep fallback even if ripgrep exists (tests). */
  forceJsGrep?: boolean;
  shellTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface ToolResult {
  ok: boolean;
  /** Full text returned to the model. */
  output: string;
  /** One-line summary for the UI timeline. */
  summary: string;
  /** Set by the `done` tool. */
  final?: string;
  /** Set by the `update_plan` tool. */
  plan?: PlanStep[];
}

export interface PlanStep { title: string; status: "pending" | "current" | "done" }

export function normalizePlan(v: unknown): PlanStep[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x) => x && typeof x === "object" && typeof (x as any).title === "string")
    .slice(0, 20)
    .map((x: any) => ({ title: String(x.title).slice(0, 120), status: x.status === "done" || x.status === "current" ? x.status : "pending" }));
}

export type ToolName =
  | "glob"
  | "grep"
  | "read_file"
  | "list_dir"
  | "write_file"
  | "edit_file"
  | "run_shell"
  | "update_plan"
  | "done";

export const MUTATING_TOOLS = new Set<ToolName>(["write_file", "edit_file", "run_shell"]);

export const TOOL_SCHEMAS: Record<ToolName, ToolSchema> = {
  glob: fn("glob", "Find files by glob pattern relative to the project root (e.g. 'src/**/*.ts'). Ignores node_modules/.git. Use this first to map the codebase.", {
    pattern: { type: "string", description: "Glob pattern, e.g. '**/*.tsx'" },
    path: { type: "string", description: "Sub-directory to search in (default: root)" },
    limit: { type: "integer", description: "Max results (default 200)" },
  }, ["pattern"]),
  grep: fn("grep", "Search file contents with a regular expression (ripgrep). Returns path:line:text matches. Use to locate symbols, strings, call sites.", {
    pattern: { type: "string", description: "Regex pattern" },
    path: { type: "string", description: "File or directory to search (default: root)" },
    glob: { type: "string", description: "Only search files matching this glob, e.g. '*.ts'" },
    ignore_case: { type: "boolean" },
    limit: { type: "integer", description: "Max matching lines (default 100)" },
  }, ["pattern"]),
  read_file: fn("read_file", "Read a text file with line numbers. Use start_line/end_line (1-based, inclusive) for large files.", {
    path: { type: "string" },
    start_line: { type: "integer" },
    end_line: { type: "integer" },
  }, ["path"]),
  list_dir: fn("list_dir", "List a directory (dirs end with /).", {
    path: { type: "string", description: "Directory (default: root)" },
  }, []),
  write_file: fn("write_file", "Create or overwrite a file inside the project root. Requires approval unless auto mode.", {
    path: { type: "string" },
    content: { type: "string" },
  }, ["path", "content"]),
  edit_file: fn("edit_file", "Replace an exact string in a file. old_string must match exactly once unless replace_all is true. Read the file first.", {
    path: { type: "string" },
    old_string: { type: "string" },
    new_string: { type: "string" },
    replace_all: { type: "boolean" },
  }, ["path", "old_string", "new_string"]),
  run_shell: fn("run_shell", "Run a shell command in the project root (bash -lc) with a timeout. Use for tests, builds, git status. Requires approval unless auto mode.", {
    command: { type: "string" },
    timeout_ms: { type: "integer", description: "Default 60000, max 600000" },
  }, ["command"]),
  update_plan: fn("update_plan", "Publish or update your plan for the task (shown to the user as a live checklist). Call it early with 3-7 short steps, then again as steps complete. Exactly one step should be 'current' while working.", {
    steps: {
      type: "array",
      items: { type: "object", properties: { title: { type: "string" }, status: { type: "string", enum: ["pending", "current", "done"] } }, required: ["title", "status"] },
    },
  }, ["steps"]),
  done: fn("done", "Finish the task. Call exactly once when the task is complete (or impossible) with a concise summary of what you found/changed.", {
    summary: { type: "string" },
  }, ["summary"]),
};

function fn(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolSchema {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } };
}

export function toolSchemasFor(readOnly: boolean): ToolSchema[] {
  return (Object.keys(TOOL_SCHEMAS) as ToolName[])
    .filter((n) => !(readOnly && MUTATING_TOOLS.has(n)))
    .map((n) => TOOL_SCHEMAS[n]);
}

function truncate(s: string, max = MAX_OUTPUT): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n… [truncated ${s.length - max} chars]`;
}

function str(v: unknown, name: string): string {
  if (typeof v !== "string") throw new Error(`Argument "${name}" must be a string`);
  return v;
}
function optInt(v: unknown, def: number, max: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : def;
}

function isIgnored(rel: string): boolean {
  return rel.split(/[\\/]/).some((seg) => IGNORED_DIRS.has(seg));
}

// ---------------------------------------------------------------- glob
export function globFiles(ctx: ToolContext, pattern: string, sub = ".", limit = 200): string[] {
  const base = resolveInRoot(ctx.root, sub);
  const g = new Bun.Glob(pattern);
  const out: string[] = [];
  for (const f of g.scanSync({ cwd: base, onlyFiles: true, dot: false, followSymlinks: false })) {
    if (isIgnored(f)) continue;
    out.push(relToRoot(ctx.root, path.join(base, f)));
    if (out.length >= limit * 5) break;
  }
  out.sort();
  return out.slice(0, limit);
}

// ---------------------------------------------------------------- grep
let rgPath: string | null | undefined;
function ripgrep(): string | null {
  if (rgPath === undefined) rgPath = Bun.which("rg");
  return rgPath;
}

export interface GrepMatch { file: string; line: number; text: string }

export async function grepFiles(
  ctx: ToolContext,
  opts: { pattern: string; path?: string; glob?: string; ignoreCase?: boolean; limit?: number },
): Promise<{ matches: GrepMatch[]; engine: "ripgrep" | "js" }> {
  const limit = opts.limit ?? 100;
  const target = resolveInRoot(ctx.root, opts.path ?? ".");
  const rg = ctx.forceJsGrep ? null : ripgrep();
  if (rg) {
    const args = [rg, "--line-number", "--no-heading", "--color", "never", "--with-filename", "--max-columns", "400"];
    for (const d of IGNORED_DIRS) args.push("-g", `!${d}`);
    if (opts.ignoreCase) args.push("-i");
    if (opts.glob) args.push("-g", opts.glob);
    args.push("-e", opts.pattern, target);
    const proc = Bun.spawn(args, { cwd: ctx.root, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code === 2) throw new Error(`ripgrep error: ${stderr.trim()}`);
    const matches: GrepMatch[] = [];
    for (const line of stdout.split("\n")) {
      if (!line) continue;
      const m = /^(.*?):(\d+):(.*)$/.exec(line);
      if (!m) continue;
      matches.push({ file: relToRoot(ctx.root, path.resolve(ctx.root, m[1]!)), line: Number(m[2]), text: m[3]! });
    }
    matches.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    return { matches: matches.slice(0, limit), engine: "ripgrep" };
  }
  // JS fallback
  let re: RegExp;
  try {
    re = new RegExp(opts.pattern, opts.ignoreCase ? "i" : "");
  } catch (e) {
    throw new Error(`Invalid regex: ${(e as Error).message}`);
  }
  const fileGlob = opts.glob ? new Bun.Glob(opts.glob.includes("/") ? opts.glob : `**/${opts.glob}`) : null;
  const files: string[] = [];
  if (statSync(target).isFile()) files.push(target);
  else {
    for (const f of new Bun.Glob("**/*").scanSync({ cwd: target, onlyFiles: true })) {
      if (isIgnored(f)) continue;
      if (fileGlob && !fileGlob.match(f)) continue;
      files.push(path.join(target, f));
    }
  }
  files.sort();
  const matches: GrepMatch[] = [];
  for (const abs of files) {
    let text: string;
    try {
      const bytes = await Bun.file(abs).bytes();
      if (bytes.subarray(0, 8000).includes(0)) continue; // binary
      text = new TextDecoder().decode(bytes);
    } catch {
      continue;
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i]!)) {
        matches.push({ file: relToRoot(ctx.root, abs), line: i + 1, text: lines[i]!.slice(0, 400) });
        if (matches.length >= limit) return { matches, engine: "js" };
      }
    }
  }
  return { matches, engine: "js" };
}

// ---------------------------------------------------------------- execute
export async function executeTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    switch (name as ToolName) {
      case "glob": {
        const pattern = str(args.pattern, "pattern");
        const files = globFiles(ctx, pattern, (args.path as string) ?? ".", optInt(args.limit, 200, 1000));
        return { ok: true, output: files.length ? files.join("\n") : "(no files matched)", summary: `${files.length} file${files.length === 1 ? "" : "s"}` };
      }
      case "grep": {
        const { matches, engine } = await grepFiles(ctx, {
          pattern: str(args.pattern, "pattern"),
          path: args.path as string | undefined,
          glob: args.glob as string | undefined,
          ignoreCase: Boolean(args.ignore_case),
          limit: optInt(args.limit, 100, 1000),
        });
        const files = new Set(matches.map((m) => m.file));
        const output = matches.map((m) => `${m.file}:${m.line}:${m.text}`).join("\n");
        return { ok: true, output: truncate(output || "(no matches)"), summary: `${matches.length} match${matches.length === 1 ? "" : "es"} in ${files.size} file${files.size === 1 ? "" : "s"} (${engine})` };
      }
      case "read_file": {
        const abs = resolveInRoot(ctx.root, str(args.path, "path"));
        if (!existsSync(abs)) return fail(`File not found: ${args.path}`);
        if (statSync(abs).isDirectory()) return fail(`${args.path} is a directory; use list_dir`);
        const lines = (await Bun.file(abs).text()).split("\n");
        const start = optInt(args.start_line, 1, lines.length || 1);
        const end = Math.min(optInt(args.end_line, Math.min(lines.length, start + 399), lines.length), lines.length);
        const width = String(end).length;
        const body = lines.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(width)}│${l}`).join("\n");
        return { ok: true, output: truncate(`${args.path} (lines ${start}-${end} of ${lines.length})\n${body}`), summary: `lines ${start}-${end} of ${lines.length}` };
      }
      case "list_dir": {
        const abs = resolveInRoot(ctx.root, (args.path as string) ?? ".");
        const entries = readdirSync(abs, { withFileTypes: true })
          .filter((e) => !IGNORED_DIRS.has(e.name))
          .map((e) => (e.isDirectory() ? `${e.name}/` : `${e.name}  (${statSync(path.join(abs, e.name)).size} B)`))
          .sort();
        return { ok: true, output: entries.join("\n") || "(empty)", summary: `${entries.length} entries` };
      }
      case "write_file": {
        const abs = resolveInRoot(ctx.root, str(args.path, "path"));
        const content = str(args.content, "content");
        const existed = await Bun.file(abs).exists();
        await Bun.write(abs, content); // Bun.write creates parent directories
        const n = content.split("\n").length;
        return { ok: true, output: `${existed ? "Overwrote" : "Created"} ${args.path} (${n} lines)`, summary: `${existed ? "overwrote" : "created"} · ${n} lines` };
      }
      case "edit_file": {
        const abs = resolveInRoot(ctx.root, str(args.path, "path"));
        if (!(await Bun.file(abs).exists())) return fail(`File not found: ${args.path}`);
        const oldS = str(args.old_string, "old_string");
        const newS = str(args.new_string, "new_string");
        if (oldS.length === 0) return fail("old_string must not be empty");
        const text = await Bun.file(abs).text();
        const count = text.split(oldS).length - 1;
        if (count === 0) return fail(`old_string not found in ${args.path}. Read the file and copy the exact text.`);
        if (count > 1 && !args.replace_all) return fail(`old_string matches ${count} times in ${args.path}; add more context or set replace_all.`);
        const next = args.replace_all ? text.split(oldS).join(newS) : text.replace(oldS, () => newS);
        await Bun.write(abs, next);
        const reps = args.replace_all ? count : 1;
        return { ok: true, output: `Edited ${args.path}: ${reps} replacement${reps === 1 ? "" : "s"}`, summary: `${reps} replacement${reps === 1 ? "" : "s"} · -${oldS.split("\n").length}/+${newS.split("\n").length} lines` };
      }
      case "run_shell": {
        const command = str(args.command, "command");
        const timeout = optInt(args.timeout_ms, ctx.shellTimeoutMs ?? 60_000, 600_000);
        const proc = Bun.spawn(["bash", "-lc", command], { cwd: resolveInRoot(ctx.root, "."), stdout: "pipe", stderr: "pipe", env: process.env });
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, timeout);
        const onAbort = () => proc.kill("SIGKILL");
        ctx.signal?.addEventListener("abort", onAbort);
        const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
        const out = [stdout && `stdout:\n${stdout}`, stderr && `stderr:\n${stderr}`].filter(Boolean).join("\n");
        if (timedOut) return { ok: false, output: truncate(`Timed out after ${timeout}ms\n${out}`), summary: `timed out (${timeout}ms)` };
        return { ok: code === 0, output: truncate(`exit ${code}\n${out}`), summary: `exit ${code}` };
      }
      case "update_plan": {
        const steps = normalizePlan(args.steps);
        if (!steps.length) return fail("steps must be a non-empty array of {title, status}");
        const done = steps.filter((x) => x.status === "done").length;
        return { ok: true, output: `Plan updated (${done}/${steps.length} done).`, summary: `${done}/${steps.length} done`, plan: steps };
      }
      case "done": {
        const summary = typeof args.summary === "string" ? args.summary : "Done.";
        return { ok: true, output: "Task marked done.", summary: "finished", final: summary };
      }
      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (e) {
    const err = e as Error;
    return fail(err instanceof SandboxError ? `Sandbox: ${err.message}` : err.message);
  }
}

function fail(msg: string): ToolResult {
  return { ok: false, output: `Error: ${msg}`, summary: msg.length > 80 ? msg.slice(0, 77) + "…" : msg };
}

/** Preview shown in confirmation prompts. */
export function previewFor(name: string, args: Record<string, unknown>, root: string): string {
  if (name === "run_shell") return `$ ${args.command}`;
  if (name === "write_file") {
    const c = String(args.content ?? "");
    const lines = c.split("\n");
    let exists = false;
    try { exists = existsSync(resolveInRoot(root, String(args.path))); } catch {}
    return `${exists ? "overwrite" : "create"} ${args.path} (${lines.length} lines)\n` + lines.slice(0, 12).map((l) => `+ ${l}`).join("\n") + (lines.length > 12 ? `\n+ … ${lines.length - 12} more` : "");
  }
  if (name === "edit_file") {
    const o = String(args.old_string ?? "").split("\n").slice(0, 8).map((l) => `- ${l}`);
    const n = String(args.new_string ?? "").split("\n").slice(0, 8).map((l) => `+ ${l}`);
    return `edit ${args.path}${args.replace_all ? " (all occurrences)" : ""}\n${[...o, ...n].join("\n")}`;
  }
  return JSON.stringify(args);
}
