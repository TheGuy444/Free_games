import { CAREER, DISCIPLINES, GLOBAL_PROMOTIONS, TIERS, WEEKS_PER_YEAR, WEIGHT_CLASSES, type Archetype, type Sex, type Tier, type TierDef } from "./constants.js";
import { resolveLight } from "./fight-light.js";
import { simulateFight } from "./fight/engine.js";
import { generateFighter } from "./fighter-gen.js";
import { ageYears, ATTR_KEYS, fights, overall, PHYSICAL_KEYS, SKILL_KEYS, syncCoarse, type Attributes, type FighterState, type PromotionState, type TitleState } from "./model.js";
import { makeName, makePromotionName, REGION_DEFS } from "./names.js";
import { postFightMoments } from "./postfight.js";
import { flair } from "./personality.js";
import { fightWear } from "./profile.js";
import { MONEY, settleEvent, weeklyBusiness, yearlyBusiness } from "./business.js";
import { realityTick } from "./reality.js";
import { boutsFor, buildSchedule, cardName, decodeSchedule, FLAVORS, pickPlan, type CardKind, type PromotionPlan } from "./schedule.js";
import { FOTN_MIN, MAIN_CARD_SIZE, rateCard, rateFight } from "./excitement.js";
import { drawTraits } from "./traits.js";
import { addPop, decayPop, initRegionPop } from "./popularity.js";
import { inductYear, seedLegends } from "./halloffame.js";
import { injuryStory, resultStory, retirementStory, signingStory, titleStory, type Story, type StoryFighter } from "./stories.js";
import { Rankings, SNAPSHOT_EVERY } from "./rankings.js";
import { clamp, Rng } from "./rng.js";
import { initialWalkKg, NO_MODS, weighIn, type FightMods, type WeighInResult } from "./weighin.js";
import type { DB } from "../db/db.js";
import { makeRepo, type Repo } from "../db/repo.js";

export interface WorldOptions {
  seed: number;
  startYear: number;
  /** Multiplies the number of regional and local promotions (and so the fighter population). */
  scale: number;
  /** Give the player a promotion of this tier (in the first region). Omit for a pure AI world. */
  playerTier?: Exclude<Tier, "global">;
}

export const MIN_REST_WEEKS = 10;
/** Share of the gap to their own average that a fighter's weak skills close each year. */
export const ROUND_OUT_PER_YEAR = 0.04;
/** A double champion must defend each belt within this many weeks or it is vacated. */
export const DOUBLE_CHAMP_DEFENSE_WEEKS = 52;
/** Chance an AI title card looks for a champ-vs-champ superfight first. */
export const SUPERFIGHT_CHANCE = 0.06;
/** Warning (player's promotion) this many weeks before a belt is vacated. */
export const DEFENSE_WARNING_WEEKS = 12;
const ROSTER_FILL_EVERY = 4;
const TITLE_FIGHT_GAP_WEEKS = 16;
const CAMP_INJURY_PER_WEEK = 0.006;

export type Fidelity = "full" | "standard" | "light";

/** One bout on a card, ready to run. */
export interface CardBout {
  red: FighterState;
  blue: FighterState;
  rounds: number;
  title: TitleState | null;
  bookingId: number | null;
  bookedWeek: number;
  /** Division the bout is fought at (defaults to red's); superfights are at the heavier one. */
  weightClassId?: number;
}

export interface BoutReport {
  boutId: number | null;
  redId: number;
  blueId: number;
  winnerId: number | null;
  method: string;
  endRound: number;
  cancelled: string | null;
  weighIns: WeighInResult[];
  titleChange: boolean;
  title: boolean;
  rounds: number;
  weightClassId: number;
  /** Successful defenses after this fight, when a champion kept the belt. */
  defenses: number | null;
  callout: { targetId: number; text: string } | null;
  /** Fight rating 0-100 (excitement.ts). */
  rating: number;
}

/**
 * The live world. Active state is held in memory for speed; every result is
 * appended to the database as it happens, and slow-changing fighter rows are
 * flushed once per sim year (and on save).
 */
export class World {
  readonly repo: Repo;
  rng: Rng;
  week = 0;
  fighters = new Map<number, FighterState>();
  promotions: PromotionState[] = [];
  titles = new Map<string, TitleState>();
  playerPromotionId: number | null = null;
  private nextPersonId = 1;
  private nextContractId = 1;
  private nextEventId = 1;
  private targetPopulation = 0;
  regionIds: number[] = [];
  private regionNames = new Map<number, string>();
  private disciplineIds = new Map<string, number>();
  readonly tierDef = new Map(TIERS.map((t) => [t.tier, t] as const));
  readonly ranks: Rankings;

  /** Counters for the headless report. */
  stats = { bouts: 0, events: 0, debuts: 0, retirements: 0, retiredCareerFights: [] as number[], weighIns: { made: 0, drained: 0, missed: 0, hospitalised: 0 }, moments: 0, titleChanges: 0 };

  private constructor(readonly db: DB, readonly opts: WorldOptions) {
    this.repo = makeRepo(db);
    this.rng = new Rng(opts.seed);
    this.ranks = new Rankings(this);
  }

  static create(db: DB, opts: WorldOptions): World {
    const w = new World(db, opts);
    w.repo.tx(() => w.generate());
    return w;
  }

  /** Calendar year of any sim week (negative weeks are the generated backstory). */
  yearOf(week: number) {
    return this.opts.startYear + Math.floor(week / WEEKS_PER_YEAR);
  }

  get year() {
    return this.opts.startYear + Math.floor(this.week / WEEKS_PER_YEAR);
  }

  promotion(id: number) {
    return this.promotions.find((p) => p.id === id);
  }

  get playerPromotion() {
    return this.playerPromotionId === null ? undefined : this.promotion(this.playerPromotionId);
  }

  regionNameOf(regionId: number) {
    return this.regionNames.get(regionId) ?? "home";
  }

  regionName(f: FighterState) {
    return this.regionNames.get(f.regionId) ?? "home";
  }

  // ---------------------------------------------------------------- generation

  private generate() {
    const { repo, rng } = this;
    repo.insertWorld(this.opts.seed, this.opts.startYear);
    WEIGHT_CLASSES.forEach((wc, i) => repo.insertWeightClass(i + 1, wc.code, wc.name, wc.sex, wc.limitKg));
    DISCIPLINES.forEach((d, i) => {
      repo.insertDiscipline(i + 1, d.code, d.name);
      this.disciplineIds.set(d.code, i + 1);
    });
    REGION_DEFS.forEach((r, i) => {
      repo.insertRegion(i + 1, r.code, r.name, r.flavor);
      this.regionIds.push(i + 1);
      this.regionNames.set(i + 1, r.name);
    });

    const used = new Set<string>();
    let promoId = 1;
    const addPromotion = (tier: TierDef, regionId: number | null) => {
      const id = promoId++;
      const plan = pickPlan(id, tier.tier);
      // The global giants compete with different models.
      const peers = this.promotions.filter((q) => q.tier === tier.tier && q.regionId === regionId);
      if (tier.tier === "global" && peers.some((q) => q.plan?.flavor === plan.flavor)) {
        const alt = pickPlan(id + 1000, tier.tier);
        plan.flavor = peers.some((q) => q.plan?.flavor === alt.flavor) ? (plan.flavor === "hybrid" ? "all_tv" : "hybrid") : alt.flavor;
        plan.ppvNetworkId = plan.flavor === "all_tv" ? null : plan.ppvNetworkId ?? 6;
      }
      const cardKinds = buildSchedule(id, tier.tier, plan.flavor, plan.goal, "ok", 0);
      const p: PromotionState = { id, name: makePromotionName(rng, used), regionId, tier: tier.tier, roster: new Set(), eventWeeks: new Set(cardKinds.keys()), eventCount: 0,
        plan, cardKinds, ppvCount: 0, tvCount: 0 };
      this.promotions.push(p);
      return p;
    };
    const tier = (t: string) => this.tierDef.get(t as TierDef["tier"])!;
    for (let i = 0; i < GLOBAL_PROMOTIONS; i++) addPromotion(tier("global"), null);
    for (const regionId of this.regionIds) {
      for (const t of TIERS) {
        if (t.tier === "global") continue;
        const count = t.tier === "major" ? t.perRegion : Math.round(t.perRegion * this.opts.scale);
        for (let i = 0; i < count; i++) addPromotion(t, regionId);
      }
    }
    if (this.opts.playerTier) {
      const mine = this.promotions.find((p) => p.tier === this.opts.playerTier && p.regionId === this.regionIds[0]);
      if (mine) {
        mine.eventWeeks = new Set(); // the player schedules their own events
        mine.cardKinds = new Map();
        delete mine.plan;
        this.playerPromotionId = mine.id;
      }
    }
    for (const p of this.promotions) repo.insertPromotion(p, 0);
    for (const p of this.promotions) this.db.prepare("UPDATE promotion SET cash = ? WHERE id = ?").run(MONEY.startingCash[p.tier], p.id);
    if (this.playerPromotionId !== null) repo.setPlayerPromotion(this.playerPromotionId);

    this.targetPopulation = this.computeTarget();
    const starters: { f: FighterState; age: number }[] = [];
    for (let i = 0; i < this.targetPopulation; i++) {
      const age = clamp(rng.normal(26, 4.5), 19, 38);
      starters.push({ f: this.createFighter(-Math.round(age * WEEKS_PER_YEAR)), age });
    }
    // Pre-history records (no bout rows). Real records are lopsided: the best are 18-3,
    // prospects are unbeaten, and fighters who lose a lot stop fighting. Win rate
    // follows a fighter's standing among everyone, not a coin flip.
    const byOvr = starters.map((s) => overall(s.f.attrs)).sort((a, b) => a - b);
    for (const { f, age } of starters) {
      const pct = byOvr.findIndex((o) => o >= overall(f.attrs)) / byOvr.length;
      const debutAge = clamp(rng.normal(22.5, 1.8), 19, 27);
      const prior = Math.max(0, Math.min(30, Math.round((age - debutAge) * clamp(rng.normal(1.8, 0.45), 0.8, 3))));
      const prospect = age < 26 && f.attrs.potential >= 68;
      const winRate = clamp(0.3 + 0.52 * Math.pow(pct, 1.4) + (prospect ? 0.08 : 0) + rng.normal(0, 0.06), 0.2, 0.94);
      for (let k = 0; k < prior; k++) {
        // Early fights are the easiest: regional bookers feed rising fighters softer opponents.
        const early = k < 3 ? 0.1 : 0;
        if (!rng.chance(Math.min(0.97, winRate + early))) { f.losses++; continue; }
        f.wins++;
        const r = rng.next();
        if (r < 0.15 + f.attrs.boxing / 400) f.koWins++;
        else if (r < 0.3 + f.attrs.sub_offense / 400) f.subWins++;
      }
      f.rating = 1500 + (overall(f.attrs) - 45) * 8;
      f.popularity = clamp(5 + prior * 0.6 + (f.attrs.charisma - 45) / 5 + (overall(f.attrs) - 45) / 3, 1, 60);
      f.regionPop = initRegionPop(f, this.regionIds);
      if (prior > 0) f.debutWeek = -Math.round(prior / 1.8) * WEEKS_PER_YEAR;
    }
    this.fillRosters();
    seedLegends(this, this.opts.seed);
    this.flush();
  }

