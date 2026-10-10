/**
 * Workspace snapshots that cannot eat your work.
 *
 * The obvious implementation — `git add . && git commit` to snapshot, `git reset
 * --hard && git clean -fd` to restore — is the one to avoid. It writes
 * `artemis_snapshot_*` commits onto whatever branch the developer is on, and the
 * restore destroys every uncommitted edit they had open before the agent started,
 * irrecoverably. An agent is not entitled to do that to someone's working tree.
 *
 * `git stash create` is the right primitive: it builds a commit object holding the
 * working tree and index and prints its SHA, and it changes nothing. No commit on
 * your branch, no moved HEAD, no touched files. Restoring checks tracked paths back
 * out of that object.
 *
 * The honest limit: `stash create` records tracked files only. Files the agent newly
 * created are therefore NOT removed by a restore — they are listed instead, and
 * deleting them is left to a human. Silently deleting untracked files is how an
 * agent destroys the one scratch file that was not meant to be in git.
 */

export interface Snapshot {
  /** The stash commit holding tracked content, or null in a clean tree with nothing to save. */
  commit: string | null;
  /** Untracked paths at snapshot time, so a restore can report what appeared since. */
  untracked: string[];
  branch: string;
  takenAt: number;
}

export interface RestoreResult {
  restored: boolean;
  /** Untracked files that appeared after the snapshot. Reported, never deleted. */
  newUntracked: string[];
  detail?: string;
}

async function git(root: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

export async function isGitRepo(root: string): Promise<boolean> {
  return (await git(root, ["rev-parse", "--is-inside-work-tree"])).code === 0;
}

async function untrackedFiles(root: string): Promise<string[]> {
  const { stdout } = await git(root, ["ls-files", "--others", "--exclude-standard"]);
  return stdout ? stdout.split("\n").filter(Boolean) : [];
}

/** Captures the working tree without altering it. Returns null outside a git repo. */
export async function snapshot(root: string): Promise<Snapshot | null> {
  if (!(await isGitRepo(root))) return null;
  const branch = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout || "HEAD";
  // Empty stdout from `stash create` means the tree is clean: nothing to save, which
  // is a valid snapshot, not a failure.
  const created = await git(root, ["stash", "create"]);
  if (created.code !== 0) return null;
  return {
    commit: created.stdout || null,
    untracked: await untrackedFiles(root),
    branch,
    takenAt: Date.now(),
  };
}

/**
 * Puts tracked files back as they were. Never switches branch, never hard-resets,
 * never deletes anything.
 */
export async function restore(root: string, snap: Snapshot): Promise<RestoreResult> {
  const now = await untrackedFiles(root);
  const before = new Set(snap.untracked);
  const newUntracked = now.filter((f) => !before.has(f));

  if (!snap.commit) {
    // The tree was clean when captured. Discarding tracked edits made since is the
    // correct restore, and `checkout -- .` does exactly that against HEAD.
    const reset = await git(root, ["checkout", "--", "."]);
    return { restored: reset.code === 0, newUntracked, ...(reset.code === 0 ? {} : { detail: reset.stderr }) };
  }
  const out = await git(root, ["checkout", snap.commit, "--", "."]);
  if (out.code !== 0) return { restored: false, newUntracked, detail: out.stderr };
  return { restored: true, newUntracked };
}

/** Lines a caller can print after a restore, including what it deliberately left behind. */
export function describeRestore(result: RestoreResult): string[] {
  const lines: string[] = [];
  lines.push(result.restored ? "workspace restored to the snapshot" : `restore failed: ${result.detail ?? "unknown"}`);
  if (result.newUntracked.length) {
    lines.push(`${result.newUntracked.length} new untracked file(s) left in place, not deleted:`);
    for (const f of result.newUntracked.slice(0, 10)) lines.push(`  ${f}`);
    if (result.newUntracked.length > 10) lines.push(`  … ${result.newUntracked.length - 10} more`);
  }
  return lines;
}
