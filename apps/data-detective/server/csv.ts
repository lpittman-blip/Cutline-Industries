/**
 * Just enough CSV parsing to show the user what they uploaded.
 *
 * The real analysis happens in pandas inside the sandbox. This exists only so
 * the browser can show columns and a few rows immediately, before any model
 * call — and so an upload that is not actually a CSV is rejected locally rather
 * than discovered three API calls later.
 *
 * It handles quoted fields, embedded commas, escaped quotes and CRLF, which is
 * what real exports contain. It does not handle every dialect, and it does not
 * need to.
 */

export type Preview = { columns: string[]; rows: number; sample: string[][] }

export class CsvError extends Error {}

/** Parse one line, respecting quotes. Returns the fields. */
export function parseLine(line: string): string[] {
  const out: string[] = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      out.push(field)
      field = ''
    } else {
      field += ch
    }
  }
  out.push(field)
  return out
}

/**
 * Split on newlines that are not inside quotes. A naive split('\n') breaks any
 * file with a comment or address field, which is most real data.
 */
export function splitRows(text: string): string[] {
  const rows: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"') {
      inQuotes = !inQuotes
      // A doubled quote inside a quoted field is an escaped quote, not a toggle.
      if (inQuotes === false && text[i + 1] === '"') {
        inQuotes = true
        current += '""'
        i++
        continue
      }
      current += ch
      continue
    }
    if (!inQuotes && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && text[i + 1] === '\n') i++
      rows.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current.length) rows.push(current)
  return rows.filter((r) => r.trim().length > 0)
}

export function preview(text: string, sampleRows = 5): Preview {
  const rows = splitRows(text)
  if (rows.length === 0) throw new CsvError('The file is empty.')

  const columns = parseLine(rows[0]).map((c) => c.trim())
  if (columns.length < 2) {
    throw new CsvError(
      'That does not look like a CSV — the first line has no commas. ' +
        'Export as comma-separated values and try again.',
    )
  }
  if (columns.some((c) => c.length === 0)) {
    throw new CsvError('The header row has a blank column name.')
  }

  const sample = rows.slice(1, 1 + sampleRows).map(parseLine)
  return { columns, rows: rows.length - 1, sample }
}