  private computeTarget() {
    const capacity = this.promotions.reduce((s, p) => s + this.tierDef.get(p.tier)!.rosterSize, 0);
    return Math.round(capacity * 1.3);
  }

  private createFighter(birthWeek: number): FighterState {
    const rng = this.rng;
    const sex: Sex = rng.chance(0.27) ? "F" : "M";
    const classes = WEIGHT_CLASSES.map((wc, i) => ({ ...wc, id: i + 1 })).filter((wc) => wc.sex === sex);
    const wc = rng.weighted(classes, classes.map((c) => c.popShare));
    const regionIdx = rng.int(0, REGION_DEFS.length - 1);
    const region = REGION_DEFS[regionIdx]!;
    const age = (this.week - birthWeek) / WEEKS_PER_YEAR;
    const g = generateFighter(rng, region.strengths, age, sex);
    const name = makeName(rng, region.flavor, sex);
    const f: FighterState = {
      id: this.nextPersonId++, name: `${name.first} ${name.last}`, sex, birthWeek, regionId: this.regionIds[regionIdx]!,
      weightClassId: wc.id, walkKg: initialWalkKg(wc.code, wc.limitKg, rng), popularity: clamp(3 + g.attrs.charisma / 15, 1, 15), regionPop: {}, traits: [], missedWeight: 0,
      archetype: g.archetype, status: "active", attrs: g.attrs,
      wins: 0, losses: 0, draws: 0, koWins: 0, subWins: 0, lossStreak: 0, winStreak: 0,
      rating: 1500, damage: 0, wear: { body: 0, arms: 0, legs: 0 }, debutWeek: null, retiredWeek: null, lastFightWeek: null, injuredUntil: null,
      idleSince: this.week, contractId: null, promotionId: null, boutsRemaining: 0, dirty: true,
    };
    f.traits = drawTraits(f.id, f.archetype, f.attrs);
    f.regionPop = initRegionPop(f, this.regionIds);
    this.repo.insertFighter(f, name.first, name.last, this.disciplineIds.get(g.discipline)!, g.disciplineLevel);
    this.fighters.set(f.id, f);
    return f;
  }

  /** A retired legend from before the game (hall of fame seeding). Not kept in the live world. */
  spawnLegend(retiredWeek: number, rng: Rng): FighterState {
    const saved = this.rng;
    this.rng = rng;
    const f = this.createFighter(retiredWeek - Math.round(rng.int(34, 40) * WEEKS_PER_YEAR));
    this.rng = saved;
    this.fighters.delete(f.id);
    return f;
  }

  // ---------------------------------------------------------------- loading

  /** Rebuild the in-memory world from a save file. */
  static load(db: DB): World {
    const row = db.prepare("SELECT seed, start_year, current_week, player_promotion_id FROM world WHERE id = 1").get() as
      { seed: number; start_year: number; current_week: number; player_promotion_id: number | null } | undefined;
    if (!row) throw new Error("Save has no world");
    const w = new World(db, { seed: row.seed, startYear: row.start_year, scale: 1 });
    w.week = row.current_week;
    // Fresh stream per load; replays of stored bouts still use their own seeds.
    w.rng = new Rng((row.seed ^ Math.imul(row.current_week + 1, 2654435761)) >>> 0);
    w.playerPromotionId = row.player_promotion_id;
    for (const r of db.prepare("SELECT id, name FROM region ORDER BY id").all() as { id: number; name: string }[]) {
      w.regionIds.push(r.id);
      w.regionNames.set(r.id, r.name);
    }
    for (const d of db.prepare("SELECT id, code FROM discipline").all() as { id: number; code: string }[]) w.disciplineIds.set(d.code, d.id);

    const counts = new Map((db.prepare("SELECT promotion_id, COUNT(*) n FROM event WHERE status = 'completed' GROUP BY promotion_id").all() as { promotion_id: number; n: number }[]).map((r) => [r.promotion_id, r.n]));
    const kindCounts = new Map<string, number>((db.prepare("SELECT promotion_id, broadcast, COUNT(*) n FROM event WHERE status = 'completed' GROUP BY promotion_id, broadcast").all() as
      { promotion_id: number; broadcast: string | null; n: number }[]).map((r) => [`${r.promotion_id}:${r.broadcast}`, r.n]));
    const playerId = (db.prepare("SELECT player_promotion_id FROM world WHERE id = 1").get() as { player_promotion_id: number | null } | undefined)?.player_promotion_id ?? undefined;
    for (const p of db.prepare("SELECT id, name, region_id, tier, event_weeks, flavor, goal, tv_network_id, ppv_network_id FROM promotion WHERE folded_week IS NULL ORDER BY id").all() as
      { id: number; name: string; region_id: number | null; tier: Tier; event_weeks: string; flavor: string | null; goal: string | null; tv_network_id: number | null; ppv_network_id: number | null }[]) {
      const isPlayer = playerId !== undefined && Number(playerId) === p.id;
      const plan: PromotionPlan | undefined = isPlayer ? undefined : p.flavor
        ? { flavor: p.flavor as PromotionPlan["flavor"], goal: p.goal as PromotionPlan["goal"], tvNetworkId: p.tv_network_id, ppvNetworkId: p.ppv_network_id }
        : pickPlan(p.id, p.tier);
      const cardKinds = decodeSchedule(p.event_weeks, p.tier);
      w.promotions.push({
        id: p.id, name: p.name, regionId: p.region_id, tier: p.tier, roster: new Set(),
        eventWeeks: new Set(cardKinds.keys()), eventCount: counts.get(p.id) ?? 0, cardKinds, plan,
        ppvCount: kindCounts.get(`${p.id}:ppv`) ?? 0, tvCount: kindCounts.get(`${p.id}:tv`) ?? 0,
      });
    }

    const attrKeys = ATTR_KEYS;
    const rows = db.prepare(`SELECT f.*, p.first_name, p.last_name, p.sex, p.birth_week, p.region_id, a.*
                             FROM fighter f JOIN person p ON p.id = f.person_id JOIN fighter_attributes a ON a.person_id = f.person_id
                             WHERE f.status != 'retired' AND f.status != 'deceased'`).all() as Record<string, unknown>[];
    for (const r of rows) {
      const attrs = Object.fromEntries(attrKeys.map((k) => [k, r[k] as number])) as unknown as Attributes;
      const f: FighterState = {
        id: r.person_id as number, name: `${r.first_name} ${r.last_name}`, sex: r.sex as Sex, birthWeek: r.birth_week as number,
        regionId: r.region_id as number, weightClassId: r.weight_class_id as number, walkKg: r.walk_weight_kg as number,
        popularity: r.popularity as number, regionPop: r.pop_regions ? JSON.parse(r.pop_regions as string) as Record<number, number> : {},
        traits: typeof r.traits === "string" ? (r.traits as string).split(",").filter(Boolean) : [], missedWeight: r.missed_weight as number, archetype: r.archetype as Archetype,
        status: r.status as FighterState["status"], attrs, wins: r.wins as number, losses: r.losses as number, draws: r.draws as number,
        koWins: r.ko_wins as number, subWins: r.sub_wins as number, lossStreak: r.loss_streak as number, winStreak: r.win_streak as number, rating: r.rating as number,
        damage: r.damage_total as number, wear: { body: r.wear_body as number, arms: r.wear_arms as number, legs: r.wear_legs as number }, debutWeek: r.pro_debut_week as number | null, retiredWeek: null,
        lastFightWeek: r.last_fight_week as number | null, injuredUntil: r.injured_until as number | null, idleSince: w.week,
        contractId: null, promotionId: null, boutsRemaining: 0, dirty: false,
      };
      // Saves from before traits and regional popularity: fill them in.
      if (r.traits === null) { f.traits = drawTraits(f.id, f.archetype, f.attrs); f.dirty = true; }
      if (r.pop_regions === null) { f.regionPop = initRegionPop(f, w.regionIds); f.dirty = true; }
      w.fighters.set(f.id, f);
    }
    for (const c of db.prepare("SELECT id, fighter_id, promotion_id, bouts_remaining FROM contract WHERE end_week IS NULL").all() as
      { id: number; fighter_id: number; promotion_id: number; bouts_remaining: number }[]) {
      const f = w.fighters.get(c.fighter_id);
      const p = w.promotion(c.promotion_id);
      if (!f || !p) continue;
      f.contractId = c.id;
      f.promotionId = p.id;
      f.boutsRemaining = c.bouts_remaining;
      f.idleSince = null;
      p.roster.add(f.id);
    }
    for (const t of db.prepare(`SELECT t.id, t.promotion_id, t.weight_class_id, r.id AS reign_id, r.fighter_id, r.defenses, r.start_week,
                                  (SELECT MAX(week) FROM bout b WHERE b.title_id = t.id) AS last_week
                                FROM title t LEFT JOIN title_reign r ON r.title_id = t.id AND r.end_week IS NULL`).all() as
      { id: number; promotion_id: number; weight_class_id: number; reign_id: number | null; fighter_id: number | null; defenses: number | null; start_week: number | null; last_week: number | null }[]) {
      w.titles.set(`${t.promotion_id}:${t.weight_class_id}`, {
        id: t.id, promotionId: t.promotion_id, weightClassId: t.weight_class_id, champion: t.fighter_id,
        reignId: t.reign_id, defenses: t.defenses ?? 0, lastTitleFightWeek: t.last_week ?? -999, reignStart: t.start_week ?? undefined,
      });
    }
    const max = (sql: string) => ((db.prepare(sql).get() as { m: number | null }).m ?? 0) + 1;
    w.nextPersonId = max("SELECT MAX(id) m FROM person");
    w.nextContractId = max("SELECT MAX(id) m FROM contract");
    w.nextEventId = max("SELECT MAX(id) m FROM event");
    w.targetPopulation = w.computeTarget();
    w.ranks.restore();
    return w;
  }

