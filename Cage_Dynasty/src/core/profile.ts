/**
 * Fighter profile detail: physicals, nickname, amateur accolades, the detailed
 * stat breakdown shown on the Standup / Clinch / Ground pages, and the health
 * report.
 *
 * Detailed stats are derived from the attributes the fight engine uses (plus a
 * small stable per-fighter lean), so they always agree with how the fighter
 * actually fights and they move as the fighter develops and ages.
 */
import { WEIGHT_CLASSES, type Archetype, type Sex } from "./constants.js";
import type { Attributes } from "./model.js";

export function hash(...xs: (number | string)[]): number {
  let h = 2166136261;
  for (const x of xs) {
    const s = String(x);
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    h = Math.imul(h ^ 0x9e37, 16777619);
  }
  return h >>> 0;
}
/** Stable value in [-1, 1) for a fighter and a label. */
export const lean = (id: number, label: string) => (hash(id, label) % 2000) / 1000 - 1;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const r = (x: number) => Math.round(clamp(x, 1, 99));

// ------------------------------------------------------------------ physicals

export interface Physicals { heightCm: number; reachCm: number; stance: "Orthodox" | "Southpaw" | "Switch" }

export function physicals(id: number, sex: Sex, weightClassId: number): Physicals {
  const limit = WEIGHT_CLASSES[weightClassId - 1]?.limitKg ?? 70;
  // Roughly: bigger divisions are taller; women are shorter at the same weight.
  const base = sex === "F" ? 128 + limit * 0.55 : 132 + limit * 0.55;
  const heightCm = Math.round(base + lean(id, "h") * 7);
  const reachCm = Math.round(heightCm + lean(id, "ape") * 6 + 1);
  const s = hash(id, "stance") % 100;
  return { heightCm, reachCm, stance: s < 72 ? "Orthodox" : s < 94 ? "Southpaw" : "Switch" };
}

export const feetInches = (cm: number) => { const inches = Math.round(cm / 2.54); return `${Math.floor(inches / 12)}'${inches % 12}"`; };

// ------------------------------------------------------------------ nickname

const NICK_BY_STYLE: Partial<Record<Archetype, string[]>> = {
  pressure_striker: ["The Storm", "Bulldozer", "Relentless", "The Hammer", "Avalanche"],
  counter_striker: ["The Ghost", "Mirage", "The Matador", "Timing", "Smooth"],
  kickboxer: ["The Axe", "Shins", "Thunderleg", "The Whip", "Lightning"],
  wrestle_boxer: ["The Engine", "Iron", "The Mauler", "Two-Way", "Grit"],
  ground_and_pound: ["The Anvil", "Sledge", "Heavy Hands", "The Press"],
  submission_hunter: ["The Python", "Spider", "The Professor", "Tap City", "Octopus"],
  clinch_grinder: ["The Vice", "Grinder", "The Wall", "Bear Hug"],
  leg_locker: ["Heel Hook", "The Mechanic", "Kneebar", "Footlocker"],
  point_karateka: ["Kata", "The Samurai", "Blitz", "Sensei", "The Blade"],
  all_rounder: ["The Complete", "Swiss Army", "Prodigy", "The Natural"],
};
const NICK_ANY = ["Tank", "Mamba", "Wolf", "Phoenix", "Viper", "The Hurricane", "Diamond", "Rocky", "Cobra", "Tiger", "Showtime", "The Butcher", "Pitbull", "Hitman", "Kid Dynamite", "Hurricane", "Valkyrie", "Rampage", "Ice", "Wildfire"];

/** About half of all fighters carry a nickname; showmen and finishers are likelier to. */
export function nickname(id: number, style: Archetype, charisma: number): string | null {
  if (hash(id, "nick?") % 100 >= 35 + charisma * 0.3) return null;
  const pool = [...(NICK_BY_STYLE[style] ?? []), ...NICK_ANY];
  return pool[hash(id, "nick") % pool.length]!;
}

// ------------------------------------------------------------------ detailed stats

export interface StatRow { label: string; value: number; note?: string }
export interface StatGroup { title: string; rows: StatRow[] }

