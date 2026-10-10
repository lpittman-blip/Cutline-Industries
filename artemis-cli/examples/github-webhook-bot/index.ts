/**
 * Example integration: a tiny GitHub-webhook-style triage bot that calls Artemis.
 *
 *   GitHub ──(issues.opened)──▶ this bot ──POST /v1/agent/runs──▶ Artemis
 *   Artemis ──(run.completed, HMAC-signed)──▶ this bot ──▶ "comment" on the issue
 *
 * Run:  ARTEMIS_URL=http://127.0.0.1:7777 ARTEMIS_API_KEY=art_... bun examples/github-webhook-bot/index.ts
 * It registers its own Artemis webhook on start. Comments are printed (and kept at GET /comments);
 * wire `postComment` to the GitHub REST API with a token if you want real comments.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { Artemis, verifyWebhookSignature } from "../../sdk/index.ts";

export interface BotOptions {
  artemis: Artemis;
  /** Directory (relative to the Artemis server's workspaces root) holding the repo to triage. */
  workspace?: string;
  githubSecret?: string;
  model?: string;
  postComment?: (issue: number, body: string) => void | Promise<void>;
}

export function createBot(opts: BotOptions) {
  let artemisSecret: string | null = null;
  const runToIssue = new Map<string, number>();
  const comments: { issue: number; body: string }[] = [];
  const post = opts.postComment ?? ((issue, body) => { console.log(`\n💬 comment on #${issue}:\n${body}\n`); });

  async function register(publicUrl: string) {
    const hook = await opts.artemis.webhooks.create({ url: `${publicUrl}/artemis`, events: ["run.completed"], description: "github triage bot" });
    artemisSecret = hook.secret;
    return hook;
  }

  async function fetchHandler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/comments") return Response.json(comments);

    if (req.method === "POST" && url.pathname === "/github") {
      const raw = await req.text();
      if (opts.githubSecret) {
        const sig = req.headers.get("x-hub-signature-256") ?? "";
        const expected = "sha256=" + createHmac("sha256", opts.githubSecret).update(raw).digest("hex");
        if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return new Response("bad signature", { status: 401 });
      }
      if (req.headers.get("x-github-event") !== "issues") return new Response("ignored", { status: 202 });
      const ev = JSON.parse(raw);
      if (ev.action !== "opened") return new Response("ignored", { status: 202 });
      const run = await opts.artemis.runs.create({
        task: `Triage GitHub issue #${ev.issue.number}: "${ev.issue.title}"\n\n${ev.issue.body ?? ""}\n\nFind the code most likely involved (use glob and grep), and summarize the likely cause and a suggested fix with file:line references.`,
        workspace: opts.workspace ?? ".",
        mode: "read_only",
        model: opts.model,
        max_steps: 12,
      });
      runToIssue.set(run.id, ev.issue.number);
      return Response.json({ run_id: run.id }, { status: 202 });
    }

    if (req.method === "POST" && url.pathname === "/artemis") {
      const raw = await req.text();
      if (!artemisSecret || !(await verifyWebhookSignature(artemisSecret, raw, req.headers.get("artemis-signature")))) return new Response("bad signature", { status: 401 });
      const ev = JSON.parse(raw);
      if (ev.type === "run.completed") {
        const run = ev.data.run;
        const issue = runToIssue.get(run.id);
        if (issue !== undefined) {
          const body = `🤖 **Artemis triage** (${run.status}, ${run.steps} steps)\n\n${run.summary}`;
          comments.push({ issue, body });
          await post(issue, body);
        }
      }
      return new Response("ok");
    }
    return new Response("not found", { status: 404 });
  }

  return { fetch: fetchHandler, register, comments };
}

if (import.meta.main) {
  const artemis = new Artemis({ baseUrl: process.env.ARTEMIS_URL ?? "http://127.0.0.1:7777", apiKey: process.env.ARTEMIS_API_KEY ?? "" });
  const bot = createBot({ artemis, workspace: process.env.BOT_WORKSPACE, githubSecret: process.env.GITHUB_WEBHOOK_SECRET, model: process.env.ARTEMIS_MODEL });
  const port = Number(process.env.PORT) || 8787;
  const server = Bun.serve({ port, fetch: bot.fetch });
  const publicUrl = process.env.BOT_PUBLIC_URL ?? `http://127.0.0.1:${server.port}`;
  await bot.register(publicUrl);
  console.log(`GitHub triage bot on ${publicUrl}  (POST /github, Artemis webhooks → /artemis, GET /comments)`);
}
