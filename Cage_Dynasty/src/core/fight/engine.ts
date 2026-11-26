import type { Attributes, FighterState } from "../model.js";
import { clamp, Rng } from "../rng.js";
import { PROFILES } from "./profiles.js";
import { scoreRound, makeJudges, decide } from "./judges.js";
import type { Corner, EventKind, FightEvent, FightResult, GroundSpot, Position, RoundStats, StrikeType, SubType } from "./types.js";

/**
 * Full-fidelity fight engine. Time moves in short steps (4-9 s). Each step the
 * fighters' styles, skills, fatigue and damage decide who acts and what they
 * try; the outcome is applied and recorded as a compact event.
 */

interface Fighter {
  a: Attributes;
  style: (typeof PROFILES)[keyof typeof PROFILES];
  stamina: number;     // 0-100
  head: number;        // accumulated head damage this fight
  body: number;
  legs: number;
  rocked: number;      // steps remaining while hurt
  cut: number;
  carry: number;       // career damage carried in
  idle: number;
  /** Fight-night form: a small random multiplier so favourites can lose. */
  form: number;
  chinPenalty: number;
  stuffed: number;
  /** Trait flags (see traits.ts). */
  t: { ko: boolean; shot: boolean; bang: boolean; brawl: boolean; safe: boolean; slow: boolean };
}

const STRIKES: Record<StrikeType, { dmg: number; acc: number; kd: number; head: boolean; sig: boolean; cost: number }> = {
  jab: { dmg: 1.2, acc: 0.42, kd: 0.002, head: true, sig: true, cost: 0.35 },
  cross: { dmg: 3.2, acc: 0.33, kd: 0.022, head: true, sig: true, cost: 0.7 },
  hook: { dmg: 3.5, acc: 0.3, kd: 0.03, head: true, sig: true, cost: 0.75 },
  uppercut: { dmg: 3.4, acc: 0.28, kd: 0.028, head: true, sig: true, cost: 0.75 },
  overhand: { dmg: 4.2, acc: 0.24, kd: 0.04, head: true, sig: true, cost: 0.9 },
  combo: { dmg: 4.6, acc: 0.3, kd: 0.032, head: true, sig: true, cost: 1.3 },
  leg_kick: { dmg: 2.4, acc: 0.55, kd: 0, head: false, sig: true, cost: 0.6 },
  body_kick: { dmg: 3, acc: 0.42, kd: 0, head: false, sig: true, cost: 0.8 },
  head_kick: { dmg: 6.5, acc: 0.17, kd: 0.1, head: true, sig: true, cost: 1.2 },
  spinning: { dmg: 6, acc: 0.12, kd: 0.09, head: true, sig: true, cost: 1.4 },
  knee_body: { dmg: 2.6, acc: 0.5, kd: 0, head: false, sig: true, cost: 0.6 },
  knee_head: { dmg: 4.8, acc: 0.3, kd: 0.06, head: true, sig: true, cost: 0.8 },
  elbow: { dmg: 3.6, acc: 0.34, kd: 0.025, head: true, sig: true, cost: 0.6 },
  dirty_boxing: { dmg: 1.8, acc: 0.48, kd: 0.006, head: true, sig: true, cost: 0.4 },
  gnp: { dmg: 2.4, acc: 0.5, kd: 0, head: true, sig: true, cost: 0.6 },
  gnp_elbow: { dmg: 3.4, acc: 0.42, kd: 0, head: true, sig: true, cost: 0.7 },
};

/** Tuning knobs for how styles play out. Calibrated against the targets in the README. */
export const KNOBS = {
  shotRate: 0.25,       // how often fighters shoot from open range
  shotBase: 0.32,       // shot success between equal fighters
  clinchSeek: 0.05,     // extra pull toward the clinch per point of clinch takedown skill over 60
  clinchTdRate: 1,      // how often trips and throws are tried from the clinch
  clinchTdBase: 0.38,   // trip/throw success between equal fighters
  pullGuard: 0.05,      // guard pulling per point of guard-sub skill over 65
  guardSubRate: 0.04,   // bottom submission attempts per point of guard-sub skill over 50
  legDamageScale: 160,  // leg-kick damage that would fully cripple (capped below)
  legDamageCap: 0.25,   // most a fighter can be slowed by leg damage
  stuffedKnee: 0.18,    // chance a stuffed shot eats a knee
  subFinish: 0.8,       // submission finishing rate
  knockdown: 1.12,      // knockdown rate from power strikes
  gamePlan: 1.6,          // how hard fighters steer the fight toward their edges (scaled by fight IQ)
};

