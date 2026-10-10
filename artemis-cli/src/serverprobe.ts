/**
 * What is actually behind the terminal, and how hard it is working.
 *
 * One OpenAI-shaped probe reaches all three things Artemis can sit on: its own
 * gateway, a vLLM server on a GPU host, and LM Studio on a laptop. Only what a
 * server really publishes is reported — GPU figures come from vLLM's Prometheus
 * endpoint, and a server without one reads as "not reported" rather than zero,
 * because a zero would be drawn as an idle GPU, which is a different claim.
 */

export interface ServerReading {
  reachable: boolean;
  model: string;
  /** KV-cache in use, 0..1, when the server publishes it. */
  gpuCache: number | null;
  running: number | null;
  queued: number | null;
  detail?: string;
}

export const UNREACHED: ServerReading = { reachable: false, model: "", gpuCache: null, running: null, queued: null };

export async function probeModels(
  baseUrl: string,
  apiKey?: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 4000,
): Promise<{ reachable: boolean; model: string; detail?: string }> {
  try {
    const res = await fetchImpl(new URL("/v1/models", baseUrl).toString(), {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { reachable: false, model: "", detail: `HTTP ${res.status}` };
    const body = (await res.json()) as { data?: { id?: unknown }[]; models?: { id?: unknown }[] };
    // vLLM and LM Studio answer {data:[{id}]}; the Artemis server answers {models:[{id}]}.
    const first = (body.data ?? body.models ?? [])[0]?.id;
    return { reachable: true, model: typeof first === "string" ? shortModel(first) : "" };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return { reachable: false, model: "", detail: /timed out/i.test(detail) ? "timed out" : detail };
  }
}

/** vLLM publishes Prometheus metrics; LM Studio does not. Absent means null, never 0. */
export function parsePrometheus(text: string): Pick<ServerReading, "gpuCache" | "running" | "queued"> {
  const read = (name: string): number | null => {
    const m = new RegExp(`^${name}(?:\\{[^}]*\\})?\\s+([0-9.eE+-]+)\\s*$`, "m").exec(text);
    if (!m) return null;
    const v = Number(m[1]);
    return Number.isFinite(v) ? v : null;
  };
  return {
    gpuCache: read("vllm:gpu_cache_usage_perc"),
    running: read("vllm:num_requests_running"),
    queued: read("vllm:num_requests_waiting"),
  };
}

export async function probeGpu(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 4000,
): Promise<Pick<ServerReading, "gpuCache" | "running" | "queued">> {
  try {
    const res = await fetchImpl(new URL("/metrics", baseUrl).toString(), { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { gpuCache: null, running: null, queued: null };
    return parsePrometheus(await res.text());
  } catch {
    return { gpuCache: null, running: null, queued: null };
  }
}

export async function probeServer(baseUrl: string, apiKey?: string, fetchImpl: typeof fetch = fetch): Promise<ServerReading> {
  const models = await probeModels(baseUrl, apiKey, fetchImpl);
  if (!models.reachable) return { ...UNREACHED, ...(models.detail ? { detail: models.detail } : {}) };
  return { reachable: true, model: models.model, ...(await probeGpu(baseUrl, fetchImpl)) };
}

/** "lmstudio-community/Qwen2.5-Coder-7B-GGUF" is unreadable in a status line; the tail is not. */
export function shortModel(id: string, max = 22): string {
  const tail = id.split("/").pop() ?? id;
  return tail.length <= max ? tail : tail.slice(0, max - 1) + "…";
}

export function serverLabel(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    return local ? `local:${u.port || "80"}` : u.host;
  } catch {
    return baseUrl;
  }
}

/**
 * Generation speed, measured from chunk arrivals.
 *
 * Timed from the FIRST token, not from the request: including the wait for the first
 * token gives a figure that climbs through the answer and settles nowhere, which says
 * nothing about how fast the model is running. The wait is kept separately, where it
 * is the useful number on its own.
 */
export class TokenMeter {
  readonly #now: () => number;
  #chars = 0;
  #firstAt: number | null = null;
  #lastAt = 0;
  #queueMs = 0;

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  record(text: string, startedAt?: number): void {
    const at = this.#now();
    if (this.#firstAt === null) {
      this.#firstAt = at;
      if (startedAt !== undefined) this.#queueMs = Math.max(0, at - startedAt);
    }
    this.#lastAt = at;
    this.#chars += text.length;
  }

  reset(): void {
    this.#chars = 0;
    this.#firstAt = null;
    this.#lastAt = 0;
    this.#queueMs = 0;
  }

  /** Milliseconds to the first token: queueing plus prompt processing. */
  get firstTokenMs(): number { return this.#queueMs; }

  /** Tokens per second, or null before there is enough to divide by. */
  get rate(): number | null {
    if (this.#firstAt === null) return null;
    const seconds = (this.#lastAt - this.#firstAt) / 1000;
    const tokens = this.#chars / 4;      // the rule the server bills with, so the two agree
    if (seconds < 0.25 || tokens < 2) return null;
    return tokens / seconds;
  }
}
