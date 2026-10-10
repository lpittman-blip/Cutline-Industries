/**
 * `artemis ci` — the pre-flight run inside a pipeline.
 *
 * Reports. Does not push.
 *
 * The tempting version commits the agent's fixes and pushes them to the developer's
 * branch. That stages whatever happens to be in the tree, diverges from the work
 * they have locally, and puts commits nobody reviewed into their history — and
 * since the push retriggers the workflow, it bills for the loop too. A reviewer
 * that edits the thing it is reviewing is not a reviewer.
 */
import { githubContext, postComment, renderComment, type Finding } from "./github.ts";
import { notifySlack } from "./slack.ts";
import { runCheck } from "./check.ts";
import { openShadowPr, type ShadowResult } from "./shadow.ts";

export interface CiResult {
  ok: boolean;
  findings: Finding[];
  comment: { posted: boolean; detail: string };
  slack: { sent: boolean; detail: string };
  /** Present only when --fix was asked for and there was something to offer. */
  shadow?: ShadowResult;
  durationMs: number;
}

export interface CiOptions {
  /**
   * Offer fixes as a pull request from a branch of Artemis's own. OFF by default:
   * pushing anywhere from CI is a decision the repository owner makes, not a
   * default a tool picks.
   */
  fix?: boolean;
  dryRun?: boolean;
}

export async function runCi(root: string, env: NodeJS.ProcessEnv = process.env, options: CiOptions = {}): Promise<CiResult> {
  const started = Date.now();
  const report = await runCheck({ root, stagedOnly: false });

  const findings: Finding[] = report.diagnostics.map((d) => ({
    file: d.file,
    line: d.line,
    rule: d.code,
    critique: d.message,
  }));

  const ctx = githubContext(env);
  const summary = { checked: report.checked.length, cached: report.cached.length, ms: Date.now() - started };

  const comment = ctx
    ? await postComment(ctx, renderComment(findings, summary))
    : { posted: false, detail: "not running in GitHub Actions" };

  const slack = await notifySlack({
    repo: ctx?.repo ?? "local",
    findings: findings.length,
    ...(findings[0]?.rule ? { topRule: findings[0].rule } : {}),
    ...(findings[0]?.file ? { file: findings[0].file } : {}),
    ...(ctx?.prNumber ? { url: `https://github.com/${ctx.repo}/pull/${ctx.prNumber}` } : {}),
    ...(ctx?.actor ? { actor: ctx.actor } : {}),
    ...(ctx?.sha ? { sha: ctx.sha } : {}),
    durationMs: summary.ms,
  }, env);

  let shadow: ShadowResult | undefined;
  if (options.fix && ctx && findings.length > 0) {
    const touched = [...new Set(findings.map((f) => f.file))];
    shadow = await openShadowPr({
      root, files: touched,
      baseBranch: (env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || "main"),
      sha: ctx.sha, repo: ctx.repo, token: ctx.token, apiUrl: ctx.apiUrl,
      summary: `${findings.length} finding(s) from the pre-flight gate.`,
      ...(options.dryRun ? { dryRun: true } : {}),
    });
  }

  return { ok: report.ok, findings, comment, slack, ...(shadow ? { shadow } : {}), durationMs: summary.ms };
}
