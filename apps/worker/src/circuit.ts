import type { Redis } from "ioredis";
import { config } from "./config";
import { circuitOpens } from "./metrics";

/**
 * Per-endpoint circuit breaker kept in Redis, so every worker replica shares it.
 * After N consecutive failures the circuit opens: deliveries to that endpoint are
 * deferred (without spending retry budget) until the cool-down ends.
 */
export class CircuitBreaker {
  constructor(private redis: Redis) {}

  /** Returns the epoch ms until which the circuit is open, or null if closed. */
  async openUntil(endpointId: string): Promise<number | null> {
    const value = await this.redis.get(`cb:open:${endpointId}`);
    return value ? Number(value) : null;
  }

  async recordSuccess(endpointId: string) {
    await this.redis.del(`cb:fail:${endpointId}`);
  }

  async recordFailure(endpointId: string) {
    const key = `cb:fail:${endpointId}`;
    const [[, failures]] = (await this.redis.multi().incr(key).pexpire(key, 60_000).exec()) as [[null, number]];
    if (failures < config.circuitThreshold) return;
    const until = Date.now() + config.circuitOpenMs;
    // NX: only the first worker to cross the threshold opens it.
    const opened = await this.redis.set(`cb:open:${endpointId}`, String(until), "PX", config.circuitOpenMs, "NX");
    if (opened) {
      circuitOpens.inc();
      await this.redis.del(key);
    }
  }
}
