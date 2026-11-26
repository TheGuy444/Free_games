import { WEIGHT_CLASSES } from "./constants.js";
import type { FighterState } from "./model.js";
import type { World } from "./world.js";

/**
 * Rankings at four levels, all from one score:
 *   - worldwide pound-for-pound, across every promotion
 *   - company pound-for-pound, inside one promotion
 *   - worldwide division rankings
 *   - company division rankings (champion listed separately)
 * The score rewards results (rating), the level of competition (promotion
 * tier), belts and defenses, momentum, and penalises inactivity.
 */

export const P4P = 0;
export const WORLD = 0;

const TIER_BONUS = { global: 160, major: 95, regional: 40, local: 0 } as const;
const BELT_BONUS = { global: 160, major: 80, regional: 30, local: 8 } as const;
export const SNAPSHOT_EVERY = 4;
export const WORLD_LIST_SIZE = 25;
export const COMPANY_LIST_SIZE = 15;

export interface Ranked {
  fighter: FighterState;
  rank: number;
  score: number;
  /** Rank at the previous snapshot (same list), null if newly ranked or no history. */
  prev: number | null;
}

export interface FighterRanks {
  worldP4P: number | null;
  companyP4P: number | null;
  worldDivision: number | null;
  companyDivision: number | null; // 0 = champion
}

export class Rankings {
  private cacheWeek = -1;
  private world = new Map<number, Ranked[]>();       // list -> worldwide ranking
  private company = new Map<string, Ranked[]>();     // `${promotionId}:${list}` -> company ranking
  private prev = new Map<string, Map<number, number>>(); // `${scope}:${list}` -> fighter -> rank
  private notable = new Set<number>();
  private champs = new Map<number, { promotionId: number; defenses: number; belts: number }>();

  constructor(private readonly w: World) {}

  /** Ranking score shared by every list. */
  score(f: FighterState): number {
    const p = f.promotionId !== null ? this.w.promotion(f.promotionId) : undefined;
    const tier = p ? TIER_BONUS[p.tier] : -40;
    const belt = this.champs.get(f.id);
    // A double champ gets most of a second belt's bonus on top.
    const beltBonus = belt ? BELT_BONUS[this.w.promotion(belt.promotionId)?.tier ?? "local"] * (1 + (belt.belts - 1) * 0.6) + belt.defenses * 8 : 0;
    const idle = f.lastFightWeek === null ? 99 : this.w.week - f.lastFightWeek;
    const inactivity = idle > 52 ? (idle - 52) * 2.5 : 0;
    return f.rating + tier + beltBonus + Math.min(f.winStreak, 8) * 9 - f.lossStreak * 28 - inactivity;
  }

  private eligible(f: FighterState) {
    return f.status === "active" && f.wins + f.losses >= 3 && f.lastFightWeek !== null && this.w.week - f.lastFightWeek <= 78;
  }

  private ensure() {
    if (this.cacheWeek === this.w.week) return;
    this.cacheWeek = this.w.week;
    this.champs.clear();
    for (const t of this.w.titles.values()) {
      if (t.champion === null) continue;
      const prev = this.champs.get(t.champion);
      this.champs.set(t.champion, { promotionId: t.promotionId, defenses: (prev?.defenses ?? 0) + t.defenses, belts: (prev?.belts ?? 0) + 1 });
    }
    this.world.clear();
    this.company.clear();
    const scored = [...this.w.fighters.values()].filter((f) => this.eligible(f)).map((f) => ({ f, s: this.score(f) }));
    scored.sort((a, b) => b.s - a.s);
    const mk = (list: { f: FighterState; s: number }[], key: string, size: number): Ranked[] =>
      list.slice(0, size).map((x, i) => ({ fighter: x.f, rank: i + 1, score: Math.round(x.s), prev: this.prev.get(key)?.get(x.f.id) ?? null }));
    this.world.set(P4P, mk(scored, `${WORLD}:${P4P}`, WORLD_LIST_SIZE));
    for (let wc = 1; wc <= WEIGHT_CLASSES.length; wc++) {
      this.world.set(wc, mk(scored.filter((x) => x.f.weightClassId === wc), `${WORLD}:${wc}`, WORLD_LIST_SIZE));
    }
    this.notable = new Set<number>();
    for (const list of this.world.values()) for (const r of list) if (r.rank <= 15) this.notable.add(r.fighter.id);
    for (const t of this.w.titles.values()) {
      const tier = this.w.promotion(t.promotionId)?.tier;
      if (t.champion !== null && (tier === "global" || tier === "major")) this.notable.add(t.champion);
    }
  }

