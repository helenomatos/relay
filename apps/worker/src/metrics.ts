import http from "node:http";
import client from "prom-client";

export const registry = new client.Registry();
registry.setDefaultLabels({ service: "worker" });
client.collectDefaultMetrics({ register: registry });

export const attemptsTotal = new client.Counter({
  name: "relay_delivery_attempts_total",
  help: "Delivery attempts by outcome",
  labelNames: ["outcome"] as const, // succeeded | retrying | dead | deferred
  registers: [registry],
});

export const attemptDuration = new client.Histogram({
  name: "relay_delivery_duration_seconds",
  help: "HTTP round-trip time to the endpoint",
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const outboxPending = new client.Gauge({
  name: "relay_outbox_pending",
  help: "Deliveries waiting in the outbox (due now or scheduled for retry)",
  registers: [registry],
});

export const queueDepth = new client.Gauge({
  name: "relay_queue_depth",
  help: "Jobs in the BullMQ queue",
  labelNames: ["state"] as const,
  registers: [registry],
});

export const circuitOpens = new client.Counter({
  name: "relay_circuit_opened_total",
  help: "Times an endpoint circuit breaker opened",
  registers: [registry],
});

export function serveMetrics(port: number) {
  return http
    .createServer(async (req, res) => {
      if (req.url === "/metrics") {
        res.writeHead(200, { "content-type": registry.contentType });
        res.end(await registry.metrics());
      } else if (req.url === "/health") {
        res.writeHead(200).end("ok");
      } else {
        res.writeHead(404).end();
      }
    })
    .listen(port);
}
