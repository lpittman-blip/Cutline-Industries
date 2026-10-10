/** Fixed-window rate limiter keyed by API key id (or client IP when unauthenticated). */
export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();
  constructor(public limit: number, public windowMs = 60_000) {}

  hit(id: string, now = Date.now()): { allowed: boolean; remaining: number; resetMs: number } {
    let w = this.windows.get(id);
    if (!w || now - w.start >= this.windowMs) {
      w = { start: now, count: 0 };
      this.windows.set(id, w);
    }
    w.count++;
    if (this.windows.size > 10_000) {
      for (const [k, v] of this.windows) if (now - v.start >= this.windowMs) this.windows.delete(k);
    }
    return { allowed: w.count <= this.limit, remaining: Math.max(0, this.limit - w.count), resetMs: w.start + this.windowMs - now };
  }
}
