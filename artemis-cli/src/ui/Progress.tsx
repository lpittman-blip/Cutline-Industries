import { Box, Text } from "ink";
import { C } from "./theme.ts";

/**
 * Progress primitives, in the Artemis palette.
 *
 * Four shapes, matching the reference design: a labelled percentage bar, a stepper of
 * connected dots, a row of per-stage segments, and a compact fraction standing in for
 * the circular gauge — a ring cannot be drawn honestly in one text cell, and the
 * quarter-filled circles do encode a real fraction, where ASCII art of a circle would
 * only decorate one.
 *
 * Two rules hold everywhere here:
 *   - a bar is only ever as full as the value it was given, clamped, never rounded up
 *     to look finished, and 99.6% draws as an unfinished bar rather than a full one;
 *   - a state with no progress to report draws empty, not full, so an unknown step is
 *     never mistaken for a completed one.
 */

export type ProgressState = "done" | "active" | "warn" | "error" | "pending";

export const PROGRESS_STYLE: Record<ProgressState, { icon: string; color: string }> = {
  done: { icon: "✓", color: C.green },
  active: { icon: "◉", color: C.blue },
  warn: { icon: "!", color: C.yellow },
  error: { icon: "✗", color: C.red },
  pending: { icon: "○", color: C.muted },
};

const FILLED = "█";
const EMPTY = "░";

/** Clamps to 0..1 and treats anything non-finite as "nothing known yet". */
export function share(value: number, total: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.min(1, Math.max(0, value / total));
}

/**
 * Cells to fill for a share. Floored, so a bar reads full only at 100%: a bar that
 * rounds 99.6% up to full tells the user the work finished when it has not.
 */
export function fillCells(ratio: number, width: number): number {
  if (width <= 0) return 0;
  const clamped = Math.min(1, Math.max(0, ratio));
  const cells = Math.floor(clamped * width);
  // Never show an empty bar for real progress; never show a full one before the end.
  if (clamped > 0 && cells === 0) return 1;
  if (clamped < 1 && cells === width) return width - 1;
  return cells;
}

export function percentLabel(ratio: number): string {
  return `${Math.floor(Math.min(1, Math.max(0, ratio)) * 100)}%`;
}

/** `75% Not confirmed  ███████░░░` — icon, percent, label, then the bar. */
export function ProgressBar(props: {
  ratio: number;
  label?: string;
  state?: ProgressState;
  width?: number;
  showPercent?: boolean;
  /** Off where the surrounding row already carries the state, as the status line does. */
  showIcon?: boolean;
}) {
  const width = props.width ?? 24;
  const state = props.state ?? (props.ratio >= 1 ? "done" : props.ratio > 0 ? "active" : "pending");
  const style = PROGRESS_STYLE[state];
  const filled = fillCells(props.ratio, width);
  return (
    <Box>
      {props.showIcon === false ? null : (
        <Box width={2} flexShrink={0}><Text color={style.color}>{style.icon}</Text></Box>
      )}
      {props.showPercent === false ? null : (
        <Box width={5} flexShrink={0}><Text bold color={C.text}>{percentLabel(props.ratio)}</Text></Box>
      )}
      <Box flexShrink={0}>
        <Text color={style.color}>{FILLED.repeat(filled)}</Text>
        <Text color={C.faint}>{EMPTY.repeat(Math.max(0, width - filled))}</Text>
      </Box>
      {props.label ? <Text color={C.muted} wrap="truncate-end">  {props.label}</Text> : null}
    </Box>
  );
}

export interface Step {
  label: string;
  state: ProgressState;
}

/**
 * `✓──✓──◉──○──○` over its labels: the whole route at a glance.
 *
 * The connector before a step takes that step's colour, so a failure shows where the
 * route broke rather than only which station failed.
 */
