/**
 * Fight and card ratings (0-100). A fight rates high for finishes, knockdowns,
 * action, submission attempts, back-and-forth damage and comebacks; low for
 * one-sided control with little happening. A card's rating weighs the main
 * event most, then the co-main, then the rest of the main card, with the
 * prelims counting a little.
 */
import type { RoundStats } from "./fight/types.js";
import type { FighterState } from "./model.js";
import { has } from "./traits.js";

/** Bouts at the top of the card that make up the main card; the rest are prelims. */
export const MAIN_CARD_SIZE = 5;
/** Weights: main event, co-main, rest of the main card (shared), prelims (shared). */
export const CARD_WEIGHTS = { main: 0.32, coMain: 0.2, mainCard: 0.3, prelims: 0.18 };
/** A card's best fight earns Fight of the Night if it rates at least this. */
export const FOTN_MIN = 65;

const clamp = (x: number) => Math.max(1, Math.min(100, x));

export function rateFight(method: string, endRound: number, rounds: number, endTimeS: number, stats: RoundStats[][] | null,
  red: FighterState, blue: FighterState, title: boolean): number {
  let s = stats ? 22 : 32;
  const finished = method === "KO" || method === "TKO" || method === "SUB";
  if (finished) s += (method === "KO" ? 22 : method === "SUB" ? 18 : 16) + (endRound >= 2 ? 6 : 0);
  if (method === "DEC_S" || method === "DEC_M" || method === "DRAW") s += 6;
  if (stats) {
    const minutes = Math.max(1, ((endRound - 1) * 300 + endTimeS) / 60);
    let sig = 0, kd = 0, subs = 0, ctrl = 0;
    const dmg = [0, 0];
    for (const rs of stats) for (const c of [0, 1] as const) {
      const x = rs[c]!;
      sig += x.sigLand; kd += x.kd; subs += x.subAtt; ctrl += x.ctrl; dmg[c] = dmg[c]! + x.dmg;
    }
    s += Math.min(14, (sig / minutes) * 1.6);
    s += Math.min(18, kd * 7);
    s += Math.min(10, subs * 2.5);
    const hi = Math.max(dmg[0]!, dmg[1]!, 1), lo = Math.min(dmg[0]!, dmg[1]!);
    s += (lo / hi) * 8; // both fighters hurting each other
    if (!finished && ctrl / (minutes * 60) > 0.45 && sig / minutes < 4) s -= 10; // lay and pray
  } else {
    // One-roll fights: estimate from who was in it.
    const aggr = (red.attrs.aggression + blue.attrs.aggression) / 2;
    s += 8 + (aggr - 55) / 3;
  }
  for (const f of [red, blue]) {
    if (has(f.traits, "brawler")) s += 5;
    if (has(f.traits, "ko_artist")) s += 3;
    if (has(f.traits, "safe_fighter")) s -= 6;
    if (has(f.traits, "lives_on_shot") && !finished) s -= 4;
  }
  if (title) s += 4;
  if (rounds === 5 && !finished && s > 55) s += 3; // five hard rounds
  return Math.round(clamp(s));
}

/** Card rating from its fights in card order (index 0 = main event). */
export function rateCard(ratings: number[]): number {
  if (ratings.length === 0) return 0;
  const main = ratings[0]!, co = ratings[1];
  const rest = ratings.slice(2, MAIN_CARD_SIZE), pre = ratings.slice(MAIN_CARD_SIZE);
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const parts: [number, number][] = [[main, CARD_WEIGHTS.main]];
  if (co !== undefined) parts.push([co, CARD_WEIGHTS.coMain]);
  if (rest.length) parts.push([avg(rest), CARD_WEIGHTS.mainCard]);
  if (pre.length) parts.push([avg(pre), CARD_WEIGHTS.prelims]);
  const w = parts.reduce((t, [, x]) => t + x, 0);
  return Math.round(parts.reduce((t, [v, x]) => t + v * x, 0) / w);
}

/** What slot a fighter's popularity commands in a region. */
export function drawLevel(pop: number): "main event" | "main card" | "prelims" {
  return pop >= 55 ? "main event" : pop >= 30 ? "main card" : "prelims";
}
