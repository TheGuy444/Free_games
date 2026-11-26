/**
 * The booking desk: shows (alter, cancel), card order, and everything the
 * "Add bout" screen shows about two fighters and their fight.
 */
import { WEEKS_PER_YEAR, type DisciplineCode } from "./constants.js";
import { BookingError, boutDivision, card, MAX_DIVISION_GAP, previewBout, replacementOptions, type Preview } from "./booking.js";
import { cardDraw, outlets } from "./business.js";
import { drawLevel, MAIN_CARD_SIZE } from "./excitement.js";
import { STYLE_NAMES } from "./fighter-gen.js";
import { ageYears, overall, type FighterState } from "./model.js";
import { popIn } from "./popularity.js";
import { feetInches, physicals } from "./profile.js";
import { has, TRAITS, type Trait } from "./traits.js";
import { divisionLabel, MIN_REST_WEEKS, type World } from "./world.js";

/** A full camp is eight weeks of preparation. */
export const FULL_CAMP_WEEKS = 8;

interface EventInfo { id: number; promotion_id: number; week: number; name: string; status: string; region_id: number | null; broadcast: string | null; venue: string | null }
function ev(world: World, eventId: number): EventInfo {
  const e = world.db.prepare("SELECT id, promotion_id, week, name, status, region_id, broadcast, venue FROM event WHERE id = ?").get(eventId) as EventInfo | undefined;
  if (!e) throw new BookingError("No such event");
  return e;
}
function mine(world: World, e: EventInfo) {
  if (e.promotion_id !== world.playerPromotionId) throw new BookingError("Not your event");
  if (e.status !== "scheduled") throw new BookingError("That show has already happened or was cancelled");
}

/** Date in the game calendar: "2026, week 14". */
export const weekLabel = (world: World, week: number) => `${world.yearOf(week)}, week ${(week % WEEKS_PER_YEAR) + 1}`;

// ------------------------------------------------------------------ shows

export function showDetails(world: World, eventId: number) {
  const e = ev(world, eventId);
  const p = world.playerPromotion!;
  const out = outlets(world, p);
  const broadcaster = e.broadcast === "ppv" ? out.ppv?.name ?? null : e.broadcast === "tv" ? out.tv?.name ?? null : null;
  const rows = card(world, eventId).filter((b) => b.status === "booked");
  const draw = cardDraw(rows.filter((b) => b.red && b.blue).map((b) => ({ red: b.red!, blue: b.blue!, title: b.titleId !== null })), e.region_id);
  return {
    id: e.id, name: e.name, status: e.status, week: e.week, weeksAway: e.week - world.week, date: weekLabel(world, e.week),
    region: e.region_id ? world.regionNameOf(e.region_id) : null, regionId: e.region_id, venue: e.venue, broadcast: e.broadcast,
    broadcastLine: e.broadcast === "none" || !e.broadcast ? "Not broadcast: gate and sponsors only."
      : broadcaster ? `The show will be broadcast on ${e.broadcast === "ppv" ? "pay-per-view through " : ""}${broadcaster}.`
      : `Set for ${e.broadcast.toUpperCase()}, but you have no ${e.broadcast.toUpperCase()} outlet yet: sign one on the Business tab.`,
    bouts: rows.length, mainCardSize: MAIN_CARD_SIZE, draw: Math.round(draw),
  };
}

