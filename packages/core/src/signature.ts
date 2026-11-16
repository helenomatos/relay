import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Webhook signing compatible with the Standard Webhooks spec
 * (https://www.standardwebhooks.com):
 *   signed content = `${msgId}.${timestampSeconds}.${body}`
 *   header         = `webhook-signature: v1,<base64 HMAC-SHA256>`
 */

const PREFIX = "whsec_";

export function generateSecret(): string {
  return PREFIX + randomBytes(24).toString("base64");
}

function secretKey(secret: string): Buffer {
  return Buffer.from(secret.startsWith(PREFIX) ? secret.slice(PREFIX.length) : secret, "base64");
}

export function sign(secret: string, msgId: string, timestamp: number, body: string): string {
  const mac = createHmac("sha256", secretKey(secret)).update(`${msgId}.${timestamp}.${body}`).digest("base64");
  return `v1,${mac}`;
}

export interface SignatureHeaders {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}

export interface VerifyOptions {
  /** Max clock skew accepted, in seconds (replay protection). */
  toleranceSec?: number;
  nowSec?: number;
}

export function verify(
  secret: string,
  headers: SignatureHeaders,
  body: string,
  { toleranceSec = 300, nowSec = Date.now() / 1000 }: VerifyOptions = {},
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;

  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(nowSec - ts) > toleranceSec) return false;

  const expected = Buffer.from(sign(secret, id, ts, body).slice(3));
  // The header may carry several space-separated signatures (key rotation).
  for (const part of signature.split(" ")) {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) continue;
    const candidate = Buffer.from(sig);
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return true;
  }
  return false;
}
