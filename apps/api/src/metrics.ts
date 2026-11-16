import client from "prom-client";

export const registry = new client.Registry();
registry.setDefaultLabels({ service: "api" });
client.collectDefaultMetrics({ register: registry });

export const eventsIngested = new client.Counter({
  name: "relay_events_ingested_total",
  help: "Events accepted by the API",
  labelNames: ["duplicate"] as const,
  registers: [registry],
});

export const httpDuration = new client.Histogram({
  name: "relay_http_request_duration_seconds",
  help: "API request latency",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});
