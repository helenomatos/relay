import { describe, expect, it } from "vitest";
import { backoffMs } from "../src/backoff";

describe("backoffMs", () => {
  it("doubles the window on each attempt", () => {
    const max = (n: number) => backoffMs(n, { baseMs: 1000, random: () => 1 });
    expect([1, 2, 3, 4].map(max)).toEqual([1000, 2000, 4000, 8000]);
  });

  it("never goes below half the window (equal jitter)", () => {
    expect(backoffMs(3, { baseMs: 1000, random: () => 0 })).toBe(2000);
  });

  it("is capped", () => {
    expect(backoffMs(30, { baseMs: 1000, capMs: 60_000, random: () => 1 })).toBe(60_000);
  });

  it("rejects attempt < 1", () => {
    expect(() => backoffMs(0)).toThrow(RangeError);
  });
});