  // ---------------------------------------------------------------- sim loop

  /**
   * When set (by the app, not by tests or the CLI), the sim stops on the eve of
   * a player event so the player can watch or simulate it. See fightNightDue().
   */
  holdPlayerEvents = false;
  private releasedEvents = new Set<number>();

  /** The player's event next week that is waiting on the player, or null. */
  fightNightDue(): number | null {
    if (!this.holdPlayerEvents || this.playerPromotionId === null) return null;
    const rows = this.db.prepare(`SELECT e.id FROM event e WHERE e.promotion_id = ? AND e.status = 'scheduled' AND e.week = ?
                                  AND EXISTS (SELECT 1 FROM booking b WHERE b.event_id = e.id AND b.status = 'booked') ORDER BY e.id`)
      .all(this.playerPromotionId, this.week + 1) as { id: number }[];
    return rows.find((r) => !this.releasedEvents.has(r.id))?.id ?? null;
  }

  /** Let the held fight night run on the next advance. */
  releaseFightNight(eventId: number) {
    this.releasedEvents.add(eventId);
  }

  /**
   * Advance the world by `weeks`, one transaction per week.
   * Returns the id of a player event it stopped in front of, or null.
   */
  advance(weeks: number): number | null {
    for (let i = 0; i < weeks; i++) {
      const due = this.fightNightDue();
      if (due !== null) return due;
      this.week++;
      this.repo.tx(() => this.step());
      // Flush outside the weekly transaction: a nested savepoint makes the bulk update far slower.
      if (this.week % WEEKS_PER_YEAR === 0) this.flush();
    }
    return this.fightNightDue();
  }

  private step() {
    const woy = this.week % WEEKS_PER_YEAR;
    if (woy === 0) this.yearTick();
    if (this.week % ROSTER_FILL_EVERY === 0) this.fillRosters();
    if (this.playerPromotionId !== null) this.campTick();
    for (const p of this.promotions) if (p.eventWeeks.has(woy)) this.runAiEvent(p);
    for (const e of this.scheduledEventsThisWeek()) this.runScheduledEvent(e.id, e.promotion_id, e.name);
    this.doubleChampTick();
    weeklyBusiness(this);
    realityTick(this);
    if (this.week % SNAPSHOT_EVERY === 0) this.ranks.snapshot();
    this.repo.setWeek(this.week);
  }

  available(f: FighterState, week = this.week) {
    return f.status === "active" &&
      (f.lastFightWeek === null || week - f.lastFightWeek >= MIN_REST_WEEKS) &&
      (f.injuredUntil === null || f.injuredUntil <= week);
  }

  // ---------------------------------------------------------------- titles and rankings

  title(promotionId: number, weightClassId: number): TitleState {
    const key = `${promotionId}:${weightClassId}`;
    let t = this.titles.get(key);
    if (!t) {
      t = { id: this.repo.insertTitle(promotionId, weightClassId), promotionId, weightClassId, champion: null, reignId: null, defenses: 0, lastTitleFightWeek: -999 };
      this.titles.set(key, t);
    }
    return t;
  }

  championOf(promotionId: number, weightClassId: number): number | null {
    return this.titles.get(`${promotionId}:${weightClassId}`)?.champion ?? null;
  }

  /**
   * Double champions: each belt must be defended within DOUBLE_CHAMP_DEFENSE_WEEKS
   * of winning or last defending it. Nothing forces them to give one up early;
   * the player may vacate either belt at any time.
   */
  private doubleChampTick() {
    const byChamp = new Map<number, TitleState[]>();
    for (const t of this.titles.values()) if (t.champion !== null) byChamp.set(t.champion, [...(byChamp.get(t.champion) ?? []), t]);
    for (const [id, ts] of byChamp) {
      if (ts.length < 2) continue;
      for (const t of ts) {
        const due = this.defenseDue(t);
        const p = this.promotion(t.promotionId);
        if (this.week >= due) this.vacate(t, `not defended within ${Math.round(DOUBLE_CHAMP_DEFENSE_WEEKS / 4.33)} months as a double champion`);
        else if (due - this.week === DEFENSE_WARNING_WEEKS && p?.id === this.playerPromotionId) {
          this.repo.news(this.week, p.id, "title", `${this.nameOf(id)} must defend the ${divisionLabel(t.weightClassId)} title within ${DEFENSE_WARNING_WEEKS} weeks or it will be vacated. Book the defense, or vacate one belt from the fighter's profile.`, id, 2);
        }
      }
    }
  }

  /** Week by which a double champion must defend this belt. */
  defenseDue(t: TitleState): number {
    return Math.max(t.lastTitleFightWeek, t.reignStart ?? -999) + DOUBLE_CHAMP_DEFENSE_WEEKS;
  }

  /** The player gives up a belt (e.g. a double champ choosing one division). */
  vacateByChoice(titleId: number) {
    const t = [...this.titles.values()].find((x) => x.id === titleId);
    if (!t || t.champion === null || t.promotionId !== this.playerPromotionId) return false;
    this.vacate(t, "vacated by choice");
    return true;
  }

  /** Every belt a fighter holds (a double champ holds two). */
  titlesOf(id: number): TitleState[] {
    const out: TitleState[] = [];
    for (const t of this.titles.values()) if (t.champion === id) out.push(t);
    return out;
  }

  isChampion(id: number): TitleState | undefined {
    for (const t of this.titles.values()) if (t.champion === id) return t;
    return undefined;
  }

  /** Company division order, champion excluded (see rankings.ts). */
  rankings(promotionId: number, weightClassId: number): FighterState[] {
    return this.ranks.companyOrder(promotionId, weightClassId);
  }

  /** Company division rank (1-15), null if unranked or champion. */
  rankOf(f: FighterState): number | null {
    const r = this.ranks.ranksOf(f).companyDivision;
    return r === null || r === 0 ? null : r;
  }

  /** News helper. Player-promotion items go to their feed; everything else is world news. */
  private news(promotionId: number | null, kind: string, text: string, fighterId: number | null = null, importance = 1, story: Story | null = null) {
    this.repo.news(this.week, promotionId, kind, text, fighterId, importance, story?.headline ?? null, story?.story ?? null);
  }

  /** Facts a news story needs about a fighter (rankings as of this week). */
  storyFighter(f: FighterState): StoryFighter {
    const r = this.ranks.ranksOf(f);
    return {
      name: f.name, sex: f.sex, wins: f.wins, losses: f.losses, draws: f.draws, koWins: f.koWins, subWins: f.subWins,
      winStreak: f.winStreak, age: Math.floor(ageYears(f, this.week)), region: this.regionName(f), style: f.archetype,
      worldP4P: r.worldP4P, worldDivision: r.worldDivision,
    };
  }

