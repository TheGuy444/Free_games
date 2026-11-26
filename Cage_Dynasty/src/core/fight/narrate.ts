import type { Sex } from "../constants.js";
import type { FightEvent, FightResult } from "./types.js";

/**
 * Turns compact fight events into play-by-play lines. Variant choice is a
 * hash of the event index, so the same fight always reads the same.
 */
export interface PbpLine {
  round: number;
  clock: string;      // elapsed time in the round, m:ss
  text: string;
  big: boolean;       // highlight-worthy moment
}

const STRIKE_NAME: Record<string, string[]> = {
  jab: ["a jab", "a stiff jab", "a quick jab", "a double jab"],
  cross: ["a straight right", "a hard cross", "a straight down the middle"],
  hook: ["a left hook", "a looping hook", "a short hook"],
  uppercut: ["an uppercut", "a rising uppercut"],
  overhand: ["an overhand right", "a wild overhand"],
  combo: ["a three-punch combination", "a one-two", "a jab-cross-hook", "a flurry of punches"],
  leg_kick: ["a low kick", "a chopping leg kick", "a calf kick", "an inside leg kick"],
  body_kick: ["a kick to the body", "a thudding body kick", "a roundhouse to the ribs"],
  head_kick: ["a head kick", "a high kick", "a switch kick upstairs"],
  spinning: ["a spinning back fist", "a spinning back kick", "a spinning wheel kick"],
  knee_body: ["a knee to the body", "a hard knee to the midsection"],
  knee_head: ["a knee up the middle", "a knee to the head"],
  elbow: ["an elbow", "a short elbow", "a slicing elbow"],
  dirty_boxing: ["short punches in the clinch", "dirty boxing on the inside", "uppercuts in tight"],
  gnp: ["punches from the top", "ground-and-pound", "short shots on the ground"],
  gnp_elbow: ["elbows from the top", "a heavy elbow on the ground"],
};

const SUB_NAME: Record<string, string> = {
  rear_naked_choke: "a rear-naked choke", guillotine: "a guillotine", arm_triangle: "an arm-triangle choke",
  triangle: "a triangle choke", armbar: "an armbar", kimura: "a kimura", heel_hook: "a heel hook",
  kneebar: "a kneebar", darce: "a d'arce choke",
};

const SPOT_NAME: Record<string, string> = {
  guard: "full guard", half: "half guard", side: "side control", mount: "full mount", back: "the back",
};

type Tpl = (A: string, D: string, x: string, v: number | undefined) => string;

const T: Partial<Record<FightEvent["k"], Tpl[]>> = {
  round_start: [() => "The round is underway."],
  round_end: [() => "That's the end of the round."],
  feel_out: [(A, D) => `${A} and ${D} trade feints in the centre.`, () => "Both fighters circle, looking for an opening.", (A) => `${A} takes the centre of the cage.`],
  strike_land: [(A, D, x) => `${A} lands ${x} on ${D}.`, (A, _D, x) => `${A} connects with ${x}.`, (A, D, x) => `${x[0]!.toUpperCase()}${x.slice(1)} from ${A} finds ${D}.`],
  strike_miss: [(A, _D, x) => `${A} misses with ${x}.`, (A, D, x) => `${D} avoids ${x} from ${A}.`, (A, _D, x) => `${A} throws ${x} but finds nothing.`],
  strike_block: [(A, D, x) => `${D} blocks ${x} from ${A}.`, (A, D, x) => `${A} throws ${x}; ${D} takes it on the arms.`],
  big_strike: [(A, D, x) => `${A} cracks ${D} with ${x}!`, (A, D, x) => `Big shot! ${x[0]!.toUpperCase()}${x.slice(1)} from ${A} snaps ${D}'s head back.`, (A, D, x) => `${A} lands ${x} flush and ${D} feels that one.`],
  rocked: [(A, D, x) => `${A} hurts ${D} with ${x}! ${D} is wobbled!`, (A, D, x) => `${D} is rocked by ${x}! ${A} smells blood.`],
  knockdown: [(A, D, x) => `DOWN GOES ${D.toUpperCase()}! ${x[0]!.toUpperCase()}${x.slice(1)} from ${A} drops {Dhim}!`, (A, D, x) => `${A} puts ${D} on the canvas with ${x}!`],
  recovers: [(A) => `${A} shakes off the cobwebs.`, (A) => `${A} looks to have recovered.`],
  td_attempt: [(A, D, x) => x === "trip" ? `${A} looks for a trip on ${D}.` : x === "throw" ? `${A} gets a grip and loads up a throw on ${D}.` : `${A} shoots for a takedown.`, (A, D) => `${A} changes levels and goes after ${D}'s legs.`],
  td_land: [(A, D, x) => `${A} gets ${D} down and lands in ${SPOT_NAME[x] ?? x}.`, (A, _D, x) => `Takedown ${A}! {Ahe} settles into ${SPOT_NAME[x] ?? x}.`],
  td_stuffed: [(A) => `${A} stuffs the takedown.`, (A) => `Great defence from ${A}, {Ahe_l} stays on {Ahis} feet.`, (A) => `${A} sprawls and shuts that down.`],
  clinch_enter: [(A, D) => `${A} closes the distance and ties up ${D}.`, (A) => `${A} clinches up.`],
  clinch_break: [(A) => `${A} breaks free of the clinch.`, (A) => `${A} pushes off and resets at distance.`],
  cage_press: [(A, D) => `${A} pins ${D} against the fence.`, (A, D) => `${A} walks ${D} back to the cage.`],
  ref_break: [() => "The referee separates them."],
  advance: [(A, _D, x) => `${A} advances to ${SPOT_NAME[x] ?? x}.`, (A, D, x) => `${A} passes ${D}'s guard into ${SPOT_NAME[x] ?? x}.`],
  pull_guard: [(A, D) => `${A} pulls guard and drags ${D} down into it.`, (A) => `${A} sits to guard, happy to fight off {Ahis} back.`],
  sweep: [(A) => `${A} sweeps and ends up on top!`, (A) => `Reversal! ${A} scrambles to the top.`],
  get_up: [(A) => `${A} works back to {Ahis} feet.`, (A) => `${A} wall-walks up and escapes.`],
  ref_standup: [() => "The referee stands them up for inactivity."],
  sub_attempt: [(A, _D, x) => `${A} goes for ${SUB_NAME[x] ?? x}!`, (A, D, x) => `${A} locks up ${SUB_NAME[x] ?? x} on ${D}!`, (A, _D, x) => `${A} is hunting ${SUB_NAME[x] ?? x}.`],
  sub_escape: [(A) => `${A} escapes!`, (A) => `${A} fights the hands and gets out.`, (A, _D, x) => `${A} survives the ${(SUB_NAME[x] ?? x).replace(/^an? /, "")}.`],
  sub_win: [(A, D, x) => `${D} TAPS! ${A} wins by ${(SUB_NAME[x] ?? x).replace(/^an? /, "")}!`, (A, D, x) => `It's over! ${A} finishes ${D} with ${SUB_NAME[x] ?? x}!`],
  cut_opened: [(A, D) => `${D} is cut! ${A} has opened {Dhim} up.`, (_A, D) => `There's blood. ${D} is bleeding.`],
  doctor_check: [(A) => `The referee calls the doctor in to look at ${A}'s cut.`],
  ko: [(A, D, x) => `KNOCKOUT! ${A} puts ${D} out cold with ${x}!`, (A, D, x) => `${D} is out! ${x[0]!.toUpperCase()}${x.slice(1)} from ${A} ends it!`],
  tko: [(A, D) => `The referee steps in! ${A} stops ${D}!`, (A, D) => `It's all over! ${D} can't defend {Dhimself} and ${A} gets the stoppage!`],
  tko_doctor: [(A, D) => `The doctor stops it! ${D} can't continue and ${A} wins by TKO.`],
  tko_corner: [(A) => `${A}'s corner has seen enough and waves it off.`],
  fatigue: [(A) => `${A} is breathing heavily.`, (A) => `${A}'s hands are dropping. {Ahe}'s tired.`],
};