export function alterShow(world: World, eventId: number, changes: { name?: string; weeksAhead?: number; regionId?: number; broadcast?: string; venue?: string | null }) {
  const e = ev(world, eventId);
  mine(world, e);
  if (changes.weeksAhead !== undefined) {
    const week = world.week + Math.max(1, Math.min(52, Math.floor(changes.weeksAhead)));
    for (const b of card(world, eventId).filter((x) => x.status === "booked")) {
      for (const f of [b.red, b.blue]) {
        if (f?.lastFightWeek != null && week - f.lastFightWeek < MIN_REST_WEEKS) throw new BookingError(`${f.name} couldn't make that date: needs ${MIN_REST_WEEKS} weeks between fights`);
      }
    }
    const clash = world.db.prepare(`SELECT e.name FROM booking b JOIN event e ON e.id = b.event_id WHERE e.status = 'scheduled' AND e.id != ? AND b.status = 'booked'
                                    AND ABS(e.week - ?) < ? AND (b.red_id IN (SELECT red_id FROM booking WHERE event_id = ? AND status = 'booked' UNION SELECT blue_id FROM booking WHERE event_id = ? AND status = 'booked')
                                    OR b.blue_id IN (SELECT red_id FROM booking WHERE event_id = ? AND status = 'booked' UNION SELECT blue_id FROM booking WHERE event_id = ? AND status = 'booked')) LIMIT 1`)
      .get(eventId, week, MIN_REST_WEEKS, eventId, eventId, eventId, eventId) as { name: string } | undefined;
    if (clash) throw new BookingError(`Too close to ${clash.name}: a fighter on both cards wouldn't have time to recover`);
    world.db.prepare("UPDATE event SET week = ? WHERE id = ?").run(week, eventId);
  }
  if (changes.name !== undefined && changes.name.trim()) world.db.prepare("UPDATE event SET name = ? WHERE id = ?").run(changes.name.trim(), eventId);
  if (changes.regionId !== undefined && world.regionIds.includes(changes.regionId)) world.db.prepare("UPDATE event SET region_id = ? WHERE id = ?").run(changes.regionId, eventId);
  if (changes.broadcast !== undefined && ["tv", "ppv", "none"].includes(changes.broadcast)) world.db.prepare("UPDATE event SET broadcast = ? WHERE id = ?").run(changes.broadcast, eventId);
  if (changes.venue !== undefined) world.db.prepare("UPDATE event SET venue = ? WHERE id = ?").run(changes.venue || null, eventId);
  return showDetails(world, eventId);
}

export function cancelShow(world: World, eventId: number) {
  const e = ev(world, eventId);
  mine(world, e);
  world.db.prepare("UPDATE booking SET status = 'cancelled', cancel_reason = 'show cancelled' WHERE event_id = ? AND status = 'booked'").run(eventId);
  world.repo.setEventStatus(eventId, "cancelled");
  world.repo.news(world.week, e.promotion_id, "event", `${e.name} has been cancelled.`, null, 2);
}

// ------------------------------------------------------------------ card order

function reorder(world: World, eventId: number, ids: number[]) {
  const list = card(world, eventId).filter((b) => b.status === "booked");
  for (const [i, id] of ids.entries()) {
    if (i < MAIN_CARD_SIZE) continue;
    const b = list.find((x) => x.id === id);
    for (const f of [b?.red, b?.blue]) {
      if (f && has(f.traits, "diva") && (world.rankOf(f) !== null || world.titlesOf(f.id).length)) throw new BookingError(`${f.name} (big ego) won't fight on the prelims`);
    }
  }
  const upd = world.db.prepare("UPDATE booking SET card_order = ? WHERE id = ?");
  ids.forEach((id, k) => upd.run(k, id));
}

export type CardPosition = "main" | "co" | "main_card" | "prelims";
export const CARD_POSITIONS: { key: CardPosition; label: string }[] = [
  { key: "main", label: "Main event" }, { key: "co", label: "Co-main event" }, { key: "main_card", label: "Main card" }, { key: "prelims", label: "Prelims" },
];

/** Move a booked bout to a slot: main event, co-main, end of the main card, or the prelims. */
export function placeBout(world: World, bookingId: number, pos: CardPosition) {
  const row = world.db.prepare("SELECT event_id FROM booking WHERE id = ?").get(bookingId) as { event_id: number } | undefined;
  if (!row) throw new BookingError("No such booking");
  const ids = card(world, row.event_id).filter((b) => b.status === "booked").map((b) => b.id).filter((id) => id !== bookingId);
  const at = pos === "main" ? 0 : pos === "co" ? Math.min(1, ids.length) : pos === "main_card" ? Math.min(MAIN_CARD_SIZE - 1, ids.length) : Math.max(MAIN_CARD_SIZE, ids.length);
  ids.splice(Math.min(at, ids.length), 0, bookingId);
  reorder(world, row.event_id, ids);
}

export function swapCorners(world: World, bookingId: number) {
  world.db.prepare("UPDATE booking SET red_id = blue_id, blue_id = red_id WHERE id = ? AND status = 'booked'").run(bookingId);
}

// ------------------------------------------------------------------ replacements

