import type { Attributes, FighterState } from "./model.js";
import { ratings } from "./model.js";
import { clamp, Rng } from "./rng.js";

export type Method = "KO" | "TKO" | "SUB" | "DEC_U" | "DEC_S" | "DEC_M" | "DRAW";

export interface BoutOutcome {
  winner: "red" | "blue" | null;
  method: Method;
  endRound: number;
  endTimeS: number;
  seed: number;
}

/**
 * Light-fidelity resolution: one weighted roll from ratings. Used for
 * off-screen promotions and history backfill. The full step-by-step engine
 * (Phase 1) replaces this for the player's promotion and any watched fight,
 * using the same seed so results are reproducible.
 */
export function resolveLight(red: FighterState, blue: FighterState, rounds: number, seed: number): BoutOutcome {
  const rng = new Rng(seed);
  const r = ratings(red.attrs);
  const b = ratings(blue.attrs);
  const edge = styleEdge(red.attrs, blue.attrs) - styleEdge(blue.attrs, red.attrs);
  const fatigue = (f: FighterState) => -Math.min(12, f.damage * 0.25);
  const diff = r.overall + fatigue(red) - (b.overall + fatigue(blue)) + edge + rng.normal(0, 5);

  if (rng.chance(0.012)) return { winner: null, method: "DRAW", endRound: rounds, endTimeS: 300, seed };

  const pRed = 1 / (1 + Math.exp(-diff / 6));
  const redWins = rng.chance(pRed);
  const w = redWins ? red.attrs : blue.attrs;
  const l = redWins ? blue.attrs : red.attrs;
  const wr = redWins ? r : b;
  const loser = redWins ? blue : red;

  const effChin = clamp(l.chin - loser.damage * 0.6, 5, 99);
  const pKO = clamp(0.2 * (wr.striking / 55) * (60 / effChin) * (0.7 + w.aggression / 180), 0.03, 0.6);
  const pSub = clamp(0.14 * (w.sub_offense / 55) * (55 / Math.max(10, l.sub_defense)), 0.02, 0.45);
  const pDec = Math.max(0.15, 1 - pKO - pSub);
  const method0 = rng.weighted(["STRIKE", "SUB", "DEC"] as const, [pKO, pSub, pDec]);

  let method: Method;
  let endRound = rounds;
  let endTimeS = 300;
  if (method0 === "DEC") {
    method = rng.weighted(["DEC_U", "DEC_S", "DEC_M"] as const, [0.68, 0.27, 0.05]);
  } else {
    method = method0 === "SUB" ? "SUB" : rng.chance(0.45) ? "KO" : "TKO";
    // Earlier rounds are likelier to see finishes.
    const weights = Array.from({ length: rounds }, (_, i) => 1 / (i + 1.2));
    endRound = rng.weighted(Array.from({ length: rounds }, (_, i) => i + 1), weights);
    endTimeS = rng.int(8, 299);
  }
  return { winner: redWins ? "red" : "blue", method, endRound, endTimeS, seed };
}

/** Small matchup bonus: grappling attack vs takedown defense, striking vs chin. */
function styleEdge(a: Attributes, d: Attributes): number {
  const wrestle = (a.takedowns - d.td_defense) * 0.06;
  const strike = ((a.boxing + a.kicks) / 2 - d.chin) * 0.03;
  return clamp(wrestle + strike, -3, 3);
}
