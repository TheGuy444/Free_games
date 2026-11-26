import { WEIGHT_CLASSES } from "./constants.js";
import { ageYears, type FighterState } from "./model.js";
import { clamp, type Rng } from "./rng.js";

export type WeighInOutcome = "made" | "drained" | "missed" | "hospitalised";

export interface WeighInResult {
  fighterId: number;
  limitKg: number;
  weightKg: number;
  outcome: WeighInOutcome;
  /** Fight-night penalties for a hard cut. */
  mods: FightMods;
}

export interface FightMods {
  startStamina: number;
  chinPenalty: number;
}

export const NO_MODS: FightMods = { startStamina: 100, chinPenalty: 0 };

/** Share of walk-around weight a fighter must lose to make the limit. */
export function cutPercent(f: FighterState, weightClassId = f.weightClassId): number {
  const limit = WEIGHT_CLASSES[weightClassId - 1]!.limitKg;
  return Math.max(0, (f.walkKg - limit) / f.walkKg);
}

/**
 * Weigh-in. Risk grows with the size of the cut, short notice, age, a history
 * of misses and low professionalism. Typical cuts are 6-12% of body weight.
 */
export function weighIn(f: FighterState, week: number, weeksNotice: number, rng: Rng, weightClassId = f.weightClassId): WeighInResult {
  const limitKg = WEIGHT_CLASSES[weightClassId - 1]!.limitKg;
  const cut = cutPercent(f, weightClassId) * 100;
  const difficulty = cut - 7 + (weeksNotice < 3 && !(f.traits ?? []).includes("company_man") ? 3 : 0) + Math.max(0, ageYears(f, week) - 32) * 0.3 +
    f.missedWeight * 1.5 - (f.attrs.professionalism - 50) / 15;
  const d = Math.max(0, difficulty);
  const pHosp = clamp(0.0002 + 0.0015 * Math.max(0, difficulty - 3), 0, 0.04);
  const pMiss = clamp(0.005 + 0.012 * d, 0.003, 0.4);
  const pDrained = clamp(0.06 + 0.045 * d, 0, 0.6);
  const roll = rng.next();
  const round1 = (x: number) => Math.round(x * 10) / 10;
  if (roll < pHosp) {
    return { fighterId: f.id, limitKg, weightKg: round1(limitKg + 1 + rng.next() * 3), outcome: "hospitalised", mods: NO_MODS };
  }
  if (roll < pHosp + pMiss) {
    return { fighterId: f.id, limitKg, weightKg: round1(limitKg + 0.3 + rng.next() * 2.2), outcome: "missed", mods: { startStamina: 92, chinPenalty: 2 } };
  }
  if (roll < pHosp + pMiss + pDrained) {
    return { fighterId: f.id, limitKg, weightKg: round1(limitKg - rng.next() * 0.2), outcome: "drained", mods: { startStamina: 84, chinPenalty: 6 } };
  }
  return { fighterId: f.id, limitKg, weightKg: round1(limitKg - rng.next() * 0.5), outcome: "made", mods: NO_MODS };
}

/** Walk-around weight for a new fighter in a class. Heavyweights rarely cut. */
export function initialWalkKg(classCode: string, limitKg: number, rng: Rng): number {
  if (classCode === "M_HW") return Math.round(clamp(rng.normal(110, 8), 95, 128) * 10) / 10;
  return Math.round(limitKg * (1 + clamp(rng.normal(0.1, 0.03), 0.02, 0.19)) * 10) / 10;
}
