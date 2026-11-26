/**
 * Newspaper copy for the News front page: a headline and a short story
 * (paragraphs separated by blank lines) for each notable news item.
 *
 * Word choice uses a hash of the item's facts, not the world RNG, so writing
 * news never changes how the simulation plays out.
 */
import type { Sex } from "./constants.js";

export interface Story {
  headline: string;
  story: string;
}

export interface StoryFighter {
  name: string;
  sex: Sex;
  wins: number;
  losses: number;
  draws: number;
  koWins: number;
  subWins: number;
  winStreak: number;
  age: number;
  region: string;
  style: string;
  worldP4P: number | null;
  worldDivision: number | null;
}

const last = (f: StoryFighter) => f.name.split(" ").slice(1).join(" ") || f.name;
const rec = (f: StoryFighter) => `${f.wins}-${f.losses}${f.draws ? `-${f.draws}` : ""}`;
const they = (f: StoryFighter) => (f.sex === "F" ? "she" : "he");
const their = (f: StoryFighter) => (f.sex === "F" ? "her" : "his");
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
function pick<T>(seed: string, options: readonly T[]): T {
  return options[hash(seed) % options.length]!;
}

export const STYLE_WORDS: Record<string, string> = {
  pressure_striker: "pressure striker",
  counter_striker: "counter striker",
  kickboxer: "kickboxer",
  wrestle_boxer: "wrestle-boxer",
  ground_and_pound: "ground-and-pound specialist",
  submission_hunter: "submission specialist",
  clinch_grinder: "clinch grinder",
  leg_locker: "leg-lock specialist",
  point_karateka: "karate stylist",
  all_rounder: "all-rounder",
};

function rankLine(f: StoryFighter, division: string): string | null {
  if (f.worldP4P !== null && f.worldP4P <= 10) return `${cap(they(f))} sits at #${f.worldP4P} on the worldwide pound-for-pound list.`;
  if (f.worldDivision !== null && f.worldDivision <= 10) return `${cap(they(f))} is ranked #${f.worldDivision} in the world at ${division.toLowerCase()}.`;
  if (f.worldP4P !== null) return `The win keeps ${last(f)} on the worldwide pound-for-pound list at #${f.worldP4P}.`;
  return null;
}

function methodPhrase(method: string, round: number, seed: string): string {
  switch (method) {
    case "KO": return pick(seed, [`by knockout in round ${round}`, `with a round-${round} knockout`]);
    case "TKO": return pick(seed, [`by TKO in round ${round}`, `with a round-${round} stoppage`, `on strikes in round ${round}`]);
    case "SUB": return pick(seed, [`by submission in round ${round}`, `with a round-${round} tapout`]);
    case "DEC_U": return "by unanimous decision";
    case "DEC_S": return "by split decision";
    case "DEC_M": return "by majority decision";
    default: return "";
  }
}

function headlineVerb(method: string, seed: string): string {
  switch (method) {
    case "KO": return pick(seed, ["knocks out", "flattens", "KOs", "puts away"]);
    case "TKO": return pick(seed, ["stops", "finishes", "batters"]);
    case "SUB": return pick(seed, ["submits", "taps", "chokes out"]);
    case "DEC_S": return pick(seed, ["edges", "squeaks past", "survives"]);
    default: return pick(seed, ["outpoints", "beats", "decisions", "outworks"]);
  }
}

export interface ResultStoryInput {
  promotion: string;
  eventName: string;
  division: string;
  winner: StoryFighter;
  loser: StoryFighter;
  method: string;
  round: number;
  rounds: number;
  titleChange: boolean;
  titleDefense: number | null; // successful defenses after this fight, when the belt was retained
  coMain: string | null;
  otherChampions: string[];
  callout: { target: string; text: string } | null;
}

