/**
 * OpenAI Agent Builder workflow — DEVELOPMENT TOOLING ONLY.
 *
 * This calls an OpenAI model through OpenAI's agents SDK. Blueprint Decisions 5
 * and 12 keep external models out of product code, out of Artemis's reasoning
 * and out of training data. Using one as a local scratch tool is none of those,
 * which is the same basis on which tools/codex-mcp exists.
 *
 * Nothing under `gateway/` may import this, no customer request may reach it,
 * and nothing it returns may enter a training corpus — `artemis.sft` would
 * reject OpenAI as a teacher regardless, and could not approve it, since
 * OpenAI's terms forbid training a competing model on its output.
 *
 * Exported from Agent Builder and repaired. The generated version ran the agent
 * and discarded the answer: its `withTrace` callback ended on a `const`
 * declaration, so the callback returned undefined, and so did `runWorkflow`.
 * It also carried an unused OpenAI client, a second empty agent, and an
 * approval stub that returned true unconditionally and was never called.
 */
import { Agent, Runner, withTrace, type AgentInputItem } from '@openai/agents'

/** Reported ~$10/M input and $50/M output. Keep an eye on what this costs. */
const MODEL = process.env.AGENT_WORKFLOW_MODEL || 'gpt-6-astra'

export const myAgent = new Agent({
  name: 'My agent',
  instructions: 'You are a helpful assistant.',
  model: MODEL,
  modelSettings: {
    reasoning: { effort: 'low', summary: 'auto' },
    // Agent Builder emits `store: true`, which retains prompts and completions
    // on OpenAI's servers. We are building a competing model; default to off.
    store: process.env.AGENT_WORKFLOW_STORE === '1',
  },
})

export type WorkflowInput = { input_as_text: string }

export type WorkflowResult = {
  output_text: string
  history: AgentInputItem[]
}

export const runWorkflow = async (
  workflow: WorkflowInput,
): Promise<WorkflowResult> => {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      'OPENAI_API_KEY is not set. Export it in the shell running this tool; ' +
        'do not paste it into a prompt, a commit or a chat message.',
    )
  }

  return withTrace('Agent builder workflow', async () => {
    const conversationHistory: AgentInputItem[] = [
      {
        role: 'user',
        content: [{ type: 'input_text', text: workflow.input_as_text }],
      },
    ]

    const runner = new Runner({
      traceMetadata: { __trace_source__: 'agent-builder' },
    })

    const result = await runner.run(myAgent, conversationHistory)

    // Validate before mutating: a failed run should not leave the caller
    // holding a half-extended history it might send back.
    if (!result.finalOutput) {
      throw new Error('Agent returned no final output')
    }
    conversationHistory.push(...result.newItems.map((item) => item.rawItem))

    // The generated code built this object and never returned it, so the whole
    // workflow resolved to undefined after paying for the tokens.
    return { output_text: result.finalOutput, history: conversationHistory }
  })
}

// --- CLI -------------------------------------------------------------------
// `--self-test` checks everything that does not need the API, so the wiring can
// be verified without a key and without spending anything.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  const args = process.argv.slice(2)

  if (args.includes('--self-test')) {
    const checks: string[] = []
    const ok = (name: string, cond: boolean) =>
      checks.push(`${cond ? 'ok  ' : 'FAIL'} ${name}`)

    ok('agent is constructed', myAgent instanceof Agent)
    ok('agent carries a model', typeof (myAgent as { model?: unknown }).model === 'string')
    ok('store defaults to false', process.env.AGENT_WORKFLOW_STORE !== '1')
    ok('runWorkflow is async', runWorkflow.constructor.name === 'AsyncFunction')

    const saved = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY
    let refused = false
    try {
      await runWorkflow({ input_as_text: 'hi' })
    } catch (err) {
      refused = String(err).includes('OPENAI_API_KEY')
    }
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved
    ok('missing key fails before any network call', refused)

    console.log(checks.join('\n'))
    process.exit(checks.some((c) => c.startsWith('FAIL')) ? 1 : 0)
  }

  const prompt = args.join(' ').trim()
  if (!prompt) {
    console.error('usage: npm run run -- "your prompt"   |   npm run check')
    process.exit(2)
  }
  // Report failures as a message, not a stack. A missing key is a setup
  // mistake, and a V8 trace buries the one line that says how to fix it.
  try {
    const out = await runWorkflow({ input_as_text: prompt })
    console.log(out.output_text)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}
