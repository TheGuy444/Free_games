import { ARCHETYPES, type Archetype, type DisciplineCode, type Sex } from "./constants.js";
import { DETAIL_KEYS, syncCoarse, type Attributes } from "./model.js";
import { clamp, type Rng } from "./rng.js";

type Shape = Partial<Record<keyof Attributes, number>>;

/**
 * Each martial art's fingerprint: offsets from the fighter's base talent.
 * Our own tuning table. The big idea: wrestlers win from the top and shoot
 * from open range but are weak off their back; BJJ is the mirror image;
 * judo, sambo and Greco take you down from the clinch; sambo is top-heavy
 * like wrestling with leg locks; MMA-first fighters are blended.
 */
export const STYLE_SHAPES: Record<DisciplineCode, Shape> = {
  WRES_FREE: {
    shot_takedown: 24, shot_defense: 18, clinch_takedown: 6, clinch_defense: 10, clinch_control: 8,
    top_control: 20, passing: 8, gnp: 10, top_sub: -4, scrambles: 16, get_up: 16,
    guard_defense: -8, sweeps: -6, guard_sub: -16, sub_defense: -4,
    punch_tech: -6, kick_speed: -10, kick_tech: -12, kick_power: -8, head_movement: -4,
    strength: 6, cardio: 8,
  },
  WRES_GRECO: {
    clinch_takedown: 22, clinch_control: 20, clinch_defense: 20, clinch_strike: 4, shot_takedown: 4, shot_defense: 14,
    top_control: 16, passing: 4, gnp: 8, top_sub: -6, scrambles: 8, get_up: 12,
    guard_defense: -8, sweeps: -8, guard_sub: -16, sub_defense: -4,
    punch_tech: -6, kick_speed: -12, kick_tech: -14, kick_power: -8,
    strength: 10, cardio: 4,
  },
  BJJ: {
    guard_sub: 24, sweeps: 20, guard_defense: 22, top_sub: 16, passing: 16, sub_defense: 20, top_control: 6, scrambles: 6,
    shot_takedown: -8, shot_defense: -8, clinch_takedown: 0, clinch_defense: -4, get_up: -8, gnp: -4,
    punch_power: -6, punch_tech: -6, kick_tech: -10, kick_power: -8, head_movement: -6,
  },
  SAMBO: {
    clinch_takedown: 22, clinch_control: 12, clinch_defense: 10, shot_takedown: 8, shot_defense: 6,
    top_control: 18, passing: 10, gnp: 12, top_sub: 14, sub_defense: 8, scrambles: 8, get_up: 8,
    guard_defense: -2, sweeps: -4, guard_sub: -8,
    punch_power: 4, kick_tech: -6, head_movement: -2,
    strength: 6,
  },
  JUDO: {
    clinch_takedown: 26, clinch_control: 16, clinch_defense: 18, shot_takedown: -6, shot_defense: -2,
    top_control: 12, passing: 4, top_sub: 8, gnp: 2, scrambles: 4, sub_defense: 6,
    guard_defense: -2, sweeps: -2, guard_sub: -6,
    punch_tech: -6, kick_speed: -8, kick_tech: -10, kick_power: -6,
    strength: 4,
  },
  BOXING: {
    punch_speed: 14, punch_power: 12, punch_tech: 22, head_movement: 20,
    kick_speed: -12, kick_tech: -16, kick_power: -10,
    shot_takedown: -10, shot_defense: -10, clinch_takedown: -8, clinch_defense: -4,
    top_control: -8, passing: -10, gnp: -2, top_sub: -12, guard_defense: -12, sweeps: -10, guard_sub: -14, get_up: -4, sub_defense: -8,
    composure: 6, speed: 6, chin: 4,
  },
  MUAY_THAI: {
    kick_power: 20, kick_tech: 16, kick_speed: 6, clinch_strike: 22, clinch_control: 16, clinch_defense: 12,
    punch_tech: 6, punch_power: 6, head_movement: 0,
    shot_takedown: -10, shot_defense: 0, clinch_takedown: 6,
    top_control: -8, passing: -10, top_sub: -12, guard_defense: -10, sweeps: -10, guard_sub: -12, get_up: -2, sub_defense: -8,
    durability: 6,
  },
  KICKBOXING: {
    kick_tech: 16, kick_speed: 12, kick_power: 12, punch_tech: 14, punch_speed: 10, punch_power: 4, head_movement: 8,
    shot_takedown: -10, shot_defense: -6, clinch_takedown: -8,
    top_control: -8, passing: -10, top_sub: -12, guard_defense: -10, sweeps: -10, guard_sub: -12, sub_defense: -8,
    cardio: 4, speed: 4,
  },
  KARATE: {
    kick_speed: 20, kick_tech: 16, kick_power: 4, punch_speed: 14, punch_tech: 6, head_movement: 14, shot_defense: 4,
    clinch_strike: -6, clinch_control: -8, clinch_takedown: -8, shot_takedown: -6,
    top_control: -8, passing: -10, top_sub: -12, guard_defense: -10, sweeps: -10, guard_sub: -12, sub_defense: -8,
    speed: 10, fight_iq: 8,
  },
  TAEKWONDO: {
    kick_speed: 22, kick_tech: 20, kick_power: 10, head_movement: 6, punch_tech: -6,
    clinch_strike: -8, clinch_control: -10, clinch_takedown: -10, clinch_defense: -6, shot_takedown: -10, shot_defense: -8,
    top_control: -10, passing: -10, top_sub: -12, guard_defense: -12, sweeps: -10, guard_sub: -12, sub_defense: -8,
    speed: 10,
  },
  AM_MMA: {
    punch_tech: 6, punch_speed: 4, punch_power: 4, kick_tech: 4, head_movement: 6,
    shot_takedown: 8, shot_defense: 12, clinch_takedown: 4, clinch_defense: 10, clinch_control: 6, clinch_strike: 4,
    top_control: 6, passing: 4, gnp: 10, top_sub: 4, guard_defense: 8, sweeps: 4, guard_sub: 2, get_up: 14, sub_defense: 8, scrambles: 8,
    fight_iq: 6,
  },
};

