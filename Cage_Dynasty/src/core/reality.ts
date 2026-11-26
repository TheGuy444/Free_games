/**
 * The in-house reality series: sixteen unsigned prospects in two divisions
 * live together and fight a knockout tournament, one bout per weekly episode,
 * broadcast on your TV partner or your own network. Exhibition bouts don't go
 * on pro records. Finalists earn contracts; winners leave as names.
 */
import { WEEKS_PER_YEAR } from "./constants.js";
import { addPop } from "./popularity.js";
import { earn, growSubscribers, outlets, spend, brand } from "./business.js";
import { simulateFight } from "./fight/engine.js";
import { rateFight } from "./excitement.js";
import type { FighterState } from "./model.js";
import type { World } from "./world.js";
import { divisionLabel } from "./world.js";

export const SHOW_NAME = "The Proving Ground";
export const CAST_PER_DIVISION = 8;
export const EPISODE_COST = 120_000;

interface Season { id: number; promotion_id: number; number: number; name: string; start_week: number; divisions: string; outlet: string; status: string; episodes: number; viewers: number }

export function currentSeason(world: World, promotionId: number): Season | undefined {
  return world.db.prepare("SELECT * FROM reality_season WHERE promotion_id = ? AND status = 'airing'").get(promotionId) as Season | undefined;
}

/** Prospects who could be cast: unsigned, young, few pro fights, best potential first. */
export function castingPool(world: World, weightClassId: number): FighterState[] {
  return [...world.fighters.values()]
    .filter((f) => f.status === "active" && f.promotionId === null && f.weightClassId === weightClassId && f.wins + f.losses <= 6 && (world.week - f.birthWeek) / WEEKS_PER_YEAR <= 29 && world.available(f))
    .sort((a, b) => b.attrs.potential - a.attrs.potential);
}

export function startSeason(world: World, divisions: [number, number]) {
  const p = world.playerPromotion!;
  if (currentSeason(world, p.id)) throw new Error("A season is already airing");
  const out = outlets(world, p);
  if (!out.tv) throw new Error("You need a TV partner or your own network to air the show");
  const casts = divisions.map((wc) => castingPool(world, wc).slice(0, CAST_PER_DIVISION));
  for (const [i, c] of casts.entries()) if (c.length < CAST_PER_DIVISION) throw new Error(`Not enough unsigned prospects at ${divisionLabel(divisions[i]!)}`);
  const number = ((world.db.prepare("SELECT MAX(number) n FROM reality_season WHERE promotion_id = ?").get(p.id) as { n: number | null }).n ?? 0) + 1;
  const name = `${SHOW_NAME}, season ${number}`;
  const id = Number(world.db.prepare(`INSERT INTO reality_season (promotion_id, number, name, start_week, divisions, outlet, status) VALUES (?, ?, ?, ?, ?, ?, 'airing')`)
    .run(p.id, number, name, world.week, divisions.join(","), out.tv.kind === "own" ? "own" : String(out.tv.deal!.networkId)).lastInsertRowid);
  const ins = world.db.prepare("INSERT INTO reality_cast (season_id, fighter_id, weight_class_id, status) VALUES (?, ?, ?, 'in')");
  casts.forEach((c, i) => c.forEach((f) => ins.run(id, f.id, divisions[i]!)));
  world.repo.news(world.week, p.id, "reality", `${p.name} announces ${name} on ${out.tv.name}: ${CAST_PER_DIVISION * 2} prospects at ${divisions.map(divisionLabel).join(" and ")}. Episodes air weekly.`, null, 2);
  return id;
}

const STAGES = [["quarterfinal", 4], ["semifinal", 2], ["final", 1]] as const;

/** Weekly: air the next episode (one bout) of any season that's on. */
export function realityTick(world: World) {
  const p = world.playerPromotion;
  if (!p) return;
  const s = currentSeason(world, p.id);
  if (!s || world.week <= s.start_week) return;
  const divisions = s.divisions.split(",").map(Number);
  // Next bout: first division that still has someone to pair in the current stage.
  for (const [stage] of STAGES) {
    for (const wc of divisions) {
      const alive = world.db.prepare("SELECT fighter_id FROM reality_cast WHERE season_id = ? AND weight_class_id = ? AND status = 'in'").all(s.id, wc) as { fighter_id: number }[];
      const foughtThisStage = (world.db.prepare(`SELECT red_id, blue_id FROM reality_bout WHERE season_id = ? AND stage = ?`).all(s.id, stage) as { red_id: number; blue_id: number }[])
        .flatMap((b) => [b.red_id, b.blue_id]);
      const waiting = alive.map((a) => a.fighter_id).filter((id) => !foughtThisStage.includes(id));
      if (waiting.length < 2) continue;
      const red = world.fighters.get(waiting[0]!), blue = world.fighters.get(waiting[1]!);
      if (!red || !blue) continue;
      airBout(world, s, stage, red, blue, wc);
      return;
    }
  }
  finishSeason(world, s);
}

