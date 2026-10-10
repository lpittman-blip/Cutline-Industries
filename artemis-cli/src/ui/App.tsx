import { Box, Static, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { useCallback, useEffect, useRef, useState } from "react";
import { Agent, DEFAULT_TOKEN_BUDGET } from "../agent/loop.ts";
import type { AgentEvent, ConfirmRequest, Mode, Phase, PlanStep, Provider } from "../agent/types.ts";
import { Banner, SectionTitle } from "./Banner.tsx";
import { ConfirmPrompt, TranscriptItem, type Item } from "./components.tsx";
import { PlanView } from "./PlanView.tsx";
import { StatusLine } from "./StatusLine.tsx";
import { C } from "./theme.ts";

export interface AppProps {
  provider: Provider;
  connection: string;
  target: string;
  root: string;
  mode: Mode;
  maxSteps: number;
  tokenBudget?: number;
  initialTask?: string;
  /** One-shot: exit after the first task finishes. */
  exitOnDone?: boolean;
  forceJsGrep?: boolean;
  /** Ask the model to review mutating actions. Safety rules run regardless. */
  review?: boolean;
  onExit?: (status: string) => void;
}

const HELP = "Commands: /help · /mode auto|confirm|read-only · /expand · /clear · /exit   Keys: Esc or Ctrl+C abort a run · Ctrl+C when idle quits · Ctrl+O expand tool output";

let idSeq = 0;
const nid = () => `i${++idSeq}`;

export function App(props: AppProps) {
  const { exit } = useApp();
  const tokenLimit = props.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const [mode, setMode] = useState<Mode>(props.mode);
  const [history, setHistory] = useState<{ id: string; items: Item[] }[]>([]);
  const [turn, setTurn] = useState<Item[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState<ConfirmRequest | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [plan, setPlan] = useState<{ steps: PlanStep[]; source: "model" | "auto" }>({ steps: [], source: "auto" });
  const [stats, setStats] = useState({ step: 0, tokens: 0 });
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [lastElapsed, setLastElapsed] = useState(0);
  const resolver = useRef<((v: boolean | "always") => void) | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const turnRef = useRef<Item[]>([]);
  const pendingRef = useRef<ConfirmRequest | null>(null);
  const runningRef = useRef(false);

  const update = useCallback((fn: (items: Item[]) => Item[]) => {
    turnRef.current = fn(turnRef.current);
    setTurn(turnRef.current);
  }, []);

  const onEvent = useCallback((e: AgentEvent) => {
    switch (e.type) {
      case "phase":
        setPhase(e.phase);
        break;
      case "plan":
        setPlan({ steps: e.steps, source: e.source });
        break;
      case "step":
        setStats((s) => ({ ...s, step: e.step }));
        break;
      case "assistant_delta":
        update((items) => {
          const last = items.at(-1);
          if (last?.kind === "assistant" && last.streaming) return [...items.slice(0, -1), { ...last, text: last.text + e.text }];
          return [...items, { kind: "assistant", id: nid(), text: e.text, streaming: true }];
        });
        break;
      case "assistant_message":
        update((items) => {
          const last = items.at(-1);
          if (last?.kind === "assistant" && last.streaming) return [...items.slice(0, -1), { ...last, text: e.text.trim(), streaming: false }];
          return [...items, { kind: "assistant", id: nid(), text: e.text.trim(), streaming: false }];
        });
        break;
      case "tool_start":
        if (e.name === "update_plan") break; // shown in the PlanView instead
        update((items) => [...items.map((i) => (i.kind === "assistant" && i.streaming ? { ...i, streaming: false } : i)), { kind: "tool", id: e.callId, name: e.name, args: e.args, status: "running" }]);
        break;
      case "approval_required":
        update((items) => items.map((i) => (i.kind === "tool" && i.id === e.request.callId ? { ...i, status: "awaiting" } : i)));
        break;
      case "review":
        // Shown as its own transcript line, not folded into the tool row: a
        // blocked action and a failed one read very differently to a user.
        update((items) => [...items, {
          kind: e.approved ? "info" : "error",
          id: e.callId + ":review",
          text: e.approved
            ? `review skipped — ${e.critique}`
            : `blocked by ${e.rule ?? "review"} (${e.source}): ${e.critique}`,
        }]);
        break;
      case "approval_resolved":
        update((items) => items.map((i) => (i.kind === "tool" && i.id === e.callId ? { ...i, status: e.approved ? "running" : "denied" } : i)));
        break;
      case "tool_end":
        update((items) =>
          items.map((i) =>
            i.kind === "tool" && i.id === e.callId
              ? { ...i, status: i.status === "denied" ? "denied" : e.ok ? "ok" : "error", summary: e.summary, output: e.output, durationMs: e.durationMs }
              : i,
          ),
        );
        break;
      case "usage":
        setStats((s) => ({ ...s, tokens: e.promptTokens + e.completionTokens }));
        break;
      case "done":
        update((items) => [...items, { kind: "done", id: nid(), text: e.summary, steps: e.steps }]);
        break;
      case "error":
        update((items) => [...items, { kind: "error", id: nid(), text: e.message }]);
        break;
      case "cancelled":
        update((items) => [...items, { kind: "info", id: nid(), text: "⊘ Aborted." }]);
        break;
    }
  }, [update]);

  const agentRef = useRef<Agent | null>(null);
  if (!agentRef.current) {
    agentRef.current = new Agent({
      provider: props.provider,
      root: props.root,
      mode: props.mode,
      maxSteps: props.maxSteps,
      tokenBudget: tokenLimit,
      forceJsGrep: props.forceJsGrep,
      review: props.review,
      onEvent,
      confirm: (req) =>
        new Promise((resolve) => {
          resolver.current = resolve;
          pendingRef.current = req;
          setPending(req);
        }),
    });
  }

  const runTask = useCallback(async (task: string) => {
    const agent = agentRef.current!;
    if (turnRef.current.length) {
      const done = turnRef.current;
      setHistory((h) => [...h, { id: nid(), items: done }]);
    }
    turnRef.current = [{ kind: "user", id: nid(), text: task }];
    setTurn(turnRef.current);
    setStats({ step: 0, tokens: 0 });
    setRunning(true);
    runningRef.current = true;
    const t0 = Date.now();
    setStartedAt(t0);
    const ac = new AbortController();
    abortRef.current = ac;
    const res = await agent.run(task, ac.signal);
    setMode(agent.mode);
    setRunning(false);
    runningRef.current = false;
    setLastElapsed(Date.now() - t0);
    setStartedAt(null);
    abortRef.current = null;
    if (props.exitOnDone) {
      props.onExit?.(res.status);
      setTimeout(() => exit(), 30);
    }
  }, [exit, props]);

  useEffect(() => {
    if (props.initialTask) void runTask(props.initialTask);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [running]);

  const abort = () => {
    abortRef.current?.abort();
    if (pendingRef.current) {
      pendingRef.current = null;
      setPending(null);
      resolver.current?.(false);
      resolver.current = null;
    }
  };

  useInput((ch, key) => {
    const ctrlC = key.ctrl && ch === "c";
    if (ctrlC || key.escape) {
      if (runningRef.current) return abort();
      if (ctrlC) { props.onExit?.("exit"); exit(); }
      return;
    }
    if (pendingRef.current) {
      const c = ch.toLowerCase();
      if (c === "y" || c === "n" || c === "a") {
        const answer = c === "y" ? true : c === "a" ? "always" : false;
        if (answer === "always") setMode("auto");
        pendingRef.current = null;
        setPending(null);
        resolver.current?.(answer);
        resolver.current = null;
      }
      return;
    }
    if (key.ctrl && ch === "o") setExpanded((x) => !x);
  });

  const submit = (value: string) => {
    const v = value.trim();
    setInput("");
    if (!v || running) return;
    if (v.startsWith("/")) {
      const [cmd, arg] = v.slice(1).split(/\s+/);
      const info = (text: string) => update((items) => [...items, { kind: "info", id: nid(), text }]);
      if (cmd === "exit" || cmd === "quit") { props.onExit?.("exit"); exit(); return; }
      if (cmd === "help") return info(HELP);
      if (cmd === "expand") { setExpanded((x) => !x); return; }
      if (cmd === "clear") { setHistory([]); turnRef.current = []; setTurn([]); setPlan({ steps: [], source: "auto" }); return; }
      if (cmd === "mode") {
        const m = arg === "auto" ? "auto" : arg === "confirm" || arg === "sandboxed" ? "confirm" : arg === "read-only" || arg === "read_only" ? "read_only" : null;
        if (!m) return info("Usage: /mode auto|confirm|read-only");
        agentRef.current!.mode = m;
        setMode(m);
        return info(`Safety mode set to ${m}.`);
      }
      return info(`Unknown command /${cmd}. ${HELP}`);
    }
    void runTask(v);
  };

  const elapsed = startedAt ? Math.max(0, now - startedAt) : lastElapsed;
  const showInput = !props.exitOnDone && !pending;

  return (
    <Box flexDirection="column">
      <Static items={history}>
        {(h) => (
          <Box key={h.id} flexDirection="column" paddingX={2}>
            {h.items.map((it) => <TranscriptItem key={it.id} item={it} expanded={false} />)}
          </Box>
        )}
      </Static>
      <Box flexDirection="column" borderStyle="round" borderColor={C.blue}>
        <Banner model={props.provider.model} connection={props.connection} target={props.target} root={props.root} />
        <SectionTitle>Current Operational Loop</SectionTitle>
        <PlanView steps={plan.steps} source={plan.source} running={running} />
        <Box flexDirection="column" paddingX={1} marginTop={turn.length ? 0 : 1}>
          {turn.length === 0 ? <Text color={C.faint}>Talk to it. Code with it. Build anything.</Text> : turn.map((it) => <TranscriptItem key={it.id} item={it} expanded={expanded} />)}
        </Box>
        {pending ? <Box paddingX={1}><ConfirmPrompt request={pending} /></Box> : null}
        {showInput ? (
          <Box marginX={1} marginTop={1} borderStyle="round" borderColor={running ? C.faint : C.sky} paddingX={1}>
            <Text color={running ? C.faint : C.blue} bold>❯ </Text>
            {running ? (
              <Text color={C.faint}>Artemis is working… (Esc to abort)</Text>
            ) : (
              <TextInput value={input} onChange={setInput} onSubmit={submit} placeholder="Ask Artemis to find, fix or build something…" />
            )}
          </Box>
        ) : null}
        <Box borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false} borderColor={C.faint} marginTop={1}>
          <StatusLine phase={phase} tokensUsed={stats.tokens} tokenLimit={tokenLimit} mode={mode} step={stats.step} maxSteps={props.maxSteps} elapsedMs={elapsed} running={running} expanded={expanded} />
        </Box>
      </Box>
    </Box>
  );
}
