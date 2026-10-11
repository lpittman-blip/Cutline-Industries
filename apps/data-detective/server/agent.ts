/**
 * The Data Detective agent, and the translation from SDK stream events to
 * progress the browser can render.
 *
 * Shapes here were read from the installed SDK's type definitions rather than
 * from documentation, because the published guides disagree with each other:
 *
 *   codeInterpreterTool({ container })            @openai/agents-openai/tools.d.ts
 *   container: { type: 'auto', file_ids, ... }    openai/resources/responses
 *   RunItemStreamEventName = 'tool_called' | ...  @openai/agents-core/events.d.ts
 *
 * Pinned versions are in package.json; re-read those files before upgrading.
 */
import { Agent, Runner, codeInterpreterTool, type AgentInputItem } from '@openai/agents'
import type { ChartRef } from './sessions.js'

export const MODEL = process.env.DATA_DETECTIVE_MODEL || 'gpt-5.1'

/**
 * Network access is disabled in the sandbox. The agent's job is to analyse the
 * file it was given; it has no reason to reach the internet, and a container
 * holding someone's uploaded data should not be able to send it anywhere.
 */
const MEMORY_LIMIT = '1g' as const

const INSTRUCTIONS = `You are Data Detective, a careful data analyst.

You are given one CSV file in your Python sandbox. Work like an analyst who will
be held to the result, not like one trying to impress.

Method, every time:
1. Load the file and LOOK at it before answering: shape, dtypes, null counts,
   obvious junk. Never assume a column is numeric or a date because of its name.
2. Do the analysis in Python. Do not compute figures in your head, and do not
   quote a number you have not actually calculated.
3. Draw a chart whenever a chart carries the answer better than a sentence.
   Save every figure with matplotlib's savefig as a PNG. Label the axes and give
   it a title that states the finding, not the mechanism.
4. Answer in plain prose. Lead with what the data says, then how you know.

State caveats explicitly and without being asked. Say so when:
- rows were dropped, coerced, or imputed, and how many;
- a result rests on a small sample, or on one outlier;
- a column is ambiguous and you picked an interpretation;
- correlation is all you have, which is the usual case — do not imply cause;
- the question cannot be answered from these columns at all. Say that plainly
  instead of answering a nearby question you can answer.

Never invent columns, rows or figures. If the file contradicts the question,
trust the file and say so.`

export function buildAgent(fileId: string) {
  return new Agent({
    name: 'Data Detective',
    model: MODEL,
    instructions: INSTRUCTIONS,
    tools: [
      codeInterpreterTool({
        container: {
          type: 'auto',
          file_ids: [fileId],
          memory_limit: MEMORY_LIMIT,
          network_policy: { type: 'disabled' },
        },
      }),
    ],
  })
}

export type Progress =
  | { kind: 'status'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'delta'; text: string }

/**
 * Pull a human-readable step out of one stream event.
 *
 * Returns null for events with nothing worth showing, which is most of them.
 * Event names are the authoritative RunItemStreamEventName union; anything the
 * SDK adds later simply falls through rather than breaking the stream.
 */
export function describeEvent(event: unknown): Progress | null {
  // Guard before reading: one unexpected null from the stream must not take
  // down the whole SSE response in the middle of an answer.
  if (!event || typeof event !== 'object') return null
  const e = event as { type?: string; name?: string; item?: unknown; data?: unknown }

  if (e.type === 'agent_updated_stream_event') {
    return { kind: 'status', text: 'Agent ready' }
  }

  if (e.type === 'raw_model_stream_event') {
    // Text deltas arrive here. The envelope has shifted between SDK versions,
    // so read it defensively instead of destructuring a fixed path.
    const text = findDelta(e.data)
    return text ? { kind: 'delta', text } : null
  }

  if (e.type !== 'run_item_stream_event') return null

  switch (e.name) {
    case 'reasoning_item_created':
      return { kind: 'status', text: 'Thinking about how to approach this' }
    case 'tool_called': {
      const code = findCode(e.item)
      return code
        ? { kind: 'code', text: code }
        : { kind: 'status', text: 'Running Python in the sandbox' }
    }
    case 'tool_output':
      return { kind: 'status', text: 'Sandbox finished a step' }
    case 'message_output_created':
      return { kind: 'status', text: 'Writing up the findings' }
    default:
      return null
  }
}

function findDelta(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (typeof d.delta === 'string' && d.delta) return d.delta
  if (d.type === 'output_text_delta' && typeof d.text === 'string') return d.text
  const event = d.event as Record<string, unknown> | undefined
  if (event && typeof event.delta === 'string' && event.delta) return event.delta
  return null
}

/** Dig the Python source out of a code-interpreter call item, if it is there. */
function findCode(item: unknown): string | null {
  const found = deepFind(item, (k, v) => k === 'code' && typeof v === 'string' && v.length > 0)
  return typeof found === 'string' ? found : null
}

/**
 * Collect every chart the sandbox produced, plus the container it ran in.
 *
 * The run items carry container ids and generated file ids, but the exact
 * nesting has moved between API versions, so this walks the structure looking
 * for the two fields instead of asserting a path. Over-collecting is handled by
 * the caller: a file that will not download is simply dropped.
 */
export function collectCharts(
  items: unknown[],
): { containerId: string | null; charts: ChartRef[] } {
  let containerId: string | null = null
  const charts: ChartRef[] = []
  const seen = new Set<string>()

  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      node.forEach(visit)
      return
    }
    const obj = node as Record<string, unknown>

    const cid = obj.container_id ?? obj.containerId
    if (typeof cid === 'string' && cid) containerId = cid

    // A chart shows up as a citation/annotation naming a file inside the container.
    const fid = obj.file_id ?? obj.fileId
    const isFileRef =
      typeof fid === 'string' &&
      fid &&
      (obj.type === 'container_file_citation' ||
        typeof obj.filename === 'string' ||
        typeof obj.container_id === 'string')

    if (isFileRef) {
      const name = typeof obj.filename === 'string' ? obj.filename : `${fid}.png`
      const key = `${String(cid ?? containerId)}:${fid}`
      if (!seen.has(key) && looksLikeImage(name)) {
        seen.add(key)
        charts.push({
          containerId: String(cid ?? containerId ?? ''),
          fileId: String(fid),
          name,
        })
      }
    }

    Object.values(obj).forEach(visit)
  }

  visit(items)
  // Charts found before the container id appeared still need it filled in.
  for (const c of charts) if (!c.containerId && containerId) c.containerId = containerId
  return { containerId, charts: charts.filter((c) => c.containerId) }
}

function looksLikeImage(name: string): boolean {
  return /\.(png|jpe?g|webp|svg)$/i.test(name)
}

function deepFind(
  node: unknown,
  pred: (key: string, value: unknown) => boolean,
  depth = 0,
): unknown {
  if (depth > 12 || !node || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const v of node) {
      const hit = deepFind(v, pred, depth + 1)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (pred(k, v)) return v
    const hit = deepFind(v, pred, depth + 1)
    if (hit !== undefined) return hit
  }
  return undefined
}

export function makeRunner(): Runner {
  return new Runner({ traceMetadata: { __trace_source__: 'data-detective' } })
}

export type { AgentInputItem }
