import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveInRoot, SandboxError } from "../src/tools/sandbox.ts";
import { executeTool, toolSchemasFor } from "../src/tools/index.ts";
import { makeFixture } from "./helpers.ts";

describe("sandbox", () => {
  const root = makeFixture();
  test("resolves paths inside the root", () => {
    expect(resolveInRoot(root, "src/math.ts")).toBe(path.join(resolveInRoot(root, "."), "src/math.ts"));
    expect(resolveInRoot(root, "new/dir/file.ts")).toEndWith("new/dir/file.ts");
  });
  test("rejects ../ escapes, absolute paths and symlinks out", () => {
    expect(() => resolveInRoot(root, "../outside.txt")).toThrow(SandboxError);
    expect(() => resolveInRoot(root, "src/../../etc/passwd")).toThrow(SandboxError);
    expect(() => resolveInRoot(root, "/etc/passwd")).toThrow(SandboxError);
    symlinkSync(os.tmpdir(), path.join(root, "escape"));
    expect(() => resolveInRoot(root, "escape/x.txt")).toThrow(SandboxError);
  });
  test("tools refuse to write outside the root", async () => {
    const r = await executeTool("write_file", { path: "../pwned.txt", content: "x" }, { root });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("Sandbox");
    expect(existsSync(path.join(root, "..", "pwned.txt"))).toBe(false);
    const e = await executeTool("edit_file", { path: "/etc/hosts", old_string: "a", new_string: "b" }, { root });
    expect(e.ok).toBe(false);
  });
});

describe("tools", () => {
  const root = makeFixture();
  test("glob finds files and skips node_modules", async () => {
    const r = await executeTool("glob", { pattern: "**/*.ts" }, { root });
    expect(r.ok).toBe(true);
    expect(r.output.split("\n")).toEqual(["src/index.ts", "src/math.ts", "src/util/strings.ts"]);
  });
  for (const forceJsGrep of [false, true]) {
    test(`grep (${forceJsGrep ? "JS fallback" : "ripgrep"}) returns path:line:text and skips node_modules`, async () => {
      const r = await executeTool("grep", { pattern: "export function add" }, { root, forceJsGrep });
      expect(r.ok).toBe(true);
      expect(r.output).toBe("src/math.ts:1:export function add(a: number, b: number) {");
      const g = await executeTool("grep", { pattern: "todo", ignore_case: true, glob: "*.md" }, { root, forceJsGrep });
      expect(g.output).toBe("README.md:2:TODO: docs");
      expect(r.summary).toContain(forceJsGrep ? "(js)" : "(ripgrep)");
    });
  }
  test("read_file supports line ranges", async () => {
    const r = await executeTool("read_file", { path: "src/math.ts", start_line: 2, end_line: 3 }, { root });
    expect(r.output).toContain("lines 2-3 of 8");
    expect(r.output).toContain("2│  return a - b; // BUG");
    expect(r.output).not.toContain("export function add");
  });
  test("list_dir", async () => {
    const r = await executeTool("list_dir", { path: "." }, { root });
    expect(r.output).toContain("src/");
    expect(r.output).not.toContain("node_modules");
  });
  test("write_file then edit_file with exact replace semantics", async () => {
    expect((await executeTool("write_file", { path: "notes/a.txt", content: "x\nx\ny\n" }, { root })).ok).toBe(true);
    const dup = await executeTool("edit_file", { path: "notes/a.txt", old_string: "x", new_string: "z" }, { root });
    expect(dup.ok).toBe(false);
    expect(dup.output).toContain("matches 2 times");
    const missing = await executeTool("edit_file", { path: "notes/a.txt", old_string: "nope", new_string: "z" }, { root });
    expect(missing.output).toContain("not found");
    expect((await executeTool("edit_file", { path: "notes/a.txt", old_string: "y", new_string: "$& literal" }, { root })).ok).toBe(true);
    expect((await executeTool("edit_file", { path: "notes/a.txt", old_string: "x", new_string: "z", replace_all: true }, { root })).summary).toContain("2 replacements");
    expect(readFileSync(path.join(root, "notes/a.txt"), "utf8")).toBe("z\nz\n$& literal\n");
  });
  test("run_shell runs in the root and enforces timeouts", async () => {
    const r = await executeTool("run_shell", { command: "pwd && echo hi >&2 && exit 3" }, { root });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("exit 3");
    expect(r.output).toContain("hi");
    expect(r.output).toContain(path.basename(root));
    const t = await executeTool("run_shell", { command: "sleep 5", timeout_ms: 200 }, { root });
    expect(t.ok).toBe(false);
    expect(t.summary).toContain("timed out");
  });
  test("update_plan validates and normalizes steps", async () => {
    const r = await executeTool("update_plan", { steps: [{ title: "a", status: "done" }, { title: "b", status: "current" }, { title: "c", status: "weird" }] }, { root });
    expect(r.ok).toBe(true);
    expect(r.plan).toEqual([{ title: "a", status: "done" }, { title: "b", status: "current" }, { title: "c", status: "pending" }]);
    expect((await executeTool("update_plan", { steps: [] }, { root })).ok).toBe(false);
  });
  test("read-only tool list excludes mutating tools", () => {
    const names = toolSchemasFor(true).map((t) => t.function.name);
    expect(names).toEqual(["glob", "grep", "read_file", "list_dir", "update_plan", "done"]);
    expect(toolSchemasFor(false)).toHaveLength(9);
  });
});