  /** Worldwide list: P4P (list 0) or a weight class id. */
  worldList(list: number): Ranked[] {
    this.ensure();
    return this.world.get(list) ?? [];
  }

  /**
   * Company list: P4P (list 0, champions included) or a division (champion
   * excluded, they sit above #1). Built from the whole roster, so new signings
   * can be ranked before their first fight in the promotion.
   */
  companyList(promotionId: number, list: number, size = COMPANY_LIST_SIZE): Ranked[] {
    this.ensure();
    const key = `${promotionId}:${list}`;
    const hit = this.company.get(key);
    if (hit) return hit.slice(0, size);
    const p = this.w.promotion(promotionId);
    if (!p) return [];
    const champ = list === P4P ? null : this.w.championOf(promotionId, list);
    const roster = [...p.roster].map((id) => this.w.fighters.get(id)!).filter((f) => f && f.status === "active" &&
      (list === P4P ? f.wins + f.losses >= 1 : f.weightClassId === list && f.id !== champ));
    const ranked = roster.map((f) => ({ f, s: this.score(f) })).sort((a, b) => b.s - a.s)
      .map((x, i) => ({ fighter: x.f, rank: i + 1, score: Math.round(x.s), prev: this.prev.get(key)?.get(x.f.id) ?? null }));
    this.company.set(key, ranked);
    return ranked.slice(0, size);
  }

  /** Full company division order (used by matchmaking and callouts). */
  companyOrder(promotionId: number, list: number): FighterState[] {
    return this.companyList(promotionId, list, 10_000).map((r) => r.fighter);
  }

  ranksOf(f: FighterState): FighterRanks {
    const find = (list: Ranked[]) => list.find((r) => r.fighter.id === f.id)?.rank ?? null;
    const p = f.promotionId;
    const champ = p !== null && this.w.championOf(p, f.weightClassId) === f.id;
    return {
      worldP4P: find(this.worldList(P4P)),
      worldDivision: find(this.worldList(f.weightClassId)),
      companyP4P: p !== null ? find(this.companyList(p, P4P)) : null,
      companyDivision: champ ? 0 : p !== null ? find(this.companyList(p, f.weightClassId)) : null,
    };
  }

  /** Ranked worldwide (top 15 of a list) or a top-tier champion: worth a headline. */
  isNotable(id: number): boolean {
    this.ensure();
    return this.notable.has(id);
  }

  /** Store a snapshot of worldwide lists (and the player's lists) and remember it for movement arrows. */
  snapshot() {
    this.cacheWeek = -1;
    this.ensure();
    const rows: [number, number, number, number, number, number][] = [];
    const remember = (key: string, list: Ranked[]) => this.prev.set(key, new Map(list.map((r) => [r.fighter.id, r.rank])));
    for (const [list, ranked] of this.world) {
      remember(`${WORLD}:${list}`, ranked);
      for (const r of ranked) rows.push([this.w.week, WORLD, list, r.rank, r.fighter.id, r.score]);
    }
    const mine = this.w.playerPromotionId;
    if (mine !== null) {
      for (let list = 0; list <= WEIGHT_CLASSES.length; list++) {
        const ranked = this.companyList(mine, list);
        remember(`${mine}:${list}`, ranked);
        for (const r of ranked) rows.push([this.w.week, mine, list, r.rank, r.fighter.id, r.score]);
      }
    }
    this.w.repo.insertRankings(rows);
    // Movement arrows for other companies compare against the last time they were viewed.
    for (const [key, ranked] of this.company) if (!key.startsWith(`${mine}:`)) remember(key, ranked);
    this.cacheWeek = -1;
  }

  /** On load, restore the last snapshot so movement arrows survive a restart. */
  restore() {
    const last = this.w.db.prepare("SELECT MAX(week) w FROM ranking_snapshot").get() as { w: number | null };
    if (last.w === null) return;
    const rows = this.w.db.prepare("SELECT scope, list, rank, fighter_id FROM ranking_snapshot WHERE week = ?").all(last.w) as { scope: number; list: number; rank: number; fighter_id: number }[];
    for (const r of rows) {
      const key = `${r.scope}:${r.list}`;
      const m = this.prev.get(key) ?? new Map<number, number>();
      m.set(r.fighter_id, r.rank);
      this.prev.set(key, m);
    }
  }

  invalidate() {
    this.cacheWeek = -1;
  }
}
