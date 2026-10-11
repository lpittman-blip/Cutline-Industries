/**
 * Everything checkable without an API key or a model call.
 *
 * The parts most likely to be wrong are the ones that never see a happy path in
 * a demo: quoted CSV fields, session expiry, the chart walker against a shape
 * that shifts between API versions, and HTML escaping in the report.
 */
import { preview, parseLine, splitRows, CsvError } from './csv.js'
import { collectCharts, describeEvent } from './agent.js'
import { buildReport } from './report.js'
import {
  createSession, getSession, sweepSessions, _resetSessions, SESSION_TTL_MS,
  type Session,
} from './sessions.js'

const checks: string[] = []
const ok = (name: string, cond: boolean) => checks.push(`${cond ? 'ok  ' : 'FAIL'} ${name}`)
const eq = (name: string, a: unknown, b: unknown) => {
  const same = JSON.stringify(a) === JSON.stringify(b)
  checks.push(`${same ? 'ok  ' : 'FAIL'} ${name}${same ? '' : `  got ${JSON.stringify(a)}`}`)
}

// --- CSV --------------------------------------------------------------------

eq('plain row splits', parseLine('a,b,c'), ['a', 'b', 'c'])
eq('quoted comma stays in the field', parseLine('a,"b,c",d'), ['a', 'b,c', 'd'])
eq('escaped quote unescapes', parseLine('a,"say ""hi""",c'), ['a', 'say "hi"', 'c'])
eq('empty trailing field survives', parseLine('a,b,'), ['a', 'b', ''])
eq('newline inside quotes does not split the row',
  splitRows('h1,h2\n"line\nbreak",v'), ['h1,h2', '"line\nbreak",v'])
eq('CRLF is one break', splitRows('a,b\r\nc,d'), ['a,b', 'c,d'])

{
  const p = preview('name,qty\nwidget,3\ngadget,4\n')
  eq('preview reads the header', p.columns, ['name', 'qty'])
  eq('preview counts data rows only', p.rows, 2)
  eq('preview samples rows', p.sample[0], ['widget', '3'])
}

const rejects = (name: string, text: string) => {
  let threw = false
  try { preview(text) } catch (e) { threw = e instanceof CsvError }
  ok(name, threw)
}
rejects('empty file is refused', '')
rejects('single-column file is refused as not-a-CSV', 'justonecolumn\nvalue\n')
rejects('blank header name is refused', 'a,,c\n1,2,3\n')

// --- sessions ----------------------------------------------------------------

_resetSessions()
{
  const s = createSession()
  ok('session round-trips by id', getSession(s.id)?.id === s.id)
  ok('unknown id returns nothing', getSession('nope') === undefined)
  ok('undefined id returns nothing', getSession(undefined) === undefined)

  s.lastSeen = Date.now() - SESSION_TTL_MS - 1000
  ok('expired session is not returned', getSession(s.id) === undefined)
}
_resetSessions()
{
  const fresh = createSession()
  const stale = createSession()
  stale.lastSeen = Date.now() - SESSION_TTL_MS - 1000
  const dropped = sweepSessions()
  ok('sweep drops only the stale one', dropped === 1 && getSession(fresh.id) !== undefined)
}

// --- stream events ------------------------------------------------------------

ok('tool call reports the sandbox',
  describeEvent({ type: 'run_item_stream_event', name: 'tool_called', item: {} })?.kind === 'status')
{
  const step = describeEvent({
    type: 'run_item_stream_event', name: 'tool_called',
    item: { rawItem: { code: 'import pandas as pd' } },
  })
  ok('tool call surfaces the python when present',
    step?.kind === 'code' && step.text.includes('pandas'))
}
ok('reasoning becomes a status',
  describeEvent({ type: 'run_item_stream_event', name: 'reasoning_item_created' })?.kind === 'status')
ok('text delta is picked up',
  describeEvent({ type: 'raw_model_stream_event', data: { delta: 'hi' } })?.kind === 'delta')
ok('unknown event names are ignored, not thrown',
  describeEvent({ type: 'run_item_stream_event', name: 'something_new_in_a_later_sdk' }) === null)
ok('unrelated events are ignored', describeEvent({ type: 'nonsense' }) === null)
ok('garbage does not throw', describeEvent(null) === null)

// --- chart collection ----------------------------------------------------------

{
  const items = [{
    type: 'code_interpreter_call',
    container_id: 'cntr_1',
    outputs: [{ type: 'image', file_id: 'file_a', filename: 'revenue.png' }],
  }]
  const { containerId, charts } = collectCharts(items)
  ok('container id is found', containerId === 'cntr_1')
  ok('one chart is collected', charts.length === 1 && charts[0].fileId === 'file_a')
  ok('chart carries its container', charts[0].containerId === 'cntr_1')
}
{
  // Annotation shape, which is where citations appear instead.
  const items = [{
    content: [{
      annotations: [
        { type: 'container_file_citation', container_id: 'cntr_2', file_id: 'f1', filename: 'trend.png' },
        { type: 'container_file_citation', container_id: 'cntr_2', file_id: 'f2', filename: 'notes.csv' },
      ],
    }],
  }]
  const { charts } = collectCharts(items)
  ok('image annotation is collected', charts.some((c) => c.fileId === 'f1'))
  ok('non-image file is not shown as a chart', !charts.some((c) => c.fileId === 'f2'))
}
{
  const dup = [
    { container_id: 'c', file_id: 'x', filename: 'a.png' },
    { container_id: 'c', file_id: 'x', filename: 'a.png' },
  ]
  ok('duplicate chart references collapse', collectCharts(dup).charts.length === 1)
}
ok('no charts means an empty list, not a crash', collectCharts([]).charts.length === 0)

// --- report --------------------------------------------------------------------

{
  const session: Session = {
    id: 'x', createdAt: Date.now(), lastSeen: Date.now(),
    fileId: 'f', filename: 'sales.csv',
    preview: { columns: ['a', 'b'], rows: 1234, sample: [] },
    history: [], containerId: 'c',
    turns: [{
      question: 'Is <script>alert(1)</script> handled?',
      answer: 'Yes — **bold** and `code` render.\n\n- one\n- two',
      charts: [], askedAt: '2026-10-11 21:00 UTC',
    }],
  }
  const html = buildReport(session, new Map([[0, [{ name: 'chart.png', dataUri: 'data:image/png;base64,AAA' }]]]))
  ok('report escapes injected markup', !html.includes('<script>alert(1)</script>'))
  ok('report keeps the escaped text visible', html.includes('&lt;script&gt;'))
  ok('report renders bold', html.includes('<strong>bold</strong>'))
  ok('report renders lists', html.includes('<li>one</li>'))
  ok('report embeds the chart', html.includes('data:image/png;base64,AAA'))
  ok('report shows the row count', html.includes('1,234'))
  ok('report names the file', html.includes('sales.csv'))
  ok('report declares both themes', html.includes('prefers-color-scheme: dark'))
}
{
  const empty: Session = {
    id: 'y', createdAt: Date.now(), lastSeen: Date.now(), fileId: null, filename: null,
    preview: null, history: [], turns: [], containerId: null,
  }
  ok('report survives an empty session', buildReport(empty, new Map()).includes('No questions'))
}

console.log(checks.join('\n'))
const failed = checks.filter((c) => c.startsWith('FAIL')).length
console.log(`\n${checks.length - failed}/${checks.length} passed`)
process.exit(failed ? 1 : 0)