  private tierImportance(p: PromotionState | undefined) {
    return p?.tier === "global" ? 3 : p?.tier === "major" ? 2 : 1;
  }

  private vacate(t: TitleState, reason: string) {
    if (t.champion === null || t.reignId === null) return;
    const f = this.fighters.get(t.champion);
    this.repo.endReign(t.reignId, this.week, reason, t.defenses);
    const p = this.promotion(t.promotionId);
    if (p && f && !reason.startsWith("lost to") && (p.id === this.playerPromotionId || p.tier !== "local")) {
      this.news(p.id, "title", `${f.name} vacates the ${p.name} ${divisionLabel(t.weightClassId)} title (${reason}).`, f.id, this.tierImportance(p));
    }
    t.champion = null;
    t.reignId = null;
    t.defenses = 0;
  }

  private crown(t: TitleState, f: FighterState) {
    t.champion = f.id;
    t.reignStart = this.week;
    t.reignId = this.repo.startReign(t.id, f.id, this.week);
    t.defenses = 0;
    this.stats.titleChanges++;
  }

  // ---------------------------------------------------------------- AI events

  private runAiEvent(p: PromotionState) {
    const tier = this.tierDef.get(p.tier)!;
    let kind: CardKind = p.cardKinds?.get(this.week % WEEKS_PER_YEAR) ?? (p.tier === "local" ? "none" : "tv");
    const pool = [...p.roster].map((id) => this.fighters.get(id)!).filter((f) => this.available(f));
    const card = this.suggestPairs(p, pool, boutsFor(kind, p.tier, tier.boutsPerCard), p.tier !== "local");
    if (card.length === 0) return;
    // A PPV needs a main event people will pay for: a title fight or real stars. Otherwise it airs on TV.
    if (kind === "ppv") {
      const main = card[0]!;
      const star = (main.red.popularity + main.blue.popularity) / 2;
      if (!main.title && star < 45) {
        kind = "tv";
        if (p.tier === "global") this.news(p.id, "business", `${p.name} moves its planned PPV to TV after failing to land a main event worth paying for.`, null, 2);
      }
    }
    p.eventCount++;
    if (kind === "ppv") p.ppvCount = (p.ppvCount ?? 0) + 1;
    if (kind === "tv") p.tvCount = (p.tvCount ?? 0) + 1;
    const eventId = this.nextEventId++;
    const name = p.plan ? cardName(p, kind, { ppv: p.ppvCount ?? 0, tv: p.tvCount ?? 0, all: p.eventCount }, p.plan.flavor) : `${p.name} ${p.eventCount}`;
    // Global promotions tour; growth-minded ones take some shows on the road; everyone else fights at home.
    let region = p.regionId ?? this.regionIds[(eventId * 7) % this.regionIds.length]!;
    if (p.regionId !== null && p.plan?.goal === "growth" && p.tier !== "local" && p.eventCount % 4 === 0) {
      const others = this.regionIds.filter((r) => r !== p.regionId);
      region = others[p.eventCount % others.length] ?? region;
    }
    this.repo.insertEvent(eventId, p.id, this.week, name, region);
    this.db.prepare("UPDATE event SET broadcast = ? WHERE id = ?").run(kind, eventId);
    this.stats.events++;
    const reports = this.runCard(p, eventId, name, card.map((c) => ({ ...c, bookingId: null, bookedWeek: this.week - 8 })), region);
    if (p.tier === "global" || p.tier === "major" || reports.some((r) => r.titleChange)) this.eventSummaryNews(p, name, reports);
  }

  /** Each new year an AI promotion plans its calendar: more cards when the money is good, fewer when it isn't. */
  private planYear() {
    const year = Math.floor(this.week / WEEKS_PER_YEAR);
    for (const p of this.promotions) {
      if (!p.plan || p.id === this.playerPromotionId) continue;
      // Running costs, and most of a good year's profit goes back into the business (fighter pay, marketing, owners).
      const yr = this.db.prepare("SELECT COALESCE(SUM(profit), 0) s, COUNT(*) n FROM event WHERE promotion_id = ? AND week > ?").get(p.id, this.week - WEEKS_PER_YEAR) as { s: number; n: number };
      const overhead = MONEY.overheadPerCard[p.tier] * yr.n;
      const spent = overhead + Math.max(0, yr.s - overhead) * MONEY.reinvest;
      this.db.prepare("UPDATE promotion SET cash = cash - ? WHERE id = ?").run(Math.round(spent), p.id);
      let cash = (this.db.prepare("SELECT cash FROM promotion WHERE id = ?").get(p.id) as { cash: number }).cash;
      const start = MONEY.startingCash[p.tier];
      // Deep in the red: new investors buy in and the promotion carries on, leaner.
      if (cash < -start * 1.5) {
        cash = Math.round(start * 0.5);
        this.db.prepare("UPDATE promotion SET cash = ? WHERE id = ?").run(cash, p.id);
        this.news(p.id, "business", `${p.name} is rescued by new investors after heavy losses, and cuts back its calendar.`, null, p.tier === "global" || p.tier === "major" ? 3 : 1);
        p.cardKinds = buildSchedule(p.id, p.tier, p.plan.flavor, "profit", "tight", year);
        p.eventWeeks = new Set(p.cardKinds.keys());
        this.repo.setPromotionWeeks(p);
        continue;
      }
      const money = cash < 0 ? "broke" : cash < start * 0.4 ? "tight" : cash > start * 2 ? "rich" : "ok";
      const before = p.eventWeeks.size;
      p.cardKinds = buildSchedule(p.id, p.tier, p.plan.flavor, p.plan.goal, money, year);
      p.eventWeeks = new Set(p.cardKinds.keys());
      this.repo.setPromotionWeeks(p);
      const after = p.eventWeeks.size;
      if (p.tier !== "local" && Math.abs(after - before) >= 2) {
        this.news(p.id, "business", after < before
          ? `${p.name} cuts back to ${after} events this year${money === "broke" ? " after a year of losses" : ""}.`
          : `${p.name} expands to ${after} events this year.`, null, p.tier === "global" || p.tier === "major" ? 2 : 1);
      }
    }
  }

  /** Card rating and Fight of the Night. */
  private finishCard(p: PromotionState, eventId: number, reports: BoutReport[]) {
    const done = reports.filter((r) => r.boutId !== null && !r.cancelled);
    if (done.length === 0) return;
    const rating = rateCard(done.map((r) => r.rating));
    this.repo.setEventRating(eventId, rating);
    const best = done.reduce((a, b) => (b.rating > a.rating ? b : a));
    if (best.rating >= FOTN_MIN) this.repo.markFotn(best.boutId!, best.redId, best.blueId);
    settleEvent(this, p, eventId, done.map((r) => ({ red: this.fighters.get(r.redId)!, blue: this.fighters.get(r.blueId)!, title: r.title, winnerId: r.winnerId })), rating);
  }

  /** One news item per notable card: main event, co-main, and any belt changing hands. */
  private eventSummaryNews(p: PromotionState, name: string, reports: BoutReport[]) {
    const done = reports.filter((r) => !r.cancelled && r.boutId !== null);
    if (done.length === 0) return;
    const line = (r: BoutReport) => {
      const red = this.nameOf(r.redId), blue = this.nameOf(r.blueId);
      if (r.winnerId === null) return `${red} and ${blue} fight to a draw`;
      const [w, l] = r.winnerId === r.redId ? [red, blue] : [blue, red];
      return `${w} def. ${l} by ${METHOD_WORDS[r.method] ?? r.method}${r.method.startsWith("DEC") ? "" : ` (R${r.endRound})`}`;
    };
    const main = done[0]!;
    const parts = [`${name}: ${line(main)}${main.titleChange ? " to win the title" : main.title ? " to retain the title" : ""}.`];
    if (done[1]) parts.push(`Co-main: ${line(done[1])}.`);
    for (const r of done.slice(1)) if (r.titleChange) parts.push(`New champion: ${this.nameOf(r.winnerId!)}.`);
    const isPlayer = p.id === this.playerPromotionId;
    const importance = Math.max(this.tierImportance(p) + (main.titleChange ? 1 : 0), isPlayer ? 2 : 1);
    let story: Story | null = null;
    const w = main.winnerId !== null ? this.fighters.get(main.winnerId) : undefined;
    const l = main.winnerId !== null ? this.fighters.get(main.winnerId === main.redId ? main.blueId : main.redId) : undefined;
    if (w && l && (importance >= 2 || main.titleChange)) {
      story = resultStory({
        promotion: p.name, eventName: name, division: divisionLabel(main.weightClassId),
        winner: this.storyFighter(w), loser: this.storyFighter(l), method: main.method, round: main.endRound, rounds: main.rounds,
        titleChange: main.titleChange, titleDefense: main.defenses,
        coMain: done[1] ? line(done[1]).replace(" def. ", " beat ") : null,
        otherChampions: done.slice(1).filter((r) => r.titleChange).map((r) => `${this.nameOf(r.winnerId!)} (${divisionLabel(r.weightClassId).toLowerCase()})`),
        callout: main.callout ? { target: this.nameOf(main.callout.targetId), text: main.callout.text } : null,
      });
    }
    this.news(p.id, "results", parts.join(" "), main.winnerId, importance, story);
  }

