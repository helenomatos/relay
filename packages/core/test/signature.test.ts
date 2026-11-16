import { describe, expect, it } from "vitest";
import { generateSecret, sign, verify } from "../src/signature";

const secret = generateSecret();
const body = JSON.stringify({ type: "invoice.paid", data: { amount: 4200 } });
const now = 1_700_000_000;

const headers = (sig: string, ts = now, id = "evt_1") => ({ id, timestamp: String(ts), signature: sig });

describe("webhook signatures", () => {
  it("generates secrets with the whsec_ prefix", () => {
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/=]+$/);
  });

  it("accepts a valid signature", () => {
    expect(verify(secret, headers(sign(secret, "evt_1", now, body)), body, { nowSec: now })).toBe(true);
  });

  it("rejects a tampered body", () => {
    const sig = sign(secret, "evt_1", now, body);
    expect(verify(secret, headers(sig), body.replace("4200", "1"), { nowSec: now })).toBe(false);
  });

  it("rejects a signature made with another secret", () => {
    const sig = sign(generateSecret(), "evt_1", now, body);
    expect(verify(secret, headers(sig), body, { nowSec: now })).toBe(false);
  });

  it("rejects a reused message id", () => {
    const sig = sign(secret, "evt_1", now, body);
    expect(verify(secret, headers(sig, now, "evt_2"), body, { nowSec: now })).toBe(false);
  });

  it("rejects stale timestamps (replay protection)", () => {
    const old = now - 600;
    expect(verify(secret, headers(sign(secret, "evt_1", old, body), old), body, { nowSec: now })).toBe(false);
  });

  it("accepts any valid signature in a rotated list", () => {
    const sig = `v1,bogus ${sign(secret, "evt_1", now, body)}`;
    expect(verify(secret, headers(sig), body, { nowSec: now })).toBe(true);
  });

  it("rejects missing headers", () => {
    expect(verify(secret, { id: undefined, timestamp: String(now), signature: "v1,x" }, body)).toBe(false);
  });
});
