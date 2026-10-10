/**
 * The pre-commit hook.
 *
 * Installed only when asked. A package `postinstall` that silently rewrites
 * `.git/hooks/pre-commit` is how a tool destroys someone's existing hook — their
 * secret scanner, their formatter, their lint-staged setup — without ever telling
 * them. This refuses to overwrite a hook it did not write, and `--force` moves the
 * existing one aside rather than deleting it.
 */
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MARKER = "# artemis-cli pre-commit gate";

export const HOOK = `#!/bin/sh
${MARKER}
# Blocks a commit whose staged TypeScript does not type-check.
# Remove this file, or run \`artemis hook --uninstall\`, to stop that.

if ! command -v artemis >/dev/null 2>&1; then
  echo "artemis not on PATH; skipping the type gate" >&2
  exit 0
fi

artemis check --staged-only || exit 1
exit 0
`;

export type InstallOutcome =
  | { status: "installed"; path: string }
  | { status: "updated"; path: string }
  | { status: "replaced"; path: string; backup: string }
  | { status: "exists"; path: string; reason: string }
  | { status: "unavailable"; reason: string };

export function hookPath(root: string): string {
  return join(root, ".git", "hooks", "pre-commit");
}

export function installHook(root: string, force = false): InstallOutcome {
  const hooks = join(root, ".git", "hooks");
  if (!existsSync(hooks)) return { status: "unavailable", reason: "no .git/hooks directory; not a git repository" };

  const path = hookPath(root);
  if (existsSync(path)) {
    const current = readFileSync(path, "utf8");
    if (current.includes(MARKER)) {
      writeFileSync(path, HOOK, { mode: 0o755 });
      chmodSync(path, 0o755);
      return { status: "updated", path };
    }
    if (!force) {
      return {
        status: "exists",
        path,
        reason: "a pre-commit hook is already installed and was not written by artemis; re-run with --force to move it aside",
      };
    }
    const backup = `${path}.before-artemis`;
    copyFileSync(path, backup);
    writeFileSync(path, HOOK, { mode: 0o755 });
    chmodSync(path, 0o755);
    return { status: "replaced", path, backup };
  }
  writeFileSync(path, HOOK, { mode: 0o755 });
  chmodSync(path, 0o755);
  return { status: "installed", path };
}

export function uninstallHook(root: string): { removed: boolean; reason?: string } {
  const path = hookPath(root);
  if (!existsSync(path)) return { removed: false, reason: "no pre-commit hook installed" };
  if (!readFileSync(path, "utf8").includes(MARKER)) {
    return { removed: false, reason: "the pre-commit hook was not written by artemis; leaving it alone" };
  }
  // Emptied rather than deleted: a git hook directory entry someone else manages
  // may be symlinked or templated, and unlinking it is the more surprising move.
  writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return { removed: true };
}