  nameOf(id: number): string {
    const f = this.fighters.get(id);
    if (f) return f.name;
    const r = this.db.prepare("SELECT first_name || ' ' || last_name n FROM person WHERE id = ?").get(id) as { n: string } | undefined;
    return r?.n ?? "unknown";
  }

  /**
   * AI matchmaking: maybe a title fight for the main event, then close
   * matchups by rating within each division. Also used to suggest cards to the player.
   */
  suggestPairs(p: PromotionState, pool: FighterState[], count: number, allowTitle: boolean): { red: FighterState; blue: FighterState; rounds: number; title: TitleState | null; weightClassId?: number }[] {
    const rng = this.rng;
    const out: { red: FighterState; blue: FighterState; rounds: number; title: TitleState | null; weightClassId?: number }[] = [];
    const taken = new Set<number>();
    const byClass = new Map<number, FighterState[]>();
    for (const f of pool) {
      const list = byClass.get(f.weightClassId) ?? [];
      list.push(f);
      byClass.set(f.weightClassId, list);
    }
    // Now and then a champion moves up to challenge the champion one division above.
    if (allowTitle && rng.chance(SUPERFIGHT_CHANCE)) {
      for (const t of this.titles.values()) {
        if (t.promotionId !== p.id || t.champion === null || this.week - t.lastTitleFightWeek < TITLE_FIGHT_GAP_WEEKS) continue;
        const below = this.titles.get(`${p.id}:${t.weightClassId - 1}`);
        if (!below || below.champion === null || WEIGHT_CLASSES[t.weightClassId - 2]?.sex !== WEIGHT_CLASSES[t.weightClassId - 1]!.sex) continue;
        const upper = pool.find((f) => f.id === t.champion), lower = pool.find((f) => f.id === below.champion);
        if (!upper || !lower || upper.id === lower.id || this.titlesOf(lower.id).length > 1) continue;
        if (upper.popularity + lower.popularity < 70) continue;
        out.push({ red: upper, blue: lower, rounds: 5, title: t, weightClassId: t.weightClassId });
        taken.add(upper.id).add(lower.id);
        break;
      }
    }
    if (allowTitle && out.length === 0) {
      let best: { red: FighterState; blue: FighterState; title: TitleState; score: number } | null = null;
      for (const [wcId, list] of byClass) {
        const t = this.title(p.id, wcId);
        if (this.week - t.lastTitleFightWeek < TITLE_FIGHT_GAP_WEEKS) continue;
        const ranked = this.rankings(p.id, wcId).filter((f) => list.includes(f));
        // A double champ lives in their home division's list, so look them up in the whole pool.
        const champ = t.champion !== null ? pool.find((f) => f.id === t.champion) : undefined;
        if (champ && taken.has(champ.id)) continue;
        let red: FighterState | undefined, blue: FighterState | undefined;
        if (t.champion !== null) { red = champ; blue = ranked[0]; } else { red = ranked[0]; blue = ranked[1]; }
        if (!red || !blue) continue;
        const score = red.rating + blue.rating + (red.popularity + blue.popularity) * 2;
        if (!best || score > best.score) best = { red, blue, title: t, score };
      }
      if (best) {
        out.push({ red: best.red, blue: best.blue, rounds: 5, title: best.title, weightClassId: best.title.weightClassId });
        taken.add(best.red.id).add(best.blue.id);
      }
    }
    const pairs: [FighterState, FighterState][] = [];
    for (const list of byClass.values()) {
      let free = list.filter((f) => !taken.has(f.id));
      // Showcase bouts: promoters build prospects by matching them with a step down in competition.
      const prospects = free.filter((f) => fights(f) <= 12 && ageYears(f, this.week) <= 27 && f.losses <= 2 && (f.attrs.potential >= 66 || f.winStreak >= 3));
      for (const pr of prospects) {
        if (taken.has(pr.id) || !rng.chance(0.75)) continue;
        const opp = free.filter((o) => !taken.has(o.id) && o.id !== pr.id && o.rating < pr.rating - 30 && o.rating > pr.rating - 220)
          .sort((a, b) => b.rating - a.rating)[rng.int(0, 2)];
        if (!opp) continue;
        pairs.push([pr, opp]);
        taken.add(pr.id).add(opp.id);
      }
      free = free.filter((f) => !taken.has(f.id));
      free.sort((a, b) => b.rating + rng.normal(0, 140) - (a.rating + rng.normal(0, 140)));
      for (let i = 0; i + 1 < free.length; i += 2) pairs.push([free[i]!, free[i + 1]!]);
    }
    pairs.sort((a, b) => b[0].rating + b[1].rating - (a[0].rating + a[1].rating));
    for (const [red, blue] of pairs) {
      if (out.length >= count) break;
      const main = out.length === 0 && (p.tier === "global" || p.tier === "major");
      out.push({ red, blue, rounds: main ? 5 : 3, title: null });
    }
    return out;
  }

  // ---------------------------------------------------------------- player events

  private scheduledEventsThisWeek() {
    return this.db.prepare("SELECT id, promotion_id, name FROM event WHERE status = 'scheduled' AND week = ?").all(this.week) as { id: number; promotion_id: number; name: string }[];
  }

  /** Schedule an event for the player's promotion. */
  scheduleEvent(weeksAhead: number, name?: string, regionId?: number, opts: { broadcast?: "tv" | "ppv" | "none"; venue?: string } = {}): number {
    const p = this.playerPromotion;
    if (!p) throw new Error("No player promotion in this world");
    if (weeksAhead < 1) throw new Error("Events must be at least one week out");
    const id = this.nextEventId++;
    const n = name?.trim() || `${p.name} ${p.eventCount + 1 + this.scheduledCount(p.id)}`;
    this.repo.scheduleEvent(id, p.id, this.week + weeksAhead, n, regionId ?? p.regionId);
    this.db.prepare("UPDATE event SET broadcast = ?, venue = ? WHERE id = ?").run(opts.broadcast ?? null, opts.venue ?? null, id);
    return id;
  }

  private scheduledCount(promotionId: number) {
    return (this.db.prepare("SELECT COUNT(*) n FROM event WHERE promotion_id = ? AND status = 'scheduled'").get(promotionId) as { n: number }).n;
  }

  private runScheduledEvent(eventId: number, promotionId: number, name: string) {
    const p = this.promotion(promotionId)!;
    const bookings = this.db.prepare(`SELECT id, red_id, blue_id, rounds, title_id, booked_week, weight_class_id FROM booking
                                      WHERE event_id = ? AND status = 'booked' ORDER BY card_order`).all(eventId) as
      { id: number; red_id: number; blue_id: number; rounds: number; title_id: number | null; booked_week: number; weight_class_id: number }[];
    const card: CardBout[] = [];
    for (const b of bookings) {
      const red = this.fighters.get(b.red_id);
      const blue = this.fighters.get(b.blue_id);
      if (!red || !blue) { this.repo.setBookingStatus(b.id, "cancelled", "fighter unavailable", null); continue; }
      const title = b.title_id !== null ? [...this.titles.values()].find((t) => t.id === b.title_id) ?? null : null;
      card.push({ red, blue, rounds: b.rounds, title, bookingId: b.id, bookedWeek: b.booked_week, weightClassId: b.weight_class_id });
    }
    p.eventCount++;
    this.stats.events++;
    const region = (this.db.prepare("SELECT region_id FROM event WHERE id = ?").get(eventId) as { region_id: number | null }).region_id ?? p.regionId;
    const reports = this.runCard(p, eventId, name, card, region);
    this.repo.setEventStatus(eventId, "completed");
    this.eventSummaryNews(p, name, reports);
    const done = reports.filter((r) => !r.cancelled).length;
    this.repo.news(this.week, p.id, "event", `${name} is in the books: ${done} bouts completed${reports.length > done ? `, ${reports.length - done} cancelled` : ""}.`);
  }

  /** Fight camp: booked fighters can get hurt in training before the event. */
  private campTick() {
    const rows = this.db.prepare(`SELECT b.id, b.red_id, b.blue_id, e.name, e.week FROM booking b JOIN event e ON e.id = b.event_id
                                  WHERE e.status = 'scheduled' AND e.promotion_id = ? AND b.status = 'booked' AND e.week > ?`).all(this.playerPromotionId, this.week) as
      { id: number; red_id: number; blue_id: number; name: string; week: number }[];
    for (const b of rows) {
      for (const id of [b.red_id, b.blue_id]) {
        const f = this.fighters.get(id);
        if (!f || !this.rng.chance(CAMP_INJURY_PER_WEEK)) continue;
        // Hurt badly enough to miss this show: he can't be re-booked onto it.
        f.injuredUntil = Math.max(this.week + this.rng.int(4, 14), b.week + 1);
        f.dirty = true;
        const opp = this.fighters.get(id === b.red_id ? b.blue_id : b.red_id);
        this.repo.setBookingStatus(b.id, "cancelled", `${f.name} injured in camp`, null);
        this.repo.news(this.week, this.playerPromotionId, "injury",
          `${f.name} is injured in camp and out of the ${b.name} bout${opp ? ` against ${opp.name}` : ""}. Find a replacement or leave it off the card.`);
        break;
      }
    }
  }

  // ---------------------------------------------------------------- running a card