function airBout(world: World, s: Season, stage: string, red: FighterState, blue: FighterState, wc: number) {
  const p = world.playerPromotion!;
  const seed = world.rng.seed();
  const rounds = stage === "final" ? 3 : 2;
  const r = simulateFight(red, blue, rounds, seed, { log: false });
  const winner = r.winner === 0 ? red : r.winner === 1 ? blue : (red.attrs.heart >= blue.attrs.heart ? red : blue); // no draws on the show: sudden victory
  const loser = winner === red ? blue : red;
  const rating = rateFight(r.method, r.endRound, rounds, r.endTimeS, r.stats, red, blue, false);
  const episode = s.episodes + 1;
  world.db.prepare(`INSERT INTO reality_bout (season_id, episode, week, stage, red_id, blue_id, winner_id, method, end_round, rating) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(s.id, episode, world.week, stage, red.id, blue.id, winner.id, r.method === "DRAW" ? "DEC_S" : r.method, r.endRound, rating);
  if (stage !== "final") world.db.prepare("UPDATE reality_cast SET status = 'out' WHERE season_id = ? AND fighter_id = ?").run(s.id, loser.id);
  else {
    world.db.prepare("UPDATE reality_cast SET status = 'winner' WHERE season_id = ? AND fighter_id = ?").run(s.id, winner.id);
    world.db.prepare("UPDATE reality_cast SET status = 'finalist' WHERE season_id = ? AND fighter_id = ?").run(s.id, loser.id);
  }
  // Television: viewers, money, and every cast member gets known.
  const out = outlets(world, p);
  const reach = out.tv?.reach ?? 20;
  const viewers = Math.round((reach / 100) * (0.4 + brand(world, p) / 120) * 600_000 * (0.8 + rating / 250));
  world.db.prepare("UPDATE reality_season SET episodes = episodes + 1, viewers = viewers + ? WHERE id = ?").run(viewers, s.id);
  spend(world, p.id, EPISODE_COST, `${s.name}: episode ${episode} production`);
  if (out.tv?.kind === "deal") earn(world, p.id, Math.round(reach * 1800), `${s.name}: episode ${episode} rights fee`);
  else growSubscribers(world, p.id, viewers * 0.02);
  for (const f of [red, blue]) addPop(f, 1.2 + rating / 60, null, world.regionIds);
  addPop(winner, 1.5, null, world.regionIds);
  red.lastFightWeek = blue.lastFightWeek = world.week - 6; // short turnaround on the show
  world.repo.news(world.week, p.id, "reality", `${s.name}, episode ${episode} (${stage}, ${divisionLabel(wc)}): ${winner.name} beats ${loser.name}${r.method.startsWith("DEC") ? " on the judges' cards" : r.method === "SUB" ? " by submission" : " by stoppage"}. ${viewers.toLocaleString("en-US")} viewers.`, winner.id, 1);
}

function finishSeason(world: World, s: Season) {
  const p = world.playerPromotion!;
  world.db.prepare("UPDATE reality_season SET status = 'finished' WHERE id = ?").run(s.id);
  const top = world.db.prepare("SELECT fighter_id, status, weight_class_id FROM reality_cast WHERE season_id = ? AND status IN ('winner','finalist')").all(s.id) as { fighter_id: number; status: string; weight_class_id: number }[];
  const names: string[] = [];
  for (const t of top) {
    const f = world.fighters.get(t.fighter_id);
    if (!f || f.promotionId !== null || f.status !== "active") continue;
    world.sign(f, p, false);
    if (t.status === "winner") { addPop(f, 10, null, world.regionIds); names.push(`${f.name} (${divisionLabel(t.weight_class_id)})`); }
  }
  world.repo.news(world.week, p.id, "reality", `${s.name} wraps after ${s.episodes} episodes and ${s.viewers.toLocaleString("en-US")} total viewers. Winners ${names.join(" and ")} and both finalists sign with ${p.name}.`, null, 3);
}
