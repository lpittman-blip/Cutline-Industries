import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { COMMENT_MARKER, githubContext, postComment, pullRequestNumber, renderComment, type Finding } from "../src/audit/github.ts";
import { buildBlocks, notifySlack } from "../src/audit/slack.ts";

const BASE = { GITHUB_REPOSITORY: "acme/widgets", GITHUB_TOKEN: "ghs_token" };
const summary = { checked: 3, cached: 7, ms: 2400 };
const findings: Finding[] = [{ file: "src/a.ts", line: 12, rule: "TS2322", critique: "Type 'string' is not assignable to 'number'." }];

describe("github context", () => {
  test("the PR number comes from the event payload first", () => {
    const dir = mkdtempSync(join(tmpdir(), "artemis-gh-"));
    const path = join(dir, "event.json");
    writeFileSync(path, JSON.stringify({ pull_request: { number: 42 } }));
    expect(pullRequestNumber({ GITHUB_EVENT_PATH: path, GITHUB_REF: "refs/pull/99/merge" })).toBe(42);
  });

  test("then from GITHUB_REF", () => {
    expect(pullRequestNumber({ GITHUB_REF: "refs/pull/77/merge" })).toBe(77);
  });

  test("a commit message is never a source", () => {
    // "Merge pull request #42 from ..." only exists on a merge commit, which is
    // exactly what a PR branch does not have.
    expect(pullRequestNumber({ GITHUB_REF: "refs/heads/feature" })).toBeNull();
  });

  test("a malformed event payload falls through instead of throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "artemis-gh-"));
    const path = join(dir, "event.json");
    writeFileSync(path, "{ not json");
    expect(pullRequestNumber({ GITHUB_EVENT_PATH: path, GITHUB_REF: "refs/pull/5/merge" })).toBe(5);
  });

  test("the API host is api.github.com, and GITHUB_API_URL wins for Enterprise", () => {
    expect(githubContext(BASE)?.apiUrl).toBe("https://api.github.com");
    expect(githubContext({ ...BASE, GITHUB_API_URL: "https://ghe.acme.com/api/v3/" })?.apiUrl).toBe("https://ghe.acme.com/api/v3");
  });

  test("outside Actions there is no context", () => {
    expect(githubContext({})).toBeNull();
    expect(githubContext({ GITHUB_REPOSITORY: "a/b" })).toBeNull();
  });
});

describe("the comment", () => {
  test("a clean run says so plainly", () => {
    const body = renderComment([], summary);
    expect(body).toContain(COMMENT_MARKER);
    expect(body).toContain("No issues found");
    expect(body).toContain("7 unchanged");
  });

  test("findings render as a table with file and line", () => {
    const body = renderComment(findings, summary);
    expect(body).toContain("`src/a.ts:12`");
    expect(body).toContain("`TS2322`");
    expect(body).toContain("Reported only. Nothing was committed or pushed.");
  });

  test("a pipe in a message cannot break the table", () => {
    const body = renderComment([{ file: "a.ts", rule: "R", critique: "a | b" }], summary);
    expect(body).toContain("a \\| b");
  });

  test("a long list is capped", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ file: `f${i}.ts`, rule: "R", critique: "x" }));
    expect(renderComment(many, summary)).toContain("15 more");   // 40 found, 25 shown
  });
});

describe("posting", () => {
  function recorder(responses: { ok: boolean; status: number; body: unknown }[]) {
    const calls: { url: string; method: string; body: unknown }[] = [];
    let i = 0;
    const impl = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : null });
      const r = responses[Math.min(i++, responses.length - 1)]!;
      return new Response(JSON.stringify(r.body), { status: r.status });
    }) as unknown as typeof fetch;
    return { calls, impl };
  }

  test("it posts to the REST API, not the web site", async () => {
    const ctx = githubContext({ ...BASE, GITHUB_REF: "refs/pull/42/merge" })!;
    const { calls, impl } = recorder([{ ok: true, status: 200, body: [] }, { ok: true, status: 201, body: {} }]);
    const out = await postComment(ctx, "hello", impl);
    expect(out.posted).toBe(true);
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("https://api.github.com/repos/acme/widgets/issues/42/comments");
    expect(post.url).not.toContain("https://github.com/acme");
  });

  test("an existing Artemis comment is edited, not duplicated", async () => {
    // A gate that runs on every push otherwise leaves a column of near-identical
    // comments, and people stop reading all of them.
    const ctx = githubContext({ ...BASE, GITHUB_REF: "refs/pull/42/merge" })!;
    const { calls, impl } = recorder([
      { ok: true, status: 200, body: [{ id: 9001, body: `${COMMENT_MARKER}\nold` }] },
      { ok: true, status: 200, body: {} },
    ]);
    const out = await postComment(ctx, "new", impl);
    expect(out.posted).toBe(true);
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/issues/comments/9001"))).toBe(true);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("someone else's comment is left alone", async () => {
    const ctx = githubContext({ ...BASE, GITHUB_REF: "refs/pull/42/merge" })!;
    const { calls, impl } = recorder([
      { ok: true, status: 200, body: [{ id: 5, body: "a human said something" }] },
      { ok: true, status: 201, body: {} },
    ]);
    await postComment(ctx, "mine", impl);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  test("no pull request means nothing is posted", async () => {
    const ctx = githubContext({ ...BASE, GITHUB_REF: "refs/heads/main" })!;
    const { calls, impl } = recorder([{ ok: true, status: 200, body: [] }]);
    expect((await postComment(ctx, "x", impl)).posted).toBe(false);
    expect(calls.length).toBe(0);
  });

  test("an API failure is reported, not thrown", async () => {
    const ctx = githubContext({ ...BASE, GITHUB_REF: "refs/pull/42/merge" })!;
    const { impl } = recorder([{ ok: false, status: 403, body: {} }, { ok: false, status: 403, body: {} }]);
    const out = await postComment(ctx, "x", impl);
    expect(out.posted).toBe(false);
    expect(out.detail).toContain("403");
  });
});

describe("slack", () => {
  const notice = { repo: "acme/widgets", findings: 2, topRule: "TS2322", file: "src/a.ts", durationMs: 2400, sha: "abcdef1234" };

  test("a clean run stays quiet", async () => {
    // A bot that posts "all clear" on every push trains the channel to filter it.
    let called = false;
    const impl = (async () => { called = true; return new Response("ok"); }) as unknown as typeof fetch;
    const out = await notifySlack({ ...notice, findings: 0 }, { ARTEMIS_SLACK_WEBHOOK_URL: "https://hooks.example" }, impl);
    expect(out.sent).toBe(false);
    expect(called).toBe(false);
  });

  test("no webhook configured is not an error", async () => {
    expect((await notifySlack(notice, {})).sent).toBe(false);
  });

  test("the payload carries a mobile fallback and the findings", () => {
    const payload = buildBlocks(notice);
    expect(payload.text).toContain("2 issues");
    expect(JSON.stringify(payload.blocks)).toContain("src/a.ts");
    expect(JSON.stringify(payload.blocks)).toContain("nothing was pushed");
  });

  test("a failure never echoes the webhook url", async () => {
    const secret = "https://hooks.slack.com/services/SECRET";
    const impl = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    const out = await notifySlack(notice, { ARTEMIS_SLACK_WEBHOOK_URL: secret }, impl);
    expect(out.sent).toBe(false);
    expect(out.detail).not.toContain("SECRET");
  });
});
