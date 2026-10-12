import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockProvider } from "./agent/mock.ts";
import { OpenAIProvider } from "./agent/openai.ts";
import type { Provider } from "./agent/types.ts";

/**
 * Where the CLI talks to Artemis when nothing else is configured.
 *
 * This used to be http://127.0.0.1:7777, which only works for someone running
 * `artemis serve` on the same machine — so the out-of-the-box experience was a
 * connection refused. The hosted gateway is the right default; a local server
 * is the special case and is selected with --url, ARTEMIS_URL, or a saved
 * login in ~/.artemis/config.json.
 *
 * Verified against the live host: GET /v1/models returns the artemis model,
 * and POST /v1/chat/completions returns 401 without a Bearer art_ key, which
 * is the route the provider uses.
 */
export const DEFAULT_SERVER_URL = "https://api.artemisai-bycutlineindustries.studio";

/** A local `artemis serve`, for convenience in docs and examples. */
export const LOCAL_SERVER_URL = "http://127.0.0.1:7777";

/**
 * Upstream third-party provider, reached ONLY via an explicit `--direct` plus
 * an explicit provider key. Never the default path: Blueprint Decisions 5 and
 * 12 keep external models out of Artemis's own work, and `--direct` is an
 * escape hatch for debugging, not a fallback.
 */
export const DEFAULT_PROVIDER_BASE_URL = "https://api.x.ai/v1";

export interface StoredConfig {
  url?: string;
  apiKey?: string;
  model?: string;
}

export function artemisHome(): string {
  return process.env.ARTEMIS_HOME || path.join(os.homedir(), ".artemis");
}
export function configPath(): string {
  return path.join(artemisHome(), "config.json");
}

export function loadConfig(): StoredConfig {
  try {
    return JSON.parse(readFileSync(configPath(), "utf8"));
  } catch {
    return {};
  }
}

export function saveConfig(cfg: StoredConfig): string {
  const dir = artemisHome();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = configPath();
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(p, 0o600); } catch {}
  return p;
}

export function configExists(): boolean {
  return existsSync(configPath());
}

/** Upstream model provider settings (used by `--direct` and by the server). */
export function upstreamFromEnv(env = process.env): { baseUrl: string; apiKey?: string; model: string; keySource?: string } {
  const candidates: [string, string | undefined][] = [
    ["ARTEMIS_PROVIDER_KEY", env.ARTEMIS_PROVIDER_KEY],
    ["XAI_API_KEY", env.XAI_API_KEY],
    ["OPENAI_API_KEY", env.OPENAI_API_KEY],
  ];
  const found = candidates.find(([, v]) => v && v.trim());
  const keySource = found?.[0];
  let baseUrl = env.ARTEMIS_PROVIDER_BASE_URL || "";
  if (!baseUrl) baseUrl = keySource === "OPENAI_API_KEY" ? "https://api.openai.com/v1" : DEFAULT_PROVIDER_BASE_URL;
  const model = env.ARTEMIS_PROVIDER_MODEL || (baseUrl.includes("openai.com") ? "gpt-4o-mini" : "grok-4-fast-non-reasoning");
  return { baseUrl, apiKey: found?.[1], model, keySource };
}

export type Connection = "server" | "direct" | "mock";

export interface ResolveOpts {
  mock?: boolean;
  direct?: boolean;
  model?: string;
  url?: string;
}

/** Pick the provider for the CLI: --mock (offline), --direct (upstream), or the Artemis server (default). */
export function resolveProvider(o: ResolveOpts, env = process.env): { provider: Provider; connection: Connection; target: string } {
  if (o.mock) return { provider: new MockProvider(), connection: "mock", target: "offline" };
  if (o.direct) {
    const up = upstreamFromEnv(env);
    if (!up.apiKey) throw new Error("--direct needs a provider key: set ARTEMIS_PROVIDER_KEY (or XAI_API_KEY / OPENAI_API_KEY).");
    return {
      provider: new OpenAIProvider({ baseUrl: up.baseUrl, apiKey: up.apiKey, model: o.model || up.model, label: "direct" }),
      connection: "direct",
      target: up.baseUrl,
    };
  }
  const cfg = loadConfig();
  const url = (o.url || env.ARTEMIS_URL || cfg.url || DEFAULT_SERVER_URL).replace(/\/$/, "");
  const apiKey = env.ARTEMIS_API_KEY || cfg.apiKey;
  if (!apiKey) throw new Error(`Not logged in. Run \`artemis login\` (or set ARTEMIS_API_KEY), use --mock for an offline demo, or --direct to call a model provider directly.`);
  return {
    provider: new OpenAIProvider({ baseUrl: `${url}/v1`, apiKey, model: o.model || env.ARTEMIS_MODEL || cfg.model || "artemis", label: "artemis" }),
    connection: "server",
    target: url,
  };
}
