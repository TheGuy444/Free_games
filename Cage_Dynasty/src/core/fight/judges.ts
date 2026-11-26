import type { Rng } from "../rng.js";
import type { Corner, RoundStats } from "./types.js";
import type { Method } from "../fight-light.js";

/** A judge leans toward striking damage (+) or control and takedowns (-). */
export interface Judge {
  bias: number;
}

export const makeJudges = (rng: Rng): Judge[] => [0, 1, 2].map(() => ({ bias: rng.normal(0, 0.35) }));

/** 10-point must scoring for one round. Returns [red, blue]. */
export function scoreRound(j: Judge, s: [RoundStats, RoundStats], rng: Rng): [number, number] {
  const pts = (x: RoundStats) =>
    x.dmg * (0.55 + 0.15 * j.bias) + x.sigLand * 0.35 + x.kd * 9 + x.tdLand * (2.2 - j.bias) +
    (x.ctrl / 30) * (1.4 - 0.6 * j.bias) + x.subAtt * 1.5;
  const a = pts(s[0]) + rng.normal(0, 1.5);
  const b = pts(s[1]) + rng.normal(0, 1.5);
  const diff = a - b;
  const total = Math.max(10, a + b);
  if (Math.abs(diff) < 0.5) return [10, 10];
  const dominant = Math.abs(diff) / total > 0.55 && (s[0].kd + s[1].kd > 0 || Math.abs(diff) > 25);
  const loser = dominant ? 8 : 9;
  return diff > 0 ? [10, loser] : [loser, 10];
}

export function decide(cards: [number, number][][]): { winner: Corner | null; method: Method } {
  const totals = cards.map((c) => c.reduce((s, r) => [s[0] + r[0], s[1] + r[1]], [0, 0]));
  const votes = totals.map(([a, b]) => (a > b ? 0 : b > a ? 1 : -1));
  const red = votes.filter((v) => v === 0).length;
  const blue = votes.filter((v) => v === 1).length;
  if (red === blue) return { winner: null, method: "DRAW" };
  const winner: Corner = red > blue ? 0 : 1;
  const w = Math.max(red, blue);
  if (w === 3) return { winner, method: "DEC_U" };
  if (red + blue === 3) return { winner, method: "DEC_S" };
  return { winner, method: "DEC_M" };
}
