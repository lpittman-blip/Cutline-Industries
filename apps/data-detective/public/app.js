/**
 * Data Detective — browser.
 *
 * Talks only to this app's own server. There is no API key here and no call to
 * OpenAI from the page; everything model-facing happens server-side.
 */

const $ = (id) => document.getElementById(id)
const el = {
  dropzone: $('dropzone'), file: $('file'), sample: $('sample'),
  intake: $('intake'), intakeError: $('intake-error'),
  dataset: $('dataset'), filename: $('filename'), rowcount: $('rowcount'),
  colcount: $('colcount'), preview: $('preview'), reset: $('reset'),
  conversation: $('conversation'), turns: $('turns'),
  working: $('working'), workingStatus: $('working-status'), workingCode: $('working-code'),
  suggestions: $('suggestions'), form: $('ask-form'), question: $('question'),
  ask: $('ask'), askError: $('ask-error'),
  reportBar: $('report-bar'), reportCount: $('report-count'), report: $('report'),
}

let sessionId = null
let busy = false
let turnCount = 0

// --- helpers ---------------------------------------------------------------

const show = (node, on = true) => { node.hidden = !on }

function fail(node, message) {
  node.textContent = message
  show(node, Boolean(message))
}

/** Escape first, then allow a tiny, fixed subset of markdown. Never innerHTML raw text. */
function renderMarkdown(text) {
  const escaped = text.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  return escaped
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split('\n')
      if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
        return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`
      }
      return `<p>${inline(lines.join('<br>'))}</p>`
    })
    .join('')
}

const inline = (s) =>
  s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
   .replace(/`([^`]+)`/g, '<code>$1</code>')

// --- loading a dataset ------------------------------------------------------

function adoptDataset(data) {
  sessionId = data.sessionId
  turnCount = 0
  el.filename.textContent = data.filename
  el.rowcount.textContent =
    data.rows >= 0 ? `${data.rows.toLocaleString()} rows` : 'large file (row count from the sandbox)'
  el.colcount.textContent = `${data.columns.length} columns`

  el.preview.querySelector('thead').innerHTML =
    `<tr>${data.columns.map((c) => `<th>${escapeCell(c)}</th>`).join('')}</tr>`
  el.preview.querySelector('tbody').innerHTML = data.sample
    .map((row) => `<tr>${row.map((v) => `<td>${escapeCell(v)}</td>`).join('')}</tr>`)
    .join('')

  el.turns.innerHTML = ''
  show(el.intake, false)
  show(el.dataset, true)
  show(el.conversation, true)
  show(el.reportBar, false)
  fail(el.intakeError, '')

  renderSuggestions(data.suggestions ?? [
    'What are the three most interesting things in this file?',
    'What data-quality problems should I know about before trusting it?',
    'Show me the main trend over time.',
  ])
  el.question.focus()
}

const escapeCell = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function renderSuggestions(list) {
  el.suggestions.innerHTML = ''
  for (const text of list) {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = text
    b.addEventListener('click', () => { el.question.value = text; submit() })
    el.suggestions.append(b)
  }
  show(el.suggestions, list.length > 0)
}

async function uploadFile(file) {
  if (!file) return
  fail(el.intakeError, '')
  el.dropzone.querySelector('strong').textContent = 'Uploading…'
  try {
    const body = new FormData()
    body.append('file', file)
    const res = await fetch('/api/upload', { method: 'POST', body })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Upload failed.')
    adoptDataset(data)
  } catch (err) {
    fail(el.intakeError, err.message)
  } finally {
    el.dropzone.querySelector('strong').textContent = 'Choose a CSV'
  }
}

// --- asking -----------------------------------------------------------------

function submit() {
  if (busy) return
  const question = el.question.value.trim()
  if (!question) return
  ask(question)
}

function ask(question) {
  busy = true
  el.ask.disabled = true
  el.question.value = ''
  fail(el.askError, '')
  show(el.suggestions, false)

  const turn = document.createElement('article')
  turn.className = 'turn'
  turn.innerHTML = `<h3 class="q"></h3><div class="a"></div>`
  turn.querySelector('.q').textContent = question
  el.turns.append(turn)
  const answerEl = turn.querySelector('.a')

  el.workingStatus.textContent = 'Starting…'
  el.workingCode.textContent = ''
  show(el.workingCode, false)
  show(el.working, true)
  el.working.scrollIntoView({ behavior: 'smooth', block: 'end' })

  const url = `/api/ask?session=${encodeURIComponent(sessionId)}&q=${encodeURIComponent(question)}`
  const source = new EventSource(url)
  let streamed = ''

  const finish = () => {
    source.close()
    busy = false
    el.ask.disabled = false
    show(el.working, false)
    el.question.focus()
  }

  source.addEventListener('status', (e) => {
    el.workingStatus.textContent = JSON.parse(e.data).text
  })

  source.addEventListener('code', (e) => {
    el.workingStatus.textContent = 'Running Python in the sandbox'
    el.workingCode.textContent = JSON.parse(e.data).text
    show(el.workingCode, true)
  })

  // Live text, so a long answer appears as it is written rather than all at once.
  source.addEventListener('delta', (e) => {
    streamed += JSON.parse(e.data).text
    answerEl.innerHTML = renderMarkdown(streamed)
  })

  source.addEventListener('charts', (e) => {
    const { charts } = JSON.parse(e.data)
    for (const chart of charts) {
      const fig = document.createElement('figure')
      const img = document.createElement('img')
      img.src = chart.url
      img.alt = chart.name
      img.loading = 'lazy'
      // A container can expire before the image loads; drop the frame quietly
      // rather than leaving a broken-image icon in the middle of the finding.
      img.addEventListener('error', () => fig.remove())
      const cap = document.createElement('figcaption')
      cap.textContent = chart.name
      fig.append(img, cap)
      turn.append(fig)
    }
  })

  source.addEventListener('answer', (e) => {
    answerEl.innerHTML = renderMarkdown(JSON.parse(e.data).text)
  })

  source.addEventListener('done', (e) => {
    turnCount = JSON.parse(e.data).turns
    el.reportCount.textContent =
      `${turnCount} ${turnCount === 1 ? 'question' : 'questions'} answered`
    el.report.href = `/api/report?session=${encodeURIComponent(sessionId)}`
    show(el.reportBar, true)
    finish()
  })

  source.addEventListener('error', (e) => {
    // EventSource fires a bare error on network drop too, with no payload.
    let text = 'The connection to the server dropped.'
    try { if (e.data) text = JSON.parse(e.data).message } catch { /* keep default */ }
    if (!streamed) turn.remove()
    fail(el.askError, text)
    finish()
  })
}

// --- wiring ------------------------------------------------------------------

el.dropzone.addEventListener('click', () => el.file.click())
el.file.addEventListener('change', () => uploadFile(el.file.files?.[0]))

for (const type of ['dragenter', 'dragover']) {
  el.dropzone.addEventListener(type, (e) => { e.preventDefault(); el.dropzone.classList.add('over') })
}
for (const type of ['dragleave', 'drop']) {
  el.dropzone.addEventListener(type, () => el.dropzone.classList.remove('over'))
}
el.dropzone.addEventListener('drop', (e) => {
  e.preventDefault()
  uploadFile(e.dataTransfer?.files?.[0])
})

el.sample.addEventListener('click', async () => {
  fail(el.intakeError, '')
  el.sample.querySelector('strong').textContent = 'Loading…'
  try {
    const res = await fetch('/api/sample', { method: 'POST' })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Could not load the sample.')
    adoptDataset(data)
  } catch (err) {
    fail(el.intakeError, err.message)
  } finally {
    el.sample.querySelector('strong').textContent = 'Try the sample'
  }
})

el.reset.addEventListener('click', () => {
  sessionId = null
  el.file.value = ''
  show(el.dataset, false)
  show(el.conversation, false)
  show(el.reportBar, false)
  show(el.intake, true)
})

el.form.addEventListener('submit', (e) => { e.preventDefault(); submit() })

// Enter sends, Shift+Enter makes a new line — what a chat box is expected to do.
el.question.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
})
