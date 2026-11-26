import { gunzipSync, gzipSync } from "node:zlib";
import type { DB } from "./db.js";
import type { FightEvent, RoundStats } from "../core/fight/types.js";
import type { FighterState, PromotionState } from "../core/model.js";
import type { WeighInResult } from "../core/weighin.js";
import type { Moment } from "../core/postfight.js";
import { ATTR_KEYS, ratings } from "../core/model.js";
import { encodeSchedule } from "../core/schedule.js";

const weeksText = (p: PromotionState) => p.cardKinds ? encodeSchedule(p.cardKinds) : [...p.eventWeeks].join(",");

/** Attributes that never change after generation (personality and potential). */
const UNCHANGING = new Set<string>(["aggression", "heart", "charisma", "mic_skill", "professionalism", "potential"]);

/**
 * All SQL lives here. The sim core calls these functions and never writes SQL
 * itself, which keeps a later move to Postgres (or Kysely) contained to this file.
 */
export function makeRepo(db: DB) {
  const s = {
    world: db.prepare("INSERT INTO world (id, seed, start_year, current_week, created_at) VALUES (1, ?, ?, 0, ?)"),
    setWeek: db.prepare("UPDATE world SET current_week = ? WHERE id = 1"),
    region: db.prepare("INSERT INTO region (id, code, name, flavor) VALUES (?, ?, ?, ?)"),
    wc: db.prepare("INSERT INTO weight_class (id, code, name, sex, limit_kg) VALUES (?, ?, ?, ?, ?)"),
    discipline: db.prepare("INSERT INTO discipline (id, code, name) VALUES (?, ?, ?)"),
    person: db.prepare("INSERT INTO person (id, first_name, last_name, sex, birth_week, region_id) VALUES (?, ?, ?, ?, ?, ?)"),
    fighter: db.prepare(`INSERT INTO fighter (person_id, weight_class_id, walk_weight_kg, archetype, base_discipline, status)
                         VALUES (?, ?, ?, ?, ?, ?)`),
    attrs: db.prepare(`INSERT INTO fighter_attributes (person_id, ${ATTR_KEYS.join(", ")}) VALUES (@person_id, ${ATTR_KEYS.map((k) => "@" + k).join(", ")})`),
    updAttrs: db.prepare(`UPDATE fighter_attributes SET ${ATTR_KEYS.filter((k) => !UNCHANGING.has(k)).map((k) => `${k}=@${k}`).join(", ")} WHERE person_id=@person_id`),
    attrHist: db.prepare("INSERT OR REPLACE INTO fighter_attr_history VALUES (?, ?, ?, ?, ?, ?)"),
    fDisc: db.prepare("INSERT INTO fighter_discipline VALUES (?, ?, ?)"),
    updFighter: db.prepare(`UPDATE fighter SET status=?, pro_debut_week=?, retired_week=?, wins=?, losses=?, draws=?,
                         ko_wins=?, sub_wins=?, rating=?, damage_total=?, last_fight_week=?, weight_class_id=?,
                         walk_weight_kg=?, popularity=?, loss_streak=?, injured_until=?, missed_weight=?, win_streak=?, wear_body=?, wear_arms=?, wear_legs=?, traits=?, pop_regions=? WHERE person_id=?`),
    boutRating: db.prepare("UPDATE bout SET rating = ?, segment = ? WHERE id = ?"),
    eventRating: db.prepare("UPDATE event SET rating = ? WHERE id = ?"),
    fotnBout: db.prepare("UPDATE bout SET fotn = 1 WHERE id = ?"),
    fotnFighter: db.prepare("UPDATE fighter SET fotn = fotn + 1 WHERE person_id = ?"),
    rankRow: db.prepare("INSERT OR REPLACE INTO ranking_snapshot VALUES (?, ?, ?, ?, ?, ?)"),
    updContractLeft: db.prepare("UPDATE contract SET bouts_remaining = ? WHERE id = ?"),
    setPlayer: db.prepare("UPDATE world SET player_promotion_id = ? WHERE id = 1"),
    promoWeeks: db.prepare("UPDATE promotion SET event_weeks = ? WHERE id = ?"),
    promoPlan: db.prepare("UPDATE promotion SET flavor = ?, goal = ?, tv_network_id = ?, ppv_network_id = ? WHERE id = ?"),
    schedEvent: db.prepare("INSERT INTO event (id, promotion_id, week, name, status, region_id) VALUES (?, ?, ?, ?, 'scheduled', ?)"),
    eventStatus: db.prepare("UPDATE event SET status = ? WHERE id = ?"),
    booking: db.prepare(`INSERT INTO booking (event_id, card_order, red_id, blue_id, weight_class_id, rounds, title_id, booked_week)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    bookingStatus: db.prepare("UPDATE booking SET status = ?, cancel_reason = ?, bout_id = ? WHERE id = ?"),
    weighIn: db.prepare("INSERT INTO weigh_in (event_id, fighter_id, week, limit_kg, weight_kg, outcome, fine) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    title: db.prepare("INSERT INTO title (promotion_id, weight_class_id) VALUES (?, ?)"),
    reign: db.prepare("INSERT INTO title_reign (title_id, fighter_id, start_week) VALUES (?, ?, ?)"),
    endReign: db.prepare("UPDATE title_reign SET end_week = ?, end_reason = ?, defenses = ? WHERE id = ?"),
    defense: db.prepare("UPDATE title_reign SET defenses = ? WHERE id = ?"),
    boutTitle: db.prepare("UPDATE bout SET title_id = ?, catchweight = ? WHERE id = ?"),
    moment: db.prepare("INSERT INTO post_fight_moment (bout_id, week, fighter_id, kind, target_id, text) VALUES (?, ?, ?, ?, ?, ?)"),
    news: db.prepare("INSERT INTO news_item (week, promotion_id, kind, text, fighter_id, importance, headline, story) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
    promotion: db.prepare("INSERT INTO promotion (id, name, region_id, tier, founded_week) VALUES (?, ?, ?, ?, ?)"),
    tierHist: db.prepare("INSERT INTO promotion_tier_history VALUES (?, ?, ?)"),
    contract: db.prepare(`INSERT INTO contract (id, fighter_id, promotion_id, kind, start_week, bouts_total, bouts_remaining, purse, win_bonus)
                         VALUES (?, ?, ?, 'exclusive', ?, ?, ?, ?, ?)`),
    endContract: db.prepare("UPDATE contract SET end_week = ?, bouts_remaining = ? WHERE id = ?"),
    event: db.prepare("INSERT INTO event (id, promotion_id, week, name, region_id) VALUES (?, ?, ?, ?, ?)"),
    bout: db.prepare(`INSERT INTO bout (event_id, week, card_order, weight_class_id, red_id, blue_id, scheduled_rounds,
                         winner_id, method, end_round, end_time_s, rng_seed, fidelity) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    boutLog: db.prepare("INSERT INTO bout_log (bout_id, events) VALUES (?, ?)"),
    roundStats: db.prepare("INSERT INTO bout_round_stats VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
    getLog: db.prepare("SELECT events FROM bout_log WHERE bout_id = ?"),
  };

  return {
    tx: <T>(fn: () => T) => db.transaction(fn)(),
    insertWorld: (seed: number, startYear: number) => s.world.run(seed, startYear, new Date().toISOString()),
    setWeek: (week: number) => s.setWeek.run(week),
    insertRegion: (id: number, code: string, name: string, flavor: string) => s.region.run(id, code, name, flavor),
    insertWeightClass: (id: number, code: string, name: string, sex: string, limit: number) => s.wc.run(id, code, name, sex, limit),
    insertDiscipline: (id: number, code: string, name: string) => s.discipline.run(id, code, name),
    insertFighter(f: FighterState, first: string, last: string, disciplineId: number, disciplineLevel: number) {
      s.person.run(f.id, first, last, f.sex, f.birthWeek, f.regionId);
      s.fighter.run(f.id, f.weightClassId, f.walkKg, f.archetype, disciplineId, f.status);
      s.attrs.run({ person_id: f.id, ...f.attrs });
      s.fDisc.run(f.id, disciplineId, disciplineLevel);
    },
    saveFighter(f: FighterState) {
      s.updFighter.run(f.status, f.debutWeek, f.retiredWeek, f.wins, f.losses, f.draws, f.koWins, f.subWins,
        f.rating, f.damage, f.lastFightWeek, f.weightClassId, f.walkKg, f.popularity, f.lossStreak, f.injuredUntil, f.missedWeight, f.winStreak, f.wear.body, f.wear.arms, f.wear.legs, f.traits.join(","), JSON.stringify(f.regionPop), f.id);
      if (f.contractId !== null) s.updContractLeft.run(f.boutsRemaining, f.contractId);
    },
    saveAttrs(f: FighterState, year: number) {
      s.updAttrs.run({ person_id: f.id, ...f.attrs });
      const r = ratings(f.attrs);
      s.attrHist.run(f.id, year, Math.round(r.overall), Math.round(r.striking), Math.round(r.grappling), Math.round(r.physical));
    },
    insertPromotion(p: PromotionState, week: number) {
      s.promotion.run(p.id, p.name, p.regionId, p.tier, week);
      s.tierHist.run(p.id, week, p.tier);
      s.promoWeeks.run(weeksText(p), p.id);
      if (p.plan) s.promoPlan.run(p.plan.flavor, p.plan.goal, p.plan.tvNetworkId, p.plan.ppvNetworkId, p.id);
    },
    setPromotionWeeks: (p: PromotionState) => s.promoWeeks.run(weeksText(p), p.id),
    setPlayerPromotion: (id: number) => s.setPlayer.run(id),
    scheduleEvent: (id: number, promotionId: number, week: number, name: string, regionId: number | null) => s.schedEvent.run(id, promotionId, week, name, regionId),
    setEventStatus: (id: number, status: string) => s.eventStatus.run(status, id),
    insertBooking: (eventId: number, order: number, redId: number, blueId: number, wcId: number, rounds: number, titleId: number | null, week: number) =>
      Number(s.booking.run(eventId, order, redId, blueId, wcId, rounds, titleId, week).lastInsertRowid),
    setBookingStatus: (id: number, status: string, reason: string | null, boutId: number | null) => s.bookingStatus.run(status, reason, boutId, id),
    insertWeighIn: (eventId: number, week: number, w: WeighInResult, fine: number) =>
      s.weighIn.run(eventId, w.fighterId, week, w.limitKg, w.weightKg, w.outcome, fine),
    insertTitle: (promotionId: number, wcId: number) => Number(s.title.run(promotionId, wcId).lastInsertRowid),
    startReign: (titleId: number, fighterId: number, week: number) => Number(s.reign.run(titleId, fighterId, week).lastInsertRowid),
    endReign: (reignId: number, week: number, reason: string, defenses: number) => s.endReign.run(week, reason, defenses, reignId),
    setDefenses: (reignId: number, defenses: number) => s.defense.run(defenses, reignId),
    setBoutTitle: (boutId: number, titleId: number | null, catchweight: boolean) => s.boutTitle.run(titleId, catchweight ? 1 : 0, boutId),
    insertMoment: (boutId: number, week: number, m: Moment) => s.moment.run(boutId, week, m.fighterId, m.kind, m.targetId, m.text),
    setBoutRating: (boutId: number, rating: number, segment: string) => s.boutRating.run(rating, segment, boutId),
    setEventRating: (eventId: number, rating: number) => s.eventRating.run(rating, eventId),
    markFotn: (boutId: number, a: number, b: number) => { s.fotnBout.run(boutId); s.fotnFighter.run(a); s.fotnFighter.run(b); },
    news: (week: number, promotionId: number | null, kind: string, text: string, fighterId: number | null = null, importance = 1,
           headline: string | null = null, story: string | null = null) =>
      s.news.run(week, promotionId, kind, text, fighterId, importance, headline, story),
    insertRankings: (rows: [number, number, number, number, number, number][]) => { for (const r of rows) s.rankRow.run(...r); },
    insertContract: (id: number, fighterId: number, promotionId: number, week: number, bouts: number, purse: number) =>
      s.contract.run(id, fighterId, promotionId, week, bouts, bouts, purse, purse),
    endContract: (id: number, week: number, remaining: number) => s.endContract.run(week, remaining, id),
    insertEvent: (id: number, promotionId: number, week: number, name: string, regionId: number | null = null) => s.event.run(id, promotionId, week, name, regionId),
    insertBout: (eventId: number, week: number, order: number, wcId: number, redId: number, blueId: number, rounds: number,
      winnerId: number | null, method: string, endRound: number, endTimeS: number, seed: number, fidelity: "full" | "standard" | "light") =>
      Number(s.bout.run(eventId, week, order, wcId, redId, blueId, rounds, winnerId, method, endRound, endTimeS, seed, fidelity).lastInsertRowid),
    /** Play-by-play is stored as gzipped JSON event codes, not text. */
    insertBoutLog: (boutId: number, events: FightEvent[], cards: [number, number][][]) =>
      s.boutLog.run(boutId, gzipSync(JSON.stringify({ e: events, c: cards }))),
    getBoutLog(boutId: number): { events: FightEvent[]; cards: [number, number][][] } | null {
      const row = s.getLog.get(boutId) as { events: Buffer } | undefined;
      if (!row) return null;
      const j = JSON.parse(gunzipSync(row.events).toString()) as { e: FightEvent[]; c: [number, number][][] };
      return { events: j.e, cards: j.c };
    },
    insertRoundStats(boutId: number, stats: RoundStats[][]) {
      stats.forEach((pair, i) => pair.forEach((x, c) =>
        s.roundStats.run(boutId, i + 1, c, x.sigAtt, x.sigLand, x.kd, x.tdAtt, x.tdLand, x.subAtt, Math.round(x.ctrl))));
    },
  };
}

export type Repo = ReturnType<typeof makeRepo>;
