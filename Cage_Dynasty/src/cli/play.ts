/**
 * Scripted player session, no UI: run your promotion for two events.
 *   npm run play -- --seed 5
 * Creates a world with a player promotion, sims two years of history, books a
 * title fight and a full card, runs fight week (camp, weigh-ins, fights,
 * post-fight moments), then books the callout for the next event.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { autoFillCard, bookBout, card, divisionName, previewBout } from "../core/booking.js";
import { WEEKS_PER_YEAR } from "../core/constants.js";
import { World } from "../core/world.js";
import { openSave } from "../db/db.js";

const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] ?? d : d; };
const seed = Number(arg("seed", "5"));
const out = arg("out", "saves/play.sqlite");
mkdirSync("saves", { recursive: true });
for (const ext of ["", "-wal", "-shm"]) if (existsSync(out + ext)) rmSync(out + ext);

let db = openSave(out);
let world = World.create(db, { seed, startYear: 2024, scale: 1, playerTier: "major" });
world.advance(2 * WEEKS_PER_YEAR);
const p = world.playerPromotion!;
const say = (s = "") => console.log(s);
say(`You run ${p.name} (major promotion). It is ${world.year}, week ${world.week % WEEKS_PER_YEAR}. Roster: ${p.roster.size} fighters.`);

// Deepest division for the first title fight.
const byDiv = new Map<number, number>();
for (const id of p.roster) { const f = world.fighters.get(id)!; byDiv.set(f.weightClassId, (byDiv.get(f.weightClassId) ?? 0) + 1); }
const wc = [...byDiv.entries()].sort((a, b) => b[1] - a[1])[0]![0];
const ranked = world.rankings(p.id, wc);
const champ = world.championOf(p.id, wc);
say(`\n${divisionName(wc)} rankings: ${champ ? `C ${world.fighters.get(champ)!.name}, ` : "title vacant, "}${ranked.slice(0, 5).map((f, i) => `#${i + 1} ${f.name} (${f.wins}-${f.losses})`).join(", ")}`);

let lastMoments: { fighter_id: number; target_id: number | null }[] = [];

function runEvent(label: string, weeks: number, book: (eventId: number) => void) {
  const eventId = world.scheduleEvent(weeks, label);
  say(`\n=== ${label}: scheduled ${weeks} weeks out ===`);
  book(eventId);
  const added = autoFillCard(world, eventId, 10);
  say(`AI booking assistant filled ${added} more bouts.`);
  const fromWeek = world.week;
  world.advance(weeks);
  say(`\nNews:`);
  for (const n of world.db.prepare("SELECT week, text FROM news_item WHERE promotion_id = ? AND week > ? ORDER BY id").all(p.id, fromWeek) as { week: number; text: string }[]) say(`  [wk ${n.week % WEEKS_PER_YEAR}] ${n.text}`);
  say(`\nResults:`);
  const rows = world.db.prepare(`SELECT b.id, b.card_order, b.method, b.end_round, b.title_id, b.catchweight, b.winner_id, b.red_id, b.blue_id,
      rp.first_name || ' ' || rp.last_name red, bp.first_name || ' ' || bp.last_name blue
      FROM bout b JOIN person rp ON rp.id = b.red_id JOIN person bp ON bp.id = b.blue_id WHERE b.event_id = ? ORDER BY b.card_order`).all(eventId) as
    { id: number; card_order: number; method: string; end_round: number; title_id: number | null; catchweight: number; winner_id: number | null; red_id: number; red: string; blue: string }[];
  lastMoments = [];
  for (const r of rows) {
    const w = r.winner_id === null ? "Draw" : r.winner_id === r.red_id ? r.red : r.blue;
    say(`  ${r.card_order}. ${r.red} vs ${r.blue}${r.title_id ? " (TITLE)" : ""}${r.catchweight ? " (catchweight)" : ""}: ${w} by ${r.method}, R${r.end_round}`);
    for (const m of world.db.prepare(`SELECT m.kind, m.text, m.fighter_id, m.target_id, p.first_name || ' ' || p.last_name who FROM post_fight_moment m
                                      JOIN person p ON p.id = m.fighter_id WHERE bout_id = ?`).all(r.id) as { kind: string; text: string; fighter_id: number; target_id: number | null; who: string }[]) {
      say(`       ${m.kind.toUpperCase()} ${m.who}: "${m.text}"`);
      lastMoments.push(m);
    }
  }
  const wi = world.db.prepare("SELECT outcome, COUNT(*) n FROM weigh_in WHERE event_id = ? GROUP BY outcome").all(eventId) as { outcome: string; n: number }[];
  say(`  Weigh-ins: ${wi.map((x) => `${x.n} ${x.outcome}`).join(", ")}`);
}

runEvent(`${p.name}: Origins`, 6, (eventId) => {
  const [a, b] = champ ? [world.fighters.get(champ)!, ranked[0]!] : [ranked[0]!, ranked[1]!];
  const pv = previewBout(world, eventId, a.id, b.id, true);
  say(`Preview ${a.name} vs ${b.name} for the ${divisionName(wc)} title: ${a.name} ${pv.redWinPct}% to win, hype ${pv.hype}/100`);
  for (const n of pv.notes) say(`  - ${n}`);
  if (pv.problems.length) say(`  Problems: ${pv.problems.join("; ")}`);
  else { bookBout(world, eventId, a.id, b.id, { title: true }); say(`Booked as the main event.`); }
});

runEvent(`${p.name}: Callout Night`, 10, (eventId) => {
  const c = lastMoments.find((m) => m.target_id !== null && world.fighters.get(m.fighter_id)?.promotionId === p.id && world.fighters.get(m.target_id!)?.promotionId === p.id);
  if (!c) { say("No callout to book from last event."); return; }
  const a = world.fighters.get(c.fighter_id)!, b = world.fighters.get(c.target_id!)!;
  const champId = world.championOf(p.id, a.weightClassId);
  const title = champId === a.id || champId === b.id;
  const pv = previewBout(world, eventId, a.id, b.id, title);
  say(`Booking the callout: ${a.name} vs ${b.name}${title ? " for the title" : ""}. ${a.name} ${pv.redWinPct}% to win, hype ${pv.hype}/100`);
  for (const n of pv.notes) say(`  - ${n}`);
  if (pv.problems.length) say(`  Can't book it: ${pv.problems.join("; ")}`);
  else bookBout(world, eventId, a.id, b.id, { title, rounds: 5 });
});

// Save and reload to prove the world persists.
world.flush();
const before = { week: world.week, fighters: world.fighters.size, roster: p.roster.size, cards: card(world, 1).length };
db.close();
db = openSave(out);
world = World.load(db);
say(`\nSaved and reloaded: week ${world.week} (was ${before.week}), ${world.fighters.size} fighters in memory (was ${before.fighters}), roster ${world.playerPromotion!.roster.size} (was ${before.roster}).`);
world.advance(4);
say(`Simmed 4 more weeks after loading without errors. Now ${world.year}, week ${world.week % WEEKS_PER_YEAR}.`);
db.close();
