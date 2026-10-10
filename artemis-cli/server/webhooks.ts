import type { Database } from "bun:sqlite";
import { createHmac, timingSafeEqual } from "node:crypto";
import { newId, nowIso } from "./db.ts";

export const WEBHOOK_EVENTS = ["run.completed", "run.needs_approval"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export function signPayload(secret: string, body: string, timestamp: number): string {
  const sig = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${sig}`;
}

/** Verify an `Artemis-Signature` header. Same algorithm the SDK exports. */
export function verifySignature(secret: string, body: string, header: string, toleranceSec = 300, now = Date.now()): boolean {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!parts.v1 || !Number.isFinite(t)) return false;
  if (Math.abs(now / 1000 - t) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest();
  const got = Buffer.from(parts.v1, "hex");
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export interface WebhookRecord { id: string; url: string; events: string[]; description: string | null; created_at: string; disabled_at: string | null }

const toRec = (r: any): WebhookRecord => ({ id: r.id, url: r.url, events: JSON.parse(r.events), description: r.description, created_at: r.created_at, disabled_at: r.disabled_at });

export class Webhooks {
  constructor(private db: Database, private opts: { maxAttempts: number; retryBaseMs: number; timeoutMs?: number; fetchImpl?: typeof fetch }) {}

  create(url: string, events: string[], description?: string): { webhook: WebhookRecord; secret: string } {
    const id = newId("wh");
    const secret = `whsec_${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex")}`;
    this.db.query("INSERT INTO webhooks (id,url,secret,events,description,created_at) VALUES (?,?,?,?,?,?)").run(id, url, secret, JSON.stringify(events), description ?? null, nowIso());
    return { webhook: this.get(id)!, secret };
  }
  get(id: string) { const r = this.db.query("SELECT * FROM webhooks WHERE id=?").get(id); return r ? toRec(r) : null; }
  list() { return this.db.query("SELECT * FROM webhooks ORDER BY created_at").all().map(toRec); }
  delete(id: string) { return this.db.query("DELETE FROM webhooks WHERE id=?").run(id).changes > 0; }
  deliveries(id: string) {
    return this.db.query("SELECT id,event,status,attempts,last_status_code,last_error,created_at,updated_at FROM webhook_deliveries WHERE webhook_id=? ORDER BY created_at DESC LIMIT 100").all(id);
  }

  /** Fan out an event to subscribed webhooks; deliveries retry in the background. */
  emit(event: WebhookEvent, data: unknown): Promise<void>[] {
    const hooks = this.db.query("SELECT * FROM webhooks WHERE disabled_at IS NULL").all() as any[];
    const jobs: Promise<void>[] = [];
    for (const h of hooks) {
      const events: string[] = JSON.parse(h.events);
      if (!events.includes(event) && !events.includes("*")) continue;
      const deliveryId = newId("dlv");
      const payload = JSON.stringify({ id: deliveryId, type: event, created_at: nowIso(), data });
      this.db.query("INSERT INTO webhook_deliveries (id,webhook_id,event,payload,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(deliveryId, h.id, event, payload, "pending", nowIso(), nowIso());
      jobs.push(this.deliver(deliveryId, h.url, h.secret, event, payload));
    }
    return jobs;
  }

  private async deliver(deliveryId: string, url: string, secret: string, event: string, payload: string): Promise<void> {
    const f = this.opts.fetchImpl ?? fetch;
    for (let attempt = 1; attempt <= this.opts.maxAttempts; attempt++) {
      let code: number | null = null;
      let error: string | null = null;
      try {
        const ts = Math.floor(Date.now() / 1000);
        const res = await f(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "Artemis-Webhooks/1.0",
            "artemis-event": event,
            "artemis-delivery": deliveryId,
            "artemis-signature": signPayload(secret, payload, ts),
          },
          body: payload,
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
        });
        code = res.status;
        if (res.ok) {
          this.db.query("UPDATE webhook_deliveries SET status='delivered', attempts=?, last_status_code=?, last_error=NULL, updated_at=? WHERE id=?").run(attempt, code, nowIso(), deliveryId);
          return;
        }
        error = `HTTP ${code}`;
      } catch (e) {
        error = (e as Error).message;
      }
      const final = attempt === this.opts.maxAttempts;
      this.db.query("UPDATE webhook_deliveries SET status=?, attempts=?, last_status_code=?, last_error=?, updated_at=? WHERE id=?").run(final ? "failed" : "retrying", attempt, code, error, nowIso(), deliveryId);
      if (!final) await Bun.sleep(this.opts.retryBaseMs * 2 ** (attempt - 1));
    }
  }
}
