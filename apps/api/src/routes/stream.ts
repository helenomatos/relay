import type { ServerResponse } from "node:http";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { config } from "../config";

const CHANNEL = "relay:activity";
const FLUSH_MS = 300;
const MAX_BATCH = 40;

/**
 * Server-Sent Events feed of delivery attempts. Workers publish every attempt
 * to Redis pub/sub; we batch per tenant so a 10k-event burst doesn't flood the browser.
 */
export async function streamRoutes(app: FastifyInstance) {
  const sub = new Redis(config.redisUrl);
  const clients = new Map<string, Set<ServerResponse>>();
  const buffers = new Map<string, unknown[]>();

  await sub.subscribe(CHANNEL);
  sub.on("message", (_channel, message) => {
    const activity = JSON.parse(message) as { tenantId: string };
    if (!clients.get(activity.tenantId)?.size) return;
    const buf = buffers.get(activity.tenantId) ?? [];
    buf.push(activity);
    if (buf.length > MAX_BATCH) buf.shift();
    buffers.set(activity.tenantId, buf);
  });

  const flush = setInterval(() => {
    for (const [tenantId, buf] of buffers) {
      if (!buf.length) continue;
      const frame = `data: ${JSON.stringify(buf)}\n\n`;
      for (const res of clients.get(tenantId) ?? []) res.write(frame);
      buffers.set(tenantId, []);
    }
  }, FLUSH_MS);
  const heartbeat = setInterval(() => {
    for (const set of clients.values()) for (const res of set) res.write(": ping\n\n");
  }, 15_000);

  app.addHook("onClose", async () => {
    clearInterval(flush);
    clearInterval(heartbeat);
    sub.disconnect();
  });

  app.get("/stream", (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");
    const set = clients.get(req.tenantId) ?? new Set();
    set.add(res);
    clients.set(req.tenantId, set);
    req.raw.on("close", () => set.delete(res));
  });
}
