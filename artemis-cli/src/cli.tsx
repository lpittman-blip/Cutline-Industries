#!/usr/bin/env bun
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { render } from "ink";
import { configPath, DEFAULT_SERVER_URL, loadConfig, resolveProvider, saveConfig } from "./config.ts";
import { probeServer, serverLabel } from "./serverprobe.ts";
import type { Mode } from "./agent/types.ts";
import { runPrint } from "./print.ts";
import { App } from "./ui/App.tsx";

const VERSION = "1.0.0";

const HELP = `◆ ARTEMIS CLI v${VERSION} — autonomous coding agent by Artemis AI

Usage
  artemis                       interactive REPL
  artemis "task"                one-shot: run the task in the TUI, then exit
  artemis -p "task"             --print: plain-text, non-interactive output
  artemis login [--url U] [--key K]   save your Artemis API key to ~/.artemis/config.json
  artemis logout                remove the saved key
  artemis status                check the Artemis server and your key
  artemis gpu [--url U]         the inference server behind the terminal, and its GPU
  artemis serve [--port 7777] [--host 127.0.0.1] [--mock]   run the Artemis API server

Options
  -y, --yes, --auto      don't ask before write_file / edit_file / run_shell
  -r, --read-only        disable write_file, edit_file and run_shell
  -p, --print            non-interactive output (approvals are denied unless --yes)
      --json             with --print: one JSON event per line
      --mock             offline scripted model (no server, no key)
      --direct           call the model provider directly (ARTEMIS_PROVIDER_KEY / XAI_API_KEY / OPENAI_API_KEY)
      --url URL          Artemis server (default: saved login, ARTEMIS_URL, or ${DEFAULT_SERVER_URL})
  -m, --model NAME       model (default "artemis" = server's configured model; "artemis-mock" = server mock)
  -C, --cwd DIR          project root / sandbox (default: current directory)
      --max-steps N      step cap per task (default 25)
      --token-budget N   stop a task after N prompt+completion tokens (default 200000)
  -h, --help, -v, --version`;

interface Flags {
  yes: boolean; readOnly: boolean; print: boolean; json: boolean; mock: boolean; direct: boolean;
  url?: string; key?: string; model?: string; cwd?: string; maxSteps?: number; tokenBudget?: number; port?: number; host?: string;
  help: boolean; version: boolean; positional: string[];
}

export function parseArgs(argv: string[]): Flags {
  const f: Flags = { yes: false, readOnly: false, print: false, json: false, mock: false, direct: false, help: false, version: false, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const val = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    switch (a) {
      case "-y": case "--yes": case "--auto": f.yes = true; break;
      case "-r": case "--read-only": f.readOnly = true; break;
      case "-p": case "--print": f.print = true; break;
      case "--json": f.json = true; break;
      case "--mock": f.mock = true; break;
      case "--direct": f.direct = true; break;
      case "--url": f.url = val(); break;
      case "--key": f.key = val(); break;
      case "-m": case "--model": f.model = val(); break;
      case "-C": case "--cwd": f.cwd = val(); break;
      case "--max-steps": f.maxSteps = Number(val()); break;
      case "--token-budget": f.tokenBudget = Number(val()); break;
      case "--port": f.port = Number(val()); break;
      case "--host": f.host = val(); break;
      case "-h": case "--help": f.help = true; break;
      case "-v": case "--version": f.version = true; break;
      case "--": f.positional.push(...argv.slice(i + 1)); i = argv.length; break;
      default:
        if (a.startsWith("-") && a.length > 1) throw new Error(`Unknown option ${a}. See artemis --help.`);
        f.positional.push(a);
    }
  }
  return f;
}

async function ask(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(q);
  rl.close();
  return a.trim();
}

async function checkServer(url: string, key: string): Promise<any> {
  const res = await fetch(`${url.replace(/\/$/, "")}/v1/status`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error?.message ?? `HTTP ${res.status}`);
  return j;
}

