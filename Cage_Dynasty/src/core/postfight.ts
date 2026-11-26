import type { FighterState } from "./model.js";
import { flair, flairBand, type FlairBand } from "./personality.js";
import type { Rng } from "./rng.js";

export type MomentKind = "callout" | "retirement" | "statement";

export interface Moment {
  fighterId: number;
  kind: MomentKind;
  targetId: number | null;
  text: string;
}

export interface PostFightContext {
  winner: FighterState | null;
  loser: FighterState | null;
  method: string;
  isMainEvent: boolean;
  titleWon: boolean;
  isChampion: (id: number) => boolean;
  /** Promotion rank (1 = top contender), champion excluded. null = unranked. */
  rankOf: (id: number) => number | null;
  /** Who the winner should call out, already chosen by the caller. */
  calloutTarget: FighterState | null;
  retiring: FighterState[];
  regionName: (f: FighterState) => string;
  promotionName: string;
}

const last = (f: FighterState) => f.name.split(" ").slice(-1)[0] ?? f.name;
const finish = (m: string) => m === "KO" || m === "TKO" || m === "SUB";

/**
 * In-cage moments after a fight: callouts, retirement speeches, and
 * statements to the crowd. Who talks and how depends on mic skill, charisma,
 * professionalism, and the result.
 */
export function postFightMoments(ctx: PostFightContext, rng: Rng): Moment[] {
  const out: Moment[] = [];
  for (const f of ctx.retiring) out.push(retirementSpeech(f, ctx, rng));

  const w = ctx.winner;
  if (w && !ctx.retiring.includes(w)) {
    const pSpeak = 0.4 + w.attrs.mic_skill / 220 + (finish(ctx.method) ? 0.15 : 0) + (ctx.isMainEvent ? 0.2 : 0);
    if (rng.chance(Math.min(0.95, pSpeak))) {
      // Louder personalities are far more likely to grab the mic and name someone.
      const fl = flair(w);
      const pCallout = 0.15 + fl / 160 + (finish(ctx.method) ? 0.1 : 0) +
        ((ctx.rankOf(w.id) ?? 99) <= 10 || ctx.isChampion(w.id) ? 0.15 : 0);
      if (ctx.calloutTarget && rng.chance(Math.min(0.9, pCallout))) out.push(callout(w, ctx.calloutTarget, ctx, rng));
      else out.push(winnerStatement(w, ctx, rng));
    }
  }
  const l = ctx.loser;
  if (l && !ctx.retiring.includes(l) && ctx.method.startsWith("DEC") && rng.chance(0.12 + l.attrs.mic_skill / 400)) {
    out.push({ fighterId: l.id, kind: "statement", targetId: null, text: rng.pick([
      `I thought I did enough. I'll be back stronger.`,
      `Respect to ${ctx.winner ? last(ctx.winner) : "him"}. Back to the gym tomorrow.`,
      `The judges saw it their way. I want the rematch.`,
    ]) });
  }
  return out;
}

function callout(w: FighterState, t: FighterState, ctx: PostFightContext, rng: Rng): Moment {
  const T = t.name;
  const tl = last(t);
  const champ = ctx.isChampion(t.id);
  const band = flairBand(flair(w));
  const lines: Record<FlairBand, string[]> = champ
    ? {
        outlandish: [
          `${tl}! That belt is on loan and I'm here to repossess it! Sign the contract or hand it over!`,
          `${T}, you've been ducking me for months. I'll put you to sleep and take that belt home in a limo!`,
          `Everybody's watching me, nobody's watching ${tl}. Make the fight, I'm the real champion!`,
          `${tl}, I'm not asking. I'm telling the whole world: you, me, the belt, biggest night this sport has ever seen!`,
        ],
        brash: [
          `${tl}! You and me for the gold. Let's give these people the fight they want!`,
          `Put me in there with ${T} for the belt. Biggest fight in the division and you know it!`,
          `${tl}, I'm coming for that strap. Get ready.`,
        ],
        measured: [
          `I've earned a shot at ${T}. Much respect, but I want that belt.`,
          `${tl} is a great champion. I'd love to test myself against him for the title.`,
        ],
        reserved: [
          `I think I've earned the title shot. If the promotion gives me ${T}, I'll be ready.`,
          `${tl} next, for the belt. That's the plan.`,
        ],
        stoic: [`The title. ${tl}. Whenever they want.`, `I'll fight ${T} for the belt when it's offered. Thank you.`],
      }
    : {
        outlandish: [
          `${tl}, I see you out there hiding in the crowd! Sign the contract, you're next and you're finished!`,
          `${T} has been running his mouth. I'll shut it in under a round, mark my words!`,
          `Somebody wake ${tl} up and tell him the cash cow wants him next! Let's make some money!`,
        ],
        brash: [
          `${tl}! Let's put on a show. You and me, next card!`,
          `Who wants to see me against ${T}? Make it happen!`,
          `${tl}, you've been talking. Let's settle it in here.`,
        ],
        measured: [`I'd like to fight ${T} next if the promotion wants it.`, `${tl} is a tough fighter. I'd like that fight next.`],
        reserved: [`If they offer me ${T}, I'll take it.`, `${tl} would be a good test. We'll talk to the promotion.`],
        stoic: [`${tl} next.`, `Give me ${T}.`],
      };
  let text = rng.pick(lines[band]);
  if (w.sex === "F" || t.sex === "F") text = text.replace(/\bhim\b/g, "her");
  return { fighterId: w.id, kind: "callout", targetId: t.id, text };
}

function winnerStatement(w: FighterState, ctx: PostFightContext, rng: Rng): Moment {
  const region = ctx.regionName(w);
  const opts = [
    `I want to thank my team and everyone who came out tonight. ${region}, this one's for you!`,
    `All glory to my coaches. We worked so hard for this.`,
    `I'm just getting started. Keep watching.`,
  ];
  if (ctx.titleWon) opts.push(`This belt is for ${region}! I told you all I would do it!`, `Dreams come true! Champion of ${ctx.promotionName}!`);
  if (ctx.method.startsWith("DEC") && w.attrs.professionalism > 55) opts.push(`Sorry it wasn't pretty tonight. A win is a win, and I'll be better next time.`);
  const band = flairBand(flair(w));
  if (band === "stoic" || band === "reserved") opts.push(`I followed the game plan. Thank you to my team.`, `Back to work on Monday.`);
  if (finish(ctx.method) && (band === "brash" || band === "outlandish")) opts.push(`Anyone else want some? Line them up!`, `Did you see that?! Nobody in this division can live with me!`);
  return { fighterId: w.id, kind: "statement", targetId: null, text: rng.pick(opts) };
}

function retirementSpeech(f: FighterState, ctx: PostFightContext, rng: Rng): Moment {
  const n = f.wins + f.losses + f.draws;
  const region = ctx.regionName(f);
  return {
    fighterId: f.id, kind: "retirement", targetId: null,
    text: rng.pick([
      `After ${n} fights, that was my last one. My body has told me it's time. Thank you, ${region}.`,
      `I'm leaving my gloves in the cage tonight. ${f.wins} wins, ${f.losses} losses, and no regrets.`,
      `I've given this sport everything. It's time to go home to my family. Thank you all.`,
    ]),
  };
}