  private fidelityFor(p: PromotionState, cardIndex: number, title: boolean): Fidelity {
    if (p.id === this.playerPromotionId) return "full";
    if (p.tier === "global") return cardIndex === 0 ? "full" : "standard";
    if (p.tier === "major" || title) return "standard";
    return "light";
  }

  runCard(p: PromotionState, eventId: number, eventName: string, card: CardBout[], region: number | null = p.regionId): BoutReport[] {
    const rng = this.rng;
    const tier = this.tierDef.get(p.tier)!;
    const reports: BoutReport[] = [];
    const isPlayer = p.id === this.playerPromotionId;
    let order = 0;
    for (const b of card) {
      const { red, blue } = b;
      const report: BoutReport = { boutId: null, redId: red.id, blueId: blue.id, winnerId: null, method: "", endRound: 0, cancelled: null, weighIns: [], titleChange: false, title: false,
        rounds: b.rounds, weightClassId: b.weightClassId ?? red.weightClassId, defenses: null, callout: null, rating: 0 };
      const wc = report.weightClassId;
      reports.push(report);
      const cancel = (reason: string) => {
        report.cancelled = reason;
        if (b.bookingId !== null) this.repo.setBookingStatus(b.bookingId, "cancelled", reason, null);
        if (isPlayer) this.repo.news(this.week, p.id, "cancelled", `${red.name} vs ${blue.name} is off: ${reason}.`);
      };
      if (!this.available(red) || !this.available(blue) || red.promotionId !== p.id || blue.promotionId !== p.id) {
        cancel(`${!this.available(red) || red.promotionId !== p.id ? red.name : blue.name} is unavailable`);
        continue;
      }

      // Weigh-ins.
      let title = b.title;
      let catchweight = false;
      const cannotWinTitle = new Set<number>();
      const mods: [FightMods, FightMods] = [NO_MODS, NO_MODS];
      let off: string | null = null;
      for (const [c, f] of [[0, red], [1, blue]] as const) {
        const w = weighIn(f, this.week, this.week - b.bookedWeek, rng, wc);
        report.weighIns.push(w);
        this.stats.weighIns[w.outcome]++;
        const fine = w.outcome === "missed" ? Math.round(tier.basePurse * 0.2) : 0;
        if (isPlayer || w.outcome !== "made") this.repo.insertWeighIn(eventId, this.week, w, fine);
        mods[c] = w.mods;
        if (w.outcome === "hospitalised") off = `${f.name} was hospitalised during the weight cut`;
        if (w.outcome === "missed") {
          catchweight = true;
          f.missedWeight++;
          f.dirty = true;
          // A fighter who misses weight cannot leave with the belt; a champion who misses is stripped.
          cannotWinTitle.add(f.id);
          if (title && title.champion === f.id) this.vacate(title, "stripped after missing weight");
          if (isPlayer) this.repo.news(this.week, p.id, "weigh_in", `${f.name} misses weight at ${w.weightKg} kg (limit ${w.limitKg} kg) and forfeits 20% of the purse. The bout goes ahead at catchweight.`);
          if (f.missedWeight >= 2) this.moveUp(f, p);
        } else if (w.outcome === "drained" && isPlayer) {
          this.repo.news(this.week, p.id, "weigh_in", `${f.name} makes weight but looks drained on the scale.`);
        }
      }
      if (off) { cancel(off); continue; }

      order++;
      const fidelity = this.fidelityFor(p, order - 1, title !== null);
      const seed = rng.seed();
      let winner: FighterState | null;
      let method: string;
      let endRound: number;
      let boutId: number;
      if (fidelity === "light") {
        const out = resolveLight(red, blue, b.rounds, seed);
        winner = out.winner === "red" ? red : out.winner === "blue" ? blue : null;
        method = out.method;
        endRound = out.endRound;
        boutId = this.repo.insertBout(eventId, this.week, order, wc, red.id, blue.id, b.rounds,
          winner?.id ?? null, method, out.endRound, out.endTimeS, seed, fidelity);
        report.rating = rateFight(method, out.endRound, b.rounds, out.endTimeS, null, red, blue, title !== null);
      } else {
        const out = simulateFight(red, blue, b.rounds, seed, { log: fidelity === "full", mods });
        winner = out.winner === 0 ? red : out.winner === 1 ? blue : null;
        method = out.method;
        endRound = out.endRound;
        boutId = this.repo.insertBout(eventId, this.week, order, wc, red.id, blue.id, b.rounds,
          winner?.id ?? null, method, out.endRound, out.endTimeS, seed, fidelity);
        this.repo.insertRoundStats(boutId, out.stats);
        report.rating = rateFight(method, out.endRound, b.rounds, out.endTimeS, out.stats, red, blue, title !== null);
        if (fidelity === "full") this.repo.insertBoutLog(boutId, out.events, out.cards);
      }
      if (title || catchweight) this.repo.setBoutTitle(boutId, title?.id ?? null, catchweight);
      this.repo.setBoutRating(boutId, report.rating, order <= MAIN_CARD_SIZE ? "main" : "prelim");
      if (b.bookingId !== null) this.repo.setBookingStatus(b.bookingId, "completed", null, boutId);
      // "title" means the belt was really on the line for the winner (not after a miss or a stripping).
      Object.assign(report, { boutId, winnerId: winner?.id ?? null, method, endRound, title: title !== null && winner !== null && !cannotWinTitle.has(winner.id) });
      this.stats.bouts++;

      // Title outcome.
      let titleWon = false;
      if (title) {
        title.lastTitleFightWeek = this.week;
        if (winner && title.champion !== winner.id && !cannotWinTitle.has(winner.id)) {
          if (title.champion !== null) this.vacate(title, `lost to ${winner.name}`);
          this.crown(title, winner);
          titleWon = true;
          report.titleChange = true;
          addPop(winner, 8, p.tier === "global" ? null : region, this.regionIds);
          // Global and major AI cards announce belt changes in their results summary instead.
          const other = this.titlesOf(winner.id).filter((t) => t !== title && t.promotionId === p.id);
          if (other.length) {
            this.news(p.id, "title", `${winner.name} is a two-division champion: ${p.name} ${divisionLabel(other[0]!.weightClassId)} and ${divisionLabel(title.weightClassId)} titles. Both belts must be defended within a year or one must be given up.`,
              winner.id, this.tierImportance(p) + 2, { headline: `${winner.name.split(" ").slice(1).join(" ")} becomes a two-division champion`,
                story: `${winner.name} (${winner.wins}-${winner.losses}) won the ${p.name} ${divisionLabel(title.weightClassId).toLowerCase()} title at ${eventName} while still holding the ${divisionLabel(other[0]!.weightClassId).toLowerCase()} belt.\n\nThe promotion's rule for double champions: each belt has to be defended within ${DOUBLE_CHAMP_DEFENSE_WEEKS / 52 === 1 ? "a year" : `${DOUBLE_CHAMP_DEFENSE_WEEKS} weeks`}, or it is vacated.` });
          }
          if (isPlayer || p.tier === "regional") {
            const loserName = winner === red ? blue.name : red.name;
            this.news(p.id, "title", `${winner.name} is the new ${p.name} ${divisionLabel(title.weightClassId)} champion.`, winner.id, this.tierImportance(p) + 1,
              titleStory(p.name, divisionLabel(title.weightClassId), this.storyFighter(winner), loserName, eventName));
          }
        } else if (winner && title.reignId !== null) {
          title.defenses++;
          this.repo.setDefenses(title.reignId, title.defenses);
          if (report.title) report.defenses = title.defenses;
        }
      }

      this.applyResult(red, blue, winner, method, p.tier, endRound, region);
      const retiring: FighterState[] = [];
      for (const f of [red, blue]) if (this.afterBout(f, p)) retiring.push(f);

      if (fidelity !== "light") {
        const loser = winner === null ? null : winner === red ? blue : red;
        const moments = postFightMoments({
          winner, loser, method, isMainEvent: order === 1, titleWon,
          isChampion: (id) => this.championOf(p.id, wc) === id,
          rankOf: (id) => { const f = this.fighters.get(id); return f ? this.rankOf(f) : null; },
          calloutTarget: winner ? this.chooseCalloutTarget(winner, loser, p) : null,
          retiring, regionName: (f) => this.regionName(f), promotionName: p.name,
        }, rng);
        for (const m of moments) {
          this.repo.insertMoment(boutId, this.week, m);
          this.stats.moments++;
          const f = this.fighters.get(m.fighterId);
          if (f && m.kind === "callout") {
            addPop(f, 0.3 + f.attrs.charisma / 200 + flair(f) / 80, region, this.regionIds);
            if (order === 1 && m.targetId !== null) report.callout = { targetId: m.targetId, text: m.text };
            if (!isPlayer && order === 1 && (p.tier === "global" || p.tier === "major") && m.targetId !== null) {
              this.news(p.id, "callout", `${f.name} calls out ${this.nameOf(m.targetId)} after winning the ${p.name} main event: "${m.text}"`, f.id, this.tierImportance(p));
            }
          }
        }
      }
    }
    this.finishCard(p, eventId, reports);
    return reports;
  }