export function standup(a: Attributes): StatGroup[] {
  return [
    { title: "Punching", rows: [
      { label: "Hand speed", value: a.punch_speed }, { label: "Technique", value: a.punch_tech }, { label: "Power", value: a.punch_power },
    ] },
    { title: "Kicking", rows: [
      { label: "Kick speed", value: a.kick_speed }, { label: "Technique", value: a.kick_tech }, { label: "Power", value: a.kick_power },
    ] },
    { title: "Defense", rows: [
      { label: "Head movement", value: a.head_movement },
      { label: "Takedown defense", value: a.shot_defense, note: "Stopping shots from open range: the sprawl." },
      { label: "Chin", value: a.chin },
    ] },
  ];
}

export function clinch(a: Attributes): StatGroup[] {
  return [
    { title: "Clinch offense", rows: [
      { label: "Knees, elbows, dirty boxing", value: a.clinch_strike },
      { label: "Clinch takedowns", value: a.clinch_takedown, note: "Trips and throws: judo, sambo and Greco-Roman." },
    ] },
    { title: "Clinch control", rows: [
      { label: "Clinch control", value: a.clinch_control, note: "Winning hand fighting and holding the cage." },
      { label: "Clinch defense", value: a.clinch_defense, note: "Staying upright against trips and throws." },
    ] },
  ];
}

export function ground(a: Attributes): StatGroup[] {
  return [
    { title: "Takedowns", rows: [
      { label: "Shots", value: a.shot_takedown, note: "Changing levels from open range: the wrestler's takedown." },
      { label: "Clinch takedowns", value: a.clinch_takedown },
    ] },
    { title: "Top game", rows: [
      { label: "Top control", value: a.top_control }, { label: "Passing", value: a.passing },
      { label: "Ground and pound", value: a.gnp }, { label: "Submissions from top", value: a.top_sub },
    ] },
    { title: "Bottom game", rows: [
      { label: "Guard retention", value: a.guard_defense }, { label: "Sweeps", value: a.sweeps },
      { label: "Submissions from bottom", value: a.guard_sub }, { label: "Getting up", value: a.get_up },
    ] },
    { title: "Both", rows: [
      { label: "Scrambles", value: a.scrambles }, { label: "Submission defense", value: a.sub_defense },
    ] },
  ];
}

/** One-line read on where a fighter wants the fight. */
export function gameSummary(a: Attributes): string {
  const top = (a.top_control + a.passing + a.gnp + a.top_sub) / 4;
  const bottom = (a.guard_defense + a.sweeps + a.guard_sub + a.get_up) / 4;
  const stand = (a.punch_tech + a.kick_tech + a.head_movement) / 3;
  const parts: string[] = [];
  if (top - bottom >= 10) parts.push("much better on top than off their back");
  else if (bottom - top >= 10) parts.push("dangerous off their back, less so on top");
  if (a.shot_takedown - a.clinch_takedown >= 10) parts.push("shoots from open range");
  else if (a.clinch_takedown - a.shot_takedown >= 10) parts.push("takes you down from the clinch");
  if (stand - (top + bottom) / 2 >= 12) parts.push("wants to keep it standing");
  return parts.length ? cap(parts.join(", ")) + "." : "Well rounded, no clear hole.";
}

// ------------------------------------------------------------------ health

export interface Wear { body: number; arms: number; legs: number }
export interface HealthPart { part: string; health: number; note: string }