export function Stepper(props: { steps: Step[]; gap?: number; palette?: Partial<Record<ProgressState, { icon: string; color: string }>> }) {
  const gap = props.gap ?? 2;
  if (props.steps.length === 0) return <Text color={C.faint}>No steps yet.</Text>;
  // A caller that already has a convention for a state keeps it: the plan shows a
  // current step as a yellow ▸, and a route drawn in a different colour beside the
  // same list would read as two different states rather than one.
  const style = (state: ProgressState) => props.palette?.[state] ?? PROGRESS_STYLE[state];
  const widths = props.steps.map((s) => Math.max(s.label.length, 1));
  return (
    <Box flexDirection="column">
      <Box>
        {props.steps.map((step, i) => {
          const st = style(step.state);
          const pad = Math.max(0, Math.floor((widths[i]! - 1) / 2));
          const tail = Math.max(0, widths[i]! - 1 - pad);
          return (
            <Box key={i} flexShrink={0}>
              {i > 0 ? <Text color={st.color}>{"─".repeat(gap)}</Text> : null}
              <Text color={C.faint}>{" ".repeat(pad)}</Text>
              <Text color={st.color} bold={step.state === "active"}>{st.icon}</Text>
              <Text color={C.faint}>{" ".repeat(tail)}</Text>
            </Box>
          );
        })}
      </Box>
      <Box>
        {props.steps.map((step, i) => (
          <Box key={i} flexShrink={0}>
            {i > 0 ? <Text>{" ".repeat(gap)}</Text> : null}
            <Text color={style(step.state).color}>{step.label}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

/** A short bar per stage, side by side, for a route whose stages have their own progress. */
export function Segments(props: { steps: Step[]; width?: number; gap?: number }) {
  const width = props.width ?? 10;
  const gap = props.gap ?? 2;
  return (
    <Box flexDirection="column">
      <Box>
        {props.steps.map((step, i) => (
          <Box key={i} flexShrink={0}>
            {i > 0 ? <Text>{" ".repeat(gap)}</Text> : null}
            <Text color={PROGRESS_STYLE[step.state].color}>
              {step.label.length > width ? step.label.slice(0, width - 1) + "…" : step.label.padEnd(width)}
            </Text>
          </Box>
        ))}
      </Box>
      <Box>
        {props.steps.map((step, i) => {
          const full = step.state === "done" || step.state === "error";
          const style = PROGRESS_STYLE[step.state];
          return (
            <Box key={i} flexShrink={0}>
              {i > 0 ? <Text>{" ".repeat(gap)}</Text> : null}
              {step.state === "pending"
                ? <Text color={C.faint}>{EMPTY.repeat(width)}</Text>
                : <>
                    <Text color={style.color}>{FILLED.repeat(full ? width : Math.max(1, Math.floor(width / 2)))}</Text>
                    <Text color={C.faint}>{EMPTY.repeat(full ? 0 : width - Math.max(1, Math.floor(width / 2)))}</Text>
                  </>}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

const QUARTERS = ["○", "◔", "◑", "◕", "●"] as const;

/**
 * The reference's circular "Status 1 of 4", as a terminal can honestly draw it.
 *
 * A ring is a shape a text cell does not have. These five glyphs encode quarters
 * exactly, so the figure is real at 0, 1/4, 1/2, 3/4 and 1 and rounds to the nearest
 * quarter in between — which is what the eye reads off a small ring anyway.
 */
export function Gauge(props: { value: number; total: number; label?: string }) {
  const ratio = share(props.value, props.total);
  const glyph = QUARTERS[Math.round(ratio * 4)] ?? QUARTERS[0];
  const state: ProgressState = ratio >= 1 ? "done" : ratio > 0 ? "active" : "pending";
  return (
    <Box>
      <Text color={PROGRESS_STYLE[state].color}>{glyph} </Text>
      <Text color={C.text}>{Math.max(0, Math.trunc(props.value))}</Text>
      <Text color={C.muted}> of {Math.max(0, Math.trunc(props.total))}</Text>
      {props.label ? <Text color={C.muted}>  {props.label}</Text> : null}
    </Box>
  );
}
