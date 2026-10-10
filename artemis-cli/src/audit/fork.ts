/**
 * Speculative forking: try several versions of a change, keep the one that compiles.
 *
 * On `git worktree`, not `git checkout -b`. Checking out branches in one working
 * directory is not parallel-safe — two forks racing in the same tree corrupt each
 * other, which is the exact failure the design claims to prevent. A worktree gives
 * each fork its own directory sharing one object store: genuinely concurrent, and
 * cheap because nothing is copied twice.
 *
 * It never touches the developer's tree. Forks live under the repo's git directory,
 * are evaluated there, and only the winner's file content comes back — as a value
 * for the caller to apply through the normal reviewed, approved write path.
 */
import { mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface Candidate {
  id: string;
  /** Why this one is worth trying, shown in the summary. */
  rationale: string;
  file: string;
  /** The complete new contents of that file. Not a diff. */
  contents: string;
}

export interface ForkResult {
  id: string;
  rationale: string;
  valid: boolean;
  errors: number;
  reason?: string;
  durationMs: number;
}

export interface ForkOutcome {
  results: ForkResult[];
  /** The candidate that compiled, with the fewest errors and then fastest. */
  winner: Candidate | null;
  /** The file as it stands now, so a caller can show a diff against the winner. */
  original: string | null;
}

async function git(cwd: string, args: string[], timeoutMs = 30_000): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout: stdout.trim(), stderr: stderr.trim() };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Evaluates every candidate concurrently, each in its own worktree.
 *
 * `concurrency` is capped on purpose: each fork runs a full `tsc`, and ten at once
 * on a CI box with two cores is slower than three, not faster.
 */
export async function evaluate(
  root: string,
  candidates: Candidate[],
  options: { concurrency?: number; timeoutMs?: number; test?: string[] } = {},
): Promise<ForkOutcome> {
  const limit = Math.max(1, Math.min(options.concurrency ?? 3, 6));
  const base = resolve(root);

  const inside = await git(base, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0) {
    return { results: candidates.map((c) => fail(c, "not a git repository")), winner: null, original: null };
  }
  // Forks are evaluated against committed state, so an uncommitted edit in the
  // developer's tree neither leaks into a fork nor is disturbed by one.
  const head = (await git(base, ["rev-parse", "HEAD"])).stdout;
  if (!head) {
    return { results: candidates.map((c) => fail(c, "no commits yet; nothing to fork from")), winner: null, original: null };
  }

  let original: string | null = null;
  if (candidates[0]) {
    original = await readFile(join(base, candidates[0].file), "utf8").catch(() => null);
  }

  const results: ForkResult[] = [];
  const queue = [...candidates];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (;;) {
      const candidate = queue.shift();
      if (!candidate) return;
      results.push(await evaluateOne(base, head, candidate, options));
    }
  });
  await Promise.all(workers);

  results.sort((a, b) => Number(b.valid) - Number(a.valid) || a.errors - b.errors || a.durationMs - b.durationMs);
  const best = results.find((r) => r.valid);
  return {
    results,
    winner: best ? candidates.find((c) => c.id === best.id) ?? null : null,
    original,
  };
}

function fail(c: Candidate, reason: string): ForkResult {
  return { id: c.id, rationale: c.rationale, valid: false, errors: 0, reason, durationMs: 0 };
}

async function evaluateOne(
  base: string,
  head: string,
  candidate: Candidate,
  options: { timeoutMs?: number; test?: string[] },
): Promise<ForkResult> {
  const started = Date.now();
  const dir = mkdtempSync(join(tmpdir(), `artemis-fork-${candidate.id}-`));

  // --detach: the fork is a throwaway checkout of HEAD, not a branch anyone will
  // see, so there is no branch to leak or to clean up afterwards.
  const added = await git(base, ["worktree", "add", "--detach", "--quiet", dir, head]);
  if (added.code !== 0) {
    return { ...fail(candidate, `worktree add failed: ${added.stderr.split("\n")[0] ?? ""}`), durationMs: Date.now() - started };
  }

  try {
    await writeFile(join(dir, candidate.file), candidate.contents, "utf8");

    const tsc = Bun.spawn(["bunx", "tsc", "--noEmit", "--pretty", "false"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const killer = setTimeout(() => tsc.kill(), options.timeoutMs ?? 120_000);
    const [out, err, code] = await Promise.all([
      new Response(tsc.stdout).text(),
      new Response(tsc.stderr).text(),
      tsc.exited,
    ]);
    clearTimeout(killer);

    const errors = (out + err).split("\n").filter((l) => /\(\d+,\d+\): error TS\d+:/.test(l)).length;
    if (code !== 0 || errors > 0) {
      return { id: candidate.id, rationale: candidate.rationale, valid: false, errors, reason: `${errors || "compiler"} error(s)`, durationMs: Date.now() - started };
    }

    if (options.test?.length) {
      const proc = Bun.spawn(options.test, { cwd: dir, stdout: "pipe", stderr: "pipe" });
      // Generous, and measured rather than guessed: a suite that takes ten seconds
      // fails a five-second limit every time, and a timeout is an exception, not a
      // non-zero exit code, so it has to be handled as its own outcome.
      const testKiller = setTimeout(() => proc.kill(), options.timeoutMs ?? 120_000);
      const [, , testCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      clearTimeout(testKiller);
      if (testCode !== 0) {
        return { id: candidate.id, rationale: candidate.rationale, valid: false, errors: 0, reason: "tests failed", durationMs: Date.now() - started };
      }
    }
    return { id: candidate.id, rationale: candidate.rationale, valid: true, errors: 0, durationMs: Date.now() - started };
  } catch (error) {
    return { ...fail(candidate, error instanceof Error ? error.message : String(error)), durationMs: Date.now() - started };
  } finally {
    // --force because the fork's tree is dirty by construction; without it the
    // worktree is left registered and the next run trips over it.
    await git(base, ["worktree", "remove", "--force", dir]).catch(() => {});
    await git(base, ["worktree", "prune"]).catch(() => {});
  }
}

/** A unified diff of the winner against what is on disk now. */
export function diff(original: string, winner: string, file: string): string[] {
  const a = original.split("\n");
  const b = winner.split("\n");
  const lines = [`--- a/${file}`, `+++ b/${file}`];
  // A line-by-line comparison, not a minimal edit script: enough to read a change,
  // and it cannot claim an edit the two files do not actually differ by.
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] !== undefined) lines.push(`-${a[i]}`);
    if (b[i] !== undefined) lines.push(`+${b[i]}`);
  }
  return lines.length > 2 ? lines : [];
}

export function formatResults(outcome: ForkOutcome): string[] {
  const lines: string[] = [];
  for (const r of outcome.results) {
    lines.push(r.valid
      ? `  ✓ ${r.id}  ${r.rationale} — compiles (${(r.durationMs / 1000).toFixed(1)}s)`
      : `  ✕ ${r.id}  ${r.rationale} — ${r.reason ?? "rejected"}`);
  }
  lines.push(outcome.winner ? `  → ${outcome.winner.id} wins` : "  → no candidate compiled; nothing to apply");
  return lines;
}