const DEC_NAME: Record<string, string> = { DEC_U: "unanimous decision", DEC_S: "split decision", DEC_M: "majority decision", DRAW: "draw" };

function hash(n: number) {
  let x = (n + 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x85ebca6b) >>> 0;
  return (x ^ (x >>> 13)) >>> 0;
}

const PRON = { M: { he: "He", he_l: "he", his: "his", him: "him", himself: "himself" }, F: { he: "She", he_l: "she", his: "her", him: "her", himself: "herself" } };

export function narrate(result: FightResult, names: [string, string], sexes: [Sex, Sex] = ["M", "M"]): PbpLine[] {
  const last = names.map((n) => n.split(" ").slice(-1)[0] ?? n) as [string, string];
  const out: PbpLine[] = [];
  result.events.forEach((e, i) => {
    const A = last[e.a];
    const D = last[e.a === 0 ? 1 : 0];
    const clock = `${Math.floor(e.t / 60)}:${String(e.t % 60).padStart(2, "0")}`;
    if (e.k === "score") {
      const cards = result.cards.map((c) => c.reduce((s, r) => [s[0] + r[0], s[1] + r[1]], [0, 0]));
      const cardText = cards.map(([a, b]) => (e.a === 0 ? `${a}-${b}` : `${b}-${a}`)).join(", ");
      const text = e.x === "DRAW"
        ? `The judges score it a draw (${cardText}).`
        : `${names[e.a]} wins by ${DEC_NAME[e.x ?? ""] ?? e.x} (${cardText}).`;
      out.push({ round: e.r, clock, text, big: true });
      return;
    }
    const pool = T[e.k];
    if (!pool) return;
    const tpl = pool[hash(i * 31 + result.seed) % pool.length]!;
    const words = e.x && STRIKE_NAME[e.x] ? STRIKE_NAME[e.x]![hash(e.r * 1000 + e.t + result.seed) % STRIKE_NAME[e.x]!.length]! : e.x ?? "";
    const big = ["knockdown", "rocked", "ko", "tko", "tko_doctor", "tko_corner", "sub_win", "big_strike", "sweep"].includes(e.k);
    const pa = PRON[sexes[e.a]], pd = PRON[sexes[e.a === 0 ? 1 : 0]];
    const text = tpl(A, D, words, e.v)
      .replace("{Ahe}", pa.he).replace("{Ahe_l}", pa.he_l).replace("{Ahis}", pa.his)
      .replace("{Dhim}", pd.him).replace("{Dhimself}", pd.himself);
    out.push({ round: e.r, clock, text, big });
  });
  return out;
}

/** Plain-text play-by-play for the CLI. */
export function toText(lines: PbpLine[]): string {
  let r = 0;
  const parts: string[] = [];
  for (const l of lines) {
    if (l.round !== r) { r = l.round; parts.push(`\n--- Round ${r} ---`); }
    parts.push(`${l.clock.padStart(5)}  ${l.big ? "**" : "  "} ${l.text}`);
  }
  return parts.join("\n");
}
