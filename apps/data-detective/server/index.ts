/**
 * Data Detective — server.
 *
 * The API key lives here and only here. The browser never receives it, never
 * sees an OpenAI URL, and cannot reach the model except through these routes.
 * Every OpenAI call is made from this process.
 */
import express from 'express'
import multer from 'multer'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import OpenAI from 'openai'

import { buildAgent, collectCharts, describeEvent, makeRunner, MODEL } from './agent.js'
import { CsvError, preview } from './csv.js'
import { buildReport, type RenderedChart } from './report.js'
import {
  createSession,
  getSession,
  sessionCount,
  sweepSessions,
  type ChartRef,
} from './sessions.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const PORT = Number(process.env.PORT || 3000)

/** 25 MB. The sandbox can take more, but a browser upload this big is a mistake. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

if (!process.env.OPENAI_API_KEY) {
  console.error(
    'OPENAI_API_KEY is not set.\n' +
      'Export it in the shell that runs the server:  export OPENAI_API_KEY=...\n' +
      'Never put it in the client, a commit, or a chat message.',
  )
  process.exit(1)
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
})

const app = express()
app.use(express.json({ limit: '1mb' }))
app.use(express.static(path.join(ROOT, 'public')))

setInterval(() => sweepSessions(), 5 * 60 * 1000).unref()

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, model: MODEL, sessions: sessionCount() })
})

/** Upload a CSV: preview it locally, then hand it to the Files API. */
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const buf = req.file?.buffer
    const name = req.file?.originalname || 'upload.csv'
    if (!buf?.length) return res.status(400).json({ error: 'No file was uploaded.' })

    let head: ReturnType<typeof preview>
    try {
      // Parse a slice: enough for a preview, without walking a 25 MB string.
      head = preview(buf.subarray(0, 256 * 1024).toString('utf8'))
    } catch (err) {
      if (err instanceof CsvError) return res.status(400).json({ error: err.message })
      throw err
    }

    const uploaded = await openai.files.create({
      file: new File([new Uint8Array(buf)], name, { type: 'text/csv' }),
      purpose: 'assistants',
    })

    const session = createSession()
    session.fileId = uploaded.id
    session.filename = name
    // The preview's row count covers only the slice we parsed; say so rather
    // than reporting a truncated count as the file's length.
    session.preview = {
      ...head,
      rows: buf.length > 256 * 1024 ? -1 : head.rows,
    }

    res.json({
      sessionId: session.id,
      filename: name,
      columns: head.columns,
      rows: session.preview.rows,
      sample: head.sample,
    })
  } catch (err) {
    console.error('upload failed:', err)
    res.status(500).json({ error: message(err) })
  }
})

/** Load the bundled sample so the app can be tried without finding a CSV. */
app.post('/api/sample', async (_req, res) => {
  try {
    const file = path.join(ROOT, 'sample-data', 'coffee-shop-sales.csv')
    const buf = await readFile(file)
    const head = preview(buf.toString('utf8'))

    const uploaded = await openai.files.create({
      file: new File([new Uint8Array(buf)], 'coffee-shop-sales.csv', { type: 'text/csv' }),
      purpose: 'assistants',
    })

    const session = createSession()
    session.fileId = uploaded.id
    session.filename = 'coffee-shop-sales.csv'
    session.preview = head

    res.json({
      sessionId: session.id,
      filename: session.filename,
      columns: head.columns,
      rows: head.rows,
      sample: head.sample,
      suggestions: [
        'Which products actually drive revenue, and is that different from unit volume?',
        'Is there a weekday pattern in sales, or am I imagining it?',
        'Did the September price change affect demand?',
        'Are any of these stores underperforming once you control for foot traffic?',
      ],
    })
  } catch (err) {
    console.error('sample failed:', err)
    res.status(500).json({ error: message(err) })
  }
})

/**
 * Ask a question. Server-sent events, so the browser sees the agent working
 * rather than a spinner: each sandbox step arrives as it happens.
 */
