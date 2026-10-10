import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

/** Real path of the deepest existing ancestor of `p` (resolves symlinks). */
function realExisting(p: string): string {
  let cur = p;
  const rest: string[] = [];
  while (!existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
  const real = existsSync(cur) ? realpathSync(cur) : cur;
  return path.join(real, ...rest);
}

/**
 * Resolve a user/model supplied path against the project root and refuse
 * anything that escapes it (../, absolute paths elsewhere, symlinks out).
 */
export function resolveInRoot(root: string, p: string): string {
  if (typeof p !== "string" || p.length === 0) p = ".";
  if (p.includes("\0")) throw new SandboxError("Path contains a NUL byte");
  const realRoot = realExisting(path.resolve(root));
  const abs = realExisting(path.resolve(realRoot, p));
  const rel = path.relative(realRoot, abs);
  if (rel === "") return abs;
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new SandboxError(`Path "${p}" is outside the project root (${realRoot})`);
  }
  return abs;
}

export function relToRoot(root: string, abs: string): string {
  const realRoot = realExisting(path.resolve(root));
  return path.relative(realRoot, abs) || ".";
}