interface CancelledRow { id: number; event_id: number; card_order: number; red_id: number; blue_id: number; rounds: number; title_id: number | null; status: string; cancel_reason: string | null }
function cancelledBooking(world: World, bookingId: number) {
  const b = world.db.prepare("SELECT id, event_id, card_order, red_id, blue_id, rounds, title_id, status, cancel_reason FROM booking WHERE id = ?").get(bookingId) as CancelledRow | undefined;
  if (!b || b.status !== "cancelled") throw new BookingError("That bout isn't off the card");
  if (b.cancel_reason?.includes("; replaced by")) throw new BookingError("That bout already has a replacement");
  const e = ev(world, b.event_id);
  mine(world, e);
  // Who's out: the one named in the reason, otherwise whoever can't make the date.
  const red = world.fighters.get(b.red_id), blue = world.fighters.get(b.blue_id);
  const cantMake = (f: FighterState | undefined) => !f || f.status !== "active" || f.promotionId !== world.playerPromotionId || (f.injuredUntil !== null && f.injuredUntil > e.week);
  let outId = b.cancel_reason && red && b.cancel_reason.startsWith(red.name) ? b.red_id : b.cancel_reason && blue && b.cancel_reason.startsWith(blue.name) ? b.blue_id : cantMake(red) ? b.red_id : b.blue_id;
  const keptId = outId === b.red_id ? b.blue_id : b.red_id;
  if (cantMake(world.fighters.get(keptId)) && !cantMake(world.fighters.get(outId))) outId = keptId;
  const kept = world.fighters.get(outId === b.red_id ? b.blue_id : b.red_id);
  if (!kept || cantMake(kept)) throw new BookingError("Neither fighter from this bout can make the show: book a new bout instead");
  const slot = card(world, b.event_id).filter((x) => x.status === "booked" && x.order < b.card_order).length;
  return { b, e, kept, keptIsRed: kept.id === b.red_id, outId: outId === kept.id ? (kept.id === b.red_id ? b.blue_id : b.red_id) : outId, slot };
}

/** The best short-notice options to step in against the fighter who's left, with what each fight would look like. */
export function replacementInfo(world: World, bookingId: number) {
  const { b, e, kept, outId, slot } = cancelledBooking(world, bookingId);
  const at = slot + 1;
  const title = b.title_id !== null;
  const opts = replacementOptions(world, e.id, kept.id, 8).map((f) => {
    const pv = previewBout(world, e.id, kept.id, f.id, title, at);
    const keepTitle = title && pv.titleEligible;
    const pv2 = keepTitle || !title ? pv : previewBout(world, e.id, kept.id, f.id, false, at);
    const rank = world.titlesOf(f.id).length ? "C" : world.rankOf(f) ? `#${world.rankOf(f)}` : "NR";
    return { id: f.id, name: f.name, rank, record: `${f.wins}-${f.losses}${f.draws ? `-${f.draws}` : ""}`, pop: Math.round(popIn(f, e.region_id)),
      line: `${kept.name} ${moneyline(pv2.redWinPct / 100)} / ${f.name} ${moneyline(1 - pv2.redWinPct / 100)}`, hype: pv2.hype,
      titleStays: keepTitle, problems: pv2.problems, notes: pv2.notes.filter((n) => !n.startsWith("Draw in")) };
  });
  return {
    bookingId, eventId: e.id, kept: { id: kept.id, name: kept.name, division: divisionLabel(kept.weightClassId), weightClassId: kept.weightClassId },
    out: { id: outId, name: world.nameOf(outId), reason: b.cancel_reason }, slot: slot + 1, title, rounds: b.rounds, weeksOut: e.week - world.week, options: opts,
  };
}

