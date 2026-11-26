import { WEIGHT_CLASSES } from "./constants.js";
import { calloutHype, flair, flairBand, FLAIR_LABEL } from "./personality.js";
import { drawLevel, MAIN_CARD_SIZE } from "./excitement.js";
import { popIn } from "./popularity.js";
import { has } from "./traits.js";
import { overall, type FighterState } from "./model.js";
import { cutPercent } from "./weighin.js";
import { MIN_REST_WEEKS, type World } from "./world.js";

/**
 * The player's booking desk: build cards for scheduled events, preview
 * matchups, and let the AI suggest bouts. All checks run here so the UI and
 * the headless demo get the same rules.
 */

export const MAX_BOUTS_PER_CARD = 14;

export interface BookingRow {
  id: number;
  order: number;
  red: FighterState | undefined;
  blue: FighterState | undefined;
  redId: number;
  blueId: number;
  rounds: number;
  titleId: number | null;
  status: string;
  cancelReason: string | null;
}

export interface EventRow {
  id: number;
  name: string;
  week: number;
  status: string;
}

export class BookingError extends Error {}

function eventRow(world: World, eventId: number) {
  const e = world.db.prepare("SELECT id, promotion_id, week, name, status, region_id FROM event WHERE id = ?").get(eventId) as
    { id: number; promotion_id: number; week: number; name: string; status: string; region_id: number | null } | undefined;
  if (!e) throw new BookingError("No such event");
  return e;
}

export function playerEvents(world: World): EventRow[] {
  return world.db.prepare(`SELECT id, name, week, status FROM event WHERE promotion_id = ?
                           ORDER BY CASE status WHEN 'scheduled' THEN 0 ELSE 1 END, week DESC LIMIT 30`).all(world.playerPromotionId) as EventRow[];
}

export function card(world: World, eventId: number): BookingRow[] {
  const rows = world.db.prepare(`SELECT id, card_order, red_id, blue_id, rounds, title_id, status, cancel_reason FROM booking
                                 WHERE event_id = ? ORDER BY card_order`).all(eventId) as
    { id: number; card_order: number; red_id: number; blue_id: number; rounds: number; title_id: number | null; status: string; cancel_reason: string | null }[];
  return rows.map((r) => ({
    id: r.id, order: r.card_order, red: world.fighters.get(r.red_id), blue: world.fighters.get(r.blue_id), redId: r.red_id, blueId: r.blue_id,
    rounds: r.rounds, titleId: r.title_id, status: r.status, cancelReason: r.cancel_reason,
  }));
}

/** Fighters already booked on any scheduled event, mapped to that event's week. */
function bookedFighters(world: World): Map<number, number> {
  const rows = world.db.prepare(`SELECT b.red_id, b.blue_id, e.week FROM booking b JOIN event e ON e.id = b.event_id
                                 WHERE b.status = 'booked' AND e.status = 'scheduled' AND e.promotion_id = ?`).all(world.playerPromotionId) as
    { red_id: number; blue_id: number; week: number }[];
  const m = new Map<number, number>();
  for (const r of rows) { m.set(r.red_id, r.week); m.set(r.blue_id, r.week); }
  return m;
}

export interface Preview {
  redWinPct: number;
  competitiveness: number;   // 0-1
  hype: number;              // 0-100
  titleEligible: boolean;
  notes: string[];
  problems: string[];
}