const SUB_BASE: Record<GroundSpot | "scramble" | "clinch", number> = {
  back: 0.11, mount: 0.06, side: 0.045, half: 0.02, guard: 0.03, scramble: 0.025, clinch: 0.025,
};

export interface FightOptions {
  /** Record events (play-by-play). Off for standard fidelity. */
  log?: boolean;
  /** Weigh-in effects, e.g. a draining cut: [red, blue]. */
  mods?: [{ startStamina: number; chinPenalty: number }, { startStamina: number; chinPenalty: number }];
}

export function simulateFight(red: FighterState, blue: FighterState, rounds: number, seed: number, opts: FightOptions = {}): FightResult {
  const rng = new Rng(seed);
  const log = opts.log !== false;
  const f: [Fighter, Fighter] = [mk(red), mk(blue)];
  if (opts.mods) for (const c of [0, 1] as const) { f[c].stamina = opts.mods[c].startStamina; f[c].chinPenalty = opts.mods[c].chinPenalty; }
  const events: FightEvent[] = [];
  const stats: RoundStats[][] = [];
  const judges = makeJudges(rng);
  const cards: [number, number][][] = judges.map(() => []);
  let pos: Position = { kind: "distance" };
  let round = 1;
  let t = 0;
  let result: { winner: Corner; method: FightResult["method"] } | null = null;

  const emit = (a: Corner, k: EventKind, x?: string, v?: number) => {
    if (log) events.push(v === undefined ? (x === undefined ? { r: round, t, a, k } : { r: round, t, a, k, x }) : { r: round, t, a, k, x, v });
  };
  const st = (c: Corner) => stats[round - 1]![c]!;
  const other = (c: Corner): Corner => (c === 0 ? 1 : 0);
  const eff = (c: Corner, v: number) => {
    const x = f[c];
    // Chewed-up legs slow everything down: movement, shots, defense.
    const legs = 1 - Math.min(KNOBS.legDamageCap, x.legs / KNOBS.legDamageScale);
    const warm = x.t.slow ? (round === 1 ? 0.88 : round >= 3 ? 1.06 : 1) : 1;
    return v * x.form * warm * (0.55 + 0.45 * x.stamina / 100) * (x.rocked > 0 ? 0.6 : 1) * legs;
  };
  const spend = (c: Corner, cost: number) => {
    const x = f[c];
    const drain = cost * (1.6 - x.a.cardio / 100) * (1 + x.body / 80);
    x.stamina = clamp(x.stamina - drain, 0, 100);
  };
  const effChin = (c: Corner) => {
    const x = f[c];
    return Math.max(8, x.a.chin * (1 - x.head / 320) - x.carry * 0.15 - x.chinPenalty);
  };
  // Five-round fighters pace themselves: fewer reckless exchanges, fewer finishes per round.
  const pace = rounds >= 5 ? 0.62 : 1;
  const finish = (winner: Corner, method: FightResult["method"], kind: EventKind, x?: string) => {
    result = { winner, method };
    emit(winner, kind, x);
  };

  /** Resolve one strike from `c`. Returns true if it landed. */
  const strike = (c: Corner, type: StrikeType): boolean => {
    const s = STRIKES[type];
    const att = f[c];
    const def = f[other(c)];
    const d = other(c);
    const A = att.a;
    const isKick = type.includes("kick") || type === "spinning";
    const isClinch = type.startsWith("knee") || type === "elbow" || type === "dirty_boxing";
    const isGnp = type.startsWith("gnp");
    // Landing comes from technique and speed; damage from the matching power stat.
    const [skillRaw, powerRaw] = isKick ? [A.kick_tech * 0.6 + A.kick_speed * 0.4, A.kick_power]
      : isClinch ? [A.clinch_strike, A.clinch_strike * 0.5 + A.strength * 0.5]
      : isGnp ? [A.gnp, A.gnp * 0.5 + A.strength * 0.5]
      : [A.punch_tech * 0.6 + A.punch_speed * 0.4, A.punch_power];
    const skill = eff(c, skillRaw);
    const pw = powerRaw;
    const defense = eff(d, isGnp ? def.a.guard_defense * 0.6 + def.a.fight_iq * 0.4
      : isClinch ? def.a.clinch_control * 0.4 + def.a.head_movement * 0.3 + def.a.composure * 0.3
      : def.a.head_movement * 0.6 + def.a.fight_iq * 0.2 + def.a.composure * 0.2);
    spend(c, s.cost);
    if (s.sig) st(c).sigAtt++;
    const acc = clamp(s.acc + 0.06 + (skill - defense) / 220 - (def.rocked > 0 ? -0.15 : 0) + (def.t.brawl ? 0.05 : 0) - (att.t.ko && !isGnp ? 0.03 : 0) + (def.t.safe ? -0.03 : 0), 0.05, 0.85);
    if (!rng.chance(acc)) {
      emit(c, rng.chance(0.4) && !type.startsWith("gnp") ? "strike_block" : "strike_miss", type);
      return false;
    }
    // Relative to the opponent, so elite-vs-elite fights finish about as often as novice fights.
    const power = Math.max(0.5, 0.95 + (pw - def.a.strength) / 260 + (skill - defense) / 400) * (0.7 + rng.next() * 0.6) * (att.t.ko ? 1.12 : 1) * (att.t.safe ? 0.9 : 1);
    const dmg = s.dmg * power;
    const landed = type === "combo" ? 2 : 1;
    st(c).sigLand += landed;
    st(c).totalLand += landed;
    st(c).dmg += dmg;
    if (s.head) def.head += dmg;
    else if (type === "leg_kick") def.legs += dmg;
    else { def.body += dmg; def.stamina = clamp(def.stamina - dmg * 0.8, 0, 100); }

    // Cuts from elbows and hard shots.
    if (s.head && (type.includes("elbow") || dmg > 4) && rng.chance(0.04)) {
      def.cut++;
      emit(c, "cut_opened", undefined, def.cut);
      if (def.cut >= 3 && rng.chance(0.35)) {
        emit(d, "doctor_check");
        if (rng.chance(0.4)) { finish(c, "TKO", "tko_doctor"); return true; }
      }
    }

    // Big moments: knockdowns, rocked opponents, finishes.
    if (s.kd > 0 || (type.startsWith("gnp") && def.rocked > 0)) {
      const chinRatio = 60 / effChin(d);
      const pKd = pace * 0.3 * KNOBS.knockdown * (att.t.ko ? 1.3 : 1) * s.kd * Math.max(0.4, 1.5 + (pw - def.a.strength) / 120 + (skill - defense) / 120) * chinRatio * chinRatio;
      if (type.startsWith("gnp")) {
        // Strikes on a hurt fighter on the ground: the referee may step in.
        if (rng.chance(pace * clamp(0.1 * chinRatio * (def.rocked > 0 ? 1.6 : 0.4), 0, 0.5))) { finish(c, "TKO", "tko", type); return true; }
      } else if (rng.chance(pKd)) {
        st(c).kd++;
        emit(c, "knockdown", type);
        if (rng.chance(clamp(0.22 * chinRatio, 0.06, 0.6))) { finish(c, "KO", "ko", type); return true; }
        def.rocked = rng.int(2, 4);
        if (att.style.gnp + att.a.aggression / 20 > 6 || rng.chance(0.55)) {
          pos = { kind: "ground", top: c, spot: rng.chance(0.6) ? "guard" : "half" };
        }
        return true;
      } else if (def.rocked > 0 && rng.chance(pace * clamp(0.18 * chinRatio, 0.06, 0.5))) {
        // Already hurt and eating more: the referee waves it off.
        finish(c, "TKO", "tko", type);
        return true;
      } else if (rng.chance(pKd * 2.5)) {
        def.rocked = rng.int(1, 3);
        emit(c, "rocked", type);
        return true;
      }
    }
    if (dmg > 4.5) emit(c, "big_strike", type);
    else emit(c, "strike_land", type);
    return true;
  };

  const trySub = (c: Corner, from: keyof typeof SUB_BASE) => {
    const att = f[c];
    const d = other(c);
    const def = f[d];
    let sub: SubType;
    if (from === "back") sub = "rear_naked_choke";
    else if (from === "clinch" || from === "scramble") sub = rng.pick(["guillotine", "darce", "heel_hook"] as const);
    else sub = rng.pick(att.style.subs) as SubType;
    if ((sub === "heel_hook" || sub === "kneebar") && !att.style.subs.includes(sub)) sub = "guillotine";
    st(c).subAtt++;
    spend(c, 1.5);
    spend(d, 1.2);
    emit(c, "sub_attempt", sub);
    // Subs from top, from the bottom and in scrambles draw on different skills.
    const offense = pos.kind === "ground" ? (pos.top === c ? att.a.top_sub : att.a.guard_sub) : Math.max(att.a.top_sub, att.a.guard_sub) * 0.8 + att.a.scrambles * 0.2;
    const ratio = eff(c, offense) / Math.max(10, eff(d, def.a.sub_defense));
    const p = pace * KNOBS.subFinish * clamp(SUB_BASE[from] * ratio * ratio * (def.stamina < 30 ? 1.5 : 1) * (def.rocked > 0 ? 1.8 : 1), 0.01, 0.65);
    if (rng.chance(p)) { finish(c, "SUB", "sub_win", sub); return; }
    emit(d, "sub_escape", sub);
    // A failed attempt can cost position: from bottom the top fighter passes, from top the bottom fighter reverses.
    if (pos.kind === "ground") {
      if (pos.top !== c && rng.chance(0.25)) pos = { kind: "ground", top: pos.top, spot: "half" };
      else if (pos.top === c && rng.chance(0.2)) { pos = { kind: "ground", top: d, spot: "guard" }; emit(d, "sweep"); }
    }
  };

  for (; round <= rounds && !result; round++) {
    stats.push([emptyStats(), emptyStats()]);
    t = 0;
    pos = { kind: "distance" };
    emit(0, "round_start");
    while (t < 300 && !result) {
      const dt = rng.int(3, 5);
      t = Math.min(300, t + dt);
      for (const c of [0, 1] as const) {
        const x = f[c];
        if (x.rocked > 0) {
          x.rocked--;
          if (x.rocked === 0 && log && rng.chance(0.5)) emit(c, "recovers");
        }
        x.stamina = clamp(x.stamina + 0.15 * x.a.cardio / 60, 0, 100);
      }

      if (pos.kind === "distance") {
        const w0 = eff(0, f[0].a.aggression + f[0].a.speed) * (f[0].rocked > 0 ? 0.3 : 1);
        const w1 = eff(1, f[1].a.aggression + f[1].a.speed) * (f[1].rocked > 0 ? 0.3 : 1);
        const lull = 0.1 * (f[0].t.safe || f[1].t.safe ? 1.6 : 1) * (f[0].t.brawl || f[1].t.brawl ? 0.5 : 1);
        if (rng.chance(lull)) { if (rng.chance(0.25)) emit(0, "feel_out"); continue; }
        const c: Corner = rng.chance(w0 / (w0 + w1)) ? 0 : 1;
        const p = f[c].style;
        const legPenalty = f[c].legs > 18 ? 0.5 : 1;
        const A = f[c].a, D = f[other(c)].a;
        // Wrestlers shoot from open range; judo, sambo, Greco and Muay Thai fighters look for the clinch;
        // a jiu-jitsu fighter who can't win the takedown may pull guard instead.
        const shotW = p.takedown * KNOBS.shotRate * (A.shot_takedown / 55) ** 2;
        const clinchW = p.clinch + Math.max(0, A.clinch_takedown - 60) * KNOBS.clinchSeek + Math.max(0, A.clinch_strike - 60) * KNOBS.clinchSeek * 0.6;
        const pullW = A.guard_sub > 65 && A.guard_sub > A.shot_takedown + 10 && D.top_control < A.guard_sub ? (A.guard_sub - 65) * KNOBS.pullGuard : 0;
        // Game plan: smarter fighters lean into where they have the edge and away from where they don't.
        const iq = KNOBS.gamePlan * (A.fight_iq / 60);
        const lean = (edge: number) => clamp(1 + (edge / 40) * iq, 0.35, 2.2);
        const punchEdge = lean((A.punch_tech + A.punch_speed) / 2 - D.head_movement);
        const kickEdge = lean((A.kick_tech + A.kick_speed) / 2 - (D.head_movement + D.shot_defense) / 2);
        const shotEdge = lean(A.shot_takedown - D.shot_defense + (A.top_control - D.guard_defense) * 0.5);
        const clinchEdge = lean(Math.max(A.clinch_takedown - D.clinch_defense, A.clinch_strike - D.clinch_control) + (A.clinch_control - D.clinch_control) * 0.5);
        // Traits override the game plan: some fighters do what they love no matter what.
        const T = f[c].t;
        const strikeT = T.bang ? 1.3 : T.shot ? 0.45 : 1;
        const powerT = (T.ko ? 1.7 : 1) * (T.brawl ? 1.35 : 1) * (T.safe ? 0.6 : 1);
        const shotT = T.shot ? 4 : T.bang ? 0.2 : 1;
        const action = rng.weighted(
          ["jab", "power", "combo", "leg_kick", "body_kick", "head_kick", "spinning", "takedown", "clinch", "pull_guard"] as const,
          [p.jab * punchEdge * strikeT * (T.ko ? 0.6 : 1), p.power * punchEdge * strikeT * powerT, p.combo * punchEdge * strikeT * powerT,
            p.leg_kick * legPenalty * kickEdge * strikeT, p.body_kick * legPenalty * kickEdge * strikeT,
            p.head_kick * legPenalty * kickEdge * strikeT * (T.ko ? 1.5 : 1), p.spinning * kickEdge * strikeT,
            shotW * (T.shot ? Math.max(1, shotEdge) : shotEdge) * shotT, clinchW * clinchEdge * (T.bang ? 0.6 : 1), pullW]);
        if (action === "takedown") {
          const d = other(c);
          st(c).tdAtt++;
          spend(c, 2.2);
          emit(c, "td_attempt");
          // Opponents read a fighter who keeps shooting: each stuffed shot makes the next one harder.
          const pTd = clamp(KNOBS.shotBase + (eff(c, f[c].a.shot_takedown) - eff(d, f[d].a.shot_defense)) / 110 - Math.min(0.18, f[c].stuffed * 0.03), 0.06, 0.85);
          if (rng.chance(pTd)) {
            st(c).tdLand++;
            pos = { kind: "ground", top: c, spot: rng.weighted(["guard", "half", "side"] as const, [55, 32, 13]) };
            emit(c, "td_land", pos.spot);
          } else {
            emit(d, "td_stuffed");
            f[c].stuffed++;
            // Shooting into a ready opponent: the knee is waiting.
            if (rng.chance(KNOBS.stuffedKnee)) strike(d, "knee_head");
            if (result) continue;
            if (rng.chance(0.35)) pos = { kind: "clinch", against: rng.chance(0.5) };
            else if (rng.chance(0.06)) trySub(d, "scramble");
          }
        } else if (action === "pull_guard") {
          spend(c, 0.5);
          pos = { kind: "ground", top: other(c), spot: "guard" };
          emit(c, "pull_guard");
        } else if (action === "clinch") {
          spend(c, 0.8);
          if (rng.chance(0.6)) { pos = { kind: "clinch", against: rng.chance(0.55) }; emit(c, "clinch_enter"); }
          else strike(c, "jab");
        } else if (action === "power") {
          strike(c, rng.weighted(["cross", "hook", "uppercut", "overhand"] as const, [4, 4, 2, 1.5]));
        } else {
          strike(c, action);
        }
        // Counter strike chance.
        if (!result && rng.chance(0.38 * f[other(c)].a.fight_iq / 60 * (f[c].t.ko || f[c].t.brawl ? 1.35 : 1) * (f[other(c)].t.brawl ? 1.3 : 1))) strike(other(c), rng.pick(["jab", "cross", "hook"] as const));
      } else if (pos.kind === "clinch") {
        const s0 = eff(0, f[0].a.strength + f[0].a.clinch_control * 1.5);
        const s1 = eff(1, f[1].a.strength + f[1].a.clinch_control * 1.5);
        const c: Corner = rng.chance(s0 / (s0 + s1)) ? 0 : 1;
        st(c).ctrl += dt * 0.5;
        const p = f[c].style;
        const action = rng.weighted(["knee_body", "knee_head", "elbow", "dirty_boxing", "trip", "press", "break", "sub"] as const,
          [3, 1.2, 1.2, 3, (p.takedown * 0.2 + 0.3) * (f[c].a.clinch_takedown / 50) ** 2 * KNOBS.clinchTdRate, pos.against ? 0.5 : 1.5, 1.5, 0.04 + p.sub * 0.015]);
        if (action === "trip") {
          const d = other(c);
          st(c).tdAtt++;
          spend(c, 1.8);
          const throwing = f[c].a.clinch_takedown >= 65 && rng.chance(0.6);
          emit(c, "td_attempt", throwing ? "throw" : "trip");
          if (rng.chance(clamp(KNOBS.clinchTdBase + (eff(c, f[c].a.clinch_takedown + f[c].a.strength * 0.5) - eff(d, f[d].a.clinch_defense + f[d].a.strength * 0.5)) / 165, 0.08, 0.8))) {
            st(c).tdLand++;
            // A clean throw lands past the guard far more often than a trip.
            const q = throwing ? Math.max(0, f[c].a.clinch_takedown - 55) * 0.9 : 0;
            pos = { kind: "ground", top: c, spot: rng.weighted(["guard", "half", "side"] as const, [45 - q * 0.6, 38, 17 + q]) };
            emit(c, "td_land", pos.spot);
          } else emit(d, "td_stuffed");
        } else if (action === "press") { pos = { kind: "clinch", against: true }; emit(c, "cage_press"); }
        else if (action === "break") { pos = { kind: "distance" }; emit(other(c), "clinch_break"); }
        else if (action === "sub") trySub(c, "clinch");
        else strike(c, action);
        if (!result && pos.kind === "clinch" && rng.chance(0.07)) { pos = { kind: "distance" }; emit(0, "ref_break"); }
      } else {
        const g = pos as Extract<Position, { kind: "ground" }>;
        const top: Corner = g.top;
        const bot = other(top);
        const ft = f[top], fb = f[bot];
        st(top).ctrl += dt;
        const topActs = rng.chance(clamp(0.55 + (eff(top, ft.a.top_control) - eff(bot, fb.a.guard_defense * 0.6 + fb.a.scrambles * 0.4)) / 200, 0.3, 0.85));
        if (topActs) {
          const action = rng.weighted(["gnp", "gnp_elbow", "advance", "sub", "hold"] as const,
            [ft.style.gnp, ft.style.gnp * 0.35, ft.style.advance, ft.style.sub * 0.3 * (g.spot === "guard" ? 0.3 : 1), 2.5]);
          if (action === "gnp" || action === "gnp_elbow") {
            strike(top, g.spot === "guard" ? "gnp" : action);
            ft.idle = 0;
          } else if (action === "advance") {
            spend(top, 1);
            const next: Record<GroundSpot, GroundSpot> = { guard: "half", half: "side", side: rng.chance(0.55) ? "mount" : "back", mount: "back", back: "back" };
            if (g.spot !== "back" && rng.chance(clamp(0.3 + (eff(top, ft.a.passing * 0.6 + ft.a.top_control * 0.4) - eff(bot, fb.a.guard_defense * 0.7 + fb.a.scrambles * 0.3)) / 140, 0.08, 0.7))) {
              pos = { kind: "ground", top, spot: next[g.spot] };
              emit(top, "advance", g.spot);
            }
            ft.idle = 0;
          } else if (action === "sub") {
            trySub(top, g.spot);
            ft.idle = 0;
          } else {
            ft.idle++;
          }
        } else {
          // Off their back, a jiu-jitsu player attacks; a wrestler fights to stand up.
          const guardLean = Math.max(0, fb.a.guard_sub - fb.a.get_up) / 15;
          const action = rng.weighted(["get_up", "sweep", "sub", "hold"] as const,
            [Math.max(1, 3 + fb.a.get_up / 30 - guardLean), 1.5 + fb.a.sweeps / 40,
              g.spot === "guard" ? fb.style.sub * 0.12 + Math.max(0, fb.a.guard_sub - 50) * KNOBS.guardSubRate + 0.1 : 0.03, 2]);
          if (action === "get_up") {
            spend(bot, 1.6);
            const spotPenalty = { guard: 0, half: 0.05, side: 0.12, mount: 0.2, back: 0.22 }[g.spot];
            if (rng.chance(clamp(0.3 + (eff(bot, fb.a.get_up * 1.5 + fb.a.scrambles * 0.5) - eff(top, ft.a.top_control * 2)) / 220 - spotPenalty, 0.05, 0.7))) {
              pos = rng.chance(0.4) ? { kind: "clinch", against: true } : { kind: "distance" };
              emit(bot, "get_up");
            }
          } else if (action === "sweep") {
            spend(bot, 1.4);
            if (g.spot !== "back" && g.spot !== "mount" && rng.chance(clamp(0.12 + (eff(bot, fb.a.sweeps) - eff(top, ft.a.top_control)) / 200, 0.03, 0.4))) {
              pos = { kind: "ground", top: bot, spot: "guard" };
              emit(bot, "sweep");
            }
          } else if (action === "sub") {
            trySub(bot, "guard");
          }
          ft.idle++;
        }
        if (!result && pos.kind === "ground" && ft.idle >= 4 && rng.chance(0.25)) {
          pos = { kind: "distance" };
          ft.idle = 0;
          emit(0, "ref_standup");
        }
      }
      for (const c of [0, 1] as const) if (log && f[c].stamina < 25 && rng.chance(0.03)) emit(c, "fatigue");
    }
    if (result) break;
    // Round over: judges score it, fighters recover in the corner.
    t = 300;
    emit(0, "round_end");
    const rs = stats[round - 1] as [RoundStats, RoundStats];
    judges.forEach((j, i) => cards[i]!.push(scoreRound(j, rs, rng)));
    for (const c of [0, 1] as const) {
      const x = f[c];
      x.stamina = clamp(x.stamina + 18 + x.a.recovery / 5, 0, 100);
      x.rocked = 0;
      x.head *= 0.75;
      // Corner stoppage for a badly beaten fighter.
      if (round < rounds && x.head > 75 + x.a.heart / 2 && rng.chance(0.25)) {
        emit(c, "tko_corner");
        result = { winner: other(c), method: "TKO" };
        break;
      }
    }
    if (result) break;
  }

  if (result) {
    const r = result as { winner: Corner; method: FightResult["method"] };
    return { winner: r.winner, method: r.method, endRound: Math.min(round, rounds), endTimeS: t, seed, events, stats, cards };
  }
  const d = decide(cards);
  if (log) events.push({ r: rounds, t: 300, a: d.winner ?? 0, k: "score", x: d.method });
  return { winner: d.winner, method: d.method, endRound: rounds, endTimeS: 300, seed, events, stats, cards };

  function mk(s: FighterState): Fighter {
    const tr = s.traits ?? [];
    return { t: { ko: tr.includes("ko_artist"), shot: tr.includes("lives_on_shot"), bang: tr.includes("loves_to_strike"), brawl: tr.includes("brawler"), safe: tr.includes("safe_fighter"), slow: tr.includes("slow_starter") },
      a: s.attrs, style: PROFILES[s.archetype], stuffed: 0, stamina: 100, head: 0, body: 0, legs: 0, rocked: 0, cut: 0, carry: s.damage, idle: 0, form: clamp(rng.normal(1, 0.15), 0.65, 1.35), chinPenalty: 0 };
  }
}

function emptyStats(): RoundStats {
  return { sigAtt: 0, sigLand: 0, totalLand: 0, kd: 0, tdAtt: 0, tdLand: 0, subAtt: 0, ctrl: 0, dmg: 0 };
}
