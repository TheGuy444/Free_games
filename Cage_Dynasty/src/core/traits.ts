/**
 * Fighter traits: personality and habits that colour how someone fights and
 * what they'll accept. Most fighters have none or one; a few have two.
 * Traits are drawn once from a hash of the fighter's id and their style, so
 * they're stable for a fighter's whole career and old saves get them too.
 */
import type { Archetype } from "./constants.js";
import type { Attributes } from "./model.js";
import { hash } from "./profile.js";

export const TRAITS = {
  ko_artist: { name: "Knockout artist", text: "Hunts the knockout: throws heavy, takes risks, rarely settles for points." },
  lives_on_shot: { name: "Lives on the shot", text: "Wrestles no matter what. Keeps shooting until the takedown comes or the lights go out." },
  loves_to_strike: { name: "Loves to bang", text: "Would rather trade than grapple, whatever their background says." },
  brawler: { name: "Brawler", text: "Stands in the pocket and swings. Exciting, and easy to hit." },
  safe_fighter: { name: "Plays it safe", text: "Fights not to lose: low risk, low output, lots of decisions." },
  diva: { name: "Big ego", text: "Won't fight lesser-known or unranked opponents, and won't fight on the prelims while ranked." },
  company_man: { name: "Company man", text: "Takes any fight, any slot, on any notice." },
  hometown_hero: { name: "Hometown hero", text: "Adored at home: draws far bigger crowds in their home region." },
  slow_starter: { name: "Slow starter", text: "Gives away early rounds and comes alive late." },
} as const;
export type Trait = keyof typeof TRAITS;

/** Draw a fighter's traits (stable for their whole career). */
export function drawTraits(id: number, archetype: Archetype, a: Attributes): Trait[] {
  const roll = (label: string) => (hash(id, "trait", label) % 1000) / 1000;
  const wrestlerish = a.shot_takedown > a.punch_tech + 8;
  const strikerish = a.punch_power + a.kick_power > 125;
  const odds: [Trait, number][] = [
    ["ko_artist", strikerish ? 0.16 : 0.05],
    ["lives_on_shot", wrestlerish ? 0.14 : 0],
    ["loves_to_strike", wrestlerish ? 0.1 : 0.02],
    ["brawler", a.aggression > 65 ? 0.14 : 0.04],
    ["safe_fighter", a.aggression < 40 ? 0.14 : 0.03],
    ["diva", a.charisma > 60 && a.professionalism < 50 ? 0.25 : 0.03],
    ["company_man", a.professionalism > 70 ? 0.2 : 0.04],
    ["hometown_hero", a.charisma > 55 ? 0.1 : 0.04],
    ["slow_starter", 0.05],
  ];
  void archetype;
  const out: Trait[] = [];
  for (const [t, p] of odds) if (roll(t) < p) out.push(t);
  // Contradictions: keep the first.
  const clash: [Trait, Trait][] = [["lives_on_shot", "loves_to_strike"], ["brawler", "safe_fighter"], ["ko_artist", "safe_fighter"], ["diva", "company_man"]];
  for (const [x, y] of clash) if (out.includes(x) && out.includes(y)) out.splice(out.indexOf(y), 1);
  return out.slice(0, 2);
}

export const has = (traits: readonly string[] | undefined, t: Trait) => !!traits && traits.includes(t);