/** Put a replacement in the same slot, same rounds; the belt stays on the line only if the new matchup is eligible. */
export function lockReplacement(world: World, bookingId: number, newId: number) {
  const { b, e, kept, keptIsRed, slot } = cancelledBooking(world, bookingId);
  const sub = world.fighters.get(newId);
  if (!sub) throw new BookingError("Unknown fighter");
  let title = b.title_id !== null;
  if (title && !previewBout(world, e.id, kept.id, sub.id, true).titleEligible) title = false;
  const pv = previewBout(world, e.id, kept.id, sub.id, title, slot + 1);
  if (pv.problems.length) throw new BookingError(pv.problems.join("; "));
  const [redId, blueId] = keptIsRed ? [kept.id, sub.id] : [sub.id, kept.id];
  const red = world.fighters.get(redId)!, blue = world.fighters.get(blueId)!;
  const div = boutDivision(world, red, blue, title);
  const t = title ? world.title(world.playerPromotionId!, div.weightClassId) : null;
  const id = world.repo.insertBooking(e.id, b.card_order, redId, blueId, div.weightClassId, title ? 5 : b.rounds, t?.id ?? null, world.week);
  world.db.prepare("UPDATE booking SET cancel_reason = ? WHERE id = ?").run(`${b.cancel_reason ?? "off"}; replaced by ${sub.name}`, b.id);
  world.repo.news(world.week, e.promotion_id, "event", `${sub.name} steps in on ${e.week - world.week} weeks' notice to face ${kept.name} at ${e.name}${b.title_id !== null && !title ? " (no longer a title fight)" : ""}.`, null, 2);
  return id;
}

// ------------------------------------------------------------------ fighter picker

export type PickerSort = "ranking" | "name" | "popularity" | "rating";

export function pickerList(world: World, eventId: number, weightClassId: number, sort: PickerSort, search = "", nearby = false) {
  const e = ev(world, eventId);
  const p = world.playerPromotion!;
  const champ = world.championOf(p.id, weightClassId);
  const order = world.rankings(p.id, weightClassId).map((f) => f.id);
  const booked = new Map((world.db.prepare(`SELECT b.red_id a, b.blue_id b, e.name, e.id FROM booking b JOIN event e ON e.id = b.event_id
                                         WHERE b.status = 'booked' AND e.status = 'scheduled' AND e.promotion_id = ?`).all(p.id) as { a: number; b: number; name: string; id: number }[])
    .flatMap((r) => [[r.a, r], [r.b, r]] as const));
  const q = search.trim().toLowerCase();
  const list = [...p.roster].map((id) => world.fighters.get(id)!).filter((f) => f && f.status === "active"
    && (nearby ? Math.abs(f.weightClassId - weightClassId) <= MAX_DIVISION_GAP && sameSexDivision(f.weightClassId, weightClassId) : f.weightClassId === weightClassId)
    && (!q || f.name.toLowerCase().includes(q)));
  const rankLabel = (f: FighterState) => {
    if (world.titlesOf(f.id).some((t) => t.promotionId === p.id)) return "C";
    const r = f.weightClassId === weightClassId ? order.indexOf(f.id) : -1;
    const rk = world.rankOf(f);
    return rk ? `#${rk}` : r >= 0 && r < 15 ? `#${r + 1}` : "NR";
  };
  const rankScore = (f: FighterState) => (f.id === champ ? -1 : world.titlesOf(f.id).length ? 0 : world.rankOf(f) ?? (100 + (order.indexOf(f.id) + 1 || 999)));
  const sorters: Record<PickerSort, (a: FighterState, b: FighterState) => number> = {
    ranking: (a, b) => rankScore(a) - rankScore(b),
    name: (a, b) => a.name.localeCompare(b.name),
    popularity: (a, b) => popIn(b, e.region_id) - popIn(a, e.region_id),
    rating: (a, b) => b.rating - a.rating,
  };
  return list.sort(sorters[sort]).map((f) => {
    const bk = booked.get(f.id);
    const status = bk ? (bk.id === eventId ? "on this card" : `booked: ${bk.name}`)
      : f.injuredUntil !== null && f.injuredUntil > e.week ? "injured"
      : f.lastFightWeek !== null && e.week - f.lastFightWeek < MIN_REST_WEEKS ? "needs rest"
      : f.boutsRemaining <= 0 ? "no fights left" : "available";
    return { id: f.id, name: f.name, rank: rankLabel(f), record: `${f.wins}-${f.losses}${f.draws ? `-${f.draws}` : ""}`,
      division: f.weightClassId !== weightClassId ? divisionLabel(f.weightClassId) : null,
      pop: Math.round(popIn(f, e.region_id)), rating: Math.round(f.rating), status, ok: status === "available" };
  });
}
const sameSexDivision = (a: number, b: number) => (a <= 8) === (b <= 8);

// ------------------------------------------------------------------ fighter panel

