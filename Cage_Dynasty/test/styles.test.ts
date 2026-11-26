import { describe, expect, it } from "vitest";
import type { DisciplineCode } from "../src/core/constants.js";
import { simulateFight } from "../src/core/fight/engine.js";
import { sampleFighter } from "../src/core/fight/sample.js";
import type { Attributes } from "../src/core/model.js";
import { Rng } from "../src/core/rng.js";

const avgOf = (style: DisciplineCode, pick: (a: Attributes) => number, n = 300) => {
  const rng = new Rng(9);
  let t = 0;
  for (let i = 0; i < n; i++) t += pick(sampleFighter(rng, 1, 28, style).attrs);
  return t / n;
};
const top = (a: Attributes) => (a.top_control + a.passing + a.gnp + a.top_sub) / 4;
const bottom = (a: Attributes) => (a.guard_defense + a.sweeps + a.guard_sub + a.get_up) / 4;

describe("martial-arts styles", () => {
  it("wrestlers are better on top than off their back; jiu-jitsu is the reverse", () => {
    expect(avgOf("WRES_FREE", top) - avgOf("WRES_FREE", bottom)).toBeGreaterThan(8);
    expect(avgOf("BJJ", bottom) - avgOf("BJJ", top)).toBeGreaterThan(2);
    expect(avgOf("BJJ", (a) => a.guard_sub)).toBeGreaterThan(avgOf("WRES_FREE", (a) => a.guard_sub) + 25);
  });

  it("sambo is top-heavy like wrestling but takes you down from the clinch", () => {
    expect(avgOf("SAMBO", top) - avgOf("SAMBO", bottom)).toBeGreaterThan(5);
    expect(avgOf("SAMBO", (a) => a.clinch_takedown)).toBeGreaterThan(avgOf("SAMBO", (a) => a.shot_takedown) + 8);
    expect(avgOf("WRES_FREE", (a) => a.shot_takedown)).toBeGreaterThan(avgOf("WRES_FREE", (a) => a.clinch_takedown) + 10);
  });

  it("in the cage, wrestlers shoot and judoka throw from the clinch", () => {
    const count = (style: DisciplineCode) => {
      const rng = new Rng(5);
      let shots = 0, clinch = 0;
      for (let i = 0; i < 300; i++) {
        const r = simulateFight(sampleFighter(rng, 1, 28, style), sampleFighter(rng, 2), 3, rng.seed());
        for (const e of r.events) if (e.a === 0 && e.k === "td_attempt") (e.x === "trip" || e.x === "throw" ? clinch++ : shots++);
      }
      return { shots, clinch };
    };
    const w = count("WRES_FREE"), j = count("JUDO");
    expect(w.shots).toBeGreaterThan(w.clinch);
    expect(j.clinch).toBeGreaterThan(j.shots);
    expect(w.shots).toBeGreaterThan(j.shots * 2);
  });
});
