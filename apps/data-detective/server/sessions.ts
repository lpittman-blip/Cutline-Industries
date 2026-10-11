/**
 * In-memory session store.
 *
 * A session holds one uploaded CSV, the conversation so far, and whatever the
 * sandbox produced, so follow-up questions keep their context and the report
 * can be assembled from everything that has happened.
 *
 * Deliberately in-memory: this is a demo, and process memory keeps uploaded
 * customer data out of any durable store. The cost is that a restart loses
 * sessions, which is the right trade for data someone uploaded to try the app.
 */
import type { AgentInputItem } from '@openai/agents'

export type Turn = {
  question: string
  answer: string
  charts: ChartRef[]
  askedAt: string
}

export type ChartRef = {
  containerId: string
  fileId: string
  /** Best-effort filename from the model's annotation, for the report. */
  name: string
}

export type Session = {
  id: string
  createdAt: number
  lastSeen: number
  /** OpenAI Files API id for the uploaded CSV, passed to the sandbox. */
  fileId: string | null
  filename: string | null
  /** Header row and row count, computed locally so the UI can show a preview. */
  preview: { columns: string[]; rows: number; sample: string[][] } | null
  history: AgentInputItem[]
  turns: Turn[]
  /** Set once the sandbox allocates a container, so charts can be fetched. */
  containerId: string | null
}

const SESSIONS = new Map<string, Session>()

/** Sessions idle longer than this are dropped, along with the uploaded data. */
export const SESSION_TTL_MS = 60 * 60 * 1000

export function createSession(): Session {
  const session: Session = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    lastSeen: Date.now(),
    fileId: null,
    filename: null,
    preview: null,
    history: [],
    turns: [],
    containerId: null,
  }
  SESSIONS.set(session.id, session)
  return session
}

export function getSession(id: string | undefined): Session | undefined {
  if (!id) return undefined
  const session = SESSIONS.get(id)
  if (!session) return undefined
  if (Date.now() - session.lastSeen > SESSION_TTL_MS) {
    SESSIONS.delete(id)
    return undefined
  }
  session.lastSeen = Date.now()
  return session
}

export function sweepSessions(now = Date.now()): number {
  let dropped = 0
  for (const [id, s] of SESSIONS) {
    if (now - s.lastSeen > SESSION_TTL_MS) {
      SESSIONS.delete(id)
      dropped++
    }
  }
  return dropped
}

export function sessionCount(): number {
  return SESSIONS.size
}

/** Test seam: drop everything between self-test cases. */
export function _resetSessions(): void {
  SESSIONS.clear()
}
