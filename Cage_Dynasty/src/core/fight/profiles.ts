import type { Archetype } from "../constants.js";

/** How often each archetype reaches for each option at distance. Our own tuning table. */
export interface StyleProfile {
  jab: number; power: number; combo: number; leg_kick: number; body_kick: number;
  head_kick: number; spinning: number; takedown: number; clinch: number;
  /** On top: share of actions spent on ground-and-pound vs advancing vs subs. */
  gnp: number; advance: number; sub: number;
  /** Preferred submission family. */
  subs: string[];
}

const base: StyleProfile = {
  jab: 10, power: 8, combo: 6, leg_kick: 5, body_kick: 2, head_kick: 1, spinning: 0.2, takedown: 3, clinch: 2,
  gnp: 5, advance: 3, sub: 2, subs: ["rear_naked_choke", "guillotine", "arm_triangle", "armbar"],
};

export const PROFILES: Record<Archetype, StyleProfile> = {
  pressure_striker: { ...base, power: 12, combo: 9, jab: 8, takedown: 1, clinch: 2 },
  counter_striker: { ...base, jab: 12, power: 7, combo: 4, takedown: 1 },
  kickboxer: { ...base, leg_kick: 9, body_kick: 5, head_kick: 2.5, spinning: 0.6, takedown: 0.8 },
  wrestle_boxer: { ...base, takedown: 8, power: 9, clinch: 3, gnp: 6, advance: 4 },
  ground_and_pound: { ...base, takedown: 9, clinch: 3, gnp: 10, advance: 3, sub: 1 },
  submission_hunter: { ...base, takedown: 6, clinch: 3, gnp: 2, advance: 5, sub: 7, subs: ["rear_naked_choke", "triangle", "armbar", "darce", "arm_triangle"] },
  clinch_grinder: { ...base, clinch: 9, takedown: 5, jab: 6, power: 5, gnp: 5, advance: 4 },
  leg_locker: { ...base, takedown: 5, clinch: 3, sub: 6, advance: 3, gnp: 3, subs: ["heel_hook", "kneebar", "armbar", "rear_naked_choke"] },
  point_karateka: { ...base, jab: 9, power: 6, combo: 3, leg_kick: 4, body_kick: 5, head_kick: 3, spinning: 0.8, takedown: 0.5, clinch: 0.5 },
  all_rounder: { ...base, takedown: 4, clinch: 3 },
};