/** Head health comes from career damage (what erodes the chin); the rest from accumulated wear. */
export function health(damage: number, wear: Wear, chin: number, injuredWeeks: number): { parts: HealthPart[]; outlook: string } {
  const head = r(100 - damage * 1.6);
  const part = (name: string, h: number, notes: [string, string, string, string]) =>
    ({ part: name, health: h, note: h >= 85 ? notes[0] : h >= 65 ? notes[1] : h >= 40 ? notes[2] : notes[3] });
  const parts = [
    part("Head", head, ["Clean. No sign of wear on the chin.", "Some mileage. Takes a shot well, but not like before.",
      `The chin is fading (chin ${chin}). Knockouts come easier now, and each one speeds up retirement.`,
      "Badly worn. Doctors and family are asking about retirement."]),
    part("Body", r(100 - wear.body), ["Healthy.", "Some rib and liver wear from body work.", "Gasses sooner after body shots.", "Ribs and core badly worn. Cardio suffers."]),
    part("Arms", r(100 - wear.arms), ["Healthy.", "Minor elbow and shoulder wear.", "Shoulders and elbows bother them in camp.", "Joints badly worn from submissions and grappling."]),
    part("Legs", r(100 - wear.legs), ["Healthy.", "Some knee and shin wear from leg kicks.", "Knees limit the footwork.", "Legs badly worn. Movement and kicking are compromised."]),
  ];
  const worst = parts.reduce((a, b) => (b.health < a.health ? b : a));
  const outlook = injuredWeeks > 0 ? `Currently injured: out for about ${Math.max(1, Math.round(injuredWeeks / 4.3))} more month(s).`
    : worst.health >= 85 ? "Fully healthy. No limits on the career from wear."
    : worst.health >= 65 ? `Normal wear for a working fighter. Watch the ${worst.part.toLowerCase()}.`
    : worst.health >= 40 ? `The ${worst.part.toLowerCase()} is shortening this career. Expect a decline in the next few years.`
    : `The ${worst.part.toLowerCase()} is close to ending this career.`;
  return { parts, outlook };
}

/**
 * Wear from one fight: legs from leg kicks, body from body work and clinch,
 * arms from submission attempts and grappling. Heals partly each year.
 */
export function fightWear(opp: Attributes, rounds: number, lost: boolean, method: string): Wear {
  const k = lost ? 1.4 : 0.8;
  const w: Wear = {
    legs: rounds * k * (0.25 + opp.kicks / 140),
    body: rounds * k * (0.2 + (opp.kicks + opp.clinch_strike) / 300),
    arms: rounds * k * (0.1 + (opp.sub_offense + opp.top_control) / 400),
  };
  if (lost && method === "SUB") w.arms += 4;
  return w;
}

// ------------------------------------------------------------------ accolades

const OLYMPIC: Record<string, string> = {
  WRES_FREE: "freestyle wrestling", WRES_GRECO: "Greco-Roman wrestling", BOXING: "boxing", JUDO: "judo", TAEKWONDO: "taekwondo", KARATE: "karate",
};
const WORLDS: Record<string, string> = {
  SAMBO: "Combat Sambo", BJJ: "Brazilian Jiu-Jitsu", MUAY_THAI: "Muay Thai", KICKBOXING: "kickboxing", AM_MMA: "amateur MMA", KARATE: "karate",
  WRES_FREE: "freestyle wrestling", WRES_GRECO: "Greco-Roman wrestling", BOXING: "boxing", JUDO: "judo", TAEKWONDO: "taekwondo",
};

/**
 * Amateur pedigree from the fighter's base disciplines. A placeholder until
 * the amateur and Olympic system simulates these tournaments for real.
 */
export function amateurAccolades(id: number, birthYear: number, sex: Sex, disciplines: { code: string; name: string; level: number }[]): string[] {
  const out: string[] = [];
  const peakYear = birthYear + 21 + (hash(id, "peak") % 4);
  const olympicYear = peakYear - (peakYear % 4);
  for (const d of [...disciplines].sort((a, b) => b.level - a.level).slice(0, 2)) {
    const roll = hash(id, d.code, "medal") % 100;
    const event = OLYMPIC[d.code];
    if (d.level >= 97 && event && roll < 25) {
      const medal = roll < 8 ? "gold" : roll < 16 ? "silver" : "bronze";
      out.push(`Olympic ${medal} medalist, ${sex === "F" ? "women's " : ""}${event} (${olympicYear})`);
    } else if (d.level >= 94 && WORLDS[d.code] && roll < 45) {
      out.push(`${cap(WORLDS[d.code]!)} world champion (${peakYear})`);
    } else if (d.level >= 90 && WORLDS[d.code] && roll < 65) {
      out.push(`${cap(WORLDS[d.code]!)} world championships medalist (${peakYear})`);
    } else if (d.level >= 82 && roll < 70) {
      out.push(`National ${d.name.toLowerCase()} champion (${peakYear - 1})`);
    } else if (d.code === "BJJ" && d.level >= 65) {
      out.push("Brazilian Jiu-Jitsu black belt");
    }
  }
  return out;
}
