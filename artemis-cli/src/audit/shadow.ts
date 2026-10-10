/**
 * Shadow-PR: the agent's fixes, offered as a pull request.
 *
 * It pushes to a BRANCH OF ITS OWN and opens a PR against yours. It does not push
 * to your branch. Pushing there stages whatever is in the tree, diverges from the
 * work you have locally, puts commits nobody reviewed in your history, and — since
 * a push retriggers the workflow that produced it — bills for the loop. A shadow PR
 * is reviewable, ignorable and closeable; a commit on your branch is none of those.
 *
 * Three further safeguards:
 *  - only files the agent actually changed are staged. Never `git add .`, which
 *    sweeps up build output, an untracked .env, anything;
 *  - `[skip ci]` on the commit, so the push cannot retrigger the workflow;
 *  - off unless asked for. The default is to comment.
 */
import { resolve } from "node:path";

export interface ShadowOptions {
  root: string;
  /** Files to stage, relative to root. Nothing else is committed. */
  files: string[];
  /** The branch the fixes are based on, used to name and target the PR. */
  baseBranch: string;
  sha: string;
  repo: string;
  token: string;
  apiUrl?: string;
  /** Written into the PR body so a reviewer knows why each change is there. */
  summary: string;
  dryRun?: boolean;
}

export interface ShadowResult {
  pushed: boolean;
  branch: string;
  prUrl?: string;
  detail: string;
}

async function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

export function shadowBranchName(baseBranch: string, sha: string): string {
  // Namespaced so it is obvious at a glance who made it, and keyed by commit so a
  // re-run on the same commit reuses one branch instead of littering.
  const safe = baseBranch.replace(/[^A-Za-z0-9._\/-]/g, "-").replace(/^refs\/heads\//, "");
  return `artemis/fix/${safe}-${sha.slice(0, 7)}`;
}

/**
 * Which of the given files git actually sees as modified.
 *
 * Parsed with a regex rather than `slice(3)`: a porcelain line begins with two
 * status columns and a space, and anything that trims the output first eats the
 * leading column and shifts every path by one character.
 */
export async function changedAmong(root: string, files: string[]): Promise<string[]> {
  if (files.length === 0) return [];
  const proc = Bun.spawn(["git", "status", "--porcelain", "--", ...files], {
    cwd: resolve(root), stdout: "pipe", stderr: "pipe",
  });
  const [raw] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const wanted = new Set(files);
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.length < 4) continue;
    // "XY path" and, for a rename, "XY old -> new": the new name is what exists.
    const path = line.slice(3).split(" -> ").pop()?.trim().replace(/^"|"$/g, "") ?? "";
    if (path && wanted.has(path)) out.push(path);
  }
  return out;
}

export async function openShadowPr(options: ShadowOptions): Promise<ShadowResult> {
  const root = resolve(options.root);
  const branch = shadowBranchName(options.baseBranch, options.sha);

  const changed = await changedAmong(root, options.files);
  if (changed.length === 0) return { pushed: false, branch, detail: "no changes to offer" };

  if (options.dryRun) {
    return { pushed: false, branch, detail: `would open ${branch} with ${changed.length} file(s): ${changed.join(", ")}` };
  }

  await git(root, ["config", "user.name", "Artemis"]);
  await git(root, ["config", "user.email", "artemis@users.noreply.github.com"]);

  const created = await git(root, ["checkout", "-B", branch]);
  if (created.code !== 0) return { pushed: false, branch, detail: `could not create ${branch}: ${created.stderr.split("\n")[0]}` };

  // Explicit paths only. `git add .` is how a token in an untracked file ends up
  // in a public branch.
  const staged = await git(root, ["add", "--", ...changed]);
  if (staged.code !== 0) return { pushed: false, branch, detail: `staging failed: ${staged.stderr.split("\n")[0]}` };

  const message = `fix: Artemis pre-flight remediation [skip ci]\n\n${options.summary}\n\nBased on ${options.sha}. Review before merging.`;
  const committed = await git(root, ["commit", "-m", message]);
  if (committed.code !== 0) return { pushed: false, branch, detail: `commit failed: ${committed.stderr.split("\n")[0]}` };

  const pushed = await git(root, ["push", "--force-with-lease", "-u", "origin", branch]);
  if (pushed.code !== 0) return { pushed: false, branch, detail: `push failed: ${pushed.stderr.split("\n")[0]}` };

  const pr = await createPullRequest(options, branch, changed);
  return { pushed: true, branch, ...(pr.url ? { prUrl: pr.url } : {}), detail: pr.detail };
}

async function createPullRequest(
  options: ShadowOptions,
  branch: string,
  changed: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ url?: string; detail: string }> {
  const api = (options.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
  const base = options.baseBranch.replace(/^refs\/heads\//, "");
  const body = [
    "Opened by the Artemis pre-flight gate.",
    "",
    options.summary,
    "",
    "Files changed:",
    ...changed.map((f) => `- \`${f}\``),
    "",
    `Based on ${options.sha}. Nothing was pushed to \`${base}\` — close this PR to discard.`,
  ].join("\n");

  const response = await fetchImpl(`${api}/repos/${options.repo}/pulls`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title: "Artemis pre-flight fixes", head: branch, base, body, draft: true }),
  });

  if (response.status === 422) {
    // Already open for this head; the force-push above refreshed it.
    return { detail: `updated the existing pull request for ${branch}` };
  }
  if (!response.ok) return { detail: `branch pushed, but opening the PR failed: HTTP ${response.status}` };
  const json = (await response.json()) as { html_url?: unknown };
  return {
    ...(typeof json.html_url === "string" ? { url: json.html_url } : {}),
    detail: `opened a draft pull request from ${branch}`,
  };
}