  /** Who a winner calls out: the champion, a ranked fighter above them, or someone who beat them. */
  chooseCalloutTarget(w: FighterState, lastOpponent: FighterState | null, p: PromotionState): FighterState | null {
    const rng = this.rng;
    const champ = this.championOf(p.id, w.weightClassId);
    const ranked = this.rankings(p.id, w.weightClassId).filter((f) => f.status === "active" && f.id !== lastOpponent?.id);
    if (champ === w.id) return ranked[0] ?? null;
    const myRank = ranked.findIndex((f) => f.id === w.id);
    if (champ !== null && myRank >= 0 && myRank < 5 && champ !== lastOpponent?.id) return this.fighters.get(champ) ?? null;
    if (rng.chance(0.3)) {
      const nemesis = this.db.prepare(`SELECT CASE WHEN red_id = @id THEN blue_id ELSE red_id END AS opp FROM bout
                                       WHERE (red_id = @id OR blue_id = @id) AND winner_id IS NOT NULL AND winner_id != @id AND week > @since
                                       ORDER BY week DESC LIMIT 1`).get({ id: w.id, since: this.week - 3 * WEEKS_PER_YEAR }) as { opp: number } | undefined;
      const n = nemesis ? this.fighters.get(nemesis.opp) : undefined;
      if (n && n.promotionId === p.id && n.status === "active" && n.id !== lastOpponent?.id) return n;
    }
    const others = ranked.filter((f) => f.id !== w.id);
    if (others.length === 0) return null;
    const from = myRank >= 0 ? myRank : Math.min(others.length, 15);
    return others[clamp(from - rng.int(1, 4), 0, others.length - 1)] ?? null;
  }

  /** Two misses in a row: the fighter moves up a division. */
  private moveUp(f: FighterState, p: PromotionState) {
    const cur = WEIGHT_CLASSES[f.weightClassId - 1]!;
    const nextIdx = WEIGHT_CLASSES.findIndex((wc, i) => i > f.weightClassId - 1 && wc.sex === cur.sex);
    if (nextIdx < 0) return;
    // Only the belt in the division they're leaving goes; a double champ keeps the upper one.
    const t = this.titlesOf(f.id).find((x) => x.weightClassId === f.weightClassId);
    if (t) this.vacate(t, "moved up a division");
    f.weightClassId = nextIdx + 1;
    f.missedWeight = 0;
    f.dirty = true;
    if (p.id === this.playerPromotionId) this.repo.news(this.week, p.id, "division", `${f.name} moves up to ${WEIGHT_CLASSES[nextIdx]!.name} after repeated weight misses.`);
  }

  private applyResult(red: FighterState, blue: FighterState, winner: FighterState | null, method: string, tier: Tier, endRound = 3, region: number | null = null) {
    const expRed = 1 / (1 + 10 ** ((blue.rating - red.rating) / 400));
    const scoreRed = winner === null ? 0.5 : winner === red ? 1 : 0;
    const k = 32;
    red.rating += k * (scoreRed - expRed);
    blue.rating += k * (1 - scoreRed - (1 - expRed));
    const stage = { global: 2, major: 1.4, regional: 1, local: 0.6 }[tier];
    for (const f of [red, blue]) {
      f.lastFightWeek = this.week;
      f.debutWeek ??= this.week;
      f.dirty = true;
      if (winner === null) f.draws++;
      f.damage += 0.6;
      const opp = f === red ? blue : red;
      const w = fightWear(opp.attrs, endRound, winner !== null && winner !== f, method);
      f.wear.body += w.body; f.wear.arms += w.arms; f.wear.legs += w.legs;
    }
    if (!winner) return;
    const loser = winner === red ? blue : red;
    const finished = method === "KO" || method === "TKO" || method === "SUB";
    winner.wins++;
    winner.lossStreak = 0;
    winner.winStreak++;
    const reach = tier === "global" ? null : region;
    addPop(winner, (finished ? 2.5 : 1.2) * stage * (0.7 + winner.attrs.charisma / 150), reach, this.regionIds);
    loser.losses++;
    loser.lossStreak++;
    loser.winStreak = 0;
    addPop(loser, -0.6 * stage, reach, this.regionIds);
    if (method === "KO" || method === "TKO") {
      winner.koWins++;
      loser.damage += method === "KO" ? 3 : 2;
      if (this.rng.chance(0.3)) this.injure(loser, this.rng.int(8, 20), `after the ${method} loss to ${winner.name}`);
    } else if (method === "SUB") {
      winner.subWins++;
      if (this.rng.chance(0.1)) this.injure(loser, this.rng.int(6, 16), `after the submission loss to ${winner.name}`);
    } else {
      loser.damage += 0.8;
    }
    this.maybeCut(loser);
  }

  /** Big promotions cut fighters who keep losing; they rebuild their records a level down. */
  private maybeCut(f: FighterState) {
    if (f.promotionId === null || f.promotionId === this.playerPromotionId) return;
    const p = this.promotion(f.promotionId);
    if (!p || p.tier === "local" || this.isChampion(f.id)) return;
    const winPct = f.wins / Math.max(1, f.wins + f.losses);
    const cut = f.lossStreak >= 3 || (f.lossStreak >= 2 && this.rankOf(f) === null && (p.tier === "global" || winPct < 0.55));
    if (!cut || f.contractId === null) return;
    this.repo.endContract(f.contractId, this.week, Math.max(0, f.boutsRemaining));
    p.roster.delete(f.id);
    f.lastPromotionId = p.id;
    f.contractId = null;
    f.promotionId = null;
    f.boutsRemaining = 0;
    f.idleSince = this.week;
    f.dirty = true;
    this.cancelFutureBookings(f, "was released");
    if (p.tier === "global" || p.tier === "major") this.news(p.id, "signing", `${p.name} releases ${f.name} (${f.wins}-${f.losses}) after ${f.lossStreak} straight losses.`, f.id, 1);
  }

  private injure(f: FighterState, weeks: number, context: string) {
    f.injuredUntil = this.week + weeks;
    // Injuries leave lasting wear on the part that was hurt.
    const part = /submission/.test(context) ? "arms" : /KO|TKO/.test(context) ? null : (["body", "arms", "legs"] as const)[(f.id + this.week) % 3]!;
    if (part) f.wear[part] += weeks * 0.5;
    else f.damage += 1;
    const mine = f.promotionId !== null && f.promotionId === this.playerPromotionId;
    if (mine || this.ranks.isNotable(f.id)) {
      const months = Math.max(1, Math.round(weeks / 4.3));
      this.news(f.promotionId, "injury", `${f.name} is out for about ${months} months ${context}.`, f.id, mine ? 2 : 1,
        injuryStory(this.storyFighter(f), months, context, f.promotionId !== null ? this.promotion(f.promotionId)?.name ?? null : null));
    }
  }

  /** Contract bookkeeping and the retirement check. Returns true if the fighter retired. */
  private afterBout(f: FighterState, p: PromotionState): boolean {
    if (f.contractId !== null) {
      f.boutsRemaining--;
      if (f.boutsRemaining <= 0) this.endContract(f, p);
    }
    if (this.shouldRetire(f)) {
      this.retire(f);
      return true;
    }
    return false;
  }

  /**
   * Per-fight retirement hazard tuned to the design targets: most careers end
   * between 30 and 40 fights, ~50 is a long veteran career, 70 is a hard stop.
   */
  shouldRetire(f: FighterState): boolean {
    const n = fights(f);
    if (n >= CAREER.forcedRetirement) return true;
    const age = ageYears(f, this.week);
    let h = 0.004 + 0.13 / (1 + Math.exp(-(n - 40) / 3.5));
    if (age > 36) h += 0.02 * (age - 36);
    if (f.lossStreak >= 3) h += 0.04 * (f.lossStreak - 2);
    // Fighters who lose more than they win drift out of the sport.
    const winPct = f.wins / Math.max(1, f.wins + f.losses);
    if (n >= 8 && winPct < 0.47) h += (0.47 - winPct) * 0.6;
    if (f.damage > 30) h += (f.damage - 30) * 0.004;
    const worstWear = Math.max(f.wear.body, f.wear.arms, f.wear.legs);
    if (worstWear > 50) h += (worstWear - 50) * 0.003;
    if (n >= CAREER.veteran) h += 0.05;
    if (this.isChampion(f.id)) h *= 0.4; // champions rarely walk away
    return this.rng.chance(clamp(h, 0, 0.95));
  }

  private retire(f: FighterState) {
    const wasChamp = this.isChampion(f.id);
    const notable = wasChamp !== undefined || this.ranks.isNotable(f.id) || (f.promotionId !== null && f.promotionId === this.playerPromotionId && fights(f) >= 10);
    if (notable) {
      const promo = f.promotionId !== null ? this.promotion(f.promotionId)?.name ?? null : null;
      this.news(f.promotionId, "retirement", `${f.name} retires at ${Math.floor(ageYears(f, this.week))} with a record of ${f.wins}-${f.losses}${f.draws ? `-${f.draws}` : ""}${wasChamp ? ", as a reigning champion" : ""}.`, f.id, wasChamp ? 3 : 2,
        retirementStory(this.storyFighter(f), promo, wasChamp !== undefined, fights(f)));
    }
    f.status = "retired";
    for (const t of this.titlesOf(f.id)) this.vacate(t, "retired");
    if (f.contractId !== null) {
      const p = this.promotion(f.promotionId!);
      if (p) this.endContract(f, p);
    }
    f.retiredWeek = this.week;
    f.dirty = true;
    this.stats.retirements++;
    this.stats.retiredCareerFights.push(fights(f));
    this.cancelFutureBookings(f, "retired");
  }

