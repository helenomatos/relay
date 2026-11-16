import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { generateSecret } from "@relay/core";
import { sql } from "../db";

const EndpointBody = z.object({
  url: z.string().url(),
  eventTypes: z.array(z.string().min(1)).default([]),
  secret: z.string().startsWith("whsec_").optional(),
});

export async function endpointRoutes(app: FastifyInstance) {
  app.post("/endpoints", async (req, reply) => {
    const body = EndpointBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", issues: body.error.issues });
    const { url, eventTypes, secret = generateSecret() } = body.data;
    const [endpoint] = await sql`
      insert into endpoints (tenant_id, url, secret, event_types)
      values (${req.tenantId}, ${url}, ${secret}, ${eventTypes})
      returning id, url, event_types, enabled, created_at`;
    // The signing secret is only ever returned once, at creation.
    return reply.code(201).send({ ...endpoint, secret });
  });

  app.get("/endpoints", async (req) =>
    sql`select id, url, event_types, enabled, created_at from endpoints where tenant_id = ${req.tenantId} order by created_at`,
  );

  app.patch("/endpoints/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const [row] = await sql`
      update endpoints set enabled = ${body.data.enabled}
      where id = ${id} and tenant_id = ${req.tenantId} returning id, url, enabled`;
    return row ?? reply.code(404).send({ error: "not_found" });
  });
}
