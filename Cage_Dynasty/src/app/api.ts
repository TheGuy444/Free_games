/**
 * Every command the UI can send. Electron (main.ts) exposes these over IPC;
 * the dev server (server.ts) exposes the same functions over HTTP so the game
 * can also run in a normal browser.
 */
import { STYLE_NAMES } from "../core/fighter-gen.js";
import type { DisciplineCode } from "../core/constants.js";
import { amateurAccolades, clinch, feetInches, gameSummary, ground, health, nickname, physicals, standup } from "../core/profile.js";
import { autoFillCard, bookBout, BookingError, cancelBooking, card, divisionName, moveBooking, playerEvents, previewBout, replacementOptions } from "../core/booking.js";
import { brand, cash, deals, launchOwnNetwork, launchOwnPpv, MONEY, NETWORKS, offers, outlets, ownMedia, signDeal, VENUES } from "../core/business.js";
import { CAST_PER_DIVISION, castingPool, currentSeason, startSeason } from "../core/reality.js";
import { TRAITS, type Trait } from "../core/traits.js";
import { drawLevel } from "../core/excitement.js";
import { FLAVORS, GOALS } from "../core/schedule.js";
import { alterShow, cancelShow, CARD_POSITIONS, fighterPanel, lockReplacement, matchupInfo, pickerList, placeBout, replacementInfo, showDetails, swapCorners, weekLabel, type CardPosition, type PickerSort } from "../core/matchmaking.js";
import { WEEKS_PER_YEAR, WEIGHT_CLASSES, type Sex } from "../core/constants.js";
import { narrate } from "../core/fight/narrate.js";
import { ageYears, overall, type FighterState } from "../core/model.js";
import { cutPercent } from "../core/weighin.js";
import { divisionLabel, type World } from "../core/world.js";
import { P4P } from "../core/rankings.js";
import { fightNightCard, runFightNight } from "../core/fightnight.js";
import { calloutHype, flair, flairBand, FLAIR_LABEL } from "../core/personality.js";

