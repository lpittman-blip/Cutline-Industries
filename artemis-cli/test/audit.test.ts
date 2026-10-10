import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuditCache, RULES_VERSION, fingerprint } from "../src/audit/cache.ts";
import { formatDiagnostics, parseDiagnostics } from "../src/audit/typecheck.ts";
import { describeRestore, restore, snapshot } from "../src/audit/checkpoint.ts";
import { HOOK, MARKER, hookPath, installHook, uninstallHook } from "../src/audit/hook.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "artemis-audit-"));
}

async function sh(cwd: string, args: string[]): Promise<number> {
  const p = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  await new Response(p.stdout).text();
  await new Response(p.stderr).text();
  return p.exited;
}

async function repo(): Promise<string> {
  const root = tmp();
  await sh(root, ["git", "init", "-q", "-b", "work"]);
  await sh(root, ["git", "config", "user.email", "t@example.com"]);
  await sh(root, ["git", "config", "user.name", "t"]);
  writeFileSync(join(root, "kept.txt"), "committed\n");
  await sh(root, ["git", "add", "."]);
  await sh(root, ["git", "commit", "-qm", "first"]);
  return root;
}

// ------------------------------------------------------------------ cache

describe("audit cache", () => {
  test("a changed byte is a miss", () => {
    const cache = new AuditCache(tmp());
    cache.record("a.ts", "one", true);
    expect(cache.lookup("a.ts", "one")?.clean).toBe(true);
    expect(cache.lookup("a.ts", "two")).toBeNull();
  });

  test("changing the rules invalidates every entry", () => {
    // Otherwise a file marked clean under the old checks is permanently exempt from
    // the new ones - the cache would quietly disable the gate it is speeding up.
    expect(fingerprint("x", 1)).not.toBe(fingerprint("x", 2));
    const root = tmp();
    const first = new AuditCache(root);
    first.record("a.ts", "same", true);
    first.save();
    const stale = JSON.parse(readFileSync(first.path, "utf8"));
    stale.version = RULES_VERSION + 1;
    writeFileSync(first.path, JSON.stringify(stale));
    expect(new AuditCache(root).size).toBe(0);
  });

  test("a failing verdict is remembered too, with its reason", () => {
    const cache = new AuditCache(tmp());
    cache.record("bad.ts", "x", false, "type errors");
    const hit = cache.lookup("bad.ts", "x");
    expect(hit?.clean).toBe(false);
    expect(hit?.detail).toBe("type errors");
  });

  test("an unreadable cache file does not break the run", () => {
    const root = tmp();
    mkdirSync(join(root, ".artemis"), { recursive: true });
    writeFileSync(join(root, ".artemis", "audit-cache.json"), "not json");
    expect(new AuditCache(root).size).toBe(0);
  });

  test("pruning drops entries for files that are gone", () => {
    const cache = new AuditCache(tmp());
    cache.record("a.ts", "x", true);
    cache.record("b.ts", "y", true);
    cache.prune(["a.ts"]);
    expect(cache.size).toBe(1);
    expect(cache.lookup("b.ts", "y")).toBeNull();
  });

  test("the cache round-trips through disk", () => {
    const root = tmp();
    const write = new AuditCache(root);
    write.record("a.ts", "contents", true);
    write.save();
    expect(new AuditCache(root).lookup("a.ts", "contents")?.clean).toBe(true);
  });
});

// ------------------------------------------------------------------ typecheck

describe("compiler diagnostics", () => {
  test("tsc output is parsed into structured errors", () => {
    const out = [
      "src/a.ts(12,5): error TS2304: Cannot find name 'x'.",
      "src/b.tsx(3,11): error TS2322: Type 'string' is not assignable to type 'number'.",
      "some unrelated line",
    ].join("\n");
    const d = parseDiagnostics(out);
    expect(d.length).toBe(2);
    expect(d[0]).toEqual({ file: "src/a.ts", line: 12, column: 5, code: "TS2304", message: "Cannot find name 'x'." });
    expect(d[1]?.code).toBe("TS2322");
  });

  test("warnings and noise are not counted as errors", () => {
    expect(parseDiagnostics("src/a.ts(1,1): warning TS6133: unused.").length).toBe(0);
    expect(parseDiagnostics("").length).toBe(0);
  });

  test("a long error list is capped so the first is still readable", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ file: "a.ts", line: i, column: 1, code: "TS1", message: "m" }));
    const text = formatDiagnostics(many, 5);
    expect(text.split("\n").length).toBe(6);
    expect(text).toContain("… 45 more");
  });
});

