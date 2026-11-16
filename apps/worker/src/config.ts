function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name}`);
  return value;
}

const num = (name: string, fallback: number) => Number(process.env[name] ?? fallback);

export const config = {
  databaseUrl: required("DATABASE_URL"),
  redisUrl: required("REDIS_URL"),
  metricsPort: num("METRICS_PORT", 9100),

  /** Parallel HTTP deliveries per worker process. */
  concurrency: num("WORKER_CONCURRENCY", 50),
  /** Outbox rows claimed per poll. */
  batchSize: num("OUTBOX_BATCH_SIZE", 500),
  pollMs: num("OUTBOX_POLL_MS", 200),
  /** Deliveries stuck in queued/delivering longer than this are reclaimed (crash recovery). */
  visibilityTimeoutSec: num("VISIBILITY_TIMEOUT_SEC", 60),

  requestTimeoutMs: num("REQUEST_TIMEOUT_MS", 10_000),
  maxAttempts: num("MAX_ATTEMPTS", 10),
  backoffBaseMs: num("BACKOFF_BASE_MS", 1_000),
  backoffCapMs: num("BACKOFF_CAP_MS", 60_000),

  /** Consecutive failures that open an endpoint's circuit, and for how long. */
  circuitThreshold: num("CIRCUIT_THRESHOLD", 20),
  circuitOpenMs: num("CIRCUIT_OPEN_MS", 15_000),
};
