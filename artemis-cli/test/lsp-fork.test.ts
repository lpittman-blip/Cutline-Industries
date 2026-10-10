import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LspClient } from "../src/audit/lsp.ts";
import { diff, evaluate, formatResults, type Candidate } from "../src/audit/fork.ts";
import { changedAmong, shadowBranchName } from "../src/audit/shadow.ts";

async function sh(cwd: string, args: string[]): Promise<number> {
  const p = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  await new Response(p.stdout).text();
  await new Response(p.stderr).text();
  return p.exited;
}

const TSCONFIG = JSON.stringify({
  compilerOptions: { strict: true, noEmit: true, target: "es2023", module: "nodenext", moduleResolution: "nodenext", skipLibCheck: true },
  include: ["src"],
});

async function tsRepo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "artemis-fork-"));
  await sh(root, ["git", "init", "-q", "-b", "work"]);
  await sh(root, ["git", "config", "user.email", "t@e.com"]);
  await sh(root, ["git", "config", "user.name", "t"]);
  writeFileSync(join(root, "tsconfig.json"), TSCONFIG);
  await sh(root, ["mkdir", "-p", join(root, "src")]).catch(() => {});
  Bun.spawnSync(["mkdir", "-p", join(root, "src")]);
  writeFileSync(join(root, "src", "a.ts"), "export const n: number = 1;\n");
  await sh(root, ["git", "add", "-A"]);
  await sh(root, ["git", "commit", "-qm", "init"]);
  return root;
}

const candidate = (id: string, contents: string): Candidate => ({ id, rationale: `variant ${id}`, file: "src/a.ts", contents });

describe("speculative forking", () => {
  test("the compiling candidate wins and the broken one is rejected", async () => {
    const root = await tsRepo();
    const outcome = await evaluate(root, [
      candidate("broken", "export const n: number = 'not a number';\n"),
      candidate("good", "export const n: number = 2;\n"),
    ], { concurrency: 2 });

    expect(outcome.winner?.id).toBe("good");
    expect(outcome.results.find((r) => r.id === "broken")?.valid).toBe(false);
    expect(outcome.results.find((r) => r.id === "good")?.valid).toBe(true);
  }, 120_000);

  test("the developer's working tree is never touched", async () => {
    // Each fork is its own worktree. Checking out branches in one directory is
    // what makes concurrent forks corrupt each other.
    const root = await tsRepo();
    writeFileSync(join(root, "src", "a.ts"), "export const n: number = 999; // my edit\n");
    await evaluate(root, [candidate("x", "export const n: number = 2;\n")], { concurrency: 1 });

    expect(await Bun.file(join(root, "src", "a.ts")).text()).toContain("my edit");
    const branch = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: root });
    expect(branch.stdout.toString().trim()).toBe("work");
  }, 120_000);

  test("no worktrees are left registered afterwards", async () => {
    const root = await tsRepo();
    await evaluate(root, [candidate("a", "export const n: number = 2;\n"), candidate("b", "export const n: number = 3;\n")], { concurrency: 2 });
    const list = Bun.spawnSync(["git", "worktree", "list"], { cwd: root }).stdout.toString();
    expect(list.split("\n").filter((l) => l.trim()).length).toBe(1);
  }, 120_000);

  test("when nothing compiles there is no winner, and it says so", async () => {
    const root = await tsRepo();
    const outcome = await evaluate(root, [candidate("bad", "export const n: number = 'x';\n")], { concurrency: 1 });
    expect(outcome.winner).toBeNull();
    expect(formatResults(outcome).join("\n")).toContain("no candidate compiled");
  }, 120_000);

  test("outside a git repo every candidate fails cleanly", async () => {
    const outcome = await evaluate(mkdtempSync(join(tmpdir(), "nogit-")), [candidate("a", "x")], {});
    expect(outcome.winner).toBeNull();
    expect(outcome.results[0]?.reason).toContain("not a git repository");
  });

  test("the diff shows only real differences", () => {
    expect(diff("same\n", "same\n", "a.ts")).toEqual([]);
    const d = diff("a\nb\n", "a\nc\n", "a.ts");
    expect(d).toContain("-b");
    expect(d).toContain("+c");
  });
});

