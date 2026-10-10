import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Agent } from "../src/agent/loop.ts";
import { MockProvider, type MockScript } from "../src/agent/mock.ts";
import { makeFixture } from "./helpers.ts";
import type { AgentEvent } from "../src/agent/types.ts";

/** A script that fires one tool call, then finishes. */
function once(name: string, args: Record<string, unknown>): MockScript {
  return [
    () => ({ content: "doing it", calls: [{ name, args }] }),
    () => ({ calls: [{ name: "done", args: { summary: "finished" } }] }),
  ];
}

function agentFor(script: MockScript, mode: "auto" | "confirm", opts: { review?: boolean; root?: string } = {}) {
  const root = opts.root ?? makeFixture();
  // bun.lock makes the fixture a Bun project, so the package-manager rule applies.
  if (!existsSync(join(root, "bun.lock"))) writeFileSync(join(root, "bun.lock"), "");
  const events: AgentEvent[] = [];
  const agent = new Agent({
    provider: new MockProvider(script, 0),
    root, mode, maxSteps: 6,
    ...(opts.review ? { review: true } : {}),
    confirm: async () => true,          // a human who approves everything
    onEvent: (e) => events.push(e),
  });
  return { root, events, agent };
}

const toolEnd = (events: AgentEvent[], name: string) =>
  events.find((e) => e.type === "tool_end" && (e as { name?: string }).name === name) as
    { ok: boolean; summary: string } | undefined;

describe("the reviewer sits in the tool path", () => {
  test("a destructive command is blocked in auto mode, where no human is asked", async () => {
    // --yes means "stop prompting me", not "run rm -rf". This is the safety floor.
    const { events, agent } = agentFor(once("run_shell", { command: "rm -rf /" }), "auto");
    await agent.run("clean up");
    const end = toolEnd(events, "run_shell");
    expect(end?.ok).toBe(false);
    expect(end?.summary).toContain("DESTRUCTIVE_SHELL");
    expect(events.some((e) => e.type === "review" && !(e as { approved: boolean }).approved)).toBe(true);
  });

  test("a human approving does not override a hard rule either", async () => {
    // The rule runs BEFORE the gate, so there is nothing left to approve.
    const { events, agent } = agentFor(once("run_shell", { command: "git reset --hard HEAD~5" }), "confirm");
    await agent.run("undo");
    expect(toolEnd(events, "run_shell")?.ok).toBe(false);
    expect(events.some((e) => e.type === "approval_required")).toBe(false);
  });

  test("the wrong package manager is caught from the project's lockfile", async () => {
    const { events, agent } = agentFor(once("run_shell", { command: "npm install left-pad" }), "auto");
    await agent.run("add a dep");
    const end = toolEnd(events, "run_shell");
    expect(end?.ok).toBe(false);
    expect(end?.summary).toContain("DEPENDENCY_DRIFT");
  });

  test("a secret about to be written to a file is blocked", async () => {
    const { root, events, agent } = agentFor(
      once("write_file", { path: "config.ts", content: "export const key = 'sk-abcdefghijklmnopqrstuvwxyz0123';" }),
      "auto",
    );
    await agent.run("add config");
    expect(toolEnd(events, "write_file")?.summary).toContain("SECRET_EXPOSURE");
    expect(existsSync(join(root, "config.ts"))).toBe(false);
  });

  test("ordinary work is untouched and still runs", async () => {
    const { root, events, agent } = agentFor(
      once("write_file", { path: "ok.ts", content: "export const n: number = 1;\n" }),
      "auto",
    );
    await agent.run("write a file");
    expect(toolEnd(events, "write_file")?.ok).toBe(true);
    expect(readFileSync(join(root, "ok.ts"), "utf8")).toContain("number = 1");
    expect(events.some((e) => e.type === "review")).toBe(false);   // silent when clean
  });

  test("read-only tools are not reviewed at all", async () => {
    const { events, agent } = agentFor(once("glob", { pattern: "**/*.ts" }), "auto");
    await agent.run("look around");
    expect(events.some((e) => e.type === "review")).toBe(false);
    expect(toolEnd(events, "glob")?.ok).toBe(true);
  });

  test("a soft finding reaches the human in the approval preview", async () => {
    // `any` is a judgement call, so it is surfaced where the decision is made
    // rather than blocking an action the user may well want.
    const { events, agent } = agentFor(
      once("write_file", { path: "loose.ts", content: "export const x: any = 1;\n" }),
      "confirm",
    );
    await agent.run("write it");
    const ask = events.find((e) => e.type === "approval_required") as { request: { preview: string } } | undefined;
    expect(ask?.request.preview).toContain("TYPESCRIPT_VIOLATION");
    expect(toolEnd(events, "write_file")?.ok).toBe(true);   // approved, so it ran
  });

  test("a soft finding does not stop an auto run", async () => {
    // Otherwise every judgement call halts an unattended run, and --yes is useless.
    const { events, agent } = agentFor(
      once("write_file", { path: "loose.ts", content: "export const x: any = 1;\n" }),
      "auto",
    );
    await agent.run("write it");
    expect(toolEnd(events, "write_file")?.ok).toBe(true);
  });

  test("the model reviewer is off unless asked for", async () => {
    // It costs a round trip per mutating action; the free rules do not.
    let completions = 0;
    const script: MockScript = [
      () => { completions++; return { content: "x", calls: [{ name: "write_file", args: { path: "a.ts", content: "export const a = 1;\n" } }] }; },
      () => { completions++; return { calls: [{ name: "done", args: { summary: "ok" } }] }; },
    ];
    const { agent } = agentFor(script, "auto");
    await agent.run("write");
    expect(completions).toBe(2);   // two turns, no extra review call
  });
});
