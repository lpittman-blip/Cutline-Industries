# Agent workflow

An OpenAI Agent Builder export, repaired and made runnable. **Development
tooling only.**

## Scope

This calls an OpenAI model through OpenAI's agents SDK. Blueprint Decisions 5
and 12 keep external models out of product code, out of Artemis's reasoning and
out of training data. A local scratch tool is none of those — the same basis on
which `tools/codex-mcp` exists.

Not allowed:

- importing this from `gateway/`;
- routing a customer request to it;
- putting its output into a training corpus. `artemis.sft` would reject OpenAI
  as a teacher anyway, and it could never be approved: OpenAI's terms forbid
  training a competing model on its output, exactly as xAI's do
  (`docs/sft-teachers.md`).

## Use

```bash
npm install
export OPENAI_API_KEY=...        # in your shell; never in a prompt or a commit
npm run run -- "your prompt"
npm run check                    # self-test, no key and no spend
npm run typecheck
```

`AGENT_WORKFLOW_MODEL` overrides the model. `AGENT_WORKFLOW_STORE=1` opts back
into server-side retention.

## What was wrong with the generated code

**It discarded the answer.** The `withTrace` callback ended on a `const`
declaration, so it returned `undefined`, and `runWorkflow` resolved to
`undefined` after paying for the tokens. `myAgentResult` was assigned and never
read.

Also removed or changed:

| | |
| --- | --- |
| unused `OpenAI` client | created for "guardrails and file search", never called; it read `OPENAI_API_KEY` for nothing |
| unused second `Agent` | named `Agent`, empty `instructions`, never referenced |
| `approvalRequest` stub | returned `true` unconditionally and was never called. Deleted rather than left: it reads as a safety control, so the day it gets wired up it approves everything silently. Write it when it is needed. |
| `store: true` | now defaults to **false**. Agent Builder opts into retaining prompts and completions on OpenAI's servers; we are building a competing model. |
| discarded history | `conversationHistory` was built up and thrown away. It is returned, so a second turn is possible. |
| validation order | the output check now runs *before* the history push, so a failed run does not hand back half-extended history. |

A missing `OPENAI_API_KEY` is caught before any network call, and the CLI prints
the message rather than a V8 stack trace.

## Model

`gpt-6-astra`, reported at roughly **$10 per million input tokens and $50 per
million output**. Those figures come from third-party sources, not OpenAI's own
model page — confirm before budgeting against them. `reasoning.effort` is
`low`; raising it raises the bill.

## Verified

- `tsc --noEmit` — clean, strict mode.
- `npm run check` — 5/5, including that a missing key fails before any
  network call.
- CLI error path — exits 1 with the message, not a stack.
- **Not** verified: a live model call. No key is configured here, so the request
  path beyond argument validation is untested.