describe("shadow pull requests", () => {
  test("the branch is namespaced and keyed by commit", () => {
    expect(shadowBranchName("refs/heads/feature/x", "abcdef1234567")).toBe("artemis/fix/feature/x-abcdef1");
    expect(shadowBranchName("weird branch!", "abcdef1234567")).toBe("artemis/fix/weird-branch--abcdef1");
  });

  test("only files the agent actually changed are considered", async () => {
    // `git add .` sweeps up build output and an untracked .env; this does not.
    const root = await tsRepo();
    writeFileSync(join(root, "src", "a.ts"), "export const n: number = 5;\n");
    writeFileSync(join(root, "untracked-secret.txt"), "do not commit me\n");
    const changed = await changedAmong(root, ["src/a.ts", "src/never-touched.ts"]);
    expect(changed).toEqual(["src/a.ts"]);
    expect(changed).not.toContain("untracked-secret.txt");
  });

  test("a clean tree offers nothing", async () => {
    expect(await changedAmong(await tsRepo(), ["src/a.ts"])).toEqual([]);
  });
});

describe("the language server client", () => {
  test("a missing language server reports unavailable instead of throwing", async () => {
    const client = new LspClient(mkdtempSync(join(tmpdir(), "lsp-")), ["definitely-not-a-real-binary-xyz", "--stdio"]);
    expect(await client.start(2000)).toBe(false);
    expect(client.available).toBe(false);
    // Every call is a safe no-op once unavailable, so a caller needs no guard.
    expect(await client.diagnostics("a.ts")).toBeNull();
    expect(await client.references("a.ts", 1, 1)).toEqual([]);
    expect(await client.hover("a.ts", 1, 1)).toBeNull();
    await client.stop();
  }, 20_000);

  test("a server that never answers times out rather than hanging", async () => {
    // Consumes stdin and never writes: the shape of a wedged server. Note `cat`
    // would NOT work here - it echoes, and an echo of our own reply is
    // indistinguishable from a real response at the protocol level.
    const client = new LspClient(mkdtempSync(join(tmpdir(), "lsp-")), ["sh", "-c", "cat > /dev/null"]);
    const started = Date.now();
    expect(await client.start(1200)).toBe(false);
    expect(Date.now() - started).toBeLessThan(6000);
    await client.stop();
  }, 20_000);
});

describe("against a real typescript-language-server", () => {
  const bin = join(process.cwd(), "node_modules/.bin/typescript-language-server");
  const installed = Bun.spawnSync(["test", "-x", bin]).exitCode === 0;

  test.skipIf(!installed)("diagnostics arrive by push, because tsserver does not offer pull", async () => {
    // The point of the push path. Asking textDocument/diagnostic of a server that
    // does not advertise diagnosticProvider returns nothing, and broken code then
    // reads as clean.
    const root = mkdtempSync(join(tmpdir(), "lsp-real-"));
    Bun.spawnSync(["mkdir", "-p", join(root, "src")]);
    writeFileSync(join(root, "tsconfig.json"), TSCONFIG);
    writeFileSync(join(root, "src", "broken.ts"), "export const n: number = 'a string';\n");

    const client = new LspClient(root, [bin, "--stdio"]);
    expect(await client.start(25_000)).toBe(true);
    expect(client.supportsPull).toBe(false);

    const diags = await client.diagnostics("src/broken.ts", 15_000);
    expect(diags).not.toBeNull();
    expect(diags!.some((d) => d.code === "2322" && d.severity === "error")).toBe(true);
    expect(diags![0]!.line).toBe(1);          // 1-based, as a human reads it
    await client.stop();
  }, 60_000);

  test.skipIf(!installed)("references and definition resolve across files", async () => {
    // What the compiler cannot answer, and what grep answers badly.
    const root = mkdtempSync(join(tmpdir(), "lsp-real-"));
    Bun.spawnSync(["mkdir", "-p", join(root, "src")]);
    writeFileSync(join(root, "tsconfig.json"), TSCONFIG);
    writeFileSync(join(root, "src", "lib.ts"), "export function authorize(user: string): boolean {\n  return user.length > 0;\n}\n");
    writeFileSync(join(root, "src", "app.ts"), "import { authorize } from './lib';\nexport const ok = authorize('x');\n");

    const client = new LspClient(root, [bin, "--stdio"]);
    expect(await client.start(25_000)).toBe(true);
    client.open("src/app.ts");

    const refs = await client.references("src/lib.ts", 1, 17);
    expect(refs.some((r) => r.file === "src/app.ts")).toBe(true);

    const def = await client.definition("src/app.ts", 2, 20);
    expect(def[0]?.file).toBe("src/lib.ts");

    const hover = await client.hover("src/lib.ts", 1, 17);
    expect(hover).toContain("authorize");
    await client.stop();
  }, 60_000);
});
