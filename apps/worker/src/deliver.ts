import { backoffMs, sign } from "@relay/core";
import type { Redis } from "ioredis";
import type { Sql } from "postgres";
import type { CircuitBreaker } from "./circuit";
import { config } from "./config";
import { attemptDuration, attemptsTotal } from "./metrics";

export const ACTIVITY_CHANNEL = "relay:activity";

interface Delivery {
  id: string;
  tenantId: string;
  eventId: string;
  endpointId: string;
  attempts: number;
}

interface Target {
  type: string;
  payload: unknown;
  createdAt: Date;
  url: string;
  secret: string;
}

type Outcome = "succeeded" | "retrying" | "dead" | "deferred";

export function createDeliverer(sql: Sql, redis: Redis, circuit: CircuitBreaker) {
  const publish = (delivery: Delivery, target: Target, outcome: Outcome, extra: Record<string, unknown>) =>
    redis.publish(
      ACTIVITY_CHANNEL,
      JSON.stringify({
        tenantId: delivery.tenantId,
        deliveryId: delivery.id,
        eventId: delivery.eventId,
        eventType: target.type,
        endpoint: new URL(target.url).pathname,
        outcome,
        at: Date.now(),
        ...extra,
      }),
    );

  return async function deliver(deliveryId: string): Promise<void> {
    // Claim: only a row still 'queued' can be picked up, so a duplicated job is a no-op.
    const [delivery] = await sql<Delivery[]>`
      update deliveries set status = 'delivering', updated_at = now()
      where id = ${deliveryId} and status = 'queued'
      returning id, tenant_id, event_id, endpoint_id, attempts`;
    if (!delivery) return;

    const [target] = await sql<Target[]>`
      select e.type, e.payload, e.created_at, ep.url, ep.secret
      from events e, endpoints ep
      where e.id = ${delivery.eventId} and ep.id = ${delivery.endpointId}`;
    if (!target) return;

    const openUntil = await circuit.openUntil(delivery.endpointId);
    if (openUntil) {
      // Circuit open: park it until the cool-down ends (+ jitter), retry budget untouched.
      const resumeAt = new Date(openUntil + Math.random() * 2_000);
      await sql`
        update deliveries set status = 'pending', next_attempt_at = ${resumeAt}, updated_at = now()
        where id = ${delivery.id}`;
      attemptsTotal.inc({ outcome: "deferred" });
      await publish(delivery, target, "deferred", { attempt: delivery.attempts });
      return;
    }

    const attempt = delivery.attempts + 1;
    const body = JSON.stringify({
      id: delivery.eventId,
      type: target.type,
      timestamp: target.createdAt.toISOString(),
      data: target.payload,
    });
    const ts = Math.floor(Date.now() / 1000);

    let statusCode: number | null = null;
    let error: string | null = null;
    const started = performance.now();
    try {
      const res = await fetch(target.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "Relay-Webhooks/1.0",
          "webhook-id": delivery.eventId,
          "webhook-timestamp": String(ts),
          "webhook-signature": sign(target.secret, delivery.eventId, ts, body),
        },
        body,
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
      statusCode = res.status;
      await res.body?.cancel();
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } };
      error = e.name === "TimeoutError" ? "timeout" : (e.cause?.code ?? e.message);
    }
    const latencyMs = Math.round(performance.now() - started);
    attemptDuration.observe(latencyMs / 1000);

    const ok = statusCode !== null && statusCode >= 200 && statusCode < 300;
    const outcome: Outcome = ok ? "succeeded" : attempt >= config.maxAttempts ? "dead" : "retrying";
    const nextAttemptAt = new Date(
      Date.now() + backoffMs(attempt, { baseMs: config.backoffBaseMs, capMs: config.backoffCapMs }),
    );

    await sql.begin(async (tx) => {
      await tx`
        insert into delivery_attempts (delivery_id, tenant_id, attempt, ok, status_code, error, latency_ms)
        values (${delivery.id}, ${delivery.tenantId}, ${attempt}, ${ok}, ${statusCode}, ${error}, ${latencyMs})`;
      if (outcome === "succeeded") {
        await tx`
          update deliveries set status = 'succeeded', attempts = ${attempt}, last_status_code = ${statusCode},
                 last_error = null, last_latency_ms = ${latencyMs}, delivered_at = now(), updated_at = now()
          where id = ${delivery.id}`;
      } else {
        // Retries are durable: the schedule lives in Postgres, not in Redis memory.
        await tx`
          update deliveries set status = ${outcome === "dead" ? "dead" : "pending"}, attempts = ${attempt},
                 next_attempt_at = ${nextAttemptAt}, last_status_code = ${statusCode}, last_error = ${error},
                 last_latency_ms = ${latencyMs}, updated_at = now()
          where id = ${delivery.id}`;
      }
    });

    if (ok) await circuit.recordSuccess(delivery.endpointId);
    else await circuit.recordFailure(delivery.endpointId);

    attemptsTotal.inc({ outcome });
    await publish(delivery, target, outcome, { attempt, statusCode, latencyMs, error });
  };
}
