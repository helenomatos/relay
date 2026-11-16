import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { verify } from "@relay/core";

/**
 * A deliberately unreliable webhook consumer, used to prove Relay's guarantees.
 * Chaos knobs (failure rate, latency, full outage) are controlled at runtime via
 * PUT /chaos. It verifies every signature and deduplicates by webhook-id, the
 * way a well-behaved consumer of an at-least-once system should.
 */

const secret = process.env.RECEIVER_SECRET;
if (!secret) throw new Error("Missing env var RECEIVER_SECRET");
const port = Number(process.env.PORT ?? 4000);

interface Chaos {
  failRate: number; // 0..1 — share of requests answered with a 5xx
  latencyMs: number; // added response latency (±50% jitter)
  outage: boolean; // refuse everything with 503
}

const chaos: Chaos = { failRate: 0, latencyMs: 0, outage: false };
const seen = new Set<string>();
const stats = { requests: 0, accepted: 0, duplicates: 0, chaosRejected: 0, invalidSignature: 0 };

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,PUT,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(JSON.stringify(body));
};

const MAX_BODY = 1024 * 1024;

const readBody = async (req: http.IncomingMessage) => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw Object.assign(new Error("payload_too_large"), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
};

async function handleHook(req: http.IncomingMessage, res: http.ServerResponse, name: string) {
  stats.requests++;
  const body = await readBody(req);

  if (chaos.outage) {
    stats.chaosRejected++;
    return json(res, 503, { error: "service_unavailable" });
  }
  if (chaos.latencyMs > 0) await sleep(chaos.latencyMs * (0.5 + Math.random()));
  if (Math.random() < chaos.failRate) {
    stats.chaosRejected++;
    return json(res, 500, { error: "chaos" });
  }

  const headers = {
    id: req.headers["webhook-id"] as string | undefined,
    timestamp: req.headers["webhook-timestamp"] as string | undefined,
    signature: req.headers["webhook-signature"] as string | undefined,
  };
  if (!verify(secret!, headers, body)) {
    stats.invalidSignature++;
    return json(res, 401, { error: "invalid_signature" });
  }

  // Idempotent consumer: a redelivered message is acknowledged but not processed twice.
  const key = `${name}:${headers.id}`;
  if (seen.has(key)) {
    stats.duplicates++;
  } else {
    seen.add(key);
    stats.accepted++;
  }
  return json(res, 200, { ok: true });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (req.method === "OPTIONS") return json(res, 204, {});
    const hook = url.pathname.match(/^\/hooks\/([\w-]+)$/);
    if (hook && req.method === "POST") return await handleHook(req, res, hook[1]!);

    if (url.pathname === "/chaos" && req.method === "GET") return json(res, 200, chaos);
    if (url.pathname === "/chaos" && req.method === "PUT") {
      const patch = JSON.parse((await readBody(req)) || "{}") as Partial<Chaos>;
      if (typeof patch.failRate === "number") chaos.failRate = Math.min(1, Math.max(0, patch.failRate));
      if (typeof patch.latencyMs === "number") chaos.latencyMs = Math.min(9_000, Math.max(0, patch.latencyMs));
      if (typeof patch.outage === "boolean") chaos.outage = patch.outage;
      return json(res, 200, chaos);
    }
    if (url.pathname === "/stats") return json(res, 200, { ...stats, unique: seen.size });
    if (url.pathname === "/reset" && req.method === "POST") {
      seen.clear();
      Object.assign(stats, { requests: 0, accepted: 0, duplicates: 0, chaosRejected: 0, invalidSignature: 0 });
      Object.assign(chaos, { failRate: 0, latencyMs: 0, outage: false });
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/health") return json(res, 200, { ok: true });
    return json(res, 404, { error: "not_found" });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return json(res, status, { error: status === 500 ? "internal_error" : (err as Error).message });
  }
});

server.keepAliveTimeout = 65_000;
server.listen(port, () => console.log(`chaos receiver listening on :${port}`));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