export function fighterPanel(world: World, fighterId: number, eventId: number) {
  const f = world.fighters.get(fighterId);
  if (!f) return null;
  const e = ev(world, eventId);
  const p = world.playerPromotion!;
  const db = world.db;
  const ph = physicals(f.id, f.sex, f.weightClassId);
  const base = db.prepare("SELECT d.code FROM fighter fi JOIN discipline d ON d.id = fi.base_discipline WHERE fi.person_id = ?").get(f.id) as { code: DisciplineCode } | undefined;
  const inPromo = db.prepare(`SELECT SUM(b.winner_id = @id) w, SUM(b.winner_id IS NOT NULL AND b.winner_id != @id) l, SUM(b.winner_id IS NULL) d
                              FROM bout b JOIN event ev ON ev.id = b.event_id WHERE ev.promotion_id = @p AND (b.red_id = @id OR b.blue_id = @id)`).get({ id: f.id, p: p.id }) as { w: number | null; l: number | null; d: number | null };
  const contract = f.contractId !== null ? db.prepare("SELECT purse, win_bonus FROM contract WHERE id = ?").get(f.contractId) as { purse: number; win_bonus: number } | undefined : undefined;
  const last = db.prepare(`SELECT b.winner_id, b.method, b.end_round, b.red_id, b.blue_id, b.week, ev.name FROM bout b JOIN event ev ON ev.id = b.event_id
                           WHERE b.red_id = @id OR b.blue_id = @id ORDER BY b.week DESC, b.id DESC LIMIT 1`).get({ id: f.id }) as
    { winner_id: number | null; method: string; end_round: number; red_id: number; blue_id: number; week: number; name: string } | undefined;

  // Camp: weeks from now to the show, or a reason he can't be ready.
  const weeksOut = e.week - world.week;
  const restUntil = f.lastFightWeek !== null ? f.lastFightWeek + MIN_REST_WEEKS : null;
  const camp = f.injuredUntil !== null && f.injuredUntil > e.week ? { ok: false, text: `Injured until ${weekLabel(world, f.injuredUntil)}: can't make this show` }
    : restUntil !== null && restUntil > e.week ? { ok: false, text: `Needs rest until ${weekLabel(world, restUntil)}: can't make this show` }
    : weeksOut >= FULL_CAMP_WEEKS ? { ok: true, text: "Has time for a full camp" }
    : weeksOut >= 4 ? { ok: true, text: `Short camp: ${weeksOut} weeks to prepare` }
    : { ok: true, text: `Short notice: ${weeksOut} week${weeksOut === 1 ? "" : "s"} to prepare, harder weight cut` };

  const regionPop = popIn(f, e.region_id);
  const where = e.region_id ? world.regionNameOf(e.region_id) : "this region";
  const level = drawLevel(regionPop);
  const rank = world.rankOf(f);
  const champ = world.titlesOf(f.id).some((t) => t.promotionId === p.id);
  const usage = champ || level === "main event" ? "Headlining our biggest shows" : rank !== null && rank <= 5 || level === "main card" ? "Main card" : rank !== null ? "Main card or top of the prelims" : "Prelims";
  const momentum = f.winStreak >= 3 ? `On a ${f.winStreak}-fight win streak` : f.lossStreak >= 2 ? `Lost ${f.lossStreak} in a row` : f.winStreak === 1 ? "Coming off a win" : f.lossStreak === 1 ? "Coming off a loss" : "Nothing specific";
  const lastFight = !last ? (f.wins + f.losses + f.draws === 0 ? "None yet: this would be the pro debut" : "Before our records began") : (() => {
    const opp = world.nameOf(last.red_id === f.id ? last.blue_id : last.red_id);
    const how = METHOD_WORDS[last.method] ?? last.method;
    const yr = world.yearOf(last.week);
    return last.winner_id === null ? `Drew with ${opp} at ${last.name} (${yr})`
      : last.winner_id === f.id ? `Defeated ${opp} by ${how}${last.method.startsWith("DEC") ? "" : ` in round ${last.end_round}`} at ${last.name} (${yr})`
      : `Lost to ${opp} by ${how}${last.method.startsWith("DEC") ? "" : ` in round ${last.end_round}`} at ${last.name} (${yr})`;
  })();
  const purse = contract?.purse ?? world.tierDef.get(p.tier)!.basePurse;
  const bonus = contract?.win_bonus ?? purse;
  return {
    id: f.id, name: f.name, sex: f.sex, promotionId: f.promotionId, age: Math.floor(ageYears(f, world.week)), height: feetInches(ph.heightCm), division: divisionLabel(f.weightClassId),
    from: world.regionName(f), record: `${f.wins}-${f.losses}${f.draws ? `-${f.draws}` : ""}`,
    recordHere: `${inPromo.w ?? 0}-${inPromo.l ?? 0}${inPromo.d ? `-${inPromo.d}` : ""} ${p.name}`,
    style: base ? STYLE_NAMES[base.code] : "MMA", overall: Math.round(overall(f.attrs)),
    rank: champ ? `${p.name} ${divisionLabel(f.weightClassId)} champion` : rank ? `${p.name} ${divisionLabel(f.weightClassId)} ranking: #${rank}` : "Unranked",
    traits: f.traits.map((t) => TRAITS[t as Trait]?.name ?? t),
    camp, pay: `$${Math.round(purse).toLocaleString("en-US")} to show, $${Math.round(bonus).toLocaleString("en-US")} win bonus · ${f.boutsRemaining} fight${f.boutsRemaining === 1 ? "" : "s"} left`,
    popularity: `Popularity in ${where}: ${Math.round(regionPop)} (${level} draw)`, usage, momentum, lastFight,
  };
}
const METHOD_WORDS: Record<string, string> = { KO: "knockout", TKO: "TKO", SUB: "submission", DEC_U: "unanimous decision", DEC_S: "split decision", DEC_M: "majority decision", DRAW: "draw" };