// ------------------------------------------------------------------ checkpoint

describe("checkpoints never destroy work", () => {
  test("a snapshot does not commit, move HEAD, or touch the tree", async () => {
    const root = await repo();
    writeFileSync(join(root, "kept.txt"), "edited but not committed\n");
    const before = (await Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: root, stdout: "pipe" }).stdout.text()).trim();

    const snap = await snapshot(root);
    expect(snap).not.toBeNull();
    const after = (await Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: root, stdout: "pipe" }).stdout.text()).trim();

    expect(after).toBe(before);
    expect(snap!.branch).toBe("work");
    expect(readFileSync(join(root, "kept.txt"), "utf8")).toBe("edited but not committed\n");
  });

  test("restoring brings back the uncommitted edit that existed before the agent ran", async () => {
    // This is the whole point: `git reset --hard` would throw this edit away.
    const root = await repo();
    writeFileSync(join(root, "kept.txt"), "work in progress\n");
    const snap = (await snapshot(root))!;

    writeFileSync(join(root, "kept.txt"), "the agent broke it\n");
    const result = await restore(root, snap);

    expect(result.restored).toBe(true);
    expect(readFileSync(join(root, "kept.txt"), "utf8")).toBe("work in progress\n");
  });

  test("files the agent created are reported, never deleted", async () => {
    const root = await repo();
    const snap = (await snapshot(root))!;
    writeFileSync(join(root, "agent-made-this.txt"), "scratch\n");

    const result = await restore(root, snap);
    expect(result.newUntracked).toEqual(["agent-made-this.txt"]);
    expect(existsSync(join(root, "agent-made-this.txt"))).toBe(true);
    expect(describeRestore(result).join("\n")).toContain("not deleted");
  });

  test("an untracked file that predates the snapshot is not reported as new", async () => {
    const root = await repo();
    writeFileSync(join(root, "mine.txt"), "pre-existing\n");
    const snap = (await snapshot(root))!;
    const result = await restore(root, snap);
    expect(result.newUntracked).toEqual([]);
    expect(existsSync(join(root, "mine.txt"))).toBe(true);
  });

  test("outside a git repository a snapshot is null, not a crash", async () => {
    expect(await snapshot(tmp())).toBeNull();
  });
});

// ------------------------------------------------------------------ hook

describe("the pre-commit hook respects what is already there", () => {
  test("installs into a git repo and is executable", async () => {
    const root = await repo();
    const out = installHook(root);
    expect(out.status).toBe("installed");
    const written = readFileSync(hookPath(root), "utf8");
    expect(written).toBe(HOOK);
    expect(written).toContain("--staged-only");
  });

  test("refuses to clobber someone else's hook", async () => {
    // A tool that silently overwrites a secret scanner or lint-staged setup is a bug.
    const root = await repo();
    writeFileSync(hookPath(root), "#!/bin/sh\n# their own scanner\nexit 0\n");
    const out = installHook(root);
    expect(out.status).toBe("exists");
    expect(readFileSync(hookPath(root), "utf8")).toContain("their own scanner");
  });

  test("--force keeps the old hook as a backup rather than deleting it", async () => {
    const root = await repo();
    writeFileSync(hookPath(root), "#!/bin/sh\n# their own scanner\nexit 0\n");
    const out = installHook(root, true);
    expect(out.status).toBe("replaced");
    expect(readFileSync((out as { backup: string }).backup, "utf8")).toContain("their own scanner");
  });

  test("re-installing over our own hook just updates it", async () => {
    const root = await repo();
    installHook(root);
    expect(installHook(root).status).toBe("updated");
  });

  test("uninstall leaves a hook we did not write alone", async () => {
    const root = await repo();
    writeFileSync(hookPath(root), "#!/bin/sh\n# theirs\n");
    const out = uninstallHook(root);
    expect(out.removed).toBe(false);
    expect(readFileSync(hookPath(root), "utf8")).toContain("theirs");
  });

  test("uninstall clears our own hook", async () => {
    const root = await repo();
    installHook(root);
    expect(uninstallHook(root).removed).toBe(true);
    expect(readFileSync(hookPath(root), "utf8")).not.toContain(MARKER);
  });

  test("outside a git repo it says so instead of throwing", () => {
    const out = installHook(tmp());
    expect(out.status).toBe("unavailable");
  });
});