/** What each style is called on a fighter's profile. */
export const STYLE_NAMES: Record<DisciplineCode, string> = {
  WRES_FREE: "Wrestler", WRES_GRECO: "Greco-Roman wrestler", BJJ: "Jiu-jitsu", SAMBO: "Sambo", JUDO: "Judoka",
  BOXING: "Boxer", MUAY_THAI: "Muay Thai", KICKBOXING: "Kickboxer", KARATE: "Karateka", TAEKWONDO: "Taekwondo", AM_MMA: "MMA",
};

const ARCHETYPE_BY_DISCIPLINE: Record<DisciplineCode, Archetype[]> = {
  WRES_FREE: ["wrestle_boxer", "ground_and_pound", "clinch_grinder"],
  WRES_GRECO: ["clinch_grinder", "ground_and_pound", "wrestle_boxer"],
  BOXING: ["pressure_striker", "counter_striker"],
  JUDO: ["clinch_grinder", "submission_hunter", "ground_and_pound"],
  BJJ: ["submission_hunter"],
  SAMBO: ["leg_locker", "submission_hunter", "clinch_grinder"],
  KARATE: ["point_karateka", "counter_striker"],
  MUAY_THAI: ["kickboxer", "pressure_striker"],
  KICKBOXING: ["kickboxer", "pressure_striker", "counter_striker"],
  TAEKWONDO: ["point_karateka", "kickboxer"],
  AM_MMA: ["all_rounder", ...ARCHETYPES],
};

export interface GeneratedFighter {
  attrs: Attributes;
  archetype: Archetype;
  discipline: DisciplineCode;
  disciplineLevel: number;
}

/**
 * Generate a fighter's attributes at a given age. `talent` is a 0-100 base,
 * normally distributed around 45. Younger fighters sit below their potential.
 */
export function generateFighter(rng: Rng, regionStrengths: readonly string[], ageYears: number, sex: Sex, force?: DisciplineCode): GeneratedFighter {
  const allDisciplines = Object.keys(STYLE_SHAPES) as DisciplineCode[];
  const discipline: DisciplineCode = force ?? (rng.chance(0.6)
    ? (rng.pick(regionStrengths) as DisciplineCode)
    : rng.pick(allDisciplines));
  const talent = clamp(rng.normal(46, 11), 15, 90);
  const potential = Math.round(clamp(talent + Math.abs(rng.normal(8, 8)), 20, 99));
  // How far toward potential they are at this age (peak ~28).
  const maturity = clamp(0.62 + (ageYears - 20) * 0.045, 0.6, 1);
  const base = talent * maturity + (potential - talent) * (maturity - 0.6);
  const shape = STYLE_SHAPES[discipline];
  const roll = (key: keyof Attributes, sd = 9) =>
    Math.round(clamp(base + (shape[key] ?? 0) + rng.normal(0, sd), 5, 99));
  // Physical and mental first (fixed order keeps old seeds stable for these), then the detailed skills.
  const attrs = {
    strength: roll("strength"), speed: roll("speed"), cardio: roll("cardio"),
    chin: Math.round(clamp(rng.normal(62 + (shape.chin ?? 0), 14), 15, 99)),
    recovery: roll("recovery"), durability: Math.round(clamp(rng.normal(60 + (shape.durability ?? 0), 14), 15, 99)),
    fight_iq: roll("fight_iq"), composure: roll("composure"),
    aggression: Math.round(clamp(rng.normal(55, 18), 5, 99)),
    heart: Math.round(clamp(rng.normal(60, 15), 10, 99)),
    charisma: Math.round(clamp(rng.normal(45, 18), 5, 99)),
    mic_skill: Math.round(clamp(rng.normal(40, 18), 5, 99)),
    professionalism: Math.round(clamp(rng.normal(60, 15), 5, 99)),
    potential,
  } as Attributes;
  for (const k of DETAIL_KEYS) attrs[k] = roll(k, 8);
  syncCoarse(attrs);
  if (sex === "F") attrs.strength = Math.round(clamp(attrs.strength, 5, 99));
  const archetype = rng.pick(ARCHETYPE_BY_DISCIPLINE[discipline]);
  return { attrs, archetype, discipline, disciplineLevel: Math.round(clamp(talent + 25 + rng.normal(0, 8), 30, 99)) };
}