app.get('/api/ask', async (req, res) => {
  const session = getSession(String(req.query.session || ''))
  const question = String(req.query.q || '').trim()

  if (!session) return res.status(404).json({ error: 'Session not found or expired.' })
  if (!session.fileId) return res.status(400).json({ error: 'Upload a CSV first.' })
  if (!question) return res.status(400).json({ error: 'Ask a question.' })
  if (question.length > 2000) return res.status(400).json({ error: 'Question is too long.' })

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  // A client that navigates away should not leave the run streaming into a
  // dead socket; this flag stops the loop writing after close.
  let closed = false
  req.on('close', () => {
    closed = true
  })

  try {
    send('status', { text: 'Starting the sandbox' })

    const agent = buildAgent(session.fileId)
    const runner = makeRunner()
    const input = [
      ...session.history,
      { role: 'user' as const, content: [{ type: 'input_text' as const, text: question }] },
    ]

    const stream = await runner.run(agent, input, { stream: true })

    for await (const event of stream) {
      if (closed) break
      const step = describeEvent(event)
      if (!step) continue
      if (step.kind === 'delta') send('delta', { text: step.text })
      else if (step.kind === 'code') send('code', { text: step.text })
      else send('status', { text: step.text })
    }

    await stream.completed
    if (closed) return

    const answer = stream.finalOutput ?? ''
    if (!answer) throw new Error('The agent finished without producing an answer.')

    const items = stream.newItems.map((i) => i.rawItem)
    const { containerId, charts } = collectCharts(items)
    if (containerId) session.containerId = containerId

    session.history = [...input, ...items]
    session.turns.push({
      question,
      answer,
      charts,
      askedAt: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
    })

    send('charts', { charts: charts.map((c, i) => ({ index: i, name: c.name, url: chartUrl(session.id, c) })) })
    send('answer', { text: answer, turn: session.turns.length - 1 })
    send('done', { turns: session.turns.length })
  } catch (err) {
    console.error('ask failed:', err)
    if (!closed) send('error', { message: message(err) })
  } finally {
    if (!closed) res.end()
  }
})

const chartUrl = (sessionId: string, c: ChartRef) =>
  `/api/chart?session=${encodeURIComponent(sessionId)}` +
  `&container=${encodeURIComponent(c.containerId)}&file=${encodeURIComponent(c.fileId)}`

/**
 * Proxy one chart out of the sandbox container.
 *
 * Proxied rather than linked directly so the API key stays server-side, and
 * scoped to files this session actually produced so a guessed id cannot read
 * another session's container.
 */
app.get('/api/chart', async (req, res) => {
  const session = getSession(String(req.query.session || ''))
  const containerId = String(req.query.container || '')
  const fileId = String(req.query.file || '')
  if (!session) return res.status(404).end()

  const owns = session.turns.some((t) =>
    t.charts.some((c) => c.containerId === containerId && c.fileId === fileId),
  )
  if (!owns) return res.status(403).end()

  try {
    const buf = await fetchChart(containerId, fileId)
    res.setHeader('Content-Type', 'image/png')
    res.setHeader('Cache-Control', 'private, max-age=600')
    res.end(buf)
  } catch (err) {
    console.error('chart fetch failed:', err)
    res.status(502).end()
  }
})

async function fetchChart(containerId: string, fileId: string): Promise<Buffer> {
  const response = await openai.containers.files.content.retrieve(fileId, {
    container_id: containerId,
  })
  return Buffer.from(await response.arrayBuffer())
}

/** Download a self-contained HTML report of the whole session. */
app.get('/api/report', async (req, res) => {
  const session = getSession(String(req.query.session || ''))
  if (!session) return res.status(404).json({ error: 'Session not found or expired.' })
  if (!session.turns.length) {
    return res.status(400).json({ error: 'Ask at least one question first.' })
  }

  const byTurn = new Map<number, RenderedChart[]>()
  for (const [i, turn] of session.turns.entries()) {
    const rendered: RenderedChart[] = []
    for (const chart of turn.charts) {
      try {
        const buf = await fetchChart(chart.containerId, chart.fileId)
        rendered.push({
          name: chart.name,
          dataUri: `data:image/png;base64,${buf.toString('base64')}`,
        })
      } catch {
        // Containers expire. A missing chart should not cost you the report.
      }
    }
    byTurn.set(i, rendered)
  }

  const html = buildReport(session, byTurn)
  const stem = (session.filename ?? 'session').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '-')
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="data-detective-${stem}.html"`)
  res.end(html)
})

function message(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)

  // An upstream auth failure is a server misconfiguration, not something the
  // visitor can act on, and the provider echoes part of the key back in it
  // (sk-dummy**********test). Neither belongs in a browser response.
  if (/\b401\b|invalid[_ ]api[_ ]key|incorrect api key|unauthorized/i.test(text)) {
    console.error('upstream auth failure — check OPENAI_API_KEY on the server')
    return 'The server is not able to reach the model right now. Check the server logs.'
  }
  if (/\b429\b|rate[_ ]limit/i.test(text)) {
    return 'The model is rate-limited right now. Wait a moment and ask again.'
  }
  if (/\b(402|quota|billing)\b/i.test(text)) {
    return 'The account backing this server has no remaining quota.'
  }

  // Belt and braces for anything else that might carry a key, masked or not.
  return text.replace(/sk-[A-Za-z0-9_*-]{6,}/g, 'sk-***')
}

// multer and body-parser surface limits as errors; turn them into plain JSON.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const e = err as { code?: string }
  if (e?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'That file is larger than 25 MB.' })
  }
  console.error('unhandled:', err)
  res.status(500).json({ error: message(err) })
})

app.listen(PORT, () => {
  console.log(`Data Detective on http://localhost:${PORT}  (model: ${MODEL})`)
})
