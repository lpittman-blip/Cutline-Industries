#!/usr/bin/env node
/**
 * Codex MCP — drive the OpenAI Codex CLI from an MCP client (Claude Code, Cursor).
 *
 * WHY A WRAPPER. Codex CLI 0.162.1 has no "serve as MCP" mode. Its `codex mcp`
 * subcommand manages MCP servers Codex *consumes* (add/remove/list), and
 * `codex app-server` speaks its own JSON-RPC protocol, not MCP. Blog posts
 * describing `codex mcp-server` are stale — the subcommand does not exist.
 * `codex exec` is the scriptable entry point, so this wraps that.
 *
 * SCOPE. This is DEVELOPMENT TOOLING. Codex is an external model, and Blueprint
 * Decisions 5 and 12 keep external models out of product code, out of Artemis's
 * reasoning, and out of training data. Using one to read code and offer a second
 * opinion is none of those things. Nothing here may be imported by `gateway/`,
 * and nothing it returns may be written into a training corpus.
 *
 * SAFETY. The sandbox defaults to read-only and the dangerous escape hatches
 * (--dangerously-bypass-approvals-and-sandbox, --dangerously-bypass-hook-trust)
 * are deliberately not reachable through any tool argument. Arguments are passed
 * as an argv array and the prompt goes over stdin, so nothing is shell-expanded.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../..')

const CODEX_BIN = process.env.CODEX_BIN || 'codex'
const DEFAULT_TIMEOUT_MS = Number(process.env.CODEX_MCP_TIMEOUT_MS || 600_000)
const MAX_OUTPUT_CHARS = 200_000

/** Resolve a caller-supplied directory, refusing anything outside the repo. */
function resolveWorkdir(dir) {
  if (!dir) return REPO_ROOT
  const resolved = path.resolve(REPO_ROOT, dir)
  const rel = path.relative(REPO_ROOT, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`cwd must stay inside the repository: ${dir}`)
  }
  return resolved
}

function clamp(text) {
  if (text.length <= MAX_OUTPUT_CHARS) return text
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n…truncated at ${MAX_OUTPUT_CHARS} characters.`
}

/**
 * Run the Codex CLI. The prompt goes over stdin rather than argv: it is
 * untrusted free text, it can be long, and argv has a length limit.
 */
function runCodex(args, { prompt = '', cwd = REPO_ROOT, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(CODEX_BIN, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (err) {
      return resolve({ code: null, stdout: '', stderr: String(err), spawnError: true })
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.stdout.on('data', (d) => {
      if (stdout.length < MAX_OUTPUT_CHARS * 2) stdout += d
    })
    child.stderr.on('data', (d) => {
      if (stderr.length < MAX_OUTPUT_CHARS * 2) stderr += d
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr: String(err), spawnError: true })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })

    child.stdin.on('error', () => {})
    child.stdin.end(prompt)
  })
}

/** Turn a failed run into a message that says what to actually do about it. */
function explainFailure({ code, stderr, spawnError, timedOut }) {
  if (spawnError) {
    return `The Codex CLI could not be started (looked for "${CODEX_BIN}").\n` +
      `Install it with:  npm install -g @openai/codex\n` +
      `Or set CODEX_BIN to its path.\n\n${stderr}`
  }
  if (timedOut) {
    return `Codex exceeded the ${DEFAULT_TIMEOUT_MS / 1000}s timeout and was killed. ` +
      `Narrow the prompt, or raise CODEX_MCP_TIMEOUT_MS.`
  }
  const auth = /not logged in|unauthor|401|authentication|login/i.test(stderr)
  if (auth) {
    return `Codex is not authenticated. On the machine running this server:\n` +
      `  codex login                 # ChatGPT account, opens a browser\n` +
      `  printenv OPENAI_API_KEY | codex login --with-api-key   # key via stdin\n` +
      `Never paste a key into a chat message.\n\n${stderr}`
  }
  return `Codex exited ${code}.\n\n${clamp(stderr)}`
}

const server = new McpServer({ name: 'codex', version: '1.0.0' })

server.tool(
  'codex_status',
  'Report whether the Codex CLI is installed and authenticated. Call this first when another codex tool fails, to tell "not set up" from "broken".',
  {},
  async () => {
    const version = await runCodex(['--version'], { timeoutMs: 20_000 })
    if (version.spawnError) {
      return { content: [{ type: 'text', text: explainFailure(version) }], isError: true }
    }
    const login = await runCodex(['login', 'status'], { timeoutMs: 30_000 })
    return {
      content: [{
        type: 'text',
        text: [
          `version: ${version.stdout.trim() || 'unknown'}`,
          `login:   ${(login.stdout + login.stderr).trim() || 'no output'}`,
          `binary:  ${CODEX_BIN}`,
          `root:    ${REPO_ROOT}`,
        ].join('\n'),
      }],
    }
  },
)