  private cancelFutureBookings(f: FighterState, reason: string) {
    if (this.playerPromotionId === null) return;
    const rows = this.db.prepare(`SELECT b.id FROM booking b JOIN event e ON e.id = b.event_id
                                  WHERE b.status = 'booked' AND e.status = 'scheduled' AND (b.red_id = @id OR b.blue_id = @id)`).all({ id: f.id }) as { id: number }[];
    for (const r of rows) {
      this.repo.setBookingStatus(r.id, "cancelled", `${f.name} ${reason}`, null);
      this.repo.news(this.week, this.playerPromotionId, "cancelled", `${f.name} has ${reason}; a booked bout is off.`);
    }
  }

  private endContract(f: FighterState, p: PromotionState) {
    if (f.contractId === null) return;
    this.repo.endContract(f.contractId, this.week, Math.max(0, f.boutsRemaining));
    p.roster.delete(f.id);
    f.lastPromotionId = p.id;
    f.contractId = null;
    f.promotionId = null;
    f.boutsRemaining = 0;
    f.idleSince = this.week;
    if (f.status !== "active") return;
    // Champions always re-sign. Others re-sign unless they've outgrown the tier or fallen below it.
    const champ = this.isChampion(f.id);
    if (champ && champ.promotionId === p.id) { this.sign(f, p); return; }
    const tier = this.tierDef.get(p.tier)!;
    const higher = TIERS[TIERS.indexOf(tier) - 1];
    const ovr = overall(f.attrs);
    const outgrown = higher !== undefined && ovr >= higher.minOverall + 3;
    if (!outgrown && ovr >= tier.minOverall && f.lossStreak < 3 && this.rng.chance(0.65)) this.sign(f, p);
    else {
      for (const t of this.titlesOf(f.id)) if (t.promotionId === p.id) this.vacate(t, "left the promotion");
      this.cancelFutureBookings(f, "left the promotion");
    }
  }

  sign(f: FighterState, p: PromotionState, announce = false) {
    const tier = this.tierDef.get(p.tier)!;
    const bouts = p.tier === "global" ? this.rng.int(4, 6) : p.tier === "major" ? this.rng.int(3, 5) : this.rng.int(2, 3);
    const purse = Math.round(tier.basePurse * (0.6 + overall(f.attrs) / 80));
    const id = this.nextContractId++;
    this.repo.insertContract(id, f.id, p.id, this.week, bouts, purse);
    const moved = f.lastPromotionId !== undefined && f.lastPromotionId !== null && f.lastPromotionId !== p.id ? this.promotion(f.lastPromotionId) : undefined;
    f.contractId = id;
    f.promotionId = p.id;
    f.boutsRemaining = bouts;
    f.idleSince = null;
    p.roster.add(f.id);
    if (!announce || this.week === 0) return;
    const mine = p.id === this.playerPromotionId;
    const record = `(${f.wins}-${f.losses}${f.draws ? `-${f.draws}` : ""})`;
    if (mine) {
      this.news(p.id, "signing", `${f.name} ${record} signs a ${bouts}-fight deal with you${moved ? `, coming over from ${moved.name}` : ""}.`, f.id, 1,
        signingStory(this.storyFighter(f), p.name, divisionLabel(f.weightClassId), moved?.name ?? null, bouts));
    } else if ((p.tier === "global" || p.tier === "major") && (this.ranks.isNotable(f.id) || f.popularity >= 30 || moved?.tier === "global")) {
      this.news(p.id, "signing", `${p.name} signs ${divisionLabel(f.weightClassId).toLowerCase()} ${f.name} ${record}${moved ? `, leaving ${moved.name}` : ""}.`, f.id, this.tierImportance(p),
        signingStory(this.storyFighter(f), p.name, divisionLabel(f.weightClassId), moved?.name ?? null, bouts));
    }
  }

  /** Top tiers pick first from the free-agent pool, so talent flows upward. */
  fillRosters() {
    const free = [...this.fighters.values()]
      .filter((f) => f.status === "active" && f.contractId === null)
      .map((f) => ({ f, score: overall(f.attrs) * 10 + (f.rating - 1500) * 0.05, ovr: overall(f.attrs) }))
      .sort((a, b) => b.score - a.score);
    // Cast members of a reality season on air are under the show's contract.
    const taken = new Set<number>((this.db.prepare(`SELECT c.fighter_id FROM reality_cast c JOIN reality_season s ON s.id = c.season_id
                                                    WHERE s.status = 'airing'`).all() as { fighter_id: number }[]).map((r) => r.fighter_id));
    for (const tier of TIERS) {
      for (const p of this.promotions) {
        if (p.tier !== tier.tier) continue;
        let need = tier.rosterSize - p.roster.size;
        // Development shows sign on potential and youth, everyone else on current quality.
        const order = p.plan?.goal === "development" && need > 0
          ? [...free].sort((a, b) => (b.f.attrs.potential - ageYears(b.f, this.week) * 2) - (a.f.attrs.potential - ageYears(a.f, this.week) * 2))
          : free;
        for (const c of order) {
          if (need <= 0) break;
          if (taken.has(c.f.id) || c.ovr < tier.minOverall) continue;
          if (p.regionId !== null && c.f.regionId !== p.regionId && !this.rng.chance(0.08)) continue;
          this.sign(c.f, p, true);
          taken.add(c.f.id);
          need--;
        }
      }
    }
  }

  private yearTick() {
    const rng = this.rng;
    for (const f of this.fighters.values()) {
      if (f.status === "retired" || f.status === "deceased") continue;
      this.progress(f);
      const age = ageYears(f, this.week);
      if (age > 30) f.walkKg = Math.round((f.walkKg + rng.normal(0.25, 0.4)) * 10) / 10;
      f.missedWeight = Math.max(0, f.missedWeight - 1);
      decayPop(f, 0.92);
      const idleYears = f.idleSince === null ? 0 : (this.week - f.idleSince) / WEEKS_PER_YEAR;
      if (age >= 45 || (age > 40 && rng.chance(0.3)) || (idleYears >= 2 && rng.chance(0.5))) this.retire(f);
    }
    inductYear(this);
    yearlyBusiness(this);
    this.planYear();
    // Keep the active population near target with a new intake of young fighters.
    const active = [...this.fighters.values()].filter((f) => f.status === "active").length;
    const intake = Math.max(0, this.targetPopulation - active);
    for (let i = 0; i < intake; i++) {
      const age = clamp(rng.normal(22, 2), 19, 28);
      this.createFighter(this.week - Math.round(age * WEEKS_PER_YEAR));
      this.stats.debuts++;
    }
  }

  /** Yearly development: growth toward potential, plateau, then decline. */
  private progress(f: FighterState) {
    const rng = this.rng;
    const age = ageYears(f, this.week);
    const a = f.attrs;
    // Skills grow together toward potential, so a fighter keeps their style's shape.
    // Weak areas also round out a little each year as they cross-train for MMA.
    const mean = SKILL_KEYS.reduce((t, k) => t + a[k], 0) / SKILL_KEYS.length;
    const growth = age < 30 ? (a.potential - mean) * 0.12 : age < 34 ? 0.5 : -0.8 * (age - 33);
    for (const k of SKILL_KEYS) {
      const roundOut = a[k] < mean && age < 34 ? (mean - a[k]) * ROUND_OUT_PER_YEAR : 0;
      a[k] = Math.round(clamp(a[k] + growth + roundOut + rng.normal(0, 1.5), 5, 99));
    }
    for (const k of PHYSICAL_KEYS) {
      const growth = age < 27 ? (a.potential - a[k]) * 0.08 : age < 31 ? 0 : -(age - 30) * 0.9 - f.damage * 0.03;
      a[k] = Math.round(clamp(a[k] + growth + rng.normal(0, 1.2), 5, 99));
    }
    a.chin = Math.round(clamp(a.chin - f.damage * 0.05, 5, 99));
    // Soft-tissue wear heals partly between camps; older bodies heal less.
    const heal = age < 30 ? 0.75 : age < 35 ? 0.82 : 0.9;
    f.wear = { body: f.wear.body * heal, arms: f.wear.arms * heal, legs: f.wear.legs * heal };
    syncCoarse(a);
    f.dirty = true;
  }

  /** Write changed fighters and a yearly attribute snapshot. */
  flush() {
    const year = this.year;
    this.repo.tx(() => {
      for (const f of this.fighters.values()) {
        if (!f.dirty) continue;
        this.repo.saveFighter(f);
        if (f.status !== "retired" || f.retiredWeek === this.week) this.repo.saveAttrs(f, year);
        f.dirty = false;
      }
      this.repo.setWeek(this.week);
    });
    // Retired fighters stay in the database but leave working memory.
    for (const [id, f] of this.fighters) if (f.status === "retired" && !f.dirty) this.fighters.delete(id);
  }
}

const METHOD_WORDS: Record<string, string> = {
  KO: "KO", TKO: "TKO", SUB: "submission", DEC_U: "unanimous decision", DEC_S: "split decision", DEC_M: "majority decision", DRAW: "draw",
};

export function divisionLabel(id: number) {
  const wc = WEIGHT_CLASSES[id - 1];
  return wc ? `${wc.sex === "F" ? "Women's " : ""}${wc.name}` : "?";
}