/** Matchmaking preview: odds, hype, storylines, and anything that blocks the booking. */
export function previewBout(world: World, eventId: number, redId: number, blueId: number, title = false, atSlot?: number): Preview {
  const e = eventRow(world, eventId);
  const red = world.fighters.get(redId);
  const blue = world.fighters.get(blueId);
  const problems: string[] = [];
  const notes: string[] = [];
  if (!red || !blue) return { redWinPct: 50, competitiveness: 0, hype: 0, titleEligible: false, notes, problems: ["Unknown fighter"] };
  if (e.promotion_id !== world.playerPromotionId) problems.push("Not your event");
  if (e.status !== "scheduled") problems.push("Event is not open for booking");
  if (red.id === blue.id) problems.push("A fighter can't fight themselves");
  for (const f of [red, blue]) {
    if (f.promotionId !== world.playerPromotionId) problems.push(`${f.name} is not on your roster`);
    if (f.status !== "active") problems.push(`${f.name} is ${f.status}`);
    if (f.injuredUntil !== null && f.injuredUntil > e.week) problems.push(`${f.name} is injured until week ${f.injuredUntil}`);
    if (f.lastFightWeek !== null && e.week - f.lastFightWeek < MIN_REST_WEEKS) problems.push(`${f.name} needs ${MIN_REST_WEEKS} weeks between fights`);
    if (f.boutsRemaining <= 0 && f.contractId !== null) problems.push(`${f.name} has no fights left on contract`);
  }
  const div = boutDivision(world, red, blue, title);
  if (div.problem) problems.push(div.problem);
  if (div.note) notes.push(div.note);
  const booked = bookedFighters(world);
  for (const f of [red, blue]) if (booked.has(f.id)) problems.push(`${f.name} is already booked (week ${booked.get(f.id)})`);

  // Odds from the same skill gap the light resolver uses.
  const diff = overall(red.attrs) - overall(blue.attrs) - (red.damage - blue.damage) * 0.25;
  const pRed = 1 / (1 + Math.exp(-diff / 6));
  const competitiveness = 1 - Math.abs(pRed - 0.5) * 2;

  const champ = world.championOf(world.playerPromotionId!, div.weightClassId);
  const titleEligible = div.titleEligible;
  if (title && !titleEligible) problems.push("Only the champion (or two contenders for a vacant belt) can fight for the title");
  if (title && titleEligible) {
    const t = world.title(world.playerPromotionId!, div.weightClassId);
    const clash = world.db.prepare("SELECT 1 FROM booking WHERE event_id = ? AND title_id = ? AND status = 'booked'").get(eventId, t.id);
    if (clash) problems.push("This title is already on the line on this card");
  }

  const callout = world.db.prepare(`SELECT fighter_id FROM post_fight_moment WHERE kind = 'callout' AND week > @since
                                    AND ((fighter_id = @a AND target_id = @b) OR (fighter_id = @b AND target_id = @a)) LIMIT 1`)
    .get({ since: e.week - 52, a: red.id, b: blue.id }) as { fighter_id: number } | undefined;
  const rematch = world.db.prepare("SELECT winner_id FROM bout WHERE (red_id = @a AND blue_id = @b) OR (red_id = @b AND blue_id = @a) ORDER BY week DESC LIMIT 1")
    .get({ a: red.id, b: blue.id }) as { winner_id: number | null } | undefined;
  // Stars draw where they're popular: hype and slot expectations use the event's region.
  const region = e.region_id;
  const popR = popIn(red, region), popB = popIn(blue, region);
  let hype = ((popR + popB) / 2) * (0.6 + 0.4 * competitiveness);
  if (region !== null) {
    const where = world.regionNameOf(region);
    notes.push(`Draw in ${where}: ${red.name} ${drawLevel(popR)} level (${Math.round(popR)}), ${blue.name} ${drawLevel(popB)} level (${Math.round(popB)})`);
  }
  // Big egos: won't face unranked, lesser-known opponents, or sit on the prelims while ranked.
  const slot = atSlot ?? (title ? 1 : card(world, eventId).filter((b) => b.status === "booked").length + 1);
  for (const [f, o, pf, po] of [[red, blue, popR, popB], [blue, red, popB, popR]] as const) {
    if (!has(f.traits, "diva")) continue;
    const ranked = world.rankOf(f) !== null || world.titlesOf(f.id).length > 0;
    if (ranked && world.rankOf(o) === null && world.titlesOf(o.id).length === 0 && po < pf) problems.push(`${f.name} (big ego) refuses to fight an unranked, lesser-known opponent`);
    if ((ranked || drawLevel(pf) !== "prelims") && slot > MAIN_CARD_SIZE) problems.push(`${f.name} (big ego) won't fight on the prelims; book them in the top ${MAIN_CARD_SIZE}`);
  }
  if (title) { hype += 20; notes.push("Title fight: five rounds"); }
  if (div.champVsChamp) { hype += 25; notes.push(title ? "Champ vs champ: the winner of the challenger's side becomes a two-division champion" : "Champ vs champ superfight (non-title)"); }
  if (callout) {
    const caller = world.fighters.get(callout.fighter_id);
    const fl = caller ? flair(caller) : 50;
    hype += calloutHype(fl);
    notes.push(`Storyline: ${caller?.name} called this fight (${FLAIR_LABEL[flairBand(fl)].toLowerCase()} callout, +${calloutHype(fl)} hype)`);
  }
  if (rematch) { hype += 5; notes.push(rematch.winner_id ? `Rematch: ${world.fighters.get(rematch.winner_id)?.name ?? "one of them"} won the first fight` : "Rematch of a draw"); }

  const prospect = (f: FighterState, o: FighterState) => f.wins + f.losses < 8 && f.attrs.potential >= 70 && overall(o.attrs) - overall(f.attrs) > 6;
  for (const [f, o] of [[red, blue], [blue, red]] as const) {
    if (prospect(f, o)) notes.push(`Risk: ${f.name} is a prospect and a big underdog here`);
    const cut = cutPercent(f) * 100;
    if (cut > 11) notes.push(`${f.name} has a hard cut (${cut.toFixed(0)}% of body weight)`);
    if (f.missedWeight > 0) notes.push(`${f.name} missed weight recently`);
  }
  const weeksOut = e.week - world.week;
  if (weeksOut < 3) notes.push("Short notice: harder weight cuts");
  const ra = world.rankOf(red), rb = world.rankOf(blue);
  if (ra || rb) notes.push(`Rankings: ${red.name} ${ra ? "#" + ra : champ === red.id ? "C" : "NR"}, ${blue.name} ${rb ? "#" + rb : champ === blue.id ? "C" : "NR"}`);

  return { redWinPct: Math.round(pRed * 100), competitiveness, hype: Math.round(Math.min(100, hype)), titleEligible, notes, problems };
}

