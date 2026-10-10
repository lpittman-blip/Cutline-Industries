import { MockProvider } from "../src/agent/mock.ts";
import { OpenAIProvider } from "../src/agent/openai.ts";
import type { Provider } from "../src/agent/types.ts";

export interface UpstreamConfig { baseUrl: string; apiKey?: string; model: string }

export interface CoreProbe {
  url: string;
  reachable: boolean;
  compatible: boolean;
  status?: number;
  detail: string;
  checked_at: string;
}

/**
 * Read-only probe of an existing Artemis core. It is only used as a chat
 * backend if it answers GET /v1/models with an OpenAI-style `{ data: [...] }`.
 */
export async function probeCore(url: string, key?: string, timeoutMs = 6000): Promise<CoreProbe> {
  const base = url.replace(/\/$/, "");
  const checked_at = new Date().toISOString();
  try {
    const res = await fetch(`${base}/v1/models`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(timeoutMs) });
    let compatible = false;
    if (res.ok) {
      const j: any = await res.json().catch(() => null);
      compatible = Array.isArray(j?.data);
    }
    return { url: base, reachable: true, compatible, status: res.status, detail: compatible ? "OpenAI-compatible /v1/models" : `GET /v1/models returned ${res.status} without an OpenAI model list`, checked_at };
  } catch (e) {
    return { url: base, reachable: false, compatible: false, detail: (e as Error).message, checked_at };
  }
}

export type Backend =
  | { kind: "mock" }
  | { kind: "core"; baseUrl: string; apiKey?: string; model: string }
  | { kind: "upstream"; baseUrl: string; apiKey: string; model: string }
  | { kind: "none"; reason: string };

export interface ProviderSettings {
  mode: "mock" | "upstream";
  upstream: UpstreamConfig;
  core?: { url: string; key?: string; probe?: CoreProbe };
}

/** Choose where a chat/agent request goes, given the requested model name. */
export function pickBackend(s: ProviderSettings, requestedModel?: string): Backend {
  if (s.mode === "mock" || requestedModel === "artemis-mock") return { kind: "mock" };
  const model = !requestedModel || requestedModel === "artemis" ? s.upstream.model : requestedModel;
  if (s.core?.probe?.compatible) return { kind: "core", baseUrl: `${s.core.probe.url}/v1`, apiKey: s.core.key, model };
  if (s.upstream.apiKey) return { kind: "upstream", baseUrl: s.upstream.baseUrl, apiKey: s.upstream.apiKey, model };
  return { kind: "none", reason: "No model provider configured. Set ARTEMIS_PROVIDER_KEY (or XAI_API_KEY / OPENAI_API_KEY), or run with ARTEMIS_PROVIDER=mock." };
}

export function providerFor(b: Backend): Provider {
  switch (b.kind) {
    case "mock": return new MockProvider();
    case "core": return new OpenAIProvider({ baseUrl: b.baseUrl, apiKey: b.apiKey ?? "", model: b.model, label: "artemis-core" });
    case "upstream": return new OpenAIProvider({ baseUrl: b.baseUrl, apiKey: b.apiKey, model: b.model, label: "upstream" });
    case "none": throw new Error(b.reason);
  }
}
