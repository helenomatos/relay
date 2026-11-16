import type { FastifyInstance } from "fastify";
import { sql } from "../db";
import { isUuid, parseLimit } from "../validation";

const STATUSES = new Set(["pending", "queued", "delivering", "succeeded", "dead"]);

export async function deliveryRoutes(app: FastifyInstance) {
  app.get("/deliveries", async (req, reply) => {
    const q = req.query as { status?: string; limit?: string };
    if (q.status && !STATUSES.has(q.status)) return reply.code(400).send({ error: "invalid_status" });
    const limit = parseLimit(q.limit);
    return sql`
      select d.id, d.status, d.attempts, d.last_status_code, d.last_error, d.last_latency_ms,
             d.next_attempt_at, d.created_at, d.updated_at, d.delivered_at,
             e.id as event_id, e.type as event_type, ep.url as endpoint_url
      from deliveries d
      join events e on e.id = d.event_id
      join endpoints ep on ep.id = d.endpoint_id
      where d.tenant_id = ${req.tenantId} ${q.status ? sql`and d.status = ${q.status}` : sql``}
      order by d.updated_at desc
      limit ${limit}`;
  });

  app.get("/deliveries/:id/attempts", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) return reply.code(404).send({ error: "not_found" });
    return sql`
      select attempt, ok, status_code, error, latency_ms, created_at from delivery_attempts
      where delivery_id = ${id} and tenant_id = ${req.tenantId} order by attempt`;
  });

  // Dead-letter replay: back into the outbox with a fresh retry budget.
  app.post("/deliveries/:id/replay", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) return reply.code(404).send({ error: "not_found_or_not_dead" });
    const rows = await sql`
      update deliveries set status = 'pending', attempts = 0, next_attempt_at = now(), updated_at = now()
      where id = ${id} and tenant_id = ${req.tenantId} and status = 'dead' returning id`;
    return rows.length ? { replayed: 1 } : reply.code(404).send({ error: "not_found_or_not_dead" });
  });

  app.post("/deliveries/replay-dead", async (req) => {
    const rows = await sql`
      update deliveries set status = 'pending', attempts = 0, next_attempt_at = now(), updated_at = now()
      where tenant_id = ${req.tenantId} and status = 'dead' returning id`;
    return { replayed: rows.length };
  });

  app.get("/stats", async (req) => {
    const t = req.tenantId;
    const [deliveries, attempts, events] = await Promise.all([
      sql`
        select count(*)::int as total,
               count(*) filter (where status = 'succeeded')::int as succeeded,
               count(*) filter (where status = 'succeeded' and attempts = 1)::int as first_try,
               count(*) filter (where status in ('pending','queued','delivering') and attempts = 0)::int as inflight,
               count(*) filter (where status in ('pending','queued','delivering') and attempts > 0)::int as retrying,
               count(*) filter (where status = 'dead')::int as dead
        from deliveries where tenant_id = ${t}`,
      sql`
        select count(*) filter (where ok and created_at > now() - interval '5 seconds')::int as ok_last5s,
               percentile_cont(0.95) within group (order by latency_ms) as p95_ms
        from delivery_attempts where tenant_id = ${t} and created_at > now() - interval '60 seconds'`,
      sql`select count(*)::int as events from events where tenant_id = ${t}`,
    ]);
    const a = attempts[0]!;
    return {
      ...deliveries[0],
      events: events[0]!.events,
      throughput: Math.round(Number(a.okLast5s) / 5),
      p95Ms: a.p95Ms === null ? null : Math.round(Number(a.p95Ms)),
    };
  });

  // Wipes the tenant's events (cascades to deliveries and attempts). Demo convenience.
  app.post("/demo/reset", async (req) => {
    await sql`delete from events where tenant_id = ${req.tenantId}`;
    return { ok: true };
  });
}
