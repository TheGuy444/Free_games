export const WEEKS_PER_YEAR = 52;

export type Sex = "M" | "F";

export interface WeightClassDef {
  code: string;
  name: string;
  sex: Sex;
  limitKg: number;
  /** Share of the fighter population in this class. */
  popShare: number;
}

// Generic weight-class labels used across real MMA; limits are our own table.
export const WEIGHT_CLASSES: WeightClassDef[] = [
  { code: "M_FLY", name: "Flyweight", sex: "M", limitKg: 57, popShare: 0.07 },
  { code: "M_BAN", name: "Bantamweight", sex: "M", limitKg: 61, popShare: 0.1 },
  { code: "M_FEA", name: "Featherweight", sex: "M", limitKg: 66, popShare: 0.12 },
  { code: "M_LIG", name: "Lightweight", sex: "M", limitKg: 70, popShare: 0.14 },
  { code: "M_WEL", name: "Welterweight", sex: "M", limitKg: 77, popShare: 0.13 },
  { code: "M_MID", name: "Middleweight", sex: "M", limitKg: 84, popShare: 0.1 },
  { code: "M_LHW", name: "Light Heavyweight", sex: "M", limitKg: 93, popShare: 0.07 },
  { code: "M_HW", name: "Heavyweight", sex: "M", limitKg: 120, popShare: 0.06 },
  { code: "F_ATM", name: "Atomweight", sex: "F", limitKg: 48, popShare: 0.03 },
  { code: "F_STR", name: "Strawweight", sex: "F", limitKg: 52, popShare: 0.06 },
  { code: "F_FLY", name: "Flyweight", sex: "F", limitKg: 57, popShare: 0.05 },
  { code: "F_BAN", name: "Bantamweight", sex: "F", limitKg: 61, popShare: 0.04 },
  { code: "F_FEA", name: "Featherweight", sex: "F", limitKg: 66, popShare: 0.03 },
];

export const DISCIPLINES = [
  { code: "WRES_FREE", name: "Freestyle Wrestling" },
  { code: "WRES_GRECO", name: "Greco-Roman Wrestling" },
  { code: "BOXING", name: "Boxing" },
  { code: "JUDO", name: "Judo" },
  { code: "BJJ", name: "Brazilian Jiu-Jitsu" },
  { code: "SAMBO", name: "Sambo" },
  { code: "KARATE", name: "Japanese Karate" },
  { code: "MUAY_THAI", name: "Muay Thai" },
  { code: "KICKBOXING", name: "Kickboxing" },
  { code: "TAEKWONDO", name: "Taekwondo" },
  { code: "AM_MMA", name: "Amateur MMA" },
] as const;
export type DisciplineCode = (typeof DISCIPLINES)[number]["code"];

export const ARCHETYPES = [
  "pressure_striker",
  "counter_striker",
  "kickboxer",
  "wrestle_boxer",
  "ground_and_pound",
  "submission_hunter",
  "clinch_grinder",
  "leg_locker",
  "point_karateka",
  "all_rounder",
] as const;
export type Archetype = (typeof ARCHETYPES)[number];

export type Tier = "global" | "major" | "regional" | "local";

export interface TierDef {
  tier: Tier;
  /** Promotions of this tier per region (global ones are world-wide). */
  perRegion: number;
  eventsPerYear: number;
  boutsPerCard: number;
  rosterSize: number;
  /** Minimum quality (0-100 overall) the promotion will sign. */
  minOverall: number;
  basePurse: number;
}

export const TIERS: TierDef[] = [
  { tier: "global", perRegion: 0, eventsPerYear: 48, boutsPerCard: 12, rosterSize: 400, minOverall: 60, basePurse: 40000 },
  { tier: "major", perRegion: 1, eventsPerYear: 22, boutsPerCard: 11, rosterSize: 160, minOverall: 50, basePurse: 12000 },
  { tier: "regional", perRegion: 4, eventsPerYear: 12, boutsPerCard: 10, rosterSize: 80, minOverall: 40, basePurse: 3000 },
  { tier: "local", perRegion: 10, eventsPerYear: 8, boutsPerCard: 8, rosterSize: 40, minOverall: 0, basePurse: 600 },
];
export const GLOBAL_PROMOTIONS = 2;

/** Career length targets from the design doc. */
export const CAREER = {
  typicalLow: 30,
  typicalHigh: 40,
  veteran: 50,
  forcedRetirement: 70,
};
