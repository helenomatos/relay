import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assertPublicUrl, generateSecret, UnsafeUrlError } from "@relay/core";
import { config } from "../config";
import { sql } from "../db";
import { isUuid } from "../validation";

const EndpointBody = z.object({
  url: z.url({ protocol: /^https?$/ }).max(2048),
  eventTypes: z.array(z.string().min(1).max(100)).max(50).default([]),
  secret: z.string().startsWith("whsec_").optional(),
});

export async function endpointRoutes(app: FastifyInstance) {
  app.post("/endpoints", async (req, reply) => {
    const body = EndpointBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", issues: body.error.issues });
    const { url, eventTypes, secret = generateSecret() } = body.data;
    if (!config.allowPrivateEndpoints) {
      try {
        await assertPublicUrl(url);
      } catch (err) {
        if (err instanceof UnsafeUrlError) return reply.code(400).send({ error: "unsafe_url", message: err.message });
        throw err;
      }
    }
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
    if (!isUuid(id)) return reply.code(404).send({ error: "not_found" });
    const body = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const [row] = await sql`
      update endpoints set enabled = ${body.data.enabled}
      where id = ${id} and tenant_id = ${req.tenantId} returning id, url, enabled`;
    return row ?? reply.code(404).send({ error: "not_found" });
  });
}