export function bookBout(world: World, eventId: number, redId: number, blueId: number, opts: { title?: boolean; rounds?: number } = {}): number {
  const pv = previewBout(world, eventId, redId, blueId, !!opts.title);
  if (pv.problems.length) throw new BookingError(pv.problems.join("; "));
  const existing = card(world, eventId).filter((b) => b.status === "booked");
  if (existing.length >= MAX_BOUTS_PER_CARD) throw new BookingError(`A card holds at most ${MAX_BOUTS_PER_CARD} bouts`);
  const red = world.fighters.get(redId)!;
  const div = boutDivision(world, red, world.fighters.get(blueId)!, !!opts.title);
  const title = opts.title ? world.title(world.playerPromotionId!, div.weightClassId) : null;
  const rounds = title ? 5 : opts.rounds === 5 ? 5 : 3;
  // Title fights headline; otherwise new bouts go to the bottom of the card.
  const order = title ? 0 : Math.max(0, ...card(world, eventId).map((b) => b.order)) + 1;
  return world.repo.insertBooking(eventId, order, redId, blueId, div.weightClassId, rounds, title?.id ?? null, world.week);
}

export function cancelBooking(world: World, bookingId: number) {
  world.repo.setBookingStatus(bookingId, "cancelled", "cancelled by the promotion", null);
}

/** Fill the rest of a card with AI-suggested bouts. Returns how many were booked. */
export function autoFillCard(world: World, eventId: number, target = 10): number {
  const e = eventRow(world, eventId);
  const p = world.playerPromotion!;
  const booked = bookedFighters(world);
  const pool = [...p.roster].map((id) => world.fighters.get(id)!).filter((f) => f && world.available(f, e.week) && !booked.has(f.id) && f.boutsRemaining > 0);
  const have = card(world, eventId).filter((b) => b.status === "booked");
  const hasTitle = have.some((b) => b.titleId !== null);
  const pairs = world.suggestPairs(p, pool, target - have.length, !hasTitle);
  let n = 0;
  for (const s of pairs) {
    try {
      // Only the headliner of an empty card gets five rounds.
      bookBout(world, eventId, s.red.id, s.blue.id, { title: s.title !== null, rounds: have.length === 0 && n === 0 ? s.rounds : 3 });
      n++;
    } catch { /* skip pairs that fail a rule */ }
  }
  return n;
}

/** Replacement options for a fighter's slot: same division, available, ranked near the original. */
export function replacementOptions(world: World, eventId: number, opponentId: number, limit = 5): FighterState[] {
  const e = eventRow(world, eventId);
  const opp = world.fighters.get(opponentId);
  if (!opp) return [];
  const booked = bookedFighters(world);
  return world.rankings(world.playerPromotionId!, opp.weightClassId)
    .filter((f) => f.id !== opp.id && world.available(f, e.week) && !booked.has(f.id))
    .sort((a, b) => Math.abs(a.rating - opp.rating) - Math.abs(b.rating - opp.rating))
    .slice(0, limit);
}

