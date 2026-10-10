/**
 * Rules that do not need a model.
 *
 * The blueprint sends every proposed action to an LLM for judgement. Most of the
 * dangerous ones are decidable by inspection: `rm -rf /`, a piped installer, `npm
 * install` in a Bun repo. Deciding those with a regex is free, instant, and cannot
 * be talked out of its answer by a persuasive diff — which is the whole problem with
 * asking a model to police another model.
 *
 * So: deterministic rules first, model second, and only for the judgement calls.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

export type RuleId =
  | "DESTRUCTIVE_SHELL"
  | "DEPENDENCY_DRIFT"
  | "STATE_INVERSION"
  | "TYPESCRIPT_VIOLATION"
  | "SECRET_EXPOSURE"
  /** Judgement only - no deterministic rule produces this; the model may. */
  | "CLEAN_CODE";

export interface RuleHit {
  rule: RuleId;
  critique: string;
  /** True when no model should be allowed to argue the action through. */
  hard: boolean;
}

const DESTRUCTIVE: [RegExp, string][] = [
  [/\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*[rR])\s+\/(?:\s|$)/, "recursive delete of the filesystem root"],
  [/\brm\s+-[a-zA-Z]*[rR]/, "recursive delete"],
  [/\bgit\s+reset\s+--hard\b/, "git reset --hard discards uncommitted work irrecoverably"],
  [/\bgit\s+clean\s+-[a-zA-Z]*[dfx]/, "git clean deletes untracked files, which are not recoverable from git"],
  [/\bgit\s+push\s+.*--force(?!-with-lease)/, "force push without --force-with-lease can erase someone else's commits"],
  [/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/, "piping a downloaded script straight into a shell"],
  [/\bchmod\s+(-[a-zA-Z]+\s+)*777\b/, "world-writable permissions"],
  [/\b(mkfs|dd\s+if=|shutdown|reboot|halt)\b/, "destructive system command"],
  [/>\s*\/dev\/sd[a-z]/, "writing directly to a block device"],
];

const SECRETS: [RegExp, string][] = [
  [/\b(xai-[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/, "a live API key appears in the payload"],
  [/-----BEGIN\s+(RSA|OPENSSH|EC|PGP)\s+PRIVATE KEY-----/, "a private key appears in the payload"],
];

const VECTOR_DB = /\b(chromadb|pinecone|weaviate|qdrant|faiss|langchain|llama[-_]?index|pgvector|@?xenova\/transformers)\b/i;

/** Which package manager the project actually uses, read from its lockfile. */
export function packageManager(root: string): "bun" | "npm" | "pnpm" | "yarn" | null {
  if (existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"))) return "bun";
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (existsSync(join(root, "package-lock.json"))) return "npm";
  return null;
}

/** Inspects a shell command. Returns every rule it trips. */
export function checkShell(command: string, root: string): RuleHit[] {
  const hits: RuleHit[] = [];
  for (const [pattern, why] of DESTRUCTIVE) {
    if (pattern.test(command)) { hits.push({ rule: "DESTRUCTIVE_SHELL", critique: why, hard: true }); break; }
  }
  for (const [pattern, why] of SECRETS) {
    if (pattern.test(command)) { hits.push({ rule: "SECRET_EXPOSURE", critique: why, hard: true }); break; }
  }

  // Using the wrong package manager writes a second lockfile, which is how two
  // developers end up resolving different dependency trees from the same repo.
  const pm = packageManager(root);
  if (pm) {
    const used = /\b(npm|pnpm|yarn|bun)\s+(install|add|i)\b/.exec(command);
    if (used && used[1] !== pm) {
      hits.push({
        rule: "DEPENDENCY_DRIFT",
        critique: `this project uses ${pm}; \`${used[1]} ${used[2]}\` writes a competing lockfile. Use \`${pm} add\`.`,
        hard: true,
      });
    }
  }
  if (VECTOR_DB.test(command)) {
    hits.push({
      rule: "STATE_INVERSION",
      critique: "Artemis retrieves context with glob and grep by design; a vector store adds an index to build and invalidate.",
      hard: false,
    });
  }
  return hits;
}

/** Inspects file content about to be written. */
export function checkContent(path: string, contents: string): RuleHit[] {
  const hits: RuleHit[] = [];
  for (const [pattern, why] of SECRETS) {
    if (pattern.test(contents)) { hits.push({ rule: "SECRET_EXPOSURE", critique: why, hard: true }); break; }
  }
  if (VECTOR_DB.test(contents)) {
    hits.push({
      rule: "STATE_INVERSION",
      critique: "a vector store or RAG dependency is being introduced; retrieval here is glob and grep.",
      hard: false,
    });
  }
  if (/\.(ts|tsx|mts|cts)$/.test(path)) {
    // `as any` and `: any` defeat the checker the whole pre-flight gate relies on.
    const anys = contents.match(/(:\s*any\b|\bas\s+any\b)/g);
    if (anys && anys.length > 0) {
      hits.push({
        rule: "TYPESCRIPT_VIOLATION",
        critique: `${anys.length} use(s) of \`any\`, which switches off the type checking this gate depends on.`,
        hard: false,
      });
    }
    if (/@ts-(ignore|nocheck)\b/.test(contents)) {
      hits.push({ rule: "TYPESCRIPT_VIOLATION", critique: "@ts-ignore / @ts-nocheck suppresses the compiler rather than fixing the error.", hard: false });
    }
  }
  return hits;
}
