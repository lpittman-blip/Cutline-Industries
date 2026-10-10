import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { PlanStep } from "../agent/types.ts";
import { C } from "./theme.ts";
import { ProgressBar, Stepper, share, type ProgressState } from "./Progress.tsx";

const STYLE = {
  done: { icon: "✓", color: C.green },
  current: { icon: "▸", color: C.yellow },
  pending: { icon: "○", color: C.muted },
} as const;

/** Plan status maps onto the shared progress palette; the two must not drift apart. */
const PLAN_STATE: Record<PlanStep["status"], ProgressState> = {
  done: "done",
  current: "active",
  pending: "pending",
};

/** A label short enough to sit under a dot without pushing the route off screen. */
function stepLabel(title: string, max = 12): string {
  const head = title.split(/\s+/).slice(0, 2).join(" ");
  return head.length > max ? head.slice(0, max - 1) + "…" : head;
}

/**
 * The agent's live plan: pending (gray), current (yellow), done (green).
 *
 * Three readings of one thing, which is the point of the reference design: the bar
 * says how far along, the route says where it broke or stalled, and the list says
 * what each step actually is. The route is dropped below two steps, where it would
 * be decoration, and above six, where the labels stop fitting.
 */
export function PlanView(props: { steps: PlanStep[]; source: "model" | "auto"; running: boolean }) {
  const done = props.steps.filter((s) => s.status === "done").length;
  const ratio = share(done, props.steps.length);
  const showRoute = props.steps.length >= 2 && props.steps.length <= 6;
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text color={C.muted}>Plan </Text>
        <Text color={C.faint}>{props.steps.length ? `${done}/${props.steps.length}` : ""}{props.source === "auto" && props.steps.length ? "  (from tool calls)" : ""}</Text>
      </Box>
      {props.steps.length > 0 ? (
        <Box marginLeft={2}>
          {/* No icon: the route below and the list carry the state already. */}
          <ProgressBar ratio={ratio} width={20} showIcon={false} state={done === props.steps.length ? "done" : props.running ? "active" : "pending"} />
        </Box>
      ) : null}
      {showRoute ? (
        <Box marginLeft={2} marginTop={0}>
          <Stepper
            steps={props.steps.map((s) => ({ label: stepLabel(s.title), state: PLAN_STATE[s.status] }))}
            palette={{ active: STYLE.current, done: STYLE.done, pending: STYLE.pending }}
          />
        </Box>
      ) : null}
      {props.steps.length === 0 ? (
        <Text color={C.faint}>  {props.running ? "Waiting for Artemis to publish a plan…" : "No active plan. Give Artemis a task below."}</Text>
      ) : (
        props.steps.map((s, i) => {
          const st = STYLE[s.status];
          return (
            <Box key={i}>
              <Box width={4} paddingLeft={2}>
                {s.status === "current" && props.running ? <Text color={st.color}><Spinner type="dots" /></Text> : <Text color={st.color}>{st.icon}</Text>}
              </Box>
              <Text color={st.color} bold={s.status === "current"} wrap="truncate-end">{s.title}</Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}
