/**
 * Posting findings into the pull request.
 *
 * Two things the obvious version gets wrong:
 *
 *  - the API host. `https://github.com/{repo}/issues/{n}/comments` is the web site.
 *    The REST endpoint is `https://api.github.com/repos/{repo}/issues/{n}/comments`,
 *    and on Enterprise it is `$GITHUB_API_URL`. The web URL 404s every time.
 *  - the PR number. Reading it out of a commit subject ("Merge pull request #42
 *    from …") only works on a merge commit, which is exactly what a PR branch does
 *    not have. It comes from the event payload, or from GITHUB_REF.
 *
 * It reports; it does not push. Committing to someone's branch from CI is a
 * different decision, and not one a reporting layer should make.
 */
import { readFileSync } from "node:fs";

export interface GitHubContext {
  apiUrl: string;
  repo: string;
  token: string;
  prNumber: number | null;
  sha: string;
  actor: string;
}

/** Reads the context GitHub Actions provides. Returns null when not in Actions. */
export function githubContext(env: NodeJS.ProcessEnv = process.env): GitHubContext | null {
  const repo = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;
  if (!repo || !token) return null;
  return {
    apiUrl: (env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, ""),
    repo,
    token,
    prNumber: pullRequestNumber(env),
    sha: env.GITHUB_SHA ?? "",
    actor: env.GITHUB_ACTOR ?? "unknown",
  };
}

/**
 * The PR number, in the order the sources are actually trustworthy:
 * the event payload, then GITHUB_REF (`refs/pull/42/merge`), then an explicit
 * override. Never the commit message.
 */
export function pullRequestNumber(env: NodeJS.ProcessEnv = process.env): number | null {
  const path = env.GITHUB_EVENT_PATH;
  if (path) {
    try {
      const event = JSON.parse(readFileSync(path, "utf8")) as {
        pull_request?: { number?: unknown };
        issue?: { number?: unknown };
        number?: unknown;
      };
      for (const candidate of [event.pull_request?.number, event.issue?.number, event.number]) {
        if (typeof candidate === "number" && Number.isInteger(candidate)) return candidate;
      }
    } catch {
      // a missing or malformed payload just means try the next source
    }
  }
  const ref = /^refs\/pull\/(\d+)\//.exec(env.GITHUB_REF ?? "");
  if (ref) return Number(ref[1]);
  const explicit = Number(env.GITHUB_PR_NUMBER);
  return Number.isInteger(explicit) && explicit > 0 ? explicit : null;
}

export interface Finding {
  file: string;
  rule: string;
  critique: string;
  suggestion?: string;
  line?: number;
}

/** A comment body. One marker line so a later run can update rather than pile up. */
export const COMMENT_MARKER = "<!-- artemis-preflight -->";

export function renderComment(findings: Finding[], summary: { checked: number; cached: number; ms: number }): string {
  const head = [
    COMMENT_MARKER,
    "### Artemis pre-flight",
    "",
  ];
  if (findings.length === 0) {
    head.push(
      `No issues found. ${summary.checked} file(s) checked, ${summary.cached} unchanged since the last run, in ${(summary.ms / 1000).toFixed(1)}s.`,
    );
    return head.join("\n");
  }
  head.push(`${findings.length} finding(s). ${summary.checked} file(s) checked, ${summary.cached} cached.`, "");
  head.push("| File | Rule | Finding |", "| :--- | :--- | :--- |");
  for (const f of findings.slice(0, 25)) {
    const where = f.line ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``;
    head.push(`| ${where} | \`${f.rule}\` | ${f.critique.replace(/\|/g, "\\|")} |`);
  }
  if (findings.length > 25) head.push(`| … | | ${findings.length - 25} more |`);

  const withFix = findings.filter((f) => f.suggestion);
  if (withFix.length) {
    head.push("", "<details><summary>Suggested changes</summary>", "");
    for (const f of withFix.slice(0, 5)) {
      head.push(`**${f.file}**`, "", "```typescript", f.suggestion as string, "```", "");
    }
    head.push("</details>");
  }
  head.push("", "_Reported only. Nothing was committed or pushed._");
  return head.join("\n");
}

async function api(
  ctx: GitHubContext,
  method: string,
  path: string,
  body?: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const response = await fetchImpl(`${ctx.apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ctx.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json: unknown = null;
  try { json = await response.json(); } catch { /* empty body is fine */ }
  return { ok: response.ok, status: response.status, json };
}

/**
 * Posts the comment, replacing Artemis's previous one on the same PR.
 *
 * Editing rather than appending: a gate that runs on every push leaves a column of
 * near-identical comments otherwise, and people stop reading all of them.
 */
export async function postComment(
  ctx: GitHubContext,
  body: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ posted: boolean; detail: string }> {
  if (ctx.prNumber === null) return { posted: false, detail: "no pull request in context; nothing to comment on" };

  const existing = await api(ctx, "GET", `/repos/${ctx.repo}/issues/${ctx.prNumber}/comments?per_page=100`, undefined, fetchImpl);
  if (existing.ok && Array.isArray(existing.json)) {
    const mine = (existing.json as { id?: number; body?: string }[])
      .find((c) => typeof c.body === "string" && c.body.includes(COMMENT_MARKER));
    if (mine?.id) {
      const patched = await api(ctx, "PATCH", `/repos/${ctx.repo}/issues/comments/${mine.id}`, { body }, fetchImpl);
      return patched.ok
        ? { posted: true, detail: `updated comment ${mine.id}` }
        : { posted: false, detail: `PATCH failed: HTTP ${patched.status}` };
    }
  }
  const created = await api(ctx, "POST", `/repos/${ctx.repo}/issues/${ctx.prNumber}/comments`, { body }, fetchImpl);
  return created.ok
    ? { posted: true, detail: `commented on #${ctx.prNumber}` }
    : { posted: false, detail: `POST failed: HTTP ${created.status}` };
}
