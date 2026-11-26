/**
 * Fight night: the player's card on the day, before and after it runs.
 * The sim stops on the eve of a player event (World.holdPlayerEvents); the
 * player picks which bouts to watch, then the card runs in one go and the
 * screen reveals each result in running order, prelims first.
 */
import { BookingError, card, previewBout } from "./booking.js";
import { MAIN_CARD_SIZE } from "./excitement.js";
import { flair, flairBand, FLAIR_LABEL } from "./personality.js";
import type { FighterState } from "./model.js";
import { moneyline, showDetails } from "./matchmaking.js";
import { divisionLabel, type World } from "./world.js";

export function slotLabel(order: number): string {
  return order === 1 ? "Main event" : order === 2 ? "Co-main event" : order <= MAIN_CARD_SIZE ? "Main card" : "Prelims";
}

const record = (f: FighterState) => `${f.wins}-${f.losses}${f.draws ? `-${f.draws}` : ""}`;

function corner(world: World, f: FighterState) {
  const fl = flair(f);
  const rank = world.rankOf(f);
  return {
    id: f.id, name: f.name, record: record(f), rank: world.titlesOf(f.id).length ? "C" : rank ? `#${rank}` : "NR",
    popularity: Math.round(f.popularity), flair: fl, flairLabel: FLAIR_LABEL[flairBand(fl)],
  };
}

/** The card as it stands on fight day, main event first. No results. */
export function fightNightCard(world: World, eventId: number) {
  const e = world.db.prepare("SELECT promotion_id, status FROM event WHERE id = ?").get(eventId) as { promotion_id: number; status: string } | undefined;
  if (!e || e.promotion_id !== world.playerPromotionId) throw new BookingError("Not your event");
  const bouts = card(world, eventId).filter((b) => b.status === "booked" && b.red && b.blue).map((b, i) => {
    const red = b.red!, blue = b.blue!;
    // Position on tonight's card (card_order can have gaps left by cancelled bouts).
    const order = i + 1;
    const title = b.titleId !== null ? [...world.titles.values()].find((t) => t.id === b.titleId) : undefined;
    const pv = previewBout(world, eventId, red.id, blue.id, false);
    return {
      bookingId: b.id, order, slot: slotLabel(order), rounds: b.rounds,
      division: divisionLabel(title?.weightClassId ?? red.weightClassId),
      title: title ? `${divisionLabel(title.weightClassId)} title` : null,
      red: corner(world, red), blue: corner(world, blue),
      odds: { red: moneyline(pv.redWinPct / 100), blue: moneyline(1 - pv.redWinPct / 100) },
    };
  });
  return { show: showDetails(world, eventId), bouts };
}

interface BoutRow {
  id: number; winner_id: number | null; method: string; end_round: number; end_time_s: number; rating: number | null; fotn: number; title_id: number | null; catchweight: number;
}

/**
 * Run the held event and return every bout from the fight-night card with its
 * result, in running order (last prelim first, main event last).
 */
export function runFightNight(world: World, eventId: number) {
  if (world.fightNightDue() !== eventId) throw new BookingError("That show isn't on tonight");
  const before = fightNightCard(world, eventId);
  world.releaseFightNight(eventId);
  world.advance(1);
  world.flush();

  const db = world.db;
  const results = before.bouts.map((b) => {
    const bk = db.prepare("SELECT status, cancel_reason, bout_id FROM booking WHERE id = ?").get(b.bookingId) as { status: string; cancel_reason: string | null; bout_id: number | null };
    const weighIns = db.prepare(`SELECT w.fighter_id, w.outcome, w.weight_kg, w.limit_kg FROM weigh_in w WHERE w.event_id = ? AND w.fighter_id IN (?, ?) AND w.outcome != 'made'`)
      .all(eventId, b.red.id, b.blue.id) as { fighter_id: number; outcome: string; weight_kg: number; limit_kg: number }[];
    const weighInNotes = weighIns.map((w) => {
      const n = world.nameOf(w.fighter_id);
      return w.outcome === "missed" ? `${n} missed weight (${w.weight_kg} kg, limit ${w.limit_kg} kg)` : w.outcome === "drained" ? `${n} looked drained on the scale` : `${n} was hospitalised cutting weight`;
    });
    const base = { ...b, weighIns: weighInNotes };
    if (bk.status !== "completed" || bk.bout_id === null) return { ...base, cancelled: bk.cancel_reason ?? "bout called off", result: null, moments: [] };
    const bout = db.prepare("SELECT id, winner_id, method, end_round, end_time_s, rating, fotn, title_id, catchweight FROM bout WHERE id = ?").get(bk.bout_id) as BoutRow;
    const hasLog = !!db.prepare("SELECT 1 FROM bout_log WHERE bout_id = ?").get(bout.id);
    const moments = (db.prepare("SELECT fighter_id, kind, target_id, text FROM post_fight_moment WHERE bout_id = ? ORDER BY id").all(bout.id) as
      { fighter_id: number; kind: string; target_id: number | null; text: string }[]).map((m) => {
      const f = world.fighters.get(m.fighter_id);
      const fl = f ? flair(f) : 50;
      return { fighterId: m.fighter_id, name: world.nameOf(m.fighter_id), kind: m.kind, targetId: m.target_id, target: m.target_id ? world.nameOf(m.target_id) : null,
        text: m.text, flair: fl, flairLabel: FLAIR_LABEL[flairBand(fl)] };
    });
    // A belt that changed hands tonight: the winner is the champion now.
    const champNow = bout.title_id !== null && bout.winner_id !== null && [...world.titles.values()].some((t) => t.id === bout.title_id && t.champion === bout.winner_id);
    const red = world.fighters.get(b.red.id), blue = world.fighters.get(b.blue.id);
    return {
      ...base, cancelled: null, moments,
      result: {
        boutId: bout.id, hasLog, winner: bout.winner_id === b.red.id ? "red" : bout.winner_id === b.blue.id ? "blue" : "draw",
        winnerName: bout.winner_id ? world.nameOf(bout.winner_id) : null,
        method: bout.method, round: bout.end_round, time: `${Math.floor(bout.end_time_s / 60)}:${String(bout.end_time_s % 60).padStart(2, "0")}`,
        rating: bout.rating, fotn: !!bout.fotn, catchweight: !!bout.catchweight,
        champion: b.title !== null && champNow ? world.nameOf(bout.winner_id!) : null,
        newChampion: b.title !== null && champNow && (bout.winner_id === b.red.id ? b.red.rank : b.blue.rank) !== "C",
        records: { red: red ? record(red) : b.red.record, blue: blue ? record(blue) : b.blue.record },
      },
    };
  });
  results.sort((a, b) => b.order - a.order);
  const ev = db.prepare("SELECT attendance, gate, ppv_buys, tv_viewers, profit, rating FROM event WHERE id = ?").get(eventId) as
    { attendance: number | null; gate: number | null; ppv_buys: number | null; tv_viewers: number | null; profit: number | null; rating: number | null };
  return { show: before.show, bouts: results, summary: ev };
}