// ------------------------------------------------------------------ matchup column

/** American moneyline from a win probability. */
export function moneyline(p: number): string {
  const q = Math.min(0.97, Math.max(0.03, p));
  const v = q >= 0.5 ? -Math.round((q / (1 - q)) * 100 / 5) * 5 : Math.round(((1 - q) / q) * 100 / 5) * 5;
  return v > 0 ? `+${v}` : String(v);
}

export function matchupInfo(world: World, eventId: number, redId: number, blueId: number, title: boolean) {
  const e = ev(world, eventId);
  const p = world.playerPromotion!;
  const red = world.fighters.get(redId), blue = world.fighters.get(blueId);
  if (!red || !blue) return null;
  const pv: Preview = previewBout(world, eventId, redId, blueId, title);
  const draw = cardDraw([{ red, blue, title }], e.region_id);
  const where = e.region_id ? world.regionNameOf(e.region_id) : "the region";
  const level = draw >= 75 ? "Very high" : draw >= 55 ? "High" : draw >= 38 ? "Solid" : draw >= 24 ? "Modest" : "Low";
  // What slot that draw fits on a show of this size.
  const scale = { global: 1.5, major: 1, regional: 0.6, local: 0.35 }[p.tier];
  const slot = draw >= 55 * scale ? "a great main event" : draw >= 40 * scale ? "a solid main event or a strong co-main" : draw >= 26 * scale ? "a good main card fight" : "a prelim fight";
  const showKind = e.broadcast === "ppv" ? "PPV" : e.broadcast === "tv" ? "TV show" : "show";
  const history = (world.db.prepare(`SELECT b.winner_id, b.method, b.end_round, b.week, ev.name FROM bout b JOIN event ev ON ev.id = b.event_id
                                     WHERE (b.red_id = @a AND b.blue_id = @b) OR (b.red_id = @b AND b.blue_id = @a) ORDER BY b.week`).all({ a: red.id, b: blue.id }) as
    { winner_id: number | null; method: string; end_round: number; week: number; name: string }[])
    .map((h) => `At ${h.name} (${world.yearOf(h.week)}): ${h.winner_id === null ? "a draw" : `${world.nameOf(h.winner_id)} won by ${METHOD_WORDS[h.method] ?? h.method}`}`);
  const pRed = pv.redWinPct / 100;
  const ppvNet = outlets(world, p).ppv;
  return {
    preview: pv,
    draw: Math.round(draw),
    drawText: `The draw of this fight is ${level.toLowerCase()} in ${where} (${Math.round(draw)}). For a ${p.tier} ${showKind} in ${where}, this would be ${slot}.`,
    line: `Estimated betting line: ${red.name} (${moneyline(pRed)}) vs ${blue.name} (${moneyline(1 - pRed)})`,
    history: history.length ? history : ["These two have never fought."],
    ppvNote: e.broadcast === "ppv" && !ppvNet ? "No PPV outlet yet: this show would air nowhere." : null,
  };
}