server.tool(
  'codex_ask',
  'Ask OpenAI Codex a question about this repository and return its answer. Read-only by default: Codex may read files and run inspection commands, but cannot modify the working tree unless write access is explicitly requested. Use for a second opinion on a design, an unfamiliar area of the codebase, or a bug you are stuck on.',
  {
    prompt: z.string().min(1).describe('What to ask Codex. Be specific; it starts with no context from this conversation.'),
    cwd: z.string().optional().describe('Repo-relative directory to work from. Defaults to the repository root; may not escape it.'),
    model: z.string().optional().describe('Override the Codex model. Omit to use its configured default.'),
    write: z.boolean().optional().describe('Allow Codex to modify files in the workspace. Defaults to false (read-only). Review the diff before committing anything it writes.'),
    timeout_seconds: z.number().int().min(10).max(3600).optional().describe('Kill the run after this long. Defaults to 600.'),
  },
  async ({ prompt, cwd, model, write, timeout_seconds }) => {
    let workdir
    try {
      workdir = resolveWorkdir(cwd)
    } catch (err) {
      return { content: [{ type: 'text', text: String(err.message) }], isError: true }
    }

    const scratch = await mkdtemp(path.join(tmpdir(), 'codex-mcp-'))
    const lastMessage = path.join(scratch, 'last.txt')
    const args = [
      'exec',
      '--sandbox', write ? 'workspace-write' : 'read-only',
      '--skip-git-repo-check',
      '--color', 'never',
      '--output-last-message', lastMessage,
    ]
    if (model) args.push('--model', model)

    try {
      const run = await runCodex(args, {
        prompt,
        cwd: workdir,
        timeoutMs: (timeout_seconds ?? DEFAULT_TIMEOUT_MS / 1000) * 1000,
      })

      // Prefer the final-message file: stdout carries the whole transcript.
      let answer = ''
      try {
        answer = (await readFile(lastMessage, 'utf8')).trim()
      } catch {
        answer = ''
      }
      if (!answer && run.code !== 0) {
        return { content: [{ type: 'text', text: explainFailure(run) }], isError: true }
      }
      if (!answer) {
        answer = run.stdout.trim() || '(Codex produced no final message.)'
      }
      const mode = write ? 'workspace-write' : 'read-only'
      return {
        content: [{ type: 'text', text: clamp(`[codex ${mode} in ${path.relative(REPO_ROOT, workdir) || '.'}]\n\n${answer}`) }],
      }
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  },
)

server.tool(
  'codex_review',
  'Run the Codex CLI\'s built-in code review against the current repository state and return its findings. Always read-only.',
  {
    prompt: z.string().optional().describe('Optional focus for the review, e.g. "concentrate on the SFT provenance gate".'),
    cwd: z.string().optional().describe('Repo-relative directory to review from. Defaults to the repository root.'),
    timeout_seconds: z.number().int().min(10).max(3600).optional(),
  },
  async ({ prompt, cwd, timeout_seconds }) => {
    let workdir
    try {
      workdir = resolveWorkdir(cwd)
    } catch (err) {
      return { content: [{ type: 'text', text: String(err.message) }], isError: true }
    }
    const run = await runCodex(
      ['exec', 'review', '--sandbox', 'read-only', '--skip-git-repo-check', '--color', 'never'],
      { prompt: prompt ?? '', cwd: workdir, timeoutMs: (timeout_seconds ?? 900) * 1000 },
    )
    if (run.code !== 0 && !run.stdout.trim()) {
      return { content: [{ type: 'text', text: explainFailure(run) }], isError: true }
    }
    return { content: [{ type: 'text', text: clamp(run.stdout.trim() || run.stderr.trim()) }] }
  },
)

// `node server.js --self-test` exercises everything that does not need Codex
// itself, so the wiring can be checked on a machine with no CLI installed.
if (process.argv.includes('--self-test')) {
  const checks = []
  const ok = (name, cond) => checks.push(`${cond ? 'ok  ' : 'FAIL'} ${name}`)

  ok('repo root resolves', path.basename(REPO_ROOT) === 'cutline-industries' || REPO_ROOT.length > 1)
  ok('default cwd is the repo root', resolveWorkdir(undefined) === REPO_ROOT)
  ok('relative cwd resolves inside', resolveWorkdir('gateway') === path.join(REPO_ROOT, 'gateway'))
  let escaped = false
  try { resolveWorkdir('../../etc') } catch { escaped = true }
  ok('cwd cannot escape the repo', escaped)
  let absEscaped = false
  try { resolveWorkdir('/etc') } catch { absEscaped = true }
  ok('absolute cwd outside the repo is refused', absEscaped)
  ok('clamp truncates', clamp('x'.repeat(MAX_OUTPUT_CHARS + 10)).includes('truncated'))
  ok('clamp leaves short text alone', clamp('short') === 'short')
  ok('missing binary explains the install', explainFailure({ spawnError: true, stderr: '' }).includes('npm install -g @openai/codex'))
  ok('auth failure explains login', explainFailure({ code: 1, stderr: 'Error: not logged in' }).includes('codex login'))
  ok('auth hint refuses key pasting', explainFailure({ code: 1, stderr: '401 unauthorized' }).includes('Never paste a key'))
  ok('timeout is reported as a timeout', explainFailure({ timedOut: true, stderr: '' }).includes('timeout'))

  const missing = await runCodex(['--version'], { timeoutMs: 5000 })
  ok('a missing/!present binary never throws', typeof missing.code !== 'undefined')

  console.log(checks.join('\n'))
  process.exit(checks.some((c) => c.startsWith('FAIL')) ? 1 : 0)
}

await server.connect(new StdioServerTransport())
