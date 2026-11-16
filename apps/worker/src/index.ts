import { setTimeout as sleep } from "node:timers/promises";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import postgres from "postgres";
import { CircuitBreaker } from "./circuit";
import { config } from "./config";
import { createDeliverer } from "./deliver";
import { outboxPending, queueDepth, serveMetrics } from "./metrics";

const QUEUE = "deliveries";

const sql = postgres(config.databaseUrl, { max: 20, transform: postgres.camel, onnotice: () => {} });
const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
const redis = new Redis(config.redisUrl);

const queue = new Queue(QUEUE, { connection });
const deliver = createDeliverer(sql, redis, new CircuitBreaker(redis));

const worker = new Worker<{ deliveryId: string }>(QUEUE, (job) => deliver(job.data.deliveryId), {
  connection,
  concurrency: config.concurrency,
});
worker.on("failed", (job, err) => console.error(`job ${job?.id} crashed:`, err.message));

let running = true;

/**
 * Outbox relay: moves due deliveries from Postgres into the queue.
 * FOR UPDATE SKIP LOCKED lets any number of worker replicas poll in parallel
 * without ever claiming the same row twice.
 */
async function relayOutbox() {
  while (running) {
    try {
      const rows = await sql<{ id: string; attempts: number }[]>`
        update deliveries set status = 'queued', updated_at = now()
        where id in (
          select id from deliveries
          where status = 'pending' and next_attempt_at <= now()
          order by next_attempt_at
          limit ${config.batchSize}
          for update skip locked
        )
        returning id, attempts`;
      if (rows.length) {
        await queue.addBulk(
          rows.map((r) => ({
            name: "deliver",
            data: { deliveryId: r.id },
            // Deterministic job id: re-enqueueing the same attempt is deduplicated by BullMQ.
            opts: { jobId: `${r.id}-${r.attempts}`, removeOnComplete: true, removeOnFail: 1000 },
          })),
        );
      }
      if (rows.length < config.batchSize) await sleep(config.pollMs);
    } catch (err) {
      console.error("outbox relay error:", (err as Error).message);
      await sleep(1_000);
    }
  }
}

/**
 * Crash recovery: if a worker dies mid-delivery (or Redis loses the job),
 * the row stays 'queued'/'delivering'. After the visibility timeout it goes
 * back to the outbox, which is what makes delivery at-least-once.
 */
async function reapStuck() {
  while (running) {
    await sleep(10_000);
    try {
      const rows = await sql`
        update deliveries set status = 'pending', updated_at = now()
        where status in ('queued', 'delivering')
          and updated_at < now() - make_interval(secs => ${config.visibilityTimeoutSec})
        returning id`;
      if (rows.length) console.warn(`reclaimed ${rows.length} stuck deliveries`);
    } catch (err) {
      console.error("reaper error:", (err as Error).message);
    }
  }
}

async function sampleGauges() {
  while (running) {
    try {
      const [[pending], counts] = await Promise.all([
        sql<{ count: number }[]>`select count(*)::int as count from deliveries where status = 'pending'`,
        queue.getJobCounts("waiting", "active", "delayed"),
      ]);
      outboxPending.set(pending!.count);
      for (const [state, n] of Object.entries(counts)) queueDepth.set({ state }, n);
    } catch {
      /* metrics are best-effort */
    }
    await sleep(2_000);
  }
}

const metricsServer = serveMetrics(config.metricsPort);
console.log(`worker up: concurrency=${config.concurrency} maxAttempts=${config.maxAttempts}`);
void relayOutbox();
void reapStuck();
void sampleGauges();

async function shutdown() {
  running = false;
  // Let in-flight deliveries finish; anything unfinished is reclaimed by the reaper.
  await worker.close();
  await queue.close();
  metricsServer.close();
  await sql.end({ timeout: 5 });
  connection.disconnect();
  redis.disconnect();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
