import { describe, expect, it } from "vitest";
import { Rng } from "../src/core/rng.js";

describe("Rng", () => {
  it("is deterministic for a seed", () => {
    const a = new Rng(123), b = new Rng(123);
    expect(Array.from({ length: 5 }, () => a.uint32())).toEqual(Array.from({ length: 5 }, () => b.uint32()));
  });
  it("differs across seeds and stays in range", () => {
    const a = new Rng(1), b = new Rng(2);
    expect(a.uint32()).not.toEqual(b.uint32());
    for (let i = 0; i < 1000; i++) {
      const v = a.int(3, 7);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(7);
    }
  });
});
