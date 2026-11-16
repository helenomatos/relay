# Relay

[![CI](https://github.com/helenomatos/relay/actions/workflows/ci.yml/badge.svg)](https://github.com/helenomatos/relay/actions/workflows/ci.yml)

**Reliable webhook delivery: at-least-once, signed, observable, and tested under chaos.**

Relay takes events from your application and delivers them to your customers' HTTP endpoints. It keeps delivering when those endpoints fail, slow down, or go offline, and when Relay's own workers crash.

![Relay dashboard during a chaos run: 30% failures, a consumer outage, and 0 lost](docs/demo.gif)

## The result

The test machine was a laptop running Docker Desktop. The consumer endpoint ran in chaos mode: 20–38% of requests got a 5xx, and it had full outages. On top of that, the worker was killed with `SIGKILL` mid-run.

| Scenario | Deliveries | Delivered | Lost | Notes |
|---|---|---|---|---|
| 5,000 events, 30% failures, 15 s consumer outage | 7,497 | 7,497 | **0** | 3,240 failed requests retried automatically |
| 10,000 events, 20% failures, +300 ms latency, **worker `kill -9` mid-flight** | 15,000 | 15,000 | **0** | 4,300+ in-flight deliveries reclaimed; 40 redeliveries deduplicated by the consumer |
| 10,000 events from the dashboard, 30% failures, manual outage | 15,000 | 15,000 | **0** | circuit breaker opened during the outage; backlog drained at ~660 deliveries/s |

Ingestion: **~1,000 events/s, p95 104 ms** (k6, 50 VUs, 0 errors).

"Delivered" is not just a status in Relay's own database. The consumer independently verifies each HMAC signature, counts unique message ids, and the test compares the two sides.

## Architecture

```mermaid
flowchart LR
    App[Your app] -->|POST /v1/events<br/>Idempotency-Key| API
    subgraph Relay
      API[API · Fastify] -->|single transaction:<br/>event + outbox rows| PG[(Postgres)]
      PG -->|outbox relay<br/>FOR UPDATE SKIP LOCKED| Q[[BullMQ · Redis]]
      Q --> W[Workers]
      W -->|attempt log, retry schedule| PG
      W -->|activity pub/sub| R[(Redis)]
      R -->|SSE| API
    end
    W -->|signed POST<br/>webhook-id / timestamp / signature| C[Customer endpoint]
    API --> D[Dashboard]
    W & API -->|/metrics| P[Prometheus] --> G[Grafana]
```

### How the guarantees are built

- **Transactional outbox.** An event and its delivery rows (one per subscribed endpoint) are written in the same Postgres transaction. If the API says `202`, the delivery exists, so there is no gap where an event is in the DB but never reaches the queue.
- **Postgres is the source of truth, Redis is the dispatcher.** The retry schedule (`next_attempt_at`) lives in Postgres. If Redis is flushed, nothing is lost, because the outbox relay re-enqueues anything due.
- **Horizontal scaling without double-claiming.** The outbox relay claims rows with `FOR UPDATE SKIP LOCKED`, so any number of worker replicas can poll at once (`docker compose up --scale worker=3`). A worker can only start a delivery whose row is still `queued`, so duplicated jobs are no-ops.
- **Crash recovery.** A delivery stuck in `queued`/`delivering` past a visibility timeout goes back to the outbox. That is what makes delivery *at-least-once*, and why consumers dedupe by `webhook-id`.
- **Exponential backoff with jitter.** Retries wait `base · 2^(n-1)`, capped, with half of the window randomised so thousands of retries don't hit a recovering endpoint at the same instant.
- **Circuit breaker per endpoint**, shared across replicas through Redis. After N consecutive failures, deliveries are parked until a cool-down ends, *without* burning their retry budget.
- **Dead-letter queue + replay.** After `MAX_ATTEMPTS`, a delivery is marked `dead`. It can be replayed one at a time or in bulk, with a fresh retry budget.
- **Idempotent ingestion.** `Idempotency-Key` is enforced by a unique constraint per tenant. A retried `POST` returns the original event instead of creating a second one.
- **Signed payloads**, following the [Standard Webhooks](https://www.standardwebhooks.com) spec: HMAC-SHA256 over `id.timestamp.body`, a timestamp tolerance against replay attacks, constant-time comparison, and support for several signatures during key rotation.
- **Multi-tenant.** Requests are authenticated with API keys, stored only as SHA-256 hashes. Every query is scoped by tenant.

## Security

- **SSRF protection.** Tenants choose the URLs Relay calls, so endpoint URLs are checked against private, loopback, link-local and cloud-metadata ranges (IPv4 and IPv6). The check runs at registration and again before every delivery, so a hostname that later resolves to an internal address is caught. Redirects are not followed. The local demo relaxes this with `ALLOW_PRIVATE_ENDPOINTS=true`, because its consumer lives on the Docker network.
- **API keys are stored only as SHA-256 hashes.** Endpoint signing secrets are returned once, at creation.
- **No internal errors are leaked.** 5xx responses are generic, and inputs (`limit`, ids, bodies) are validated before they reach SQL. All queries are parameterised.
- **Bounded inputs**: request bodies are size-limited, and event types and endpoint lists are capped.
- **Local stack is not exposed.** Every port in `docker-compose.yml` binds to `127.0.0.1`. The credentials in `.env.example` and the compose file are throwaway demo values, never meant for real use.
- **The SSE stream authenticates with `?key=`**, since `EventSource` can't send headers. That route is excluded from the nginx access log.

## Run it

Requires Docker.

```bash
docker compose up -d --build --wait
```

| | |
|---|---|
| Dashboard | http://localhost:8088 |
| API | http://localhost:3000 |
| Grafana | http://localhost:3001 |
| Prometheus | http://localhost:9090 |

A demo tenant and two endpoints are seeded automatically (see `.env.example`). In the dashboard, set a failure rate, send 10,000 events, flip **Outage** on and off, and watch the guarantee panel.

```bash
# Send an event
curl -X POST localhost:3000/v1/events \
  -H "authorization: Bearer rk_demo_7f3c9a1e5b2d4f6a8c0e" \
  -H "idempotency-key: order-42-paid" \
  -H "content-type: application/json" \
  -d '{"type":"invoice.paid","payload":{"amount":4200,"currency":"EUR"}}'

# Load test with k6 (10,000 events by default)
pnpm load

# Full chaos test: 30% failures + 15 s outage, asserts 0 lost
pnpm e2e
```

## API

| Method | Path | |
|---|---|---|
| `POST` | `/v1/events` | Ingest an event (`Idempotency-Key` header supported) |
| `GET` | `/v1/events` | Recent events |
| `POST` | `/v1/endpoints` | Register an endpoint; the signing secret is returned once |
| `GET` / `PATCH` | `/v1/endpoints[/:id]` | List and enable/disable endpoints |
| `GET` | `/v1/deliveries?status=` | Deliveries with last status code, error, and latency |
| `GET` | `/v1/deliveries/:id/attempts` | Full attempt log |
| `POST` | `/v1/deliveries/:id/replay` | Replay a dead-lettered delivery |
| `POST` | `/v1/deliveries/replay-dead` | Replay the whole DLQ |
| `GET` | `/v1/stats` | Aggregate counters, throughput, and p95 |
| `GET` | `/v1/stream` | Live delivery attempts (Server-Sent Events) |

## Verifying webhooks (consumer side)

```ts
import { verify } from "@relay/core";

const ok = verify(secret, {
  id: req.headers["webhook-id"],
  timestamp: req.headers["webhook-timestamp"],
  signature: req.headers["webhook-signature"],
}, rawBody);
```

`apps/receiver` is a complete reference consumer: it verifies signatures and deduplicates by `webhook-id`. It also has the chaos knobs used in the tests.

## Project layout

```
apps/api         Fastify API: ingestion, endpoints, deliveries, stats, SSE
apps/worker      Outbox relay, BullMQ consumer, retries, circuit breaker, reaper
apps/receiver    Reference consumer with chaos controls (failure rate, latency, outage)
apps/dashboard   React + Tailwind dashboard (served by nginx in Docker)
packages/core    Signing/verification and backoff, unit-tested
db/migrations    SQL migrations (applied by a one-shot migrate container)
infra/           Prometheus scrape config, Grafana datasource and dashboard
scripts/         k6 load test, end-to-end chaos test
```

## CI

GitHub Actions runs typecheck, unit tests, and build. It then brings the whole stack up and runs the chaos e2e test: 2,000 events, 30% failures, and a 15 s outage. The build fails if a single delivery is lost, dead-lettered, or fails signature verification.

## Stack

TypeScript · Node.js · Fastify · PostgreSQL · Redis · BullMQ · React · Tailwind CSS · Docker Compose · nginx · Prometheus · Grafana · k6 · Vitest · GitHub Actions

## Known limits / next steps

- The reference receiver keeps its dedup set in memory. A real consumer would use a unique constraint or a TTL'd key store.
- Delivery ordering is not guaranteed (by design, as in most webhook providers). Per-endpoint FIFO would need partitioned queues.
- The SSRF re-check resolves DNS just before the request, but the HTTP client resolves again on connect. Closing that last small window needs pinning the resolved IP in a custom dispatcher.
- There is no per-tenant rate limiting yet.
- Next: per-tenant rate limits, endpoint secret rotation via the API, OpenTelemetry traces, and Terraform for AWS (ECS Fargate + RDS + ElastiCache).
