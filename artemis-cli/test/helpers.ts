import { expect } from "bun:test";
import type { MockScript } from "../src/agent/mock.ts";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function makeFixture(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "artemis-fx-"));
  const w = (p: string, s: string) => { mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); writeFileSync(path.join(dir, p), s); };
  w("package.json", JSON.stringify({ name: "fixture", version: "1.0.0" }, null, 2));
  w("src/math.ts", "export function add(a: number, b: number) {\n  return a - b; // BUG\n}\n\nexport function mul(a: number, b: number) {\n  return a * b;\n}\n");
  w("src/index.ts", 'import { add } from "./math";\nconsole.log(add(2, 3));\n');
  w("src/util/strings.ts", "export const shout = (s: string) => s.toUpperCase();\n// TODO: add whisper\n");
  w("README.md", "# Fixture\nTODO: docs\n");
  w("node_modules/dep/index.js", "export function add() {}\n");
  return dir;
}

export async function waitFor(fn: () => boolean, timeoutMs = 5000, stepMs = 20): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor timed out");
    await Bun.sleep(stepMs);
  }
}

/** glob → grep → read → edit → done, each step using the previous result. */
export const FIX_BUG_SCRIPT: MockScript = [
  () => ({ content: "Mapping the project.", calls: [{ name: "glob", args: { pattern: "src/**/*.ts" } }] }),
  (ctx) => {
    expect(ctx.results.at(-1)!.content).toContain("src/math.ts");
    return { calls: [{ name: "grep", args: { pattern: "BUG", path: "src" } }] };
  },
  (ctx) => {
    const file = ctx.results.at(-1)!.content.split(":")[0]!;
    return { calls: [{ name: "read_file", args: { path: file, start_line: 1, end_line: 3 } }] };
  },
  (ctx) => {
    expect(ctx.results.at(-1)!.content).toContain("return a - b");
    return { content: "Fixing the subtraction.", calls: [{ name: "edit_file", args: { path: "src/math.ts", old_string: "return a - b; // BUG", new_string: "return a + b;" } }] };
  },
  (ctx) => ({ calls: [{ name: "done", args: { summary: `Fixed add(): ${ctx.results.at(-1)!.content}` } }] }),
];


import type { ServerConfig } from "../server/app.ts";

export function testServerConfig(workspacesRoot: string, overrides: Partial<ServerConfig> = {}): ServerConfig {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "artemis-srv-"));
  return {
    dbPath: path.join(dataDir, "artemis.db"),
    dataDir,
    providers: { mode: "mock", upstream: { baseUrl: "http://127.0.0.1:9/v1", model: "none" } },
    workspacesRoot,
    allowRepoClone: false,
    rateLimitPerMin: 1000,
    webhook: { maxAttempts: 3, retryBaseMs: 20 },
    ...overrides,
  };
}

/** Collect SSE events from a fetch Response until `end`. */
export async function readSse(res: Response): Promise<{ event: string; data: any; id?: string }[]> {
  const out: { event: string; data: any; id?: string }[] = [];
  const text = await res.text();
  for (const block of text.split(/\n\n/)) {
    let event = "message", id: string | undefined;
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trim());
      else if (line.startsWith("id:")) id = line.slice(3).trim();
    }
    if (data.length) out.push({ event, id, data: data[0] === "[DONE]" ? "[DONE]" : JSON.parse(data.join("\n")) });
  }
  return out;
}
