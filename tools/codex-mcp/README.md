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
history. `codex login status` shows the active method; `codex logout` clears it.

### Store the credentials in the keyring, not a plaintext file

By default Codex caches the session in **plaintext** at `~/.codex/auth.json`.
That file contains access tokens — it is a password. This wrapper means a
long-lived credential sits on whatever box runs the MCP server, so move it into
the OS credential store in `~/.codex/config.toml`:

```toml
# file | keyring | auto | ephemeral
cli_auth_credentials_store = "keyring"
```

`keyring` fails loudly if no credential store is available; `auto` falls back to
`auth.json`. Never commit `auth.json`, and never paste it anywhere.

### Headless hosts

Browser login needs a browser and a working `localhost:1455` callback, so it
fails on a remote or headless runner — which is often exactly where an MCP
server lives. Use device code instead:

```bash
codex login --device-auth
```

It must be enabled first in ChatGPT security settings (personal) or workspace
permissions (admin). The documented fallback is copying `auth.json` from a
machine that can do the browser flow; prefer device code, and if you do copy the
file, treat it as moving a password between machines.

### Behind a TLS proxy

If the host sits behind a corporate TLS proxy or private root CA, point Codex at
the PEM bundle before logging in, or the login itself fails:

```bash
export CODEX_CA_CERTIFICATE=/path/to/root-ca.pem
codex login
```

It falls back to `SSL_CERT_FILE` when unset. This applies to login, ordinary
HTTPS and WebSocket connections alike.

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

## Where this came from

The tool surface (`codex exec`, the absence of an MCP serve mode) was read off
`codex --help` on the installed binary. The authentication section follows
OpenAI's own docs at `learn.chatgpt.com/docs/auth`, cross-checked against the
binary: `--with-api-key`, `--with-access-token`, `--device-auth` and `logout`
all exist in 0.162.1, and `cli_auth_credentials_store` is accepted under
`--strict-config` while an invented key is rejected as an unknown field.

Re-check both after a CLI upgrade. The published third-party write-ups are
wrong about `codex mcp-server`, which is why nothing here trusts them.

## Checking it without Codex installed

```bash
node server.js --self-test
```

Exercises path confinement, output clamping and every failure message, none of
which need the CLI or a login.