export function makeApi(world: World) {
  const db = world.db;
  // The app stops on the eve of each of the player's shows: watch or simulate it.
  world.holdPlayerEvents = true;
  const p = () => world.playerPromotion!;
  const fighterRow = (f: FighterState, rank: string) => ({
    id: f.id, name: f.name, rank, record: `${f.wins}-${f.losses}-${f.draws}`, overall: Math.round(overall(f.attrs)),
    rating: Math.round(f.rating), popularity: Math.round(f.popularity), age: Math.floor(ageYears(f, world.week)),
    style: f.archetype.replace(/_/g, " "), cut: Math.round(cutPercent(f) * 100), fightsLeft: f.boutsRemaining,
    status: f.status !== "active" ? f.status : f.injuredUntil !== null && f.injuredUntil > world.week ? `injured (${f.injuredUntil - world.week} wk)` :
      f.lastFightWeek !== null && world.week - f.lastFightWeek < 10 ? `resting (${10 - (world.week - f.lastFightWeek)} wk)` : "ready",
  });
  const guard = <T>(fn: () => T) => {
    try { return { ok: true as const, value: fn() }; }
    catch (e) { if (e instanceof BookingError) return { ok: false as const, error: e.message }; throw e; }
  };
  const nameOf = (id: number) => {
    const f = world.fighters.get(id);
    if (f) return f.name;
    const r = db.prepare("SELECT first_name || ' ' || last_name n FROM person WHERE id = ?").get(id) as { n: string } | undefined;
    return r?.n ?? "?";
  };

  return {
    state: () => ({
      promotion: p().name, tier: p().tier, year: world.year, week: world.week, weekOfYear: world.week % WEEKS_PER_YEAR,
      roster: p().roster.size, fightNight: world.fightNightDue(), events: playerEvents(world).filter((e) => e.status === "scheduled").map((e) => ({ ...e, weeksAway: e.week - world.week })),
    }),
    news: (limit = 40) => db.prepare("SELECT week, kind, text FROM news_item WHERE promotion_id = ? ORDER BY id DESC LIMIT ?").all(p().id, limit),
    divisions: () => WEIGHT_CLASSES.map((wc, i) => {
      const id = i + 1;
      const champ = world.championOf(p().id, id);
      const count = [...p().roster].filter((fid) => world.fighters.get(fid)?.weightClassId === id).length;
      return { id, name: divisionName(id), limitKg: wc.limitKg, champion: champ ? nameOf(champ) : null, count };
    }).filter((d) => d.count > 0),
    roster: (wcId: number) => {
      const champ = world.championOf(p().id, wcId);
      const rows = [];
      if (champ !== null && world.fighters.get(champ)) rows.push(fighterRow(world.fighters.get(champ)!, "C"));
      world.rankings(p().id, wcId).forEach((f, i) => rows.push(fighterRow(f, i < 15 ? `#${i + 1}` : "NR")));
      return rows;
    },
    events: () => playerEvents(world).map((e) => ({ ...e, weeksAway: e.week - world.week })),
    createEvent: (weeksAhead: number, name?: string, regionId?: number, broadcast?: "tv" | "ppv" | "none", venue?: string) =>
      world.scheduleEvent(Math.max(1, Math.min(52, Math.floor(weeksAhead))), name, regionId || undefined, { broadcast: broadcast || undefined, venue: venue || undefined }),
    regions: () => world.regionIds.map((id) => ({ id, name: world.regionNameOf(id), home: id === p().regionId })),
    venues: () => VENUES,
    moveBout: (bookingId: number, dir: -1 | 1) => {
      try { moveBooking(world, bookingId, dir); return { ok: true }; }
      catch (e) { if (e instanceof BookingError) return { ok: false, error: e.message }; throw e; }
    },
    business: () => {
      const me = p();
      const out = outlets(world, me);
      const recent = db.prepare(`SELECT id, name, week, region_id, broadcast, venue, attendance, gate, ppv_buys, ppv_revenue, tv_viewers, tv_revenue, sponsors, costs, profit, rating
                                 FROM event WHERE promotion_id = ? AND status = 'completed' ORDER BY week DESC LIMIT 12`).all(me.id) as Record<string, number | string | null>[];
      const season = currentSeason(world, me.id);
      const seasonCast = season ? db.prepare(`SELECT c.fighter_id, c.weight_class_id, c.status, ps.first_name || ' ' || ps.last_name AS name FROM reality_cast c JOIN person ps ON ps.id = c.fighter_id
                                              WHERE c.season_id = ? ORDER BY c.weight_class_id, c.status`).all(season.id) : [];
      const seasonBouts = season ? db.prepare("SELECT episode, stage, red_id, blue_id, winner_id, method, end_round, rating FROM reality_bout WHERE season_id = ? ORDER BY episode").all(season.id) as
        { episode: number; stage: string; red_id: number; blue_id: number; winner_id: number; method: string; end_round: number; rating: number }[] : [];
      return {
        cash: cash(world, me.id), brand: brand(world, me), media: ownMedia(world, me.id),
        tv: out.tv ? { name: out.tv.name, reach: Math.round(out.tv.reach), kind: out.tv.kind } : null,
        ppv: out.ppv ? { name: out.ppv.name, reach: Math.round(out.ppv.reach), kind: out.ppv.kind, share: out.ppv.share } : null,
        deals: deals(world, me.id).map((d) => ({ ...d, network: NETWORKS.find((n) => n.id === d.networkId)?.name, endsYear: world.yearOf(d.endWeek) })),
        offers: offers(world, me), money: MONEY,
        recent: recent.map((e) => ({ ...e, region: e.region_id ? world.regionNameOf(e.region_id as number) : "" })),
        season: season ? { ...season, cast: seasonCast, bouts: seasonBouts.map((b) => ({ ...b, red: nameOf(b.red_id), blue: nameOf(b.blue_id), winner: nameOf(b.winner_id) })) } : null,
        pastSeasons: db.prepare("SELECT name, episodes, viewers FROM reality_season WHERE promotion_id = ? AND status = 'finished' ORDER BY id DESC").all(me.id),
        castingDivisions: WEIGHT_CLASSES.map((wc, i) => ({ id: i + 1, name: divisionName(i + 1), available: castingPool(world, i + 1).length })).filter((d) => d.available >= CAST_PER_DIVISION),
      };
    },
    signDeal: (networkId: number) => { try { signDeal(world, p(), networkId); return { ok: true }; } catch (e) { return { ok: false, error: (e as Error).message }; } },
    launchNetwork: (name: string) => { try { launchOwnNetwork(world, p(), name || `${p().name} Network`); return { ok: true }; } catch (e) { return { ok: false, error: (e as Error).message }; } },
    launchPpv: () => { try { launchOwnPpv(world, p()); return { ok: true }; } catch (e) { return { ok: false, error: (e as Error).message }; } },
    startReality: (a: number, b: number) => { try { startSeason(world, [a, b]); return { ok: true }; } catch (e) { return { ok: false, error: (e as Error).message }; } },
    /** All-time records, worldwide or for your promotion. */
    records: (scope: "world" | "mine" = "world") => {
      const where = scope === "mine" ? `e.promotion_id = ${p().id}` : "1=1";
      const ev = (order: string, col: string, min = "") => db.prepare(`SELECT e.id, e.name, e.week, ${col} AS value, pr.name AS promotion FROM event e JOIN promotion pr ON pr.id = e.promotion_id
                                          WHERE ${where} AND ${col} IS NOT NULL ${min} ORDER BY ${col} ${order} LIMIT 5`).all() as { id: number; name: string; week: number; value: number; promotion: string }[];
      const fights = (order: string) => db.prepare(`SELECT b.id, b.red_id, b.blue_id, b.method, b.end_round, b.rating AS value, e.name AS event, e.week FROM bout b JOIN event e ON e.id = b.event_id
                                          WHERE ${where} AND b.rating IS NOT NULL AND b.fidelity != 'light' ORDER BY b.rating ${order} LIMIT 5`).all() as { id: number; red_id: number; blue_id: number; method: string; end_round: number; value: number; event: string; week: number }[];
      const fotn = db.prepare(`SELECT b.fid AS id, ps.first_name || ' ' || ps.last_name AS name, COUNT(*) AS value FROM
                                 (SELECT red_id AS fid, event_id FROM bout WHERE fotn = 1 UNION ALL SELECT blue_id, event_id FROM bout WHERE fotn = 1) b
                               JOIN event e ON e.id = b.event_id JOIN person ps ON ps.id = b.fid WHERE ${where} GROUP BY b.fid ORDER BY value DESC LIMIT 5`).all();
      const yr = <T extends { week: number }>(xs: T[]) => xs.map((x) => ({ ...x, year: world.yearOf(x.week) }));
      const named = (xs: ReturnType<typeof fights>) => yr(xs).map((b) => ({ ...b, fight: `${nameOf(b.red_id)} vs ${nameOf(b.blue_id)}` }));
      return {
        highestGate: yr(ev("DESC", "e.gate")), highestPpv: yr(ev("DESC", "e.ppv_buys", "AND e.ppv_buys > 0")), mostAttended: yr(ev("DESC", "e.attendance")),
        bestCard: yr(ev("DESC", "e.rating")), worstCard: yr(ev("ASC", "e.rating", "AND (SELECT COUNT(*) FROM bout x WHERE x.event_id = e.id) >= 5")),
        bestFight: named(fights("DESC")), worstFight: named(fights("ASC")), mostFotn: fotn,
      };
    },
    card: (eventId: number) => {
      const rows = card(world, eventId);
      const bouts = db.prepare(`SELECT b.id, b.method, b.end_round, b.end_time_s, b.winner_id, b.title_id, b.catchweight, b.rating, b.fotn,
                                  EXISTS (SELECT 1 FROM bout_log l WHERE l.bout_id = b.id) AS has_log
                                FROM bout b WHERE b.id = ?`);
      const moments = db.prepare("SELECT fighter_id, kind, target_id, text FROM post_fight_moment WHERE bout_id = ?");
      const weighIns = db.prepare("SELECT fighter_id, weight_kg, limit_kg, outcome, fine FROM weigh_in WHERE event_id = ?").all(eventId) as
        { fighter_id: number; weight_kg: number; limit_kg: number; outcome: string; fine: number }[];
      return rows.map((r) => {
        const boutId = (db.prepare("SELECT bout_id FROM booking WHERE id = ?").get(r.id) as { bout_id: number | null }).bout_id;
        const b = boutId ? bouts.get(boutId) as { id: number; method: string; end_round: number; end_time_s: number; winner_id: number | null; title_id: number | null; catchweight: number; has_log: number; rating: number | null; fotn: number } : null;
        return {
          id: r.id, order: r.order, red: nameOf(r.redId), blue: nameOf(r.blueId), redId: r.redId, blueId: r.blueId, rounds: r.rounds,
          title: r.titleId !== null, status: r.status, reason: r.cancelReason, division: divisionName((r.red ?? r.blue)?.weightClassId ?? 1),
          result: b ? { boutId: b.id, winner: b.winner_id ? nameOf(b.winner_id) : "Draw", method: b.method, round: b.end_round, catchweight: !!b.catchweight, hasLog: !!b.has_log, rating: b.rating, fotn: !!b.fotn } : null,
          moments: b ? (moments.all(b.id) as { fighter_id: number; kind: string; target_id: number | null; text: string }[]).map((m) => ({ who: nameOf(m.fighter_id), kind: m.kind, target: m.target_id ? nameOf(m.target_id) : null, targetId: m.target_id, fighterId: m.fighter_id, text: m.text })) : [],
          weighIns: weighIns.filter((w) => w.fighter_id === r.redId || w.fighter_id === r.blueId).map((w) => ({ who: nameOf(w.fighter_id), ...w })),
        };
      });
    },
    eventInfo: (eventId: number) => {
      const e = db.prepare(`SELECT id, name, week, status, region_id, broadcast, venue, attendance, gate, ppv_buys, ppv_revenue, tv_viewers, tv_revenue, sponsors, costs, profit, rating
                            FROM event WHERE id = ?`).get(eventId) as Record<string, number | string | null> | undefined;
      return e ? { ...e, region: e.region_id ? world.regionNameOf(e.region_id as number) : null } : null;
    },
    preview: (eventId: number, redId: number, blueId: number, title: boolean) => previewBout(world, eventId, redId, blueId, title),
    book: (eventId: number, redId: number, blueId: number, title: boolean, rounds: number) => {
      try { return { ok: true, id: bookBout(world, eventId, redId, blueId, { title, rounds }) }; }
      catch (e) { if (e instanceof BookingError) return { ok: false, error: e.message }; throw e; }
    },
    cancel: (bookingId: number) => { cancelBooking(world, bookingId); return true; },
    // Booking desk (shows screen and Add bout screen).
    shows: () => playerEvents(world).filter((e) => e.status === "scheduled").sort((a, b) => a.week - b.week).map((e) => showDetails(world, e.id)),
    pastShows: () => playerEvents(world).filter((e) => e.status === "completed").slice(0, 12).map((e) => ({ id: e.id, name: e.name, date: weekLabel(world, e.week) })),
    showDetails: (eventId: number) => showDetails(world, eventId),
    alterShow: (eventId: number, changes: { name?: string; weeksAhead?: number; regionId?: number; broadcast?: string; venue?: string | null }) => guard(() => alterShow(world, eventId, changes)),
    cancelShow: (eventId: number) => guard(() => cancelShow(world, eventId)),
    placeBout: (bookingId: number, pos: CardPosition) => guard(() => placeBout(world, bookingId, pos)),
    swapCorners: (bookingId: number) => guard(() => swapCorners(world, bookingId)),
    cardPositions: () => CARD_POSITIONS,
    dropOff: (bookingId: number) => { db.prepare("UPDATE booking SET cancel_reason = 'cancelled by the promotion' WHERE id = ? AND status = 'cancelled'").run(bookingId); return true; },
    replacementInfo: (bookingId: number) => guard(() => replacementInfo(world, bookingId)),
    lockReplacement: (bookingId: number, newId: number) => guard(() => lockReplacement(world, bookingId, newId)),
    picker: (eventId: number, wcId: number, sort: PickerSort, search: string, nearby: boolean) => pickerList(world, eventId, wcId, sort, search, nearby),
    fighterPanel: (fighterId: number, eventId: number) => fighterPanel(world, fighterId, eventId),
    matchup: (eventId: number, redId: number, blueId: number, title: boolean) => matchupInfo(world, eventId, redId, blueId, title),
    titleFor: (wcId: number) => {
      const t = world.title(p().id, wcId);
      return { id: t.id, label: `${p().name} ${divisionLabel(wcId)} title`, champion: t.champion !== null ? nameOf(t.champion) : null };
    },
    bookAt: (eventId: number, redId: number, blueId: number, title: boolean, rounds: number, pos: CardPosition) => guard(() => {
      const id = bookBout(world, eventId, redId, blueId, { title, rounds });
      try { placeBout(world, id, pos); } catch (e) { if (!(e instanceof BookingError)) throw e; placeBout(world, id, "main_card"); }
      return id;
    }),
    vacateTitle: (titleId: number) => world.vacateByChoice(titleId),
    /** scope: "global", or a promotion id (defaults to yours). */
    hallOfFame: (scope: "global" | number = p().id) => {
      const sc = scope === "global" ? 0 : scope;
      const rows = db.prepare(`SELECT h.fighter_id, h.week, h.score, h.citation, ps.first_name || ' ' || ps.last_name AS name, ps.nickname, ps.sex,
                                      f.wins, f.losses, f.draws, f.weight_class_id
                               FROM hall_of_fame h JOIN person ps ON ps.id = h.fighter_id JOIN fighter f ON f.person_id = h.fighter_id
                               WHERE h.scope = ? ORDER BY h.week DESC, h.score DESC`).all(sc) as
        { fighter_id: number; week: number; score: number; citation: string; name: string; nickname: string | null; sex: string; wins: number; losses: number; draws: number; weight_class_id: number }[];
      return rows.map((r) => ({ ...r, year: world.yearOf(r.week), division: divisionName(r.weight_class_id), promotionId: sc || null,
        nickname: r.nickname ?? nickname(r.fighter_id, "all_rounder", 50) }));
    },
    hallScopes: () => [{ id: "global", name: "MMA Hall of Fame (all promotions)" }, ...(db.prepare(`SELECT DISTINCT p.id, p.name FROM hall_of_fame h JOIN promotion p ON p.id = h.scope
                        ORDER BY CASE WHEN p.id = ? THEN 0 ELSE 1 END, p.name`).all(p().id) as { id: number; name: string }[]).map((x) => ({ id: x.id, name: `${x.name} Hall of Fame` }))],
    autofill: (eventId: number) => autoFillCard(world, eventId, 10),
    replacements: (eventId: number, opponentId: number) => replacementOptions(world, eventId, opponentId).map((f) => fighterRow(f, world.rankOf(f) ? `#${world.rankOf(f)}` : "NR")),
    advance: (weeks: number) => {
      world.advance(Math.max(1, Math.min(52 * 5, Math.floor(weeks))));
      world.flush();
      return world.week;
    },
    advanceToNextEvent: () => {
      const next = playerEvents(world).filter((e) => e.status === "scheduled").sort((a, b) => a.week - b.week)[0];
      const weeks = next ? next.week - world.week : 1;
      const held = world.advance(Math.max(1, weeks));
      world.flush();
      return held ?? next?.id ?? null;
    },
    fightNight: () => { const id = world.fightNightDue(); return id === null ? null : fightNightCard(world, id); },
    runFightNight: (eventId: number) => runFightNight(world, eventId),
    featuredBouts: () => db.prepare(`SELECT b.id, e.name AS event, b.method, b.end_round AS round,
                     rp.first_name || ' ' || rp.last_name AS red, bp.first_name || ' ' || bp.last_name AS blue,
                     CASE WHEN b.winner_id = b.red_id THEN 'red' WHEN b.winner_id = b.blue_id THEN 'blue' ELSE 'draw' END AS winner
                   FROM bout b JOIN bout_log l ON l.bout_id = b.id JOIN event e ON e.id = b.event_id
                   JOIN person rp ON rp.id = b.red_id JOIN person bp ON bp.id = b.blue_id
                   ORDER BY (e.promotion_id = ?) DESC, b.id DESC LIMIT 40`).all(p().id),
    playByPlay: (boutId: number) => {
      const b = db.prepare(`SELECT b.rng_seed AS seed, b.method, b.end_round, b.end_time_s,
                              rp.first_name || ' ' || rp.last_name AS red, rp.sex AS rsex, bp.first_name || ' ' || bp.last_name AS blue, bp.sex AS bsex
                            FROM bout b JOIN person rp ON rp.id = b.red_id JOIN person bp ON bp.id = b.blue_id WHERE b.id = ?`).get(boutId) as
        { seed: number; method: string; end_round: number; end_time_s: number; red: string; blue: string; rsex: Sex; bsex: Sex } | undefined;
      const log = world.repo.getBoutLog(boutId);
      if (!b || !log) return null;
      const result = { winner: null, method: b.method as never, endRound: b.end_round, endTimeS: b.end_time_s, seed: b.seed, events: log.events, stats: [], cards: log.cards };
      return { red: b.red, blue: b.blue, lines: narrate(result, [b.red, b.blue], [b.rsex, b.bsex]) };
    },
    /** scope: "world" or a promotion id. list: 0 = pound-for-pound, otherwise a weight class id. */
    rankings: (scope: "world" | number, list: number) => {
      const promoName = (f: FighterState) => (f.promotionId ? world.promotion(f.promotionId)?.name ?? "" : "free agent");
      const row = (f: FighterState, rank: string, prev: number | null, score: number) => {
        const t = world.isChampion(f.id);
        const tp = t ? world.promotion(t.promotionId) : undefined;
        return {
          id: f.id, rank, prev, score, name: f.name, division: divisionLabel(f.weightClassId), promotion: promoName(f),
          record: `${f.wins}-${f.losses}${f.draws ? `-${f.draws}` : ""}`, belt: t && tp ? `${tp.name} ${divisionLabel(t.weightClassId)} champion` : null,
        };
      };
      if (scope === "world") return world.ranks.worldList(list).map((r) => row(r.fighter, String(r.rank), r.prev, r.score));
      const out = [];
      if (list !== P4P) {
        const champ = world.championOf(scope, list);
        const f = champ !== null ? world.fighters.get(champ) : undefined;
        if (f) out.push(row(f, "C", null, Math.round(world.ranks.score(f))));
      }
      for (const r of world.ranks.companyList(scope, list)) out.push(row(r.fighter, String(r.rank), r.prev, r.score));
      return out;
    },
    fighterProfile: (id: number) => {
      const f = world.fighters.get(id);
      if (!f) return null;
      const r = world.ranks.ranksOf(f);
      const t = world.isChampion(f.id);
      const promo = f.promotionId ? world.promotion(f.promotionId) : undefined;
      const recent = db.prepare(`SELECT b.week, b.method, b.end_round, b.winner_id, b.red_id, b.blue_id, b.title_id, e.name AS event
                                 FROM bout b JOIN event e ON e.id = b.event_id WHERE b.red_id = @id
                                 UNION ALL SELECT b.week, b.method, b.end_round, b.winner_id, b.red_id, b.blue_id, b.title_id, e.name
                                 FROM bout b JOIN event e ON e.id = b.event_id WHERE b.blue_id = @id ORDER BY 1 DESC LIMIT 8`).all({ id }) as
        { week: number; method: string; end_round: number; winner_id: number | null; red_id: number; blue_id: number; title_id: number | null; event: string }[];
      const div = divisionLabel(f.weightClassId);
      return {
        id: f.id, name: f.name, age: Math.floor(ageYears(f, world.week)), record: `${f.wins}-${f.losses}-${f.draws}`,
        division: div, promotion: promo?.name ?? "free agent", style: f.archetype.replace(/_/g, " "), popularity: Math.round(f.popularity),
        flair: flair(f), flairLabel: FLAIR_LABEL[flairBand(flair(f))], calloutHype: calloutHype(flair(f)),
        overall: Math.round(overall(f.attrs)), streak: f.winStreak ? `W${f.winStreak}` : f.lossStreak ? `L${f.lossStreak}` : "-",
        belt: t ? world.titlesOf(f.id).map((x) => `${world.promotion(x.promotionId)?.name} ${divisionLabel(x.weightClassId)} champion (${x.defenses} defense${x.defenses === 1 ? "" : "s"})`).join(" · ") : null,
        belts: world.titlesOf(f.id).map((x) => ({ titleId: x.id, label: `${divisionLabel(x.weightClassId)}`, mine: x.promotionId === p().id,
          defendBy: world.titlesOf(f.id).length > 1 ? world.yearOf(world.defenseDue(x)) + ", week " + ((world.defenseDue(x) % 52) + 1) : null })),
        ranks: [
          { label: "Pound-for-pound, worldwide", value: r.worldP4P },
          { label: `${div}, worldwide`, value: r.worldDivision },
          { label: `Pound-for-pound, ${promo?.name ?? "company"}`, value: r.companyP4P },
          { label: `${div}, ${promo?.name ?? "company"}`, value: r.companyDivision === 0 ? "C" : r.companyDivision },
        ],
        general: (() => {
          const ph = physicals(f.id, f.sex, f.weightClassId);
          const person = db.prepare("SELECT nickname, birth_week FROM person WHERE id = ?").get(f.id) as { nickname: string | null; birth_week: number };
          const disc = db.prepare(`SELECT d.code, d.name, fd.level FROM fighter_discipline fd JOIN discipline d ON d.id = fd.discipline_id
                                   WHERE fd.person_id = ? ORDER BY fd.level DESC`).all(f.id) as { code: string; name: string; level: number }[];
          const birthYear = world.yearOf(person.birth_week);
          const reigns = db.prepare(`SELECT pr.name AS promotion, t.weight_class_id AS wc, r.start_week, r.end_week, r.defenses, r.end_reason
                                     FROM title_reign r JOIN title t ON t.id = r.title_id JOIN promotion pr ON pr.id = t.promotion_id
                                     WHERE r.fighter_id = ? ORDER BY r.start_week`).all(f.id) as { promotion: string; wc: number; start_week: number; end_week: number | null; defenses: number; end_reason: string | null }[];
          const yr = (w: number) => world.yearOf(w);
          const peak = db.prepare("SELECT MIN(rank) r FROM ranking_snapshot WHERE fighter_id = ? AND scope = 0 AND list = 0").get(f.id) as { r: number | null };
          const pro = reigns.map((x) => `${x.end_week === null ? "" : "Former "}${x.promotion} ${divisionLabel(x.wc).toLowerCase()} champion (${yr(x.start_week)}${x.end_week === null ? "-present" : yr(x.end_week) !== yr(x.start_week) ? `-${yr(x.end_week)}` : ""}${x.defenses ? `, ${x.defenses} defense${x.defenses === 1 ? "" : "s"}` : ""})`);
          if (peak.r !== null) pro.push(`Peak pound-for-pound rank: #${peak.r} worldwide`);
          if (f.winStreak >= 5) pro.push(`On a ${f.winStreak}-fight win streak`);
          const finishes = f.koWins + f.subWins;
          return {
            nickname: person.nickname ?? nickname(f.id, f.archetype, f.attrs.charisma),
            born: (() => {
              const wk = ((person.birth_week % 52) + 52) % 52;
              const d = new Date(Date.UTC(birthYear, 0, 1 + wk * 7 + (f.id % 7)));
              return `${d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })} (age ${Math.floor(ageYears(f, world.week))})`;
            })(), from: world.regionName(f), height: `${feetInches(ph.heightCm)} (${ph.heightCm} cm)`,
            reach: `${Math.round(ph.reachCm / 2.54)}" (${ph.reachCm} cm)`, stance: ph.stance, sex: f.sex,
            weight: `${divisionLabel(f.weightClassId)}, walks around ${Math.round(f.walkKg)} kg`,
            base: disc.slice(0, 2).map((d) => d.name).join(", "),
            style: (() => {
              const b = db.prepare("SELECT d.code FROM fighter f JOIN discipline d ON d.id = f.base_discipline WHERE f.person_id = ?").get(f.id) as { code: DisciplineCode } | undefined;
              return b ? STYLE_NAMES[b.code] : "MMA";
            })(),
            finishes: `${f.koWins} KO/TKO, ${f.subWins} submissions, ${f.wins - finishes} decisions`,
            amateur: amateurAccolades(f.id, birthYear, f.sex, disc),
            traits: f.traits.map((t) => ({ key: t, ...TRAITS[t as Trait] })),
            regionPop: world.regionIds.map((r) => ({ region: world.regionNameOf(r), pop: Math.round(f.regionPop[r] ?? 0), level: drawLevel(f.regionPop[r] ?? 0), home: r === f.regionId }))
              .sort((a, b) => b.pop - a.pop),
            fotn: (db.prepare("SELECT fotn FROM fighter WHERE person_id = ?").get(f.id) as { fotn: number }).fotn,
            reality: (db.prepare(`SELECT s.name, c.status FROM reality_cast c JOIN reality_season s ON s.id = c.season_id WHERE c.fighter_id = ? AND c.status IN ('winner','finalist')`).all(f.id) as { name: string; status: string }[])
              .map((x) => `${x.status === "winner" ? "Winner" : "Finalist"}, ${x.name}`),
            pro,
          };
        })(),
        health: health(f.damage, f.wear, f.attrs.chin, f.injuredUntil !== null && f.injuredUntil > world.week ? f.injuredUntil - world.week : 0),
        standup: standup(f.attrs),
        clinch: clinch(f.attrs),
        ground: ground(f.attrs),
        gameSummary: gameSummary(f.attrs),
        promotionId: f.promotionId, tier: promo?.tier ?? null,
        recent: recent.map((b) => {
          const opp = b.red_id === id ? b.blue_id : b.red_id;
          return { week: b.week, event: b.event, opponent: nameOf(opp), result: b.winner_id === null ? "D" : b.winner_id === id ? "W" : "L", method: b.method, round: b.end_round, title: b.title_id !== null };
        }),
      };
    },
    /** scope: "mine" (your promotion), "world" (everyone else), or "all". */
    newsFeed: (scope: "mine" | "world" | "all", kind = "all", minImportance = 1, limit = 80) => {
      const mine = p().id;
      const where = [scope === "mine" ? "promotion_id = @mine" : scope === "world" ? "(promotion_id IS NULL OR promotion_id != @mine)" : "1=1",
        kind === "all" ? "1=1" : "kind = @kind", "importance >= @imp"].join(" AND ");
      return db.prepare(`SELECT n.week, n.kind, n.text, n.importance, n.fighter_id, pr.name AS promotion FROM news_item n
                         LEFT JOIN promotion pr ON pr.id = n.promotion_id WHERE ${where} ORDER BY n.id DESC LIMIT @limit`)
        .all({ mine, kind, imp: minImportance, limit: Math.min(300, limit) });
    },
    /**
     * The newspaper front page: the lead story, two shorter stories, then briefs.
     * Picks from the last 4 weeks, by importance then recency, one story per fighter.
     */
    newsFront: (scope: "mine" | "world" | "all") => {
      const mine = p().id;
      const where = scope === "mine" ? "n.promotion_id = @mine" : scope === "world" ? "(n.promotion_id IS NULL OR n.promotion_id != @mine)" : "1=1";
      const rows = db.prepare(`SELECT n.id, n.week, n.kind, n.headline, n.story, n.importance, n.fighter_id, n.promotion_id,
                                      pr.name AS promotion, pr.tier, ps.sex, ps.first_name || ' ' || ps.last_name AS fname
                               FROM news_item n LEFT JOIN promotion pr ON pr.id = n.promotion_id LEFT JOIN person ps ON ps.id = n.fighter_id
                               WHERE n.story IS NOT NULL AND n.week > @since AND ${where}
                               ORDER BY n.importance DESC, n.week DESC, n.id ASC LIMIT 200`)
        .all({ mine, since: world.week - 4 }) as { fighter_id: number | null; kind: string; importance: number; week: number }[];
      // Results outrank a same-week title note about the same fighter, so drop repeats by fighter.
      const seen = new Set<number>();
      const picked = rows.filter((r) => {
        if (r.fighter_id === null) return true;
        if (seen.has(r.fighter_id)) return false;
        seen.add(r.fighter_id);
        return true;
      });
      return { lead: picked[0] ?? null, second: picked.slice(1, 3), briefs: picked.slice(3, 9) };
    },
    promotions: () => {
      const rows = db.prepare(`SELECT p.id, p.name, p.tier, p.cash, COALESCE(r.name, 'World') AS region,
                     (SELECT COUNT(*) FROM contract c WHERE c.promotion_id = p.id AND c.end_week IS NULL) AS roster,
                     (SELECT COUNT(*) FROM event e WHERE e.promotion_id = p.id AND e.status = 'completed') AS events
                   FROM promotion p LEFT JOIN region r ON r.id = p.region_id
                   ORDER BY CASE p.tier WHEN 'global' THEN 0 WHEN 'major' THEN 1 WHEN 'regional' THEN 2 ELSE 3 END, p.name`).all() as
        { id: number; name: string; tier: string; cash: number; region: string; roster: number; events: number }[];
      const woy = world.week % WEEKS_PER_YEAR;
      const net = (id: number | null) => NETWORKS.find((n) => n.id === id)?.name ?? null;
      return rows.map((r) => {
        const ps = world.promotion(r.id);
        const plan = ps?.plan;
        const kinds = [...(ps?.cardKinds ?? new Map()).entries()];
        const count = (k: string) => kinds.filter(([, x]) => x === k).length;
        const ahead = kinds.map(([w, k]) => [(w - woy + WEEKS_PER_YEAR) % WEEKS_PER_YEAR, k] as const).filter(([d]) => d > 0).sort((a, b) => a[0] - b[0])[0];
        return {
          ...r, mine: r.id === world.playerPromotionId,
          flavor: plan ? FLAVORS[plan.flavor].label : null, flavorBlurb: plan ? FLAVORS[plan.flavor].blurb : null,
          goal: plan ? GOALS[plan.goal].label : null, goalBlurb: plan ? GOALS[plan.goal].blurb : null,
          tv: plan ? (net(plan.tvNetworkId) ?? (plan.flavor === "own_network" ? "Own network" : count("tv") ? "Local TV" : null)) : null,
          ppv: plan ? net(plan.ppvNetworkId) : null,
          calendar: plan ? { ppv: count("ppv"), tv: count("tv"), none: count("none") } : null,
          next: ahead ? { inWeeks: ahead[0], kind: ahead[1] } : null,
        };
      });
    },
    topFighters: (limit: number) => [...world.fighters.values()].filter((f) => f.status === "active")
      .sort((a, b) => b.rating - a.rating).slice(0, Math.min(200, limit))
      .map((f) => ({ id: f.id, name: f.name, division: divisionName(f.weightClassId), promotion: f.promotionId ? world.promotion(f.promotionId)?.name ?? "" : "free agent", record: `${f.wins}-${f.losses}-${f.draws}`, rating: Math.round(f.rating) })),
  };
}

export type Api = ReturnType<typeof makeApi>;
