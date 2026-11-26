import type { FighterState } from "./model.js";
import { hash } from "./profile.js";

/**
 * Flair: where a fighter sits between stoic and outlandish, 0 to 100.
 * 0 is the quiet, business-like professional who lets the fighting talk;
 * 100 is the loud showman who sells every fight on the microphone.
 *
 * Derived from mic skill, professionalism, charisma and traits, plus a fixed
 * per-fighter offset, so it needs no storage and stays the same across saves.
 * Charisma counts for less than the others: a fighter can be magnetic and
 * still stoic.
 */
export function flair(f: Pick<FighterState, "id" | "attrs" | "traits">): number {
  const a = f.attrs;
  let v = 50 + 0.35 * (a.charisma - 45) + 0.45 * (a.mic_skill - 40) - 0.8 * (a.professionalism - 60);
  if (f.traits.includes("diva")) v += 12;
  if (f.traits.includes("company_man")) v -= 10;
  v += (hash(f.id, "flair") % 21) - 10;
  return Math.round(Math.max(0, Math.min(100, v)));
}

export type FlairBand = "stoic" | "reserved" | "measured" | "brash" | "outlandish";

export function flairBand(v: number): FlairBand {
  if (v < 20) return "stoic";
  if (v < 40) return "reserved";
  if (v < 60) return "measured";
  if (v < 80) return "brash";
  return "outlandish";
}

export const FLAIR_LABEL: Record<FlairBand, string> = {
  stoic: "Stoic",
  reserved: "Reserved",
  measured: "Measured",
  brash: "Brash",
  outlandish: "Outlandish",
};

/** Hype a callout adds to the fight it sets up: 4 for the stoic, up to 16 for the outlandish. */
export function calloutHype(v: number): number {
  return Math.round(4 + v * 0.12);
}
