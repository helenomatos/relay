import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sql } from "../db";
import { eventsIngested } from "../metrics";
import { parseLimit } from "../validation";

const EventBody = z.object({
  type: z.string().min(1).max(100).regex(/^[a-z0-9_.-]+$/i),
  payload: z.record(z.string(), z.unknown()),
});

export async function eventRoutes(app: FastifyInstance) {
  app.post("/events", async (req, reply) => {
    const body = EventBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", issues: body.error.issues });

    const idemHeader = req.headers["idempotency-key"];
    const idempotencyKey = typeof idemHeader === "string" && idemHeader.length > 0 ? idemHeader : null;
    if (idempotencyKey && idempotencyKey.length > 200) {
      return reply.code(400).send({ error: "idempotency_key_too_long" });
    }

    const { type, payload } = body.data;
    const tenantId = req.tenantId;

    // The event and its outbox rows commit together, or not at all.
    const result = await sql.begin(async (tx) => {
      const [event] = await tx<{ id: string }[]>`
        insert into events (tenant_id, type, payload, idempotency_key)
        values (${tenantId}, ${type}, ${tx.json(payload as never)}, ${idempotencyKey})
        on conflict (tenant_id, idempotency_key) do nothing
        returning id`;

      if (!event) {
        const [existing] = await tx<{ id: string }[]>`
          select id from events where tenant_id = ${tenantId} and idempotency_key = ${idempotencyKey}`;
        return { id: existing!.id, duplicate: true, deliveries: 0 };
      }

      const deliveries = await tx`
        insert into deliveries (tenant_id, event_id, endpoint_id)
        select tenant_id, ${event.id}, id from endpoints
        where tenant_id = ${tenantId} and enabled
          and (cardinality(event_types) = 0 or ${type} = any(event_types))
        returning id`;
      return { id: event.id, duplicate: false, deliveries: deliveries.length };
    });

    eventsIngested.inc({ duplicate: String(result.duplicate) });
    return reply.code(result.duplicate ? 200 : 202).send(result);
  });

  app.get("/events", async (req) => {
    const limit = parseLimit((req.query as { limit?: string }).limit);
    return sql`
      select id, type, payload, idempotency_key, created_at from events
      where tenant_id = ${req.tenantId} order by created_at desc limit ${limit}`;
  });
}
