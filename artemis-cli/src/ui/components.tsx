import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { C, TOOL_ICONS, argSummary, fmtMs } from "./theme.ts";
import type { ConfirmRequest } from "../agent/types.ts";

export type Item =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; streaming: boolean }
  | {
      kind: "tool";
      id: string;
      name: string;
      args: Record<string, unknown>;
      status: "running" | "awaiting" | "ok" | "error" | "denied";
      summary?: string;
      output?: string;
      durationMs?: number;
    }
  | { kind: "done"; id: string; text: string; steps: number }
  | { kind: "error"; id: string; text: string }
  | { kind: "info"; id: string; text: string };

function ToolRow({ item, expanded }: { item: Extract<Item, { kind: "tool" }>; expanded: boolean }) {
  const icon = TOOL_ICONS[item.name] ?? "•";
  const statusEl =
    item.status === "running" ? <Text color={C.sky}><Spinner type="dots" /></Text>
    : item.status === "awaiting" ? <Text color={C.orange}>◌</Text>
    : item.status === "ok" ? <Text color={C.green}>✓</Text>
    : item.status === "denied" ? <Text color={C.orange}>⊘</Text>
    : <Text color={C.red}>✗</Text>;
  const lines = (item.output ?? "").split("\n");
  const shown = expanded ? lines.slice(0, 18) : [];
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Box>
        <Box width={2} flexShrink={0}>{statusEl}</Box>
        <Box flexShrink={0}>
          <Text color={C.sky}>{icon} </Text>
          <Text bold color={C.text}>{item.name}</Text>
        </Box>
        <Text color={C.muted} wrap="truncate-end"> {argSummary(item.name, item.args, 48)}</Text>
        {item.summary ? <Text wrap="truncate-end" color={item.status === "ok" ? C.faint : item.status === "error" ? C.red : C.orange}>  → {item.summary}</Text> : null}
        {item.durationMs !== undefined ? <Box flexShrink={0}><Text color={C.faint}>  {fmtMs(item.durationMs)}</Text></Box> : null}
        {item.output && item.status !== "running" && item.name !== "done" ? <Text color={C.faint}>  {expanded ? "▾" : "▸"}</Text> : null}
      </Box>
      {shown.length > 0 && item.name !== "done" ? (
        <Box flexDirection="column" marginLeft={4} borderStyle="single" borderLeft borderTop={false} borderRight={false} borderBottom={false} borderColor={C.faint} paddingLeft={1}>
          {shown.map((l, i) => <Text key={i} color={C.muted} wrap="truncate-end">{l || " "}</Text>)}
          {lines.length > shown.length ? <Text color={C.faint}>… {lines.length - shown.length} more lines</Text> : null}
        </Box>
      ) : null}
    </Box>
  );
}

export function TranscriptItem({ item, expanded }: { item: Item; expanded: boolean }) {
  switch (item.kind) {
    case "user":
      return (
        <Box marginTop={1}>
          <Text color={C.blue} bold>❯ </Text>
          <Text color={C.text} bold>{item.text}</Text>
        </Box>
      );
    case "assistant":
      return (
        <Box marginLeft={2}>
          <Text color={C.sky}>◆ </Text>
          <Text color={C.text}>{item.text}{item.streaming ? <Text color={C.sky}>▍</Text> : null}</Text>
        </Box>
      );
    case "tool":
      return <ToolRow item={item} expanded={expanded} />;
    case "done":
      return (
        <Box marginTop={1} marginLeft={2} borderStyle="round" borderColor={C.green} paddingX={1} flexDirection="column">
          <Text color={C.green} bold>✓ Done in {item.steps} step{item.steps === 1 ? "" : "s"}</Text>
          <Text color={C.text}>{item.text}</Text>
        </Box>
      );
    case "error":
      return <Box marginLeft={2}><Text color={C.red}>✗ {item.text}</Text></Box>;
    case "info":
      return <Box marginLeft={2}><Text color={C.muted}>{item.text}</Text></Box>;
  }
}

export function ConfirmPrompt({ request }: { request: ConfirmRequest }) {
  const lines = request.preview.split("\n");
  return (
    <Box borderStyle="round" borderColor={C.orange} paddingX={1} flexDirection="column" marginTop={1}>
      <Text color={C.orange} bold>▲ Approve {request.tool}?</Text>
      <Box flexDirection="column" marginY={0} marginLeft={1}>
        {lines.slice(0, 20).map((l, i) => (
          <Text key={i} color={l.startsWith("+") ? C.green : l.startsWith("-") ? C.red : C.text} wrap="truncate-end">{l}</Text>
        ))}
      </Box>
      <Box marginTop={0}>
        <Text color={C.green} bold>[y]</Text><Text color={C.muted}> allow  </Text>
        <Text color={C.red} bold>[n]</Text><Text color={C.muted}> deny  </Text>
        <Text color={C.orange} bold>[a]</Text><Text color={C.muted}> allow all this session</Text>
      </Box>
    </Box>
  );
}
