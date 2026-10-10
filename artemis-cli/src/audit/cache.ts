/**
 * Remembering which files have already been audited clean.
 *
 * A content hash, not an AST hash: hashing the bytes is what actually tells you the
 * file changed, and calling it "structural" would promise that a reformat is free
 * when it is not.
 *
 * The cache key folds in a RULES_VERSION. Without that, changing what the audit
 * checks for leaves every previously-clean file permanently exempt from the new
 * rule — the cache would quietly disable the thing it is meant to speed up. Bump
 * RULES_VERSION whenever the checks change and the whole cache invalidates.
 *
 * A failing verdict is cached too. Re-running a check that is going to fail the
 * same way wastes exactly as much time as re-running one that passes.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Bump when the meaning of a clean verdict changes. */
export const RULES_VERSION = 1;

export interface CacheEntry {
  /** sha256 of the file's bytes, with the rules version folded in. */
  fingerprint: string;
  clean: boolean;
  /** Short reason kept so a cached failure can be reported, not just re-run. */
  detail?: string;
  at: number;
}

export interface CacheFile {
  version: number;
  entries: Record<string, CacheEntry>;
}

export function fingerprint(contents: Buffer | string, rules = RULES_VERSION): string {
  return createHash("sha256")
    .update(`artemis-audit/v${rules}\n`)
    .update(contents)
    .digest("hex");
}

export class AuditCache {
  readonly #path: string;
  #file: CacheFile;

  constructor(root: string, path = join(root, ".artemis", "audit-cache.json")) {
    this.#path = path;
    this.#file = { version: RULES_VERSION, entries: {} };
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (parsed && typeof parsed === "object") {
        const file = parsed as Partial<CacheFile>;
        // A cache written under different rules says nothing about the current ones.
        if (file.version === RULES_VERSION && file.entries && typeof file.entries === "object") {
          this.#file = { version: RULES_VERSION, entries: file.entries };
        }
      }
    } catch {
      // absent or unreadable: start empty rather than fail the run
    }
  }

  get path(): string { return this.#path; }
  get size(): number { return Object.keys(this.#file.entries).length; }

  /** The remembered verdict for this exact content, or null when it must be checked. */
  lookup(relative: string, contents: Buffer | string): CacheEntry | null {
    const entry = this.#file.entries[relative];
    if (!entry) return null;
    return entry.fingerprint === fingerprint(contents) ? entry : null;
  }

  record(relative: string, contents: Buffer | string, clean: boolean, detail?: string): void {
    this.#file.entries[relative] = {
      fingerprint: fingerprint(contents),
      clean,
      ...(detail ? { detail } : {}),
      at: Date.now(),
    };
  }

  /** Drops entries for files that are no longer present, so the file cannot grow forever. */
  prune(present: Iterable<string>): void {
    const keep = new Set(present);
    for (const key of Object.keys(this.#file.entries)) if (!keep.has(key)) delete this.#file.entries[key];
  }

  save(): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    writeFileSync(this.#path, JSON.stringify(this.#file, null, 2) + "\n");
  }
}
