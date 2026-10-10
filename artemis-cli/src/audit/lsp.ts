/**
 * A TypeScript language server client.
 *
 * This buys what the compiler cannot: where a symbol is defined, who calls it,
 * what type an expression actually has. For an agent, "find every caller of
 * `authorize`" answered by the language server beats grepping for the string,
 * which also finds the comment, the test name and the unrelated method.
 *
 * It is NOT the type gate. `artemis check` stays on `tsc --noEmit`, because a gate
 * must fail loudly and a language server has too many ways to answer "nothing" —
 * see the diagnostics note below.
 *
 * Four things the naive client gets wrong, all fixed here:
 *
 *  1. `readexactly`, not `readexact`. The latter does not exist on a StreamReader
 *     and throws on the first response.
 *  2. Responses must be matched by id. LSP interleaves notifications — logs,
 *     progress, published diagnostics — so "read the next message" hands you a log
 *     line and every later read is off by one.
 *  3. Diagnostics are PUSHED by tsserver via textDocument/publishDiagnostics.
 *     Requesting textDocument/diagnostic from a server that does not advertise
 *     `diagnosticProvider` returns nothing, and broken code then reads as clean.
 *     This waits for the push and only uses pull when the server offers it.
 *  4. A file URI is percent-encoded. `file://` + a path with a space is not a URI.
 */
