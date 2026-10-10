import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { render } from "ink-testing-library";
import { DEFAULT_SCRIPT, MockProvider, type MockScript } from "../src/agent/mock.ts";
import { App, type AppProps } from "../src/ui/App.tsx";
import { PlanView } from "../src/ui/PlanView.tsx";
import { StatusLine } from "../src/ui/StatusLine.tsx";
import { FIX_BUG_SCRIPT, makeFixture, waitFor } from "./helpers.ts";

const strip = (s = "") => s.replace(/\x1b\[[0-9;]*m/g, "");
const app = (over: Partial<AppProps> & { script?: MockScript; delay?: number } = {}) => {
  const root = over.root ?? makeFixture();
  const ui = render(
    <App provider={new MockProvider(over.script ?? FIX_BUG_SCRIPT, over.delay ?? 0)} connection="mock" target="offline" root={root} mode="auto" maxSteps={25} initialTask="Fix the bug in add()" {...over} />,
  );
  return { ui, root, frame: () => strip(ui.lastFrame()), all: () => strip(ui.frames.join("\n")) };
};

describe("Ink layout (reference design)", () => {
  test("rounded frame, banner, operational loop section, plan, timeline and StatusLine", async () => {
    let status = "";
    const { ui, root, frame, all } = app({ exitOnDone: true, onExit: (s) => (status = s) });
    await waitFor(() => frame().includes("Done in 5 steps"));
    const f = frame();
    expect(f.split("\n")[0]).toMatch(/^╭─+╮$/);
    expect(f).toContain("ARTEMIS | Codebase Agent v1.0.0 (Research Preview)");
    expect(f).toContain("CURRENT OPERATIONAL LOOP");
    // auto-plan from tool calls, all done at the end
    expect(f).toContain("✓ Map files: src/**/*.ts");
    expect(f).toContain("Edit src/math.ts");
    for (const t of ["glob", "grep", "read_file", "edit_file"]) expect(f).toContain(t);
    expect(f).toMatch(/ DONE .*tokens [\d.]+k?\/200\.0k .*AUTO .*step 5\/25/);
    // phase badge went through the real loop states
    expect(all()).toContain(" PLANNING ");
    expect(all()).toContain(" ANALYZING ");
    expect(all()).toContain(" EXECUTING ");
    expect(all()).toContain("Esc to abort");
    expect(readFileSync(path.join(root, "src/math.ts"), "utf8")).toContain("a + b");
    await waitFor(() => status === "done");
    ui.unmount();
  });

  test("model-published plan renders pending/current/done with gray/yellow/green", async () => {
    const { ui, frame, all } = app({ script: DEFAULT_SCRIPT, mode: "read_only", initialTask: "Survey" });
    await waitFor(() => frame().includes("Done in"));
    expect(all()).toMatch(/▸ +Map the codebase with glob|⠋|⠙/);
    expect(frame()).toContain("Plan 3/3");
    expect(frame()).toContain("READ-ONLY");
    ui.unmount();
    const steps = [
      { title: "Done step", status: "done" as const },
      { title: "Current step", status: "current" as const },
      { title: "Pending step", status: "pending" as const },
    ];
    const pv = render(<PlanView steps={steps} source="model" running={false} />);
    const raw = pv.lastFrame()!;
    expect(strip(raw)).toContain("Plan 1/3");
    const colorOf = (title: string) => { const i = raw.indexOf(title); return raw.slice(raw.lastIndexOf("\x1b[38;2;", i), i); };
    expect(colorOf("Done step")).toContain("38;2;61;190;120"); // green #3dbe78
    expect(colorOf("Current step")).toContain("38;2;245;197;66"); // yellow #f5c542
    expect(colorOf("Pending step")).toContain("38;2;138;148;166"); // gray #8a94a6
    pv.unmount();
  });

  test("StatusLine: inverse phase badge, used/limit tokens, safety mode, abort hint", () => {
    const cases = [
      ["analyzing", "ANALYZING", "confirm", "SANDBOXED"],
      ["planning", "PLANNING", "auto", "AUTO"],
      ["executing", "EXECUTING", "read_only", "READ-ONLY"],
    ] as const;
    for (const [phase, label, mode, safety] of cases) {
      const s = render(<StatusLine phase={phase} tokensUsed={12_345} tokenLimit={200_000} mode={mode} step={3} maxSteps={25} elapsedMs={1500} running expanded={false} />);
      const raw = s.lastFrame()!;
      expect(raw).toContain("\x1b[7m"); // inverse
      const f = strip(raw);
      expect(f).toContain(` ${label} `);
      expect(f).toContain("tokens 12.3k/200.0k");
      expect(f).toContain(safety);
      expect(f).toContain("step 3/25");
      expect(f).toContain("Esc to abort");
      s.unmount();
    }
  });

  test("confirm (SANDBOXED) mode shows AWAITING APPROVAL and the diff; y applies the edit", async () => {
    const { ui, root, frame } = app({ mode: "confirm" });
    await waitFor(() => frame().includes("Approve edit_file?"));
    expect(frame()).toContain("AWAITING APPROVAL");
    expect(frame()).toContain("SANDBOXED");
    expect(frame()).toContain("- return a - b; // BUG");
    expect(frame()).toContain("+ return a + b;");
    await Bun.sleep(30);
    ui.stdin.write("y");
    await waitFor(() => frame().includes("Done in 5 steps"));
    expect(readFileSync(path.join(root, "src/math.ts"), "utf8")).toContain("a + b");
    ui.unmount();
  });

  for (const [name, key] of [["Esc", "\x1b"], ["Ctrl+C", "\x03"]] as const) {
    test(`${name} aborts a running task`, async () => {
      const slow: MockScript = [() => ({ content: "thinking ".repeat(200), calls: [{ name: "glob", args: { pattern: "*" } }] })];
      const { ui, frame } = app({ script: slow, delay: 20 });
      await waitFor(() => frame().includes("thinking"));
      await Bun.sleep(30);
      ui.stdin.write(key);
      await waitFor(() => frame().includes("Aborted"));
      expect(frame()).toContain(" ABORTED ");
      expect(frame()).toContain("Ask Artemis"); // REPL input is back
      ui.unmount();
    });
  }

  test("tool results collapse/expand with Ctrl+O", async () => {
    const { ui, frame } = app();
    await waitFor(() => frame().includes("Done in 5 steps"));
    expect(frame()).not.toContain("src/util/strings.ts");
    await Bun.sleep(30);
    ui.stdin.write("\x0f");
    await waitFor(() => frame().includes("src/util/strings.ts"));
    expect(frame()).toContain("▾");
    ui.unmount();
  });
});
