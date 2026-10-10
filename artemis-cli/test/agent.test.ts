import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Agent } from "../src/agent/loop.ts";
import { DEFAULT_SCRIPT, MockProvider, type MockScript } from "../src/agent/mock.ts";
import { TRANSITIONS } from "../src/agent/loop.ts";
import { FIX_BUG_SCRIPT } from "./helpers.ts";
import type { AgentEvent, Phase } from "../src/agent/types.ts";
import { makeFixture } from "./helpers.ts";

function run(mode: "auto" | "confirm" | "read_only", confirm?: () => Promise<boolean | "always">, maxSteps = 25, script = FIX_BUG_SCRIPT) {
  const root = makeFixture();
  const events: AgentEvent[] = [];
  const agent = new Agent({ provider: new MockProvider(script, 0), root, mode, maxSteps, confirm, onEvent: (e) => events.push(e) });
  return { root, events, agent, go: () => agent.run("Fix the bug in add()") };
}

describe("agent loop (mock provider)", () => {
  test("autonomously runs glob → grep → read → edit → done", async () => {
    const { root, events, go } = run("auto");
    const res = await go();
    expect(res.status).toBe("done");
    expect(res.steps).toBe(5);
    expect(events.filter((e) => e.type === "tool_start").map((e) => (e as any).name)).toEqual(["glob", "grep", "read_file", "edit_file", "done"]);
    expect(events.filter((e) => e.type === "tool_end").every((e) => (e as any).ok)).toBe(true);
    expect(readFileSync(path.join(root, "src/math.ts"), "utf8")).toContain("return a + b;");
    expect(res.summary).toContain("Edited src/math.ts");
    expect(res.usage.promptTokens).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "assistant_delta")).toBe(true);
  });

  test("confirm mode asks before edits and respects a denial", async () => {
    const asked: string[] = [];
    const { root, events, go } = run("confirm", async () => { asked.push("edit"); return false; });
    const res = await go();
    expect(asked).toEqual(["edit"]);
    expect(events.find((e) => e.type === "approval_resolved")).toMatchObject({ approved: false });
    expect(readFileSync(path.join(root, "src/math.ts"), "utf8")).toContain("a - b");
    expect(res.status).toBe("done");
  });

  test("confirm 'always' switches the session to auto", async () => {
    const { agent, root, go } = run("confirm", async () => "always");
    await go();
    expect(agent.mode).toBe("auto");
    expect(readFileSync(path.join(root, "src/math.ts"), "utf8")).toContain("a + b");
  });

  test("read-only mode never offers or runs mutating tools", async () => {
    const { root, events, go } = run("read_only");
    const res = await go();
    expect(res.status).toBe("done");
    expect(events.map((e) => (e as any).name).filter(Boolean)).not.toContain("edit_file");
    expect(readFileSync(path.join(root, "src/math.ts"), "utf8")).toContain("a - b");
  });

  test("step cap stops runaway loops", async () => {
    const loop: MockScript = [() => ({ calls: [{ name: "glob", args: { pattern: "*" } }] })];
    const { go } = run("auto", undefined, 3, loop);
    const res = await go();
    expect(res.status).toBe("max_steps");
    expect(res.steps).toBe(3);
  });

  test("cancellation via AbortSignal", async () => {
    const { agent } = run("auto");
    const ac = new AbortController();
    ac.abort();
    const res = await agent.run("x", ac.signal);
    expect(res.status).toBe("cancelled");
  });

  test("state machine: phases follow legal transitions (planning → analyzing → awaiting_approval → executing → done)", async () => {
    const { events, go } = run("confirm", async () => true);
    await go();
    const phases = events.filter((e) => e.type === "phase").map((e: any) => e.phase);
    expect(phases[0]).toBe("planning");
    expect(phases).toContain("analyzing");
    expect(phases).toContain("awaiting_approval");
    expect(phases).toContain("executing");
    expect(phases.at(-1)).toBe("done");
    for (const e of events.filter((e) => e.type === "phase") as any[]) expect(TRANSITIONS[e.from as Phase]).toContain(e.phase);
  });

  test("without update_plan, the plan mirrors tool calls (auto) and ends all done", async () => {
    const { events, go } = run("auto");
    await go();
    const plans = events.filter((e) => e.type === "plan") as any[];
    const last = plans.at(-1)!;
    expect(last.source).toBe("auto");
    expect(last.steps.map((s: any) => s.title)).toEqual(["Map files: src/**/*.ts", "Search: /BUG/", "Read src/math.ts", "Edit src/math.ts"]);
    expect(last.steps.every((s: any) => s.status === "done")).toBe(true);
    expect(plans.some((p) => p.steps.some((s: any) => s.status === "current"))).toBe(true);
  });

  test("model-published plan (update_plan) drives the checklist", async () => {
    const root = makeFixture();
    const events: AgentEvent[] = [];
    const agent = new Agent({ provider: new MockProvider(DEFAULT_SCRIPT, 0), root, mode: "auto", onEvent: (e) => events.push(e) });
    await agent.run("Survey");
    const plans = events.filter((e) => e.type === "plan" && e.source === "model") as any[];
    expect(plans.length).toBeGreaterThanOrEqual(5);
    expect(plans[0].steps.map((s: any) => s.status)).toEqual(["current", "pending", "pending", "pending", "pending"]);
    expect(agent.plan.every((s) => s.status === "done")).toBe(true);
  });

  test("token budget stops the loop with real usage counts", async () => {
    const root = makeFixture();
    const agent = new Agent({ provider: new MockProvider(FIX_BUG_SCRIPT, 0), root, mode: "auto", tokenBudget: 300 });
    const res = await agent.run("Fix the bug");
    expect(res.status).toBe("budget");
    expect(res.usage.promptTokens + res.usage.completionTokens).toBeGreaterThanOrEqual(300);
    expect(agent.phase).toBe("error");
  });
});
