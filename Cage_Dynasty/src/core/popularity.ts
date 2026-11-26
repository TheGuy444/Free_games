/**
 * Popularity by region. A fighter has worldwide popularity (f.popularity, used
 * for rankings and news) and a number per region that drives ticket sales,
 * PPV buys and what card slot they expect there. Fighting in a region builds
 * popularity mostly there; global promotions' broadcasts reach everywhere;
 * fighters are always a bit bigger at home.
 */
import type { FighterState } from "./model.js";
import { has } from "./traits.js";

const clamp = (x: number) => Math.max(0, Math.min(100, x));

/** Starting regional numbers from worldwide popularity. */
export function initRegionPop(f: FighterState, regionIds: number[]): Record<number, number> {
  const out: Record<number, number> = {};
  for (const r of regionIds) out[r] = Math.round(f.popularity * (r === f.regionId ? homeBoost(f) : 0.45) * 10) / 10;
  return out;
}
const homeBoost = (f: FighterState) => (has(f.traits, "hometown_hero") ? 2.4 : 1.5);

/** Popularity in one region. */
export function popIn(f: FighterState, regionId: number | null): number {
  if (regionId === null) return f.popularity;
  return f.regionPop[regionId] ?? f.popularity * (regionId === f.regionId ? homeBoost(f) : 0.45);
}

/**
 * Add (or remove) popularity from a fight or moment in `regionId` (null = a
 * worldwide broadcast). The local market moves most.
 */
export function addPop(f: FighterState, amount: number, regionId: number | null, regionIds: number[]) {
  f.popularity = clamp(f.popularity + amount);
  for (const r of regionIds) {
    const share = regionId === null ? 0.9 : r === regionId ? 1.8 : 0.3;
    const home = r === f.regionId && amount > 0 ? (has(f.traits, "hometown_hero") ? 1.6 : 1.2) : 1;
    f.regionPop[r] = Math.round(clamp(popIn(f, r) + amount * share * home) * 10) / 10;
  }
}

export function decayPop(f: FighterState, factor: number) {
  f.popularity = clamp(f.popularity * factor);
  for (const r of Object.keys(f.regionPop)) f.regionPop[Number(r)] = Math.round(f.regionPop[Number(r)]! * factor * 10) / 10;
}

/** Where a fighter is biggest. */
export function biggestMarket(f: FighterState): number | null {
  let best: number | null = null;
  for (const [r, v] of Object.entries(f.regionPop)) if (best === null || v > (f.regionPop[best] ?? 0)) best = Number(r);
  return best;
}