export function resultStory(i: ResultStoryInput): Story {
  const w = i.winner, l = i.loser, seed = `${i.eventName}|${w.name}|${l.name}`;
  const div = i.division.toLowerCase();
  const verb = headlineVerb(i.method, seed);
  const headline = i.titleChange
    ? pick(seed + "h", [`${last(w)} ${verb} ${last(l)} for ${div} gold`, `New ${div} ${w.sex === "F" ? "queen" : "king"}: ${last(w)} ${verb} ${last(l)}`, `${last(w)} takes the ${i.promotion} ${div} title`])
    : i.titleDefense !== null
      ? pick(seed + "h", [`${last(w)} ${verb} ${last(l)}, keeps the belt`, `${last(w)} defends ${div} title against ${last(l)}`])
      : pick(seed + "h", [`${last(w)} ${verb} ${last(l)} at ${i.eventName}`, `${last(w)} ${verb} ${last(l)} in main event`]);

  const how = methodPhrase(i.method, i.round, seed);
  const p1 = i.titleChange
    ? `${w.name} (${rec(w)}) is the new ${i.promotion} ${div} champion after beating ${l.name} ${how} in the main event of ${i.eventName}.`
    : i.titleDefense !== null
      ? `${w.name} (${rec(w)}) kept the ${i.promotion} ${div} title, beating ${l.name} ${how} at ${i.eventName}. It was ${their(w)} ${ordinal(i.titleDefense)} successful defense.`
      : `${w.name} (${rec(w)}) beat ${l.name} ${how} in the main event of ${i.eventName}.`;

  const color: string[] = [];
  if (i.method.startsWith("DEC") && i.round === i.rounds) {
    color.push(pick(seed + "d", [
      `The fight went the full ${i.rounds} rounds, and the judges sided with ${last(w)}.`,
      `${last(l)} made it to the final bell, but ${last(w)} did more over ${i.rounds} rounds.`,
    ]));
  } else if (i.round === 1) {
    color.push(pick(seed + "q", [`It was over before the first round was done.`, `${last(l)} barely had time to settle in.`]));
  }
  color.push(`The ${w.age}-year-old ${STYLE_WORDS[w.style] ?? "fighter"} from ${w.region}${w.winStreak >= 3 ? ` has now won ${w.winStreak} in a row` : ` has finished ${w.koWins + w.subWins} of ${their(w)} ${w.wins} wins`}.`);
  const rl = rankLine(w, i.division);
  if (rl) color.push(rl);
  color.push(`${last(l)} drops to ${rec(l)}.`);

  const p3: string[] = [];
  if (i.callout) p3.push(`Afterwards ${last(w)} called out ${i.callout.target}: "${i.callout.text}"`);
  if (i.coMain) p3.push(`In the co-main event, ${i.coMain}.`);
  if (i.otherChampions.length) p3.push(`Also crowned on the night: ${i.otherChampions.join(", ")}.`);

  return { headline, story: [p1, color.join(" "), p3.join(" ")].filter(Boolean).join("\n\n") };
}

export function titleStory(promotion: string, division: string, w: StoryFighter, loser: string, eventName: string): Story {
  const seed = `${eventName}|${w.name}|title`;
  return {
    headline: pick(seed, [`${last(w)} crowned ${promotion} ${division.toLowerCase()} champion`, `${last(w)} wins ${division.toLowerCase()} gold`]),
    story: [
      `${w.name} (${rec(w)}) won the ${promotion} ${division.toLowerCase()} title at ${eventName}, beating ${loser}.`,
      `The ${w.age}-year-old ${STYLE_WORDS[w.style] ?? "fighter"} from ${w.region} ${w.winStreak >= 3 ? `has won ${w.winStreak} straight` : "now has a target on " + their(w) + " back"}.`,
    ].join("\n\n"),
  };
}

export function signingStory(f: StoryFighter, promotion: string, division: string, from: string | null, bouts: number | null): Story {
  const seed = `${f.name}|${promotion}|sign`;
  const headline = from
    ? pick(seed, [`${last(f)} leaves ${from} for ${promotion}`, `${promotion} lands ${last(f)} from ${from}`])
    : pick(seed, [`${promotion} signs ${last(f)}`, `${last(f)} joins ${promotion}`]);
  const p1 = `${promotion} has signed ${division.toLowerCase()} ${f.name} (${rec(f)})${bouts ? ` to a ${bouts}-fight deal` : ""}${from ? `, taking ${them(f)} away from ${from}` : ""}.`;
  const finishes = f.koWins + f.subWins;
  const p2 = `The ${f.age}-year-old ${STYLE_WORDS[f.style] ?? "fighter"} from ${f.region} has ${finishes} finishes in ${f.wins} wins${f.worldDivision ? ` and is ranked #${f.worldDivision} in the world at ${division.toLowerCase()}` : ""}.`;
  return { headline, story: `${p1}\n\n${p2}` };
}
const them = (f: StoryFighter) => (f.sex === "F" ? "her" : "him");

export function retirementStory(f: StoryFighter, promotion: string | null, wasChamp: boolean, fights: number): Story {
  const seed = `${f.name}|retire`;
  return {
    headline: wasChamp ? `Champion ${last(f)} walks away` : pick(seed, [`${last(f)} retires after ${fights} fights`, `${last(f)} calls it a career`]),
    story: [
      `${f.name} has retired at ${f.age} with a record of ${rec(f)}${wasChamp && promotion ? `, leaving the ${promotion} title vacant` : ""}.`,
      `Over ${fights} professional fights the ${STYLE_WORDS[f.style] ?? "fighter"} from ${f.region} won ${f.koWins} by knockout and ${f.subWins} by submission.`,
    ].join("\n\n"),
  };
}

export function injuryStory(f: StoryFighter, months: number, context: string, promotion: string | null): Story {
  return {
    headline: `${last(f)} out for ${months} month${months === 1 ? "" : "s"}`,
    story: `${f.name} (${rec(f)})${promotion ? ` of ${promotion}` : ""} will be out for about ${months} month${months === 1 ? "" : "s"} ${context}.${f.worldDivision ? ` ${cap(they(f))} is ranked #${f.worldDivision} in the world.` : ""}`,
  };
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
}