async function main() {
  let f: Flags;
  try { f = parseArgs(process.argv.slice(2)); } catch (e) { console.error((e as Error).message); process.exit(2); }
  if (f.help) { console.log(HELP); return; }
  if (f.version) { console.log(VERSION); return; }
  const sub = f.positional[0];

  if (sub === "serve") {
    if (f.mock) process.env.ARTEMIS_PROVIDER = "mock";
    if (f.cwd) process.env.ARTEMIS_WORKSPACES_ROOT = path.resolve(f.cwd);
    const { startServer } = await import("../server/index.ts");
    await startServer({ port: f.port ?? (Number(process.env.PORT) || 7777), hostname: f.host ?? process.env.HOST ?? "127.0.0.1" });
    return;
  }
  if (sub === "login") {
    const cfg = loadConfig();
    const url = (f.url || process.env.ARTEMIS_URL || cfg.url || DEFAULT_SERVER_URL).replace(/\/$/, "");
    const key = f.key || process.env.ARTEMIS_API_KEY || (process.stdin.isTTY ? await ask(`Artemis API key for ${url}: `) : "");
    if (!key) { console.error("No key given. Use --key art_... or run interactively."); process.exit(2); }
    try {
      const st = await checkServer(url, key);
      const p = saveConfig({ ...cfg, url, apiKey: key });
      console.log(`✓ Logged in to ${url} as key "${st.key?.name}" (${st.key?.scopes?.join(", ")}). Saved to ${p}`);
    } catch (e) {
      console.error(`✗ Login failed: ${(e as Error).message}`);
      process.exit(1);
    }
    return;
  }
  if (sub === "logout") {
    const cfg = loadConfig();
    delete cfg.apiKey;
    saveConfig(cfg);
    console.log(`Removed the saved key from ${configPath()}.`);
    return;
  }
  if (sub === "status") {
    const cfg = loadConfig();
    const url = f.url || process.env.ARTEMIS_URL || cfg.url || DEFAULT_SERVER_URL;
    const key = process.env.ARTEMIS_API_KEY || cfg.apiKey;
    if (!key) { console.error("Not logged in. Run `artemis login`."); process.exit(1); }
    try { console.log(JSON.stringify(await checkServer(url, key), null, 2)); } catch (e) { console.error(`✗ ${url}: ${(e as Error).message}`); process.exit(1); }
    return;
  }

  if (sub === "gpu") {
    // Points at whatever the terminal is configured for: the Artemis server, vLLM on
    // a GPU host, or LM Studio. Reports only what the server published; a server that
    // does not expose GPU figures is said to not expose them, never shown at 0%.
    const cfg = loadConfig();
    const url = (f.url || process.env.ARTEMIS_URL || cfg.url || DEFAULT_SERVER_URL).replace(/\/$/, "");
    const key = process.env.ARTEMIS_API_KEY || cfg.apiKey;
    const r = await probeServer(url, key);
    if (f.json) { console.log(JSON.stringify({ server: url, ...r }, null, 2)); process.exit(r.reachable ? 0 : 1); }
    console.log(`server     ${serverLabel(url)}`);
    console.log(`reachable  ${r.reachable ? "yes" : `no${r.detail ? ` (${r.detail})` : ""}`}`);
    if (!r.reachable) {
      console.error("\nPoint the terminal elsewhere with --url, or `artemis login --url <url>`.");
      console.error("A vLLM server on a GPU host and LM Studio on this machine both answer this.");
      process.exit(1);
    }
    console.log(`model      ${r.model || "none loaded"}`);
    if (r.gpuCache === null) {
      console.log("gpu        not reported by this server");
      console.error("\nGPU figures come from a vLLM /metrics endpoint. The Artemis server and LM");
      console.error("Studio do not publish one, so there is nothing to read here.");
    } else {
      console.log(`kv cache   ${Math.round(r.gpuCache * 100)}%`);
      if (r.running !== null) console.log(`running    ${r.running}`);
      if (r.queued !== null) console.log(`queued     ${r.queued}`);
    }
    return;
  }

  const root = path.resolve(f.cwd ?? process.cwd());
  const mode: Mode = f.readOnly ? "read_only" : f.yes ? "auto" : "confirm";
  const maxSteps = f.maxSteps && f.maxSteps > 0 ? Math.min(f.maxSteps, 200) : Number(process.env.ARTEMIS_MAX_STEPS) || 25;
  let resolved;
  try { resolved = resolveProvider({ mock: f.mock, direct: f.direct, model: f.model, url: f.url }); }
  catch (e) { console.error(`✗ ${(e as Error).message}`); process.exit(2); }
  const tokenBudget = f.tokenBudget && f.tokenBudget > 0 ? f.tokenBudget : Number(process.env.ARTEMIS_TOKEN_BUDGET) || undefined;
  const task = f.positional.join(" ").trim();

  if (f.print || !process.stdin.isTTY) {
    if (!task) { console.error("--print needs a task, e.g. artemis -p \"find the auth middleware\""); process.exit(2); }
    const res = await runPrint({ provider: resolved.provider, root, mode, maxSteps, task, json: f.json, tokenBudget, connection: resolved.connection, target: resolved.target });
    process.exit(res.status === "done" ? 0 : 1);
  }

  let status = "done";
  const app = render(
    <App provider={resolved.provider} connection={resolved.connection} target={resolved.target} root={root} mode={mode} maxSteps={maxSteps} tokenBudget={tokenBudget} initialTask={task || undefined} exitOnDone={Boolean(task)} onExit={(s) => (status = s)} />,
    { exitOnCtrlC: false }, // Ctrl+C aborts a running task; when idle it quits (handled in App)
  );
  await app.waitUntilExit();
  process.exit(status === "done" || status === "exit" ? 0 : 1);
}

if (import.meta.main) await main();
