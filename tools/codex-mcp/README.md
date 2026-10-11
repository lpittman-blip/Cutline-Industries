# Codex MCP

Drive the OpenAI Codex CLI from an MCP client — Claude Code, Cursor, anything
that speaks stdio MCP. Three tools: `codex_status`, `codex_ask`, `codex_review`.

## Why a wrapper and not Codex's own MCP mode

Codex CLI **0.162.1 has no "serve as MCP" mode.** Verified against the installed
binary, not documentation:

- `codex mcp` **manages MCP servers Codex consumes** — `add`, `remove`, `list`,
  `get`, `login`, `logout`. It is the opposite direction.
- `codex app-server` speaks its own JSON-RPC protocol with its own TypeScript
  bindings and JSON Schema generators. Not MCP.
- There is no `codex mcp-server` and no `codex mcp serve`. Blog posts describing
  one are stale.

`codex exec` is the supported non-interactive entry point, so this wraps that.
If a future release adds a real MCP mode, delete this and use it.

## Setup

```bash
npm install -g @openai/codex          # the CLI itself
cd tools/codex-mcp && npm install     # this wrapper's two deps
codex login                           # ChatGPT account, opens a browser
```

If you prefer an API key over a ChatGPT login, Codex reads it from **stdin**:

```bash
printenv OPENAI_API_KEY | codex login --with-api-key
```

Never paste a key into a chat message, a tool argument, or a command line.
`--with-api-key` exists precisely so the value stays out of argv and shell
history.

Already registered in the repo's `.mcp.json`. Restart your MCP client to pick it
up, then call `codex_status` to confirm it is wired.

## Tools

| tool | what it does |
| --- | --- |
| `codex_status` | Version and login state. Call this first when something fails — it separates "not set up" from "broken". |
| `codex_ask` | Ask Codex a question about the repo. Read-only unless `write: true`. |
| `codex_review` | Codex's built-in code review against the current tree. Always read-only. |

`codex_ask` takes `prompt`, and optionally `cwd` (repo-relative), `model`,
`write`, `timeout_seconds`.

## Safety

- **Read-only by default.** `codex_ask` runs under `--sandbox read-only`;
  `write: true` upgrades to `workspace-write` and nothing more. Review the diff
  before committing anything Codex writes.
- **No escape hatches.** `--dangerously-bypass-approvals-and-sandbox` and
  `--dangerously-bypass-hook-trust` are not reachable through any tool argument.
- **No shell.** Arguments are passed as an argv array and the prompt goes over
  stdin, so nothing is shell-expanded and a long prompt cannot overflow argv.
- **Confined to the repo.** `cwd` is resolved against the repo root and refused
  if it escapes, including absolute paths. Tested over the wire, not just in
  unit tests.
- **Bounded.** 600s default timeout, SIGKILL on expiry, output clamped to 200k
  characters.

## The boundary that matters

This is **development tooling**. Codex is an external model, and Blueprint
Decisions 5 and 12 keep external models out of product code, out of Artemis's
reasoning, and out of training data.

Asking Codex to read code and offer a second opinion is none of those. What is
not allowed:

- importing anything here from `gateway/`;
- writing Codex output into any training corpus — `artemis.sft` would reject it
  anyway, since OpenAI is not an approved teacher and could not be
  (`docs/sft-teachers.md`);
- routing a customer's message to it.

## Checking it without Codex installed

```bash
node server.js --self-test
```

Exercises path confinement, output clamping and every failure message, none of
which need the CLI or a login.
