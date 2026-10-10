import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBot } from "../examples/github-webhook-bot/index.ts";
import { Artemis, ArtemisError, verifyWebhookSignature } from "../sdk/index.ts";
import { startServer } from "../server/index.ts";
import { signPayload } from "../server/webhooks.ts";
import { Agent } from "../src/agent/loop.ts";
import { OpenAIProvider } from "../src/agent/openai.ts";
import type { AgentEvent } from "../src/agent/types.ts";
import { makeFixture, testServerConfig, waitFor } from "./helpers.ts";

let srv: Awaited<ReturnType<typeof startServer>>;
let client: Artemis;
let ws: string;
const CLI = path.join(import.meta.dir, "..", "src", "cli.tsx");
/** Async spawn: the server lives in this process, so spawnSync would deadlock it. */
async function cli(args: string[], env: Record<string, string | undefined>) {
  const p = Bun.spawn(["bun", CLI, ...args], { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { stdout, stderr, exitCode };
}

beforeAll(async () => {
  ws = makeFixture();
  srv = await startServer({ port: 0, config: testServerConfig(path.dirname(ws)), quiet: true });
  client = new Artemis({ baseUrl: srv.url, apiKey: srv.bootstrapKey! });
});
afterAll(() => srv.stop());

describe("SDK against a running server", () => {
  test("health, status, typed errors", async () => {
    expect((await client.health()).status).toBe("ok");
    expect((await client.status()).model_backend.kind).toBe("mock");
    const bad = new Artemis({ baseUrl: srv.url, apiKey: "art_nope" });
    const err = await bad.status().catch((e) => e);
    expect(err).toBeInstanceOf(ArtemisError);
    expect(err.status).toBe(401);
    expect(err.requestId).toStartWith("req_");
  });

  test("runs.create + runs.wait with an approval callback", async () => {
    const run = await client.runs.create({ task: "Survey", workspace: path.basename(ws), mode: "confirm" });
    const seen: string[] = [];
    const approvals: string[] = [];
    const final = await client.runs.wait(run.id, {
      onEvent: (e) => seen.push(e.type),
      onApproval: (p) => { approvals.push(p.tool); return true; },
    });
    expect(final.status).toBe("completed");
    expect(approvals).toEqual(["write_file", "edit_file"]);
    expect(seen).toContain("tool_end");
    expect(readFileSync(path.join(ws, "docs/MOCK_NOTES.md"), "utf8")).toContain("reviewed");
    expect((await client.runs.list()).some((r) => r.id === run.id)).toBe(true);
  });

  test("chat.completions create + stream", async () => {
    const c = await client.chat.completions.create({ messages: [{ role: "user", content: "hi" }] });
    expect(c.choices[0]!.message.role).toBe("assistant");
    let text = "";
    for await (const chunk of client.chat.completions.stream({ messages: [{ role: "user", content: "hi" }] })) text += chunk.choices[0]?.delta?.content ?? "";
    expect(text.length).toBeGreaterThan(0);
  });

  test("search, sessions/notes, webhooks, keys", async () => {
    const s = await client.search({ type: "grep", pattern: "export function", workspace: path.basename(ws) });
    expect(s.count).toBeGreaterThan(0);
    const ses = await client.sessions.create({ title: "SDK" });
    await client.sessions.notes.add(ses.id, "remember this");
    expect((await client.sessions.notes.list(ses.id))[0]!.content).toBe("remember this");
    const hook = await client.webhooks.create({ url: "http://127.0.0.1:9/x", events: ["run.completed"] });
    expect(hook.secret).toStartWith("whsec_");
    await client.webhooks.delete(hook.id);
    const k = await client.keys.create({ name: "sdk", scopes: ["chat"] });
    expect((await client.keys.list()).some((x) => x.id === k.id)).toBe(true);
    await client.keys.revoke(k.id);
  });

  test("verifyWebhookSignature (Web Crypto) matches the server's signer", async () => {
    const body = JSON.stringify({ type: "run.completed" });
    const header = signPayload("whsec_x", body, Math.floor(Date.now() / 1000));
    expect(await verifyWebhookSignature("whsec_x", body, header)).toBe(true);
    expect(await verifyWebhookSignature("whsec_y", body, header)).toBe(false);
  });
});

describe("CLI through the Artemis server", () => {
  test("agent loop uses the server's /v1/chat/completions and runs tools locally", async () => {
    const local = makeFixture();
    const events: AgentEvent[] = [];
    const agent = new Agent({ provider: new OpenAIProvider({ baseUrl: `${srv.url}/v1`, apiKey: srv.bootstrapKey!, model: "artemis", label: "artemis" }), root: local, mode: "auto", onEvent: (e) => events.push(e) });
    const res = await agent.run("Survey the project");
    expect(res.status).toBe("done");
    expect(events.filter((e) => e.type === "tool_start").map((e: any) => e.name).filter((n) => n !== "update_plan")).toEqual(["glob", "grep", "read_file", "write_file", "edit_file", "done"]);
    expect(readFileSync(path.join(local, "docs/MOCK_NOTES.md"), "utf8")).toContain("Status: reviewed");
    expect(res.usage.completionTokens).toBeGreaterThan(0);
  });

  test("`artemis login` saves the key (0600) and `artemis -p` runs a task via the server", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "artemis-home-"));
    const env = { ...process.env, ARTEMIS_HOME: home, ARTEMIS_API_KEY: "", ARTEMIS_URL: "", NO_COLOR: "1" };
    const login = await cli(["login", "--url", srv.url, "--key", srv.bootstrapKey!], env);
    expect(login.stdout).toContain("Logged in");
    const cfgFile = path.join(home, "config.json");
    expect(JSON.parse(readFileSync(cfgFile, "utf8")).url).toBe(srv.url);
    expect(statSync(cfgFile).mode & 0o777).toBe(0o600);
    const local = makeFixture();
    const run = await cli(["-p", "--read-only", "-C", local, "Where is add() defined?"], env);
    const out = run.stdout;
    expect(run.exitCode).toBe(0);
    expect(out).toContain("via server");
    expect(out).toContain("grep");
    expect(out).toContain("Done in");
    const bad = await cli(["login", "--url", srv.url, "--key", "art_bad"], env);
    expect(bad.exitCode).toBe(1);
  }, 20000);

  test("`artemis --mock -p` works fully offline", async () => {
    const local = makeFixture();
    const run = await cli(["--mock", "-p", "-y", "-C", local, "Survey"], { ...process.env, NO_COLOR: "1" });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("Wrote docs/MOCK_NOTES.md");
  });
});

describe("example integration: GitHub triage bot", () => {
  test("issue webhook → Artemis run → signed run.completed → comment", async () => {
    const posted: { issue: number; body: string }[] = [];
    const bot = createBot({ artemis: client, workspace: path.basename(ws), postComment: (issue, body) => { posted.push({ issue, body }); } });
    const botServer = Bun.serve({ port: 0, fetch: bot.fetch });
    await bot.register(`http://127.0.0.1:${botServer.port}`);
    const res = await fetch(`http://127.0.0.1:${botServer.port}/github`, {
      method: "POST",
      headers: { "x-github-event": "issues", "content-type": "application/json" },
      body: JSON.stringify({ action: "opened", issue: { number: 42, title: "add() returns wrong result", body: "2+3 gives -1" } }),
    });
    expect(res.status).toBe(202);
    await waitFor(() => posted.length > 0, 8000);
    expect(posted[0]!.issue).toBe(42);
    expect(posted[0]!.body).toContain("Artemis triage");
    // forged webhook is rejected
    const forged = await fetch(`http://127.0.0.1:${botServer.port}/artemis`, { method: "POST", body: "{}", headers: { "artemis-signature": "t=1,v1=00" } });
    expect(forged.status).toBe(401);
    botServer.stop(true);
  });
});
