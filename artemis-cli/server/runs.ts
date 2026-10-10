import type { Database } from "bun:sqlite";
import { Agent } from "../src/agent/loop.ts";
import type { AgentEvent, ConfirmRequest, Mode, Provider } from "../src/agent/types.ts";
import { newId, nowIso } from "./db.ts";
import type { Webhooks } from "./webhooks.ts";

export type RunStatus = "queued" | "running" | "needs_approval" | "completed" | "failed" | "cancelled";
export const TERMINAL: RunStatus[] = ["completed", "failed", "cancelled"];

export interface RunRecord {
  id: string;
  task: string;
  status: RunStatus;
  mode: Mode;
  workspace: string;
  model: string;
  session_id: string | null;
  max_steps: number;
  steps: number;
  summary: string | null;
  stop_reason: string | null;
  pending_approval: ConfirmRequest | null;
  usage: { prompt_tokens: number; completion_tokens: number };
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface StoredEvent { seq: number; type: string; data: any; created_at: string }

function toRun(r: any): RunRecord {
  return {
    id: r.id, task: r.task, status: r.status, mode: r.mode, workspace: r.workspace, model: r.model, session_id: r.session_id,
    max_steps: r.max_steps, steps: r.steps, summary: r.summary, stop_reason: r.stop_reason,
    pending_approval: r.pending_approval ? JSON.parse(r.pending_approval) : null,
    usage: { prompt_tokens: r.prompt_tokens, completion_tokens: r.completion_tokens },
    created_at: r.created_at, updated_at: r.updated_at, finished_at: r.finished_at,
  };
}

type Listener = (e: StoredEvent) => void;

interface Live {
  abort: AbortController;
  approve?: (answer: boolean | "always") => void;
  listeners: Set<Listener>;
  seq: number;
  done: Promise<void>;
}

export class RunManager {
  private live = new Map<string, Live>();
  constructor(private db: Database, private webhooks: Webhooks) {}

  get(id: string): RunRecord | null {
    const r = this.db.query("SELECT * FROM runs WHERE id=?").get(id);
    return r ? toRun(r) : null;
  }
  list(limit = 50): RunRecord[] {
    return this.db.query("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?").all(limit).map(toRun);
  }
  events(id: string, after = 0): StoredEvent[] {
    return (this.db.query("SELECT seq,type,data,created_at FROM run_events WHERE run_id=? AND seq>? ORDER BY seq").all(id, after) as any[]).map((r) => ({ ...r, data: JSON.parse(r.data) }));
  }
  activeCount(): number {
    return this.live.size;
  }
  subscribe(id: string, fn: Listener): (() => void) | null {
    const l = this.live.get(id);
    if (!l) return null;
    l.listeners.add(fn);
    return () => l.listeners.delete(fn);
  }
  /** Resolves when the run reaches a terminal state (for tests and SDK wait()). */
  finished(id: string): Promise<void> {
    return this.live.get(id)?.done ?? Promise.resolve();
  }

  private patch(id: string, fields: Record<string, unknown>) {
    const keys = Object.keys(fields);
    this.db.query(`UPDATE runs SET ${keys.map((k) => `${k}=?`).join(",")}, updated_at=? WHERE id=?`).run(...(keys.map((k) => fields[k]) as any[]), nowIso(), id);
  }

  private record(id: string, type: string, data: unknown, persist = true) {
    const l = this.live.get(id);
    if (!l) return;
    const ev: StoredEvent = { seq: persist ? ++l.seq : l.seq, type, data, created_at: nowIso() };
    if (persist) this.db.query("INSERT INTO run_events (run_id,seq,type,data,created_at) VALUES (?,?,?,?,?)").run(id, ev.seq, type, JSON.stringify(data), ev.created_at);
    for (const fn of l.listeners) fn(ev);
  }

  start(input: { task: string; workspace: string; mode: Mode; maxSteps: number; provider: Provider; sessionId?: string | null; memory?: string; createdBy?: string }): RunRecord {
    const id = newId("run");
    const ts = nowIso();
    this.db.query("INSERT INTO runs (id,task,status,mode,workspace,model,session_id,max_steps,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, input.task, "queued", input.mode, input.workspace, input.provider.model, input.sessionId ?? null, input.maxSteps, input.createdBy ?? null, ts, ts);

    let resolveDone!: () => void;
    const live: Live = { abort: new AbortController(), listeners: new Set(), seq: 0, done: new Promise((r) => (resolveDone = r)) };
    this.live.set(id, live);

    const onEvent = (e: AgentEvent) => {
      if (e.type === "assistant_delta") return this.record(id, e.type, { text: e.text }, false);
      if (e.type === "step") this.patch(id, { steps: e.step });
      if (e.type === "usage") this.patch(id, { prompt_tokens: e.promptTokens, completion_tokens: e.completionTokens });
      const { type, ...data } = e;
      this.record(id, type, data);
    };

    const agent = new Agent({
      provider: input.provider,
      root: input.workspace,
      mode: input.mode,
      maxSteps: input.maxSteps,
      onEvent,
      systemPromptExtra: input.memory ? `Session memory notes (from the user's app):\n${input.memory}` : "",
      confirm: (req) =>
        new Promise((resolve) => {
          live.approve = (answer) => {
            live.approve = undefined;
            this.patch(id, { status: "running", pending_approval: null });
            resolve(answer);
          };
          this.patch(id, { status: "needs_approval", pending_approval: JSON.stringify(req) });
          this.webhooks.emit("run.needs_approval", { run: this.get(id), approval: req });
        }),
    });

    queueMicrotask(async () => {
      this.patch(id, { status: "running" });
      const res = await agent.run(input.task, live.abort.signal);
      const status: RunStatus = res.status === "done" ? "completed" : res.status === "cancelled" ? "cancelled" : "failed";
      this.patch(id, { status, summary: res.summary, stop_reason: res.status, steps: res.steps, pending_approval: null, finished_at: nowIso() });
      this.record(id, "run_finished", { status, summary: res.summary, steps: res.steps });
      this.live.delete(id);
      // Deliveries retry in the background; don't hold the run open for them.
      for (const p of this.webhooks.emit("run.completed", { run: this.get(id) })) p.catch(() => {});
      resolveDone();
    });
    return this.get(id)!;
  }

  approve(id: string, approved: boolean, always = false): "ok" | "not_found" | "not_pending" {
    const l = this.live.get(id);
    if (!l) return this.get(id) ? "not_pending" : "not_found";
    if (!l.approve) return "not_pending";
    l.approve(approved ? (always ? "always" : true) : false);
    return "ok";
  }

  cancel(id: string): "ok" | "not_found" | "finished" {
    const l = this.live.get(id);
    if (!l) return this.get(id) ? "finished" : "not_found";
    l.abort.abort();
    l.approve?.(false);
    return "ok";
  }
}
