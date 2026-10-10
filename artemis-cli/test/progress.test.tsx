import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { Gauge, ProgressBar, Segments, Stepper, fillCells, percentLabel, share } from "../src/ui/Progress.tsx";
import { PlanView } from "../src/ui/PlanView.tsx";
import { StatusLine } from "../src/ui/StatusLine.tsx";
import { C } from "../src/ui/theme.ts";

const strip = (s = "") => s.replace(/\x1b\[[0-9;]*m/g, "");
const draw = (el: React.ReactElement) => strip(render(el).lastFrame());
const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return `38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
};

describe("progress arithmetic", () => {
  test("a share is clamped and survives a zero total", () => {
    expect(share(3, 4)).toBe(0.75);
    expect(share(9, 4)).toBe(1);
    expect(share(-1, 4)).toBe(0);
    expect(share(1, 0)).toBe(0);
    expect(share(1, NaN)).toBe(0);
  });

  test("a bar reads full only at 100%", () => {
    // 99.6% rounded up to a full bar tells the user the work finished when it has not.
    expect(fillCells(0.996, 10)).toBe(9);
    expect(fillCells(1, 10)).toBe(10);
  });

  test("real progress is never drawn as an empty bar", () => {
    expect(fillCells(0.01, 10)).toBe(1);
    expect(fillCells(0, 10)).toBe(0);
  });

  test("the percentage floors, matching the bar", () => {
    expect(percentLabel(0.999)).toBe("99%");
    expect(percentLabel(1)).toBe("100%");
    expect(percentLabel(0)).toBe("0%");
  });

  test("a zero-width bar does not divide by itself", () => {
    expect(fillCells(0.5, 0)).toBe(0);
  });
});

describe("ProgressBar", () => {
  test("shows the icon, the percentage, the fill and the label", () => {
    const out = draw(<ProgressBar ratio={0.75} label="Not confirmed" state="error" width={8} />);
    expect(out).toContain("✗");
    expect(out).toContain("75%");
    expect(out).toContain("Not confirmed");
    expect(out).toContain("██████░░");
  });

  test("the state picks the palette colour", () => {
    const raw = render(<ProgressBar ratio={1} state="done" width={4} />).lastFrame()!;
    expect(raw).toContain(rgb(C.green));
  });

  test("the state is inferred from the value when it is not given", () => {
    expect(draw(<ProgressBar ratio={1} width={4} />)).toContain("✓");
    expect(draw(<ProgressBar ratio={0.5} width={4} />)).toContain("◉");
    expect(draw(<ProgressBar ratio={0} width={4} />)).toContain("○");
  });

  test("the percentage can be dropped where space is tight", () => {
    expect(draw(<ProgressBar ratio={0.5} width={4} showPercent={false} />)).not.toContain("50%");
  });
});

describe("Stepper", () => {
  const steps = [
    { label: "Customer", state: "done" as const },
    { label: "Shipping", state: "error" as const },
    { label: "Payment", state: "pending" as const },
  ];

  test("draws the route over its labels", () => {
    const out = draw(<Stepper steps={steps} />);
    const [route, labels] = out.split("\n");
    expect(route).toContain("✓");
    expect(route).toContain("✗");
    expect(route).toContain("○");
    expect(route).toContain("─");
    expect(labels).toContain("Customer");
    expect(labels).toContain("Payment");
  });

  test("the connector takes the colour of the step it leads into", () => {
    // So a failure shows where the route broke, not only which station failed.
    const raw = render(<Stepper steps={steps} />).lastFrame()!;
    const red = raw.indexOf(rgb(C.red));
    expect(red).toBeGreaterThan(-1);
    expect(raw.slice(red, red + 30)).toContain("─");
  });

  test("an empty plan says so rather than drawing an empty route", () => {
    expect(draw(<Stepper steps={[]} />)).toContain("No steps yet");
  });

  test("a caller's own convention overrides the default palette", () => {
    const raw = render(
      <Stepper steps={[{ label: "One", state: "active" }]} palette={{ active: { icon: "▸", color: C.yellow } }} />,
    ).lastFrame()!;
    expect(raw).toContain(rgb(C.yellow));
    expect(strip(raw)).toContain("▸");
  });
});

describe("Segments and Gauge", () => {
  test("each stage gets its own bar, full only when it is finished", () => {
    const out = draw(
      <Segments width={6} steps={[
        { label: "Checkout", state: "done" },
        { label: "Shipping", state: "active" },
        { label: "Payment", state: "pending" },
      ]} />,
    );
    const [labels, bars] = out.split("\n");
    expect(labels).toContain("Check…");   // width 6 leaves five characters and an ellipsis
    expect(bars).toContain("██████");   // done
    expect(bars).toContain("░░░░░░");   // pending, empty rather than full
  });

  test("the gauge encodes real quarters", () => {
    expect(draw(<Gauge value={0} total={4} />)).toContain("○");
    expect(draw(<Gauge value={1} total={4} />)).toContain("◔");
    expect(draw(<Gauge value={2} total={4} />)).toContain("◑");
    expect(draw(<Gauge value={4} total={4} />)).toContain("●");
  });

  test("the gauge reads as the reference does", () => {
    expect(draw(<Gauge value={1} total={4} label="Payment" />)).toContain("1 of 4  Payment");
  });

  test("a gauge with no total does not divide by zero", () => {
    expect(draw(<Gauge value={1} total={0} />)).toContain("1 of 0");
  });
});

describe("wired into the existing UI", () => {
  const steps = [
    { title: "Map the codebase", status: "done" as const },
    { title: "Patch the bug", status: "current" as const },
    { title: "Run the tests", status: "pending" as const },
  ];

  test("the plan shows a bar, a route and the list together", () => {
    const out = draw(<PlanView steps={steps} source="model" running={true} />);
    expect(out).toContain("Plan 1/3");
    expect(out).toContain("33%");
    expect(out).toContain("Map the");          // the route's short label
    expect(out).toContain("Map the codebase"); // the list's full title
  });

  test("the route uses the plan's own colours, not a second convention", () => {
    const raw = render(<PlanView steps={steps} source="model" running={true} />).lastFrame()!;
    const route = raw.split("\n")[2] ?? "";
    expect(route).toContain(rgb(C.yellow));    // current, as the list draws it
    expect(route).not.toContain(rgb(C.blue));
  });

  test("the route is dropped when it would be decoration or would not fit", () => {
    // A route is only a route once it connects something, so look for the connector:
    // the bar and the list both legitimately show a ✓ for a finished single step.
    const one = draw(<PlanView steps={[steps[0]!]} source="model" running={false} />);
    expect(one).toContain("Plan 1/1");
    expect(one).not.toContain("─");

    const many = Array.from({ length: 8 }, (_, i) => ({ title: `Step ${i}`, status: "pending" as const }));
    const wide = draw(<PlanView steps={many} source="auto" running={false} />);
    expect(wide).toContain("Plan 0/8");
    expect(wide).not.toContain("─────");
  });

  test("an empty plan still invites a task", () => {
    expect(draw(<PlanView steps={[]} source="model" running={false} />)).toContain("No active plan");
  });

  test("the status line draws the context bar it already colours", () => {
    const line = (used: number) => render(
      <StatusLine phase="analyzing" tokensUsed={used} tokenLimit={100} mode="confirm" step={1} maxSteps={25} elapsedMs={900} running={true} expanded={false} />,
    ).lastFrame()!;
    expect(strip(line(50))).toContain("█");
    expect(line(95)).toContain(rgb(C.red));     // over 90%
    expect(line(75)).toContain(rgb(C.orange));  // over 70%, the figure's own threshold
  });
});

describe("the icon can be dropped where the row already carries the state", () => {
  test("ProgressBar without its icon starts at the percentage", () => {
    const out = draw(<ProgressBar ratio={0.5} width={4} showIcon={false} />);
    expect(out).not.toContain("◉");
    expect(out).toContain("50%");
  });

  test("the status line shows a bar, not a second state glyph", () => {
    const line = strip(render(
      <StatusLine phase="analyzing" tokensUsed={75} tokenLimit={100} mode="confirm" step={1} maxSteps={25} elapsedMs={900} running={true} expanded={false} />,
    ).lastFrame()!);
    expect(line).toContain("█");
    expect(line).not.toContain("!");
  });
});
