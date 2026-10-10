import type { Database } from "bun:sqlite";
import { newId, nowIso } from "./db.ts";

export const SCOPES = ["chat", "agent", "search", "sessions", "webhooks", "admin"] as const;
export type Scope = (typeof SCOPES)[number];

export interface ApiKeyRecord {
  id: string;
  name: string;
  prefix: string;
  scopes: Scope[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export function hashKey(raw: string): string {
  return new Bun.CryptoHasher("sha256").update(raw).digest("hex");
}

function row(r: any): ApiKeyRecord {
  return { id: r.id, name: r.name, prefix: r.prefix, scopes: JSON.parse(r.scopes), created_at: r.created_at, last_used_at: r.last_used_at, revoked_at: r.revoked_at };
}

/** Create a key. The raw secret is returned once; only its SHA-256 is stored. */
export function createKey(db: Database, name: string, scopes: Scope[], raw?: string): { key: string; record: ApiKeyRecord } {
  const secret = raw ?? `art_${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex")}`;
  const id = newId("key");
  const prefix = secret.slice(0, 12);
  db.query("INSERT INTO api_keys (id,name,prefix,hash,scopes,created_at) VALUES (?,?,?,?,?,?)").run(id, name, prefix, hashKey(secret), JSON.stringify(scopes), nowIso());
  return { key: secret, record: getKey(db, id)! };
}

export function getKey(db: Database, id: string): ApiKeyRecord | null {
  const r = db.query("SELECT * FROM api_keys WHERE id = ?").get(id);
  return r ? row(r) : null;
}

export function listKeys(db: Database): ApiKeyRecord[] {
  return db.query("SELECT * FROM api_keys ORDER BY created_at").all().map(row);
}

export function revokeKey(db: Database, id: string): boolean {
  return db.query("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(nowIso(), id).changes > 0;
}

export function countKeys(db: Database): number {
  return (db.query("SELECT COUNT(*) AS n FROM api_keys WHERE revoked_at IS NULL").get() as any).n;
}

export function authenticate(db: Database, header: string | undefined | null): ApiKeyRecord | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return null;
  const r: any = db.query("SELECT * FROM api_keys WHERE hash = ? AND revoked_at IS NULL").get(hashKey(m[1]!.trim()));
  if (!r) return null;
  db.query("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(nowIso(), r.id);
  return row(r);
}

export function hasScope(k: ApiKeyRecord, s: Scope): boolean {
  return k.scopes.includes("admin") || k.scopes.includes(s);
}
