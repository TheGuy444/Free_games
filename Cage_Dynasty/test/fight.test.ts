import { describe, expect, it } from "vitest";
import { simulateFight } from "../src/core/fight/engine.js";
import { narrate } from "../src/core/fight/narrate.js";
import { sampleFighter } from "../src/core/fight/sample.js";
import { Rng } from "../src/core/rng.js";

const pair = (seed: number) => {
  const rng = new Rng(seed);
  return [sampleFighter(rng, 1), sampleFighter(rng, 2)] as const;
};

describe("fight engine", () => {
  it("replays identically from the same seed", () => {
    const [a, b] = pair(1);
    expect(simulateFight(a, b, 3, 42)).toEqual(simulateFight(a, b, 3, 42));
  });

  it("produces a valid result and stats for every round fought", () => {
    for (let s = 0; s < 200; s++) {
      const [a, b] = pair(s);
      const r = simulateFight(a, b, s % 2 ? 5 : 3, s);
      expect(r.endRound).toBeGreaterThanOrEqual(1);
      expect(r.endRound).toBeLessThanOrEqual(s % 2 ? 5 : 3);
      expect(r.endTimeS).toBeGreaterThan(0);
      expect(r.endTimeS).toBeLessThanOrEqual(300);
      expect(r.stats.length).toBe(r.endRound);
      if (r.method.startsWith("DEC")) expect(r.cards.every((c) => c.length === r.endRound)).toBe(true);
      if (r.method !== "DRAW") expect(r.winner === 0 || r.winner === 1).toBe(true);
    }
  });

  it("finish rates land in realistic ranges over many fights", () => {
    const rng = new Rng(77);
    const n = 3000;
    let ko = 0, sub = 0, dec = 0;
    for (let i = 0; i < n; i++) {
      const r = simulateFight(sampleFighter(rng, 1), sampleFighter(rng, 2), 3, rng.seed(), { log: false });
      if (r.method === "KO" || r.method === "TKO") ko++;
      else if (r.method === "SUB") sub++;
      else if (r.method.startsWith("DEC")) dec++;
    }
    expect(ko / n).toBeGreaterThan(0.25);
    expect(ko / n).toBeLessThan(0.42);
    expect(sub / n).toBeGreaterThan(0.12);
    expect(sub / n).toBeLessThan(0.26);
    expect(dec / n).toBeGreaterThan(0.38);
    expect(dec / n).toBeLessThan(0.58);
  });

  it("skips the event log at standard fidelity", () => {
    const [a, b] = pair(3);
    expect(simulateFight(a, b, 3, 9, { log: false }).events).toEqual([]);
  });
});

describe("narration", () => {
  it("turns events into readable lines that end with the result", () => {
    const [a, b] = pair(5);
    const r = simulateFight(a, b, 3, 5);
    const lines = narrate(r, [a.name, b.name]);
    expect(lines.length).toBeGreaterThan(2); // quick finishes are legitimately short
    expect(lines.every((l) => l.text.length > 0 && !l.text.includes("{"))).toBe(true);
    expect(lines.at(-1)!.big).toBe(true);
  });

  it("uses the right pronouns for women's fights", () => {
    let found = false;
    for (let s = 0; s < 60 && !found; s++) {
      const [a, b] = pair(s);
      const lines = narrate(simulateFight(a, b, 3, s), [a.name, b.name], ["F", "F"]);
      const text = lines.map((l) => l.text).join(" ");
      expect(text).not.toMatch(/\b(he|him|his|himself)\b/i);
      found = /\b(she|her)\b/i.test(text);
    }
    expect(found).toBe(true);
  });
});
