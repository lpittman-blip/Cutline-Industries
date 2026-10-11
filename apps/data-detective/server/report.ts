/**
 * Build the downloadable report.
 *
 * Self-contained HTML: charts are inlined as data URIs so the file still works
 * after the sandbox container has expired and after it has been emailed on.
 * A report that only renders while the server is up is not a report.
 */
import type { Session } from './sessions.js'

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )

/** Minimal markdown: paragraphs, bullets, bold, inline code. Input is escaped first. */
function renderText(text: string): string {
  const safe = escapeHtml(text)
  const blocks = safe.split(/\n{2,}/)
  return blocks
    .map((block) => {
      const lines = block.split('\n')
      if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
        const items = lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`)
        return `<ul>${items.join('')}</ul>`
      }
      return `<p>${inline(lines.join('<br>'))}</p>`
    })
    .join('\n')
}

const inline = (s: string) =>
  s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')

export type RenderedChart = { name: string; dataUri: string }

export function buildReport(
  session: Session,
  chartsByTurn: Map<number, RenderedChart[]>,
): string {
  const title = session.filename ? `Data Detective — ${session.filename}` : 'Data Detective report'
  const generated = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC'

  const turns = session.turns
    .map((turn, i) => {
      const charts = (chartsByTurn.get(i) ?? [])
        .map(
          (c) =>
            `<figure><img src="${c.dataUri}" alt="${escapeHtml(c.name)}">` +
            `<figcaption>${escapeHtml(c.name)}</figcaption></figure>`,
        )
        .join('\n')
      return `<section class="turn">
  <h2>${escapeHtml(turn.question)}</h2>
  <p class="meta">asked ${escapeHtml(turn.askedAt)}</p>
  ${renderText(turn.answer)}
  ${charts}
</section>`
    })
    .join('\n')

  const cols = session.preview?.columns ?? []

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root {
    --bg: #fbfaf8; --fg: #1c1a17; --muted: #6b6560; --line: #e3ded7;
    --card: #ffffff; --accent: #8a5a2b;
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#171614; --fg:#eceae6; --muted:#9c958c; --line:#302c28;
            --card:#1f1d1b; --accent:#d9a066; color-scheme: dark; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:16px/1.65 ui-serif, Georgia, "Times New Roman", serif;
         padding: 40px 16px; }
  main { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 1.9rem; margin:0 0 .25rem; text-wrap: balance; }
  h2 { font-size: 1.15rem; margin: 0 0 .25rem; text-wrap: balance; }
  .meta { color: var(--muted); font-size: .85rem; margin:.1rem 0 1rem;
          font-family: ui-sans-serif, system-ui, sans-serif; }
  .summary { border:1px solid var(--line); background:var(--card);
             border-radius:10px; padding:16px 20px; margin: 20px 0 32px; }
  .summary dl { display:grid; grid-template-columns:auto 1fr; gap:6px 18px; margin:0;
                font-family: ui-sans-serif, system-ui, sans-serif; font-size:.9rem; }
  .summary dt { color: var(--muted); }
  .summary dd { margin:0; font-variant-numeric: tabular-nums; }
  .turn { border-top:1px solid var(--line); padding-top:24px; margin-top:28px; }
  figure { margin: 20px 0; }
  figure img { max-width:100%; border:1px solid var(--line); border-radius:8px;
               background:#fff; display:block; }
  figcaption { color:var(--muted); font-size:.82rem; margin-top:6px;
               font-family: ui-sans-serif, system-ui, sans-serif; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:.9em;
         background:color-mix(in srgb, var(--fg) 7%, transparent);
         padding:1px 5px; border-radius:4px; }
  ul { padding-left: 1.2rem; }
  footer { margin-top:40px; padding-top:16px; border-top:1px solid var(--line);
           color:var(--muted); font-size:.82rem;
           font-family: ui-sans-serif, system-ui, sans-serif; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(title)}</h1>
  <p class="meta">Generated ${escapeHtml(generated)}</p>

  <div class="summary">
    <dl>
      <dt>Source file</dt><dd>${escapeHtml(session.filename ?? 'none')}</dd>
      <dt>Rows</dt><dd>${session.preview ? session.preview.rows.toLocaleString('en-US') : '—'}</dd>
      <dt>Columns</dt><dd>${cols.length || '—'}</dd>
      <dt>Questions</dt><dd>${session.turns.length}</dd>
    </dl>
  </div>

  ${turns || '<p>No questions were asked in this session.</p>'}

  <footer>
    <p><strong>How to read this.</strong> Every figure was computed by an AI agent
    running Python over the uploaded file. The caveats in each answer are part of
    the finding, not boilerplate — read them before acting on a number. Anything
    the agent could not determine from these ${cols.length || 'the'} columns is
    said so explicitly rather than estimated.</p>
    <p>Charts are embedded in this file, so it stays readable offline and after
    the analysis session ends.</p>
  </footer>
</main>
</body>
</html>`
}