export function divisionName(id: number) {
  const wc = WEIGHT_CLASSES[id - 1];
  return wc ? `${wc.sex === "F" ? "Women's " : ""}${wc.name}` : "?";
}

/** How many divisions apart two fighters can be and still meet (the lighter one moves up). */
export const MAX_DIVISION_GAP = 2;

/**
 * Which division a bout is fought at. Same division: that one. Different
 * divisions: the heavier one, unless the title asked for belongs to a lighter
 * division one of them holds (a double champ defending the lower belt).
 */
export function boutDivision(world: World, red: FighterState, blue: FighterState, title: boolean):
  { weightClassId: number; titleEligible: boolean; champVsChamp: boolean; note: string | null; problem: string | null } {
  const pid = world.playerPromotionId!;
  const candidates = [...new Set([red.weightClassId, blue.weightClassId, ...world.titlesOf(red.id), ...world.titlesOf(blue.id)]
    .map((x) => (typeof x === "number" ? x : x.promotionId === pid ? x.weightClassId : null)).filter((x): x is number => x !== null))];
  const eligible = (wc: number) => {
    const c = world.championOf(pid, wc);
    if (c === red.id || c === blue.id) return true;
    return c === null && red.weightClassId === wc && blue.weightClassId === wc;
  };
  const reachable = (wc: number) => [red, blue].every((f) => {
    const a = WEIGHT_CLASSES[f.weightClassId - 1]!, b = WEIGHT_CLASSES[wc - 1]!;
    return a.sex === b.sex && wc >= f.weightClassId - (world.championOf(pid, wc) === f.id ? 99 : 0) && wc - f.weightClassId <= MAX_DIVISION_GAP;
  });
  const sexOk = WEIGHT_CLASSES[red.weightClassId - 1]!.sex === WEIGHT_CLASSES[blue.weightClassId - 1]!.sex;
  const titled = candidates.filter((wc) => eligible(wc) && reachable(wc)).sort((a, b) => b - a);
  const plain = Math.max(red.weightClassId, blue.weightClassId);
  const wc = title && titled.length ? titled[0]! : red.weightClassId === blue.weightClassId ? red.weightClassId : plain;
  const champVsChamp = world.titlesOf(red.id).some((t) => t.promotionId === pid) && world.titlesOf(blue.id).some((t) => t.promotionId === pid) && red.id !== blue.id;
  let problem: string | null = null;
  if (!sexOk) problem = "Fighters are in different divisions";
  else if (!reachable(wc)) problem = `Too big a weight gap: fighters can move up at most ${MAX_DIVISION_GAP} divisions`;
  const movers = [red, blue].filter((f) => f.weightClassId < wc).map((f) => f.name);
  const note = red.weightClassId !== blue.weightClassId || wc !== red.weightClassId
    ? `Fought at ${WEIGHT_CLASSES[wc - 1]!.name}${movers.length ? ` (${movers.join(" and ")} moving up)` : ""}` : null;
  return { weightClassId: wc, titleEligible: titled.length > 0, champVsChamp, note, problem };
}

/** Move a booked bout up (-1) or down (+1) the card. Big egos refuse to drop to the prelims. */
export function moveBooking(world: World, bookingId: number, dir: -1 | 1) {
  const row = world.db.prepare("SELECT event_id FROM booking WHERE id = ?").get(bookingId) as { event_id: number } | undefined;
  if (!row) throw new BookingError("No such booking");
  const list = card(world, row.event_id).filter((b) => b.status === "booked");
  const i = list.findIndex((b) => b.id === bookingId), j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  const moving = list[i]!, other = list[j]!;
  for (const [b, to] of [[moving, j], [other, i]] as const) {
    if (to + 1 > MAIN_CARD_SIZE) for (const f of [b.red, b.blue]) {
      if (f && has(f.traits, "diva") && (world.rankOf(f) !== null || world.titlesOf(f.id).length)) throw new BookingError(`${f.name} (big ego) won't fight on the prelims`);
    }
  }
  [list[i], list[j]] = [other, moving];
  const upd = world.db.prepare("UPDATE booking SET card_order = ? WHERE id = ?");
  list.forEach((b, k) => upd.run(k, b.id));
}
