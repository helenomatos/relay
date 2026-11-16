import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { sql } from "./db";

export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

const cache = new Map<string, { tenantId: string; expires: number }>();

async function tenantForKey(key: string): Promise<string | null> {
  const hash = hashKey(key);
  const hit = cache.get(hash);
  if (hit && hit.expires > Date.now()) return hit.tenantId;
  const [row] = await sql<{ tenantId: string }[]>`select tenant_id from api_keys where key_hash = ${hash}`;
  if (!row) return null;
  cache.set(hash, { tenantId: row.tenantId, expires: Date.now() + 60_000 });
  return row.tenantId;
}

declare module "fastify" {
  interface FastifyRequest {
    tenantId: string;
  }
}

export async function authenticate(req: FastifyRequest, reply: FastifyReply) {
  const header = req.headers.authorization;
  // EventSource can't send headers, so the stream endpoint accepts ?key=
  const key = header?.startsWith("Bearer ") ? header.slice(7) : (req.query as { key?: string }).key;
  const tenantId = key ? await tenantForKey(key) : null;
  if (!tenantId) return reply.code(401).send({ error: "invalid_api_key" });
  req.tenantId = tenantId;
}
