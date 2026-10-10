import path from "node:path";
import { upstreamFromEnv, artemisHome } from "../src/config.ts";
import { countKeys, createKey } from "./auth.ts";
import { createServer, VERSION, type ServerConfig } from "./app.ts";
import { probeCore } from "./providers.ts";

export function configFromEnv(env = process.env): ServerConfig {
  const dataDir = env.ARTEMIS_DATA_DIR || path.join(artemisHome(), "server");
  const up = upstreamFromEnv(env);
  const coreUrl = env.ARTEMIS_CORE_URL?.trim();
  return {
    dbPath: env.ARTEMIS_DB || path.join(dataDir, "artemis.db"),
    dataDir,
    providers: {
      mode: env.ARTEMIS_PROVIDER === "mock" ? "mock" : "upstream",
      upstream: { baseUrl: up.baseUrl, apiKey: up.apiKey, model: up.model },
      ...(coreUrl ? { core: { url: coreUrl, key: env.ARTEMIS_CORE_KEY } } : {}),
    },
    workspacesRoot: path.resolve(env.ARTEMIS_WORKSPACES_ROOT || process.cwd()),
    allowRepoClone: env.ARTEMIS_ALLOW_CLONE === "1",
    rateLimitPerMin: Number(env.ARTEMIS_RATE_LIMIT) || 120,
    webhook: { maxAttempts: Number(env.ARTEMIS_WEBHOOK_ATTEMPTS) || 5, retryBaseMs: Number(env.ARTEMIS_WEBHOOK_RETRY_MS) || 2000 },
    publicUrl: env.ARTEMIS_PUBLIC_URL,
  };
}

export async function startServer(opts: { port?: number; hostname?: string; config?: ServerConfig; quiet?: boolean } = {}) {
  const cfg = opts.config ?? configFromEnv();
  const s = createServer(cfg);
  let bootstrapKey: string | undefined;
  if (countKeys(s.db) === 0) {
    const preset = process.env.ARTEMIS_BOOTSTRAP_KEY;
    bootstrapKey = createKey(s.db, "bootstrap-admin", ["admin"], preset || undefined).key;
  }
  if (cfg.providers.core) cfg.providers.core.probe = await probeCore(cfg.providers.core.url, cfg.providers.core.key, 4000);
  const server = Bun.serve({ port: opts.port ?? 7777, hostname: opts.hostname ?? "127.0.0.1", fetch: s.app.fetch, idleTimeout: 0 });
  const url = `http://${server.hostname}:${server.port}`;
  if (!cfg.publicUrl) cfg.publicUrl = url;
  if (!opts.quiet) {
    const log = (k: string, v: string) => console.log(`  \x1b[38;2;138;148;166m${k.padEnd(10)}\x1b[0m ${v}`);
    console.log(`\x1b[38;2;76;141;255m◆ ARTEMIS\x1b[0m API server v${VERSION}`);
    log("url", url);
    log("docs", `${url}/docs`);
    log("database", cfg.dbPath);
    log("workspaces", cfg.workspacesRoot);
    const be = cfg.providers.mode === "mock" ? "mock (offline)" : cfg.providers.upstream.apiKey ? `${cfg.providers.upstream.baseUrl} · ${cfg.providers.upstream.model}` : "none configured (only model=artemis-mock works)";
    log("model", be);
    if (cfg.providers.core?.probe) log("core", `${cfg.providers.core.url} → ${cfg.providers.core.probe.compatible ? "compatible, used for chat" : `not used (${cfg.providers.core.probe.detail})`}`);
    if (bootstrapKey && !process.env.ARTEMIS_BOOTSTRAP_KEY) {
      console.log(`\n  \x1b[38;2;240;138;60mFirst run: created an admin API key (shown once, stored hashed):\x1b[0m\n  ${bootstrapKey}\n  Log the CLI in with:  artemis login --url ${url} --key ${bootstrapKey}\n`);
    }
  }
  return { ...s, server, url, bootstrapKey, stop: () => server.stop(true) };
}

if (import.meta.main) {
  await startServer({ port: Number(process.env.PORT) || 7777, hostname: process.env.HOST || "127.0.0.1" });
}
