import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { StatusLine } from "../src/ui/StatusLine.tsx";
import { TokenMeter, parsePrometheus, probeGpu, probeModels, probeServer, serverLabel, shortModel } from "../src/serverprobe.ts";

const strip = (s = "") => s.replace(/\x1b\[[0-9;]*m/g, "");
const responder = (h: (url: string) => Response) => (async (u: string | URL | Request) => h(String(u))) as unknown as typeof fetch;

const VLLM = `vllm:gpu_cache_usage_perc{model_name="artemis"} 0.42
vllm:num_requests_running{model_name="artemis"} 3.0
vllm:num_requests_waiting{model_name="artemis"} 1.0
`;

describe("probing whatever is behind the terminal", () => {
  test("an LM Studio or vLLM model list is understood", async () => {
    const f = responder(() => new Response(JSON.stringify({ data: [{ id: "lmstudio-community/Qwen2.5-Coder-7B" }] })));
    const r = await probeModels("http://localhost:1234", undefined, f);
    expect(r.reachable).toBe(true);
    expect(r.model).toBe("Qwen2.5-Coder-7B");
  });

  test("the Artemis server's own shape is understood by the same probe", async () => {
    const f = responder(() => new Response(JSON.stringify({ models: [{ id: "artemis" }] })));
    expect((await probeModels("http://x", undefined, f)).model).toBe("artemis");
  });

  test("an HTTP error and a refused connection both report a reason", async () => {
    const bad = responder(() => new Response("no", { status: 503 }));
    expect((await probeModels("http://x", undefined, bad)).detail).toBe("HTTP 503");
    const dead = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    const r = await probeModels("http://x", undefined, dead);
    expect(r.reachable).toBe(false);
    expect(r.detail).toContain("fetch failed");
  });

  test("a key is sent only when there is one", async () => {
    const seen: Record<string, unknown>[] = [];
    const f = (async (_u: string, init: RequestInit) => { seen.push((init.headers ?? {}) as Record<string, unknown>); return new Response(JSON.stringify({ data: [] })); }) as unknown as typeof fetch;
    await probeModels("http://x", "art_key", f);
    await probeModels("http://x", undefined, f);
    expect(seen[0]!.Authorization).toBe("Bearer art_key");
    expect("Authorization" in seen[1]!).toBe(false);
  });

  test("vLLM gauges are read, and a server without them reports null not zero", () => {
    // A zero would be drawn as an idle GPU, which is a different claim from "not told".
    expect(parsePrometheus(VLLM)).toEqual({ gpuCache: 0.42, running: 3, queued: 1 });
    expect(parsePrometheus("# nothing\n")).toEqual({ gpuCache: null, running: null, queued: null });
  });

  test("a missing metrics endpoint is not an error", async () => {
    const f = responder(() => new Response("nope", { status: 404 }));
    expect(await probeGpu("http://x", f)).toEqual({ gpuCache: null, running: null, queued: null });
  });

  test("a full probe combines model and GPU, and skips metrics when unreachable", async () => {
    const up = responder((u) => u.endsWith("/metrics") ? new Response(VLLM) : new Response(JSON.stringify({ data: [{ id: "artemis-1b" }] })));
    expect(await probeServer("http://gpu-vm:8000", undefined, up)).toEqual({ reachable: true, model: "artemis-1b", gpuCache: 0.42, running: 3, queued: 1 });

    let metrics = 0;
    const down = responder((u) => { if (u.endsWith("/metrics")) metrics++; return new Response("x", { status: 502 }); });
    expect((await probeServer("http://gpu-vm:8000", undefined, down)).reachable).toBe(false);
    expect(metrics).toBe(0);
  });

  test("labels stay short enough for a status line", () => {
    expect(shortModel("org/Very-Long-Model-Name-Instruct-v2", 22)).toBe("Very-Long-Model-Name-…");
    expect(serverLabel("http://127.0.0.1:8000")).toBe("local:8000");
    expect(serverLabel("https://gpu.example.com:8000")).toBe("gpu.example.com:8000");
  });
});

describe("TokenMeter", () => {
  test("the rate is timed from the first token, not from the request", () => {
    // Including the queue wait gives a figure that climbs through the answer and
    // settles nowhere, which says nothing about how fast the model is running.
    let now = 1000;
    const m = new TokenMeter(() => now);
    now = 5000;
    m.record("abcd", 1000);
    now = 6000;
    m.record("abcdefgh");
    expect(m.firstTokenMs).toBe(4000);
    expect(m.rate).toBe(3);
  });

  test("no rate is claimed from too little evidence", () => {
    let now = 0;
    const m = new TokenMeter(() => now);
    expect(m.rate).toBeNull();
    m.record("abcd");
    now = 50;
    expect(m.rate).toBeNull();
  });

  test("a meter resets between tasks", () => {
    let now = 0;
    const m = new TokenMeter(() => now);
    m.record("abcd"); now = 1000; m.record("abcd");
    expect(m.rate).toBeGreaterThan(0);
    m.reset();
    expect(m.rate).toBeNull();
  });
});

describe("the status line shows only what was measured", () => {
  const line = (over: Record<string, unknown> = {}) => strip(render(
    <StatusLine phase="analyzing" tokensUsed={10} tokenLimit={100} mode="confirm" step={1} maxSteps={25} elapsedMs={900} running={true} expanded={false} {...over} />,
  ).lastFrame()!);

  test("a rate and a GPU figure appear when they exist", () => {
    const out = line({ rate: 18.4, gpuCache: 0.42 });
    expect(out).toContain("18.4 tok/s");
    expect(out).toContain("gpu 42%");
  });

  test("neither is drawn when there is nothing to draw", () => {
    // A blank is honest; a zero would read as a stalled model or an idle GPU.
    const out = line();
    expect(out).not.toContain("tok/s");
    expect(out).not.toContain("gpu ");
  });

  test("a genuine zero is still shown", () => {
    expect(line({ gpuCache: 0 })).toContain("gpu 0%");
  });
});
