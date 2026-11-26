import type { CardKind, PromotionPlan } from "./schedule.js";
import type { Archetype, Sex, Tier } from "./constants.js";

export interface Attributes {
  // Coarse ratings. Derived from the detailed stats below by syncCoarse(); used by
  // rankings, the one-roll resolver and booking. The fight engine reads the detailed stats.
  boxing: number; kicks: number; clinch_strike: number;
  takedowns: number; td_defense: number; top_control: number;
  sub_offense: number; sub_defense: number; scrambles: number;
  strength: number; speed: number; cardio: number;
  chin: number; recovery: number; durability: number;
  fight_iq: number; composure: number; aggression: number; heart: number;
  charisma: number; mic_skill: number; professionalism: number;
  potential: number;
  // Standup
  punch_speed: number; punch_power: number; punch_tech: number;
  kick_speed: number; kick_power: number; kick_tech: number;
  head_movement: number;
  /** Takedowns from open range (shots) and defending them (sprawl). */
  shot_takedown: number; shot_defense: number;
  // Clinch (clinch_strike above is knees, elbows, dirty boxing)
  clinch_control: number;
  /** Trips and throws from the clinch: judo, sambo, Greco. */
  clinch_takedown: number;
  clinch_defense: number;
  // Ground, on top (top_control above is holding position)
  passing: number; gnp: number; top_sub: number;
  // Ground, on the bottom
  guard_defense: number; sweeps: number; guard_sub: number; get_up: number;
}

/** Detailed technical stats; scrambles, top_control, clinch_strike and sub_defense are detailed too. */
export const DETAIL_KEYS = [
  "punch_speed", "punch_power", "punch_tech", "kick_speed", "kick_power", "kick_tech", "head_movement",
  "shot_takedown", "shot_defense", "clinch_strike", "clinch_control", "clinch_takedown", "clinch_defense",
  "top_control", "passing", "gnp", "top_sub", "guard_defense", "sweeps", "guard_sub", "get_up",
  "sub_defense", "scrambles",
] as const satisfies readonly (keyof Attributes)[];

/** Every stored attribute column, in table order. */
export const ATTR_KEYS = [
  "boxing", "kicks", "clinch_strike", "takedowns", "td_defense", "top_control", "sub_offense", "sub_defense", "scrambles",
  "strength", "speed", "cardio", "chin", "recovery", "durability", "fight_iq", "composure", "aggression", "heart",
  "charisma", "mic_skill", "professionalism", "potential",
  "punch_speed", "punch_power", "punch_tech", "kick_speed", "kick_power", "kick_tech", "head_movement",
  "shot_takedown", "shot_defense", "clinch_control", "clinch_takedown", "clinch_defense",
  "passing", "gnp", "top_sub", "guard_defense", "sweeps", "guard_sub", "get_up",
] as const satisfies readonly (keyof Attributes)[];

/** Skills that develop with training (detailed stats plus fight IQ and composure). */
export const SKILL_KEYS = [...DETAIL_KEYS, "fight_iq", "composure"] as const;

export const PHYSICAL_KEYS = ["strength", "speed", "cardio", "chin", "recovery", "durability"] as const satisfies readonly (keyof Attributes)[];

/** Recompute the coarse ratings from the detailed stats. */
export function syncCoarse(a: Attributes): Attributes {
  const r = Math.round;
  a.boxing = r(a.punch_tech * 0.4 + a.punch_speed * 0.3 + a.punch_power * 0.3);
  a.kicks = r(a.kick_tech * 0.4 + a.kick_speed * 0.3 + a.kick_power * 0.3);
  a.takedowns = r(Math.max(a.shot_takedown, a.clinch_takedown) * 0.7 + Math.min(a.shot_takedown, a.clinch_takedown) * 0.3);
  a.td_defense = r((a.shot_defense + a.clinch_defense) / 2);
  a.sub_offense = r(Math.max(a.top_sub, a.guard_sub) * 0.7 + Math.min(a.top_sub, a.guard_sub) * 0.3);
  return a;
}

export type FighterStatus = "amateur" | "active" | "injured" | "retired" | "deceased";

export interface FighterState {
  id: number;
  name: string;
  /** Walk-around weight; the cut to a class limit drives weigh-in risk. */
  walkKg: number;
  /** 0-100 worldwide drawing power: grows with wins, finishes, charisma and big stages. */
  popularity: number;
  /** Popularity by region id (see popularity.ts). */
  regionPop: Record<number, number>;
  /** Personality traits (see traits.ts). */
  traits: string[];
  /** Recent weight misses (decays each year). */
  missedWeight: number;
  sex: Sex;
  birthWeek: number;
  regionId: number;
  weightClassId: number;
  archetype: Archetype;
  status: FighterStatus;
  attrs: Attributes;
  wins: number;
  losses: number;
  draws: number;
  koWins: number;
  subWins: number;
  lossStreak: number;
  winStreak: number;
  /** Last promotion the fighter left, for 'signs with X, leaving Y' news. */
  lastPromotionId?: number | null;
  rating: number;
  damage: number;
  /** Accumulated wear by body part (0-100); head wear is `damage`. */
  wear: { body: number; arms: number; legs: number };
  debutWeek: number | null;
  retiredWeek: number | null;
  lastFightWeek: number | null;
  injuredUntil: number | null;
  /** Weeks spent as a free agent in a row; long droughts push retirement. */
  idleSince: number | null;
  contractId: number | null;
  promotionId: number | null;
  boutsRemaining: number;
  dirty: boolean;
}

export interface PromotionState {
  id: number;
  name: string;
  regionId: number | null;
  tier: Tier;
  roster: Set<number>;
  /** Weeks of the year this promotion runs events. */
  eventWeeks: Set<number>;
  eventCount: number;
  /** What kind of card each scheduled week is (AI promotions). */
  cardKinds?: Map<number, CardKind>;
  plan?: PromotionPlan;
  ppvCount?: number;
  tvCount?: number;
}

export const fights = (f: FighterState) => f.wins + f.losses + f.draws;

export const ageYears = (f: FighterState, week: number) => (week - f.birthWeek) / 52;

const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

export function ratings(a: Attributes) {
  const striking = avg([a.boxing, a.kicks, a.clinch_strike, a.head_movement]);
  const bottom = avg([a.guard_defense, a.get_up, a.sweeps]);
  const grappling = avg([a.takedowns, a.td_defense, a.top_control, a.sub_offense, a.sub_defense, a.scrambles, bottom]);
  const physical = avg([a.strength, a.speed, a.cardio, a.chin, a.recovery, a.durability]);
  const mental = avg([a.fight_iq, a.composure, a.aggression, a.heart]);
  const overall = 0.3 * striking + 0.3 * grappling + 0.25 * physical + 0.15 * mental;
  return { striking, grappling, physical, mental, overall };
}

export const overall = (a: Attributes) => ratings(a).overall;

/** Personality on the mic is a 0-100 flair score: see personality.ts. */

export interface TitleState {
  id: number;
  promotionId: number;
  weightClassId: number;
  champion: number | null;
  reignId: number | null;
  defenses: number;
  lastTitleFightWeek: number;
  /** Week the current reign began. */
  reignStart?: number;
}