import { pathToFileURL, fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface LspDiagnostic {
  file: string;
  line: number;       // 1-based, as a human reads it
  column: number;
  severity: "error" | "warning" | "info" | "hint";
  code: string;
  message: string;
}

export interface Location {
  file: string;
  line: number;
  column: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const SEVERITY = ["error", "error", "warning", "info", "hint"] as const;

export class LspClient {
  readonly #root: string;
  readonly #command: string[];
  #proc: ReturnType<typeof Bun.spawn> | null = null;
  #nextId = 0;
  #pending = new Map<number, Pending>();
  #published = new Map<string, LspDiagnostic[]>();
  #pullCapable = false;
  #buffer = Buffer.alloc(0);
  #opened = new Set<string>();

  constructor(root: string, command = ["typescript-language-server", "--stdio"]) {
    this.#root = resolve(root);
    this.#command = command;
  }

  get available(): boolean { return this.#proc !== null; }
  get supportsPull(): boolean { return this.#pullCapable; }

  /** Returns false when no language server is installed, rather than throwing. */
  async start(timeoutMs = 15_000): Promise<boolean> {
    try {
      this.#proc = Bun.spawn(this.#command, {
        cwd: this.#root,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      });
    } catch {
      this.#proc = null;
      return false;
    }
    void this.#readLoop();
    try {
      const result = (await this.#request("initialize", {
        processId: process.pid,
        rootUri: pathToFileURL(this.#root).href,
        workspaceFolders: [{ uri: pathToFileURL(this.#root).href, name: "workspace" }],
        // Declaring real capabilities, because the server tailors its replies to
        // them: ask for nothing and you are entitled to nothing.
        capabilities: {
          textDocument: {
            synchronization: { dynamicRegistration: false },
            publishDiagnostics: { relatedInformation: false },
            diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
            definition: { linkSupport: false },
            references: {},
            hover: { contentFormat: ["plaintext"] },
          },
          workspace: { workspaceFolders: true },
        },
      }, timeoutMs)) as { capabilities?: { diagnosticProvider?: unknown } };
      this.#pullCapable = Boolean(result?.capabilities?.diagnosticProvider);
      this.#notify("initialized", {});
      return true;
    } catch {
      await this.stop();
      return false;
    }
  }

  async stop(): Promise<void> {
    for (const p of this.#pending.values()) { clearTimeout(p.timer); p.reject(new Error("client stopped")); }
    this.#pending.clear();
    this.#proc?.kill();
    this.#proc = null;
  }

  // ---------------------------------------------------------------- transport

  #send(payload: Record<string, unknown>): void {
    // `stdin: "pipe"` gives a FileSink; the number form only appears for an fd,
    // which this never asks for.
    const sink = this.#proc?.stdin;
    if (!sink || typeof sink === "number") throw new Error("language server is not running");
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    sink.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]));
    sink.flush();
  }

  #notify(method: string, params: unknown): void {
    this.#send({ jsonrpc: "2.0", method, params });
  }

  #request(method: string, params: unknown, timeoutMs = 10_000): Promise<unknown> {
    const id = ++this.#nextId;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.#pending.set(id, { resolve: resolvePromise, reject, timer });
      try { this.#send({ jsonrpc: "2.0", id, method, params }); }
      catch (e) { clearTimeout(timer); this.#pending.delete(id); reject(e as Error); }
    });
  }

  /** One reader for the whole stream, dispatching by id. Never "read the next message". */
  async #readLoop(): Promise<void> {
    const stdout = this.#proc?.stdout;
    if (!stdout) return;
    for await (const chunk of stdout as unknown as AsyncIterable<Uint8Array>) {
      this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
      for (;;) {
        const split = this.#buffer.indexOf("\r\n\r\n");
        if (split < 0) break;
        const header = this.#buffer.subarray(0, split).toString("ascii");
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        if (!match) { this.#buffer = this.#buffer.subarray(split + 4); continue; }
        const length = Number(match[1]);
        const start = split + 4;
        if (this.#buffer.length < start + length) break;   // body still arriving
        const body = this.#buffer.subarray(start, start + length).toString("utf8");
        this.#buffer = this.#buffer.subarray(start + length);
        try { this.#dispatch(JSON.parse(body)); } catch { /* a malformed frame is not fatal */ }
      }
    }
  }

  #dispatch(message: Record<string, unknown>): void {
    const id = message.id;
    // A response has an id and NO method. A server-to-client request has both, and
    // tsserver does send them (workspace/configuration). Matching on the id alone
    // resolves our pending request with the server's question - and an echo server
    // would "answer" every request with our own text.
    if (typeof id === "number" && message.method === undefined) {
      const pending = this.#pending.get(id);
      if (!pending) return;    // a response to a request we already timed out on
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    // A server request we do not implement still needs an answer, or the server
    // waits on it forever.
    if (typeof id === "number" && typeof message.method === "string") {
      try { this.#send({ jsonrpc: "2.0", id, result: null }); } catch { /* shutting down */ }
      return;
    }
    if (message.method === "textDocument/publishDiagnostics") {
      const params = message.params as { uri?: string; diagnostics?: unknown[] } | undefined;
      if (typeof params?.uri === "string") {
        this.#published.set(params.uri, (params.diagnostics ?? []).map((d) => this.#toDiagnostic(params.uri as string, d)));
      }
    }
  }

  #toDiagnostic(uri: string, raw: unknown): LspDiagnostic {
    const d = raw as { range?: { start?: { line?: number; character?: number } }; severity?: number; code?: unknown; message?: unknown };
    return {
      file: this.#relative(uri),
      line: (d.range?.start?.line ?? 0) + 1,       // LSP is 0-based; humans are not
      column: (d.range?.start?.character ?? 0) + 1,
      severity: SEVERITY[d.severity ?? 1] ?? "error",
      code: String(d.code ?? ""),
      message: typeof d.message === "string" ? d.message : "",
    };
  }

  #relative(uri: string): string {
    try {
      const abs = fileURLToPath(uri);
      return abs.startsWith(this.#root) ? abs.slice(this.#root.length + 1) : abs;
    } catch {
      return uri;
    }
  }

  // ---------------------------------------------------------------- documents

  #uri(file: string): string {
    return pathToFileURL(resolve(this.#root, file)).href;
  }

  /** Opening a file is what makes the server analyse it and publish its diagnostics. */
  open(file: string): void {
    const uri = this.#uri(file);
    if (this.#opened.has(uri)) return;
    let text = "";
    try { text = readFileSync(resolve(this.#root, file), "utf8"); } catch { return; }
    this.#opened.add(uri);
    this.#notify("textDocument/didOpen", {
      textDocument: { uri, languageId: file.endsWith("x") ? "typescriptreact" : "typescript", version: 1, text },
    });
  }

  /**
   * Diagnostics for one file.
   *
   * Pull when the server advertises it, otherwise open the file and wait for the
   * push. The wait is explicit: an empty result arriving instantly, before the
   * server has analysed anything, is the failure mode that makes broken code look
   * clean.
   */
  async diagnostics(file: string, waitMs = 4000): Promise<LspDiagnostic[] | null> {
    if (!this.#proc) return null;
    const uri = this.#uri(file);
    this.open(file);

    if (this.#pullCapable) {
      try {
        const result = (await this.#request("textDocument/diagnostic", { textDocument: { uri } })) as { items?: unknown[] };
        if (Array.isArray(result?.items)) return result.items.map((d) => this.#toDiagnostic(uri, d));
      } catch { /* fall through to the push path */ }
    }

    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const published = this.#published.get(uri);
      if (published) return published;
      await new Promise((r) => setTimeout(r, 50));
    }
    // Never return [] here. "The server did not answer in time" and "this file is
    // clean" are different facts, and conflating them is how a gate goes blind.
    return null;
  }

  async definition(file: string, line: number, column: number): Promise<Location[]> {
    if (!this.#proc) return [];
    this.open(file);
    const result = await this.#request("textDocument/definition", {
      textDocument: { uri: this.#uri(file) },
      position: { line: line - 1, character: column - 1 },
    }).catch(() => null);
    return this.#locations(result);
  }

  async references(file: string, line: number, column: number): Promise<Location[]> {
    if (!this.#proc) return [];
    this.open(file);
    const result = await this.#request("textDocument/references", {
      textDocument: { uri: this.#uri(file) },
      position: { line: line - 1, character: column - 1 },
      context: { includeDeclaration: false },
    }).catch(() => null);
    return this.#locations(result);
  }

  async hover(file: string, line: number, column: number): Promise<string | null> {
    if (!this.#proc) return null;
    this.open(file);
    const result = (await this.#request("textDocument/hover", {
      textDocument: { uri: this.#uri(file) },
      position: { line: line - 1, character: column - 1 },
    }).catch(() => null)) as { contents?: unknown } | null;
    if (!result?.contents) return null;
    const c = result.contents as { value?: unknown } | { value?: unknown }[] | string;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.map((x) => (typeof x?.value === "string" ? x.value : "")).filter(Boolean).join("\n") || null;
    return typeof c.value === "string" ? c.value : null;
  }

  #locations(result: unknown): Location[] {
    const list = Array.isArray(result) ? result : result ? [result] : [];
    return list.map((raw) => {
      const l = raw as { uri?: string; targetUri?: string; range?: { start?: { line?: number; character?: number } }; targetRange?: { start?: { line?: number; character?: number } } };
      const uri = l.uri ?? l.targetUri ?? "";
      const start = (l.range ?? l.targetRange)?.start;
      return { file: this.#relative(uri), line: (start?.line ?? 0) + 1, column: (start?.character ?? 0) + 1 };
    }).filter((l) => l.file);
  }
}
