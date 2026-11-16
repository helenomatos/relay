import cors from "@fastify/cors";
import Fastify from "fastify";
import { authenticate } from "./auth";
import { config } from "./config";
import { sql } from "./db";
import { httpDuration, registry } from "./metrics";
import { deliveryRoutes } from "./routes/deliveries";
import { endpointRoutes } from "./routes/endpoints";
import { eventRoutes } from "./routes/events";
import { streamRoutes } from "./routes/stream";
import { seedDemo } from "./seed";

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

// Per-request access logs are noise at thousands of req/s; metrics cover them.
const quiet = { logLevel: "warn" } as const;

await app.register(cors, { origin: true });

// Never leak internals (SQL errors, stack traces) to clients.
app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
  const status = err.statusCode ?? 500;
  if (status >= 500) {
    req.log.error(err);
    return reply.code(status).send({ error: "internal_error" });
  }
  return reply.code(status).send({ error: err.name === "FastifyError" ? "bad_request" : err.name, message: err.message });
});

app.addHook("onResponse", async (req, reply) => {
  const route = req.routeOptions.url ?? "unknown";
  if (route === "/metrics" || route === "/v1/stream") return;
  httpDuration.observe({ method: req.method, route, status: reply.statusCode }, reply.elapsedTime / 1000);
});

app.get("/health", quiet, async () => {
  await sql`select 1`;
  return { ok: true };
});

app.get("/metrics", quiet, async (_req, reply) => reply.type(registry.contentType).send(await registry.metrics()));

await app.register(
  async (v1) => {
    v1.addHook("onRequest", authenticate);
    await v1.register(eventRoutes);
    await v1.register(endpointRoutes);
    await v1.register(deliveryRoutes);
    await v1.register(streamRoutes);
  },
  { prefix: "/v1", ...quiet },
);

await seedDemo((msg) => app.log.info(msg));

const shutdown = async () => {
  await app.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ port: config.port, host: "0.0.0.0" });
