import type { Method } from "../fight-light.js";

/** Who did it: 0 = red corner, 1 = blue corner. */
export type Corner = 0 | 1;

export type GroundSpot = "guard" | "half" | "side" | "mount" | "back";

export type Position =
  | { kind: "distance" }
  | { kind: "clinch"; against: boolean } // against = pressed on the cage
  | { kind: "ground"; top: Corner; spot: GroundSpot };

export type StrikeType =
  | "jab" | "cross" | "hook" | "uppercut" | "combo" | "overhand"
  | "leg_kick" | "body_kick" | "head_kick" | "spinning"
  | "knee_body" | "knee_head" | "elbow" | "dirty_boxing" | "gnp" | "gnp_elbow";

export type SubType =
  | "rear_naked_choke" | "guillotine" | "arm_triangle" | "triangle" | "armbar"
  | "kimura" | "heel_hook" | "kneebar" | "darce";

/**
 * Compact play-by-play event. Stored as data (not sentences) so narration can
 * be improved later without touching saves.
 *   r = round, t = second in round, a = actor, k = kind, x = detail, v = value
 */
export interface FightEvent {
  r: number;
  t: number;
  a: Corner;
  k: EventKind;
  x?: string;
  v?: number;
}

export type EventKind =
  | "round_start" | "round_end" | "feel_out"
  | "strike_land" | "strike_miss" | "strike_block" | "big_strike"
  | "rocked" | "knockdown" | "recovers"
  | "td_attempt" | "td_land" | "td_stuffed" | "pull_guard"
  | "clinch_enter" | "clinch_break" | "cage_press" | "ref_break"
  | "advance" | "sweep" | "get_up" | "ref_standup"
  | "sub_attempt" | "sub_escape" | "sub_win"
  | "cut_opened" | "doctor_check"
  | "ko" | "tko" | "tko_doctor" | "tko_corner"
  | "fatigue" | "crowd"
  | "score";

export interface RoundStats {
  sigAtt: number;
  sigLand: number;
  totalLand: number;
  kd: number;
  tdAtt: number;
  tdLand: number;
  subAtt: number;
  ctrl: number;     // seconds in a controlling position
  dmg: number;      // damage dealt
}

export interface FightResult {
  winner: Corner | null;
  method: Method | "NC";
  endRound: number;
  endTimeS: number;
  seed: number;
  events: FightEvent[];
  /** stats[round-1][corner] */
  stats: RoundStats[][];
  /** Judge cards: cards[judge][round-1] = [red, blue] */
  cards: [number, number][][];
}
