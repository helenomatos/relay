export interface BackoffOptions {
  baseMs?: number;
  capMs?: number;
  random?: () => number;
}

/**
 * Exponential backoff with "equal jitter": the delay grows as base * 2^(n-1),
 * capped, and half of it is randomised so retries from many deliveries
 * don't hit a recovering endpoint at the same instant (thundering herd).
 */
export function backoffMs(attempt: number, { baseMs = 1000, capMs = 60_000, random = Math.random }: BackoffOptions = {}): number {
  if (attempt < 1) throw new RangeError("attempt must be >= 1");
  const exp = Math.min(capMs, baseMs * 2 ** (attempt - 1));
  return Math.round(exp / 2 + random() * (exp / 2));
}
