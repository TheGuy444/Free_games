import { WEIGHT_CLASSES, type DisciplineCode } from "../constants.js";
import { generateFighter } from "../fighter-gen.js";
import { drawTraits } from "../traits.js";
import type { FighterState } from "../model.js";
import { makeName, REGION_DEFS } from "../names.js";
import type { Rng } from "../rng.js";

/** A standalone fighter for tests, calibration and the CLI fight printer. */
export function sampleFighter(rng: Rng, id: number, age = 28, style?: DisciplineCode): FighterState {
  const region = rng.pick(REGION_DEFS);
  const g = generateFighter(rng, region.strengths, age, "M", style);
  const n = makeName(rng, region.flavor, "M");
  return {
    id, name: `${n.first} ${n.last}`, sex: "M", birthWeek: -age * 52, regionId: 1,
    weightClassId: WEIGHT_CLASSES.findIndex((w) => w.code === "M_LIG") + 1, archetype: g.archetype, status: "active",
    walkKg: 76, popularity: 10, regionPop: {}, traits: drawTraits(id * 7919 + rng.int(0, 1e6), g.archetype, g.attrs), missedWeight: 0,
    attrs: g.attrs, wins: 0, losses: 0, draws: 0, koWins: 0, subWins: 0, lossStreak: 0, winStreak: 0, rating: 1500, damage: 0, wear: { body: 0, arms: 0, legs: 0 },
    debutWeek: 0, retiredWeek: null, lastFightWeek: null, injuredUntil: null, idleSince: null, contractId: null,
    promotionId: null, boutsRemaining: 0, dirty: false,
  };
}
