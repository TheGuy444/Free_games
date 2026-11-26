/**
 * Halls of fame: one global, one per promotion.
 *
 * Every year, fighters who have been retired at least a year are scored on
 * their whole career (wins, finishes, title reigns weighted by promotion tier,
 * defenses, peak pound-for-pound rank). The best go into the global hall; each
 * global or major promotion (and yours) inducts its own greats by what they
 * did there. A new world starts with a class of legends from before the game.
 */
import { WEEKS_PER_YEAR, type Tier } from "./constants.js";
import { Rng } from "./rng.js";
import type { World } from "./world.js";
import { divisionLabel } from "./world.js";

export const GLOBAL_HOF = 0;
const TIER_WEIGHT: Record<Tier, number> = { global: 12, major: 7, regional: 2, local: 0.5 };
/** Career score needed for the global hall, and the most inducted per year. */
export const GLOBAL_THRESHOLD = 70;
export const GLOBAL_PER_YEAR = 3;
/** Promotion-hall score needed (from what they did in that promotion), and the most per promotion per year. */
export const COMPANY_THRESHOLD = 38;
export const COMPANY_PER_YEAR = 1;
/** Fighters stay eligible for this many years after they retire. */
const ELIGIBLE_YEARS = 15;

interface Candidate { id: number; name: string; wins: number; losses: number; draws: number; ko: number; sub: number; retired: number }
interface Reign { fighter_id: number; promotion_id: number; tier: Tier; name: string; wc: number; start_week: number; end_week: number | null; defenses: number }

export function inductYear(world: World) {
  const db = world.db;
  const week = world.week;
  const cands = db.prepare(`SELECT f.person_id AS id, p.first_name || ' ' || p.last_name AS name, f.wins, f.losses, f.draws, f.ko_wins AS ko, f.sub_wins AS sub, f.retired_week AS retired
                            FROM fighter f JOIN person p ON p.id = f.person_id
                            WHERE f.status = 'retired' AND f.retired_week BETWEEN @from AND @to AND f.wins >= 10`)
    .all({ from: week - ELIGIBLE_YEARS * WEEKS_PER_YEAR, to: week - WEEKS_PER_YEAR }) as Candidate[];
  if (cands.length === 0) return;
  const inducted = new Set((db.prepare("SELECT fighter_id || ':' || scope AS k FROM hall_of_fame").all() as { k: string }[]).map((r) => r.k));
  const reignsOf = db.prepare(`SELECT r.fighter_id, t.promotion_id, pr.tier, pr.name, t.weight_class_id AS wc, r.start_week, r.end_week, r.defenses
                               FROM title_reign r JOIN title t ON t.id = r.title_id JOIN promotion pr ON pr.id = t.promotion_id WHERE r.fighter_id = ?`);
  const peakP4P = db.prepare("SELECT MIN(rank) r FROM ranking_snapshot WHERE fighter_id = ? AND scope = 0 AND list = 0");
  const winsIn = db.prepare(`SELECT pr.id AS pid, pr.tier, COUNT(*) AS w FROM bout b JOIN event e ON e.id = b.event_id JOIN promotion pr ON pr.id = e.promotion_id
                             WHERE b.winner_id = ? GROUP BY pr.id`);
  const insert = db.prepare("INSERT INTO hall_of_fame (fighter_id, scope, week, score, citation) VALUES (?, ?, ?, ?, ?)");

  const global: { c: Candidate; score: number; citation: string }[] = [];
  const company = new Map<number, { c: Candidate; score: number; citation: string }[]>();
  for (const c of cands) {
    const reigns = reignsOf.all(c.id) as Reign[];
    const peak = (peakP4P.get(c.id) as { r: number | null }).r;
    let score = c.wins + (c.ko + c.sub) * 0.3 - c.losses * 0.3 + (peak !== null && peak <= 10 ? (11 - peak) * 2 : 0);
    for (const r of reigns) score += TIER_WEIGHT[r.tier] * (1 + r.defenses * 0.5);
    const cite = citation(world, c, reigns, peak);
    if (score >= GLOBAL_THRESHOLD && !inducted.has(`${c.id}:${GLOBAL_HOF}`)) global.push({ c, score, citation: cite });

    for (const w of winsIn.all(c.id) as { pid: number; tier: Tier; w: number }[]) {
      if (w.tier !== "global" && w.tier !== "major" && w.pid !== world.playerPromotionId) continue;
      if (inducted.has(`${c.id}:${w.pid}`)) continue;
      const mine = reigns.filter((r) => r.promotion_id === w.pid);
      const s = w.w * 1.5 + mine.reduce((t, r) => t + 8 * (1 + r.defenses * 0.5), 0);
      if (s >= COMPANY_THRESHOLD) company.set(w.pid, [...(company.get(w.pid) ?? []), { c, score: s, citation: citation(world, c, mine, peak) }]);
    }
  }
  const announce = (scope: number, list: { c: Candidate; score: number; citation: string }[], cap: number) => {
    for (const x of list.sort((a, b) => b.score - a.score).slice(0, cap)) {
      insert.run(x.c.id, scope, week, Math.round(x.score), x.citation);
      const promo = scope === GLOBAL_HOF ? null : world.promotion(scope);
      world.repo.news(week, scope === GLOBAL_HOF ? null : scope, "hall_of_fame",
        `${x.c.name} is inducted into the ${promo ? `${promo.name} Hall of Fame` : "MMA Hall of Fame"}. ${x.citation}`, x.c.id,
        scope === GLOBAL_HOF ? 3 : scope === world.playerPromotionId ? 2 : 1);
    }
  };
  announce(GLOBAL_HOF, global, GLOBAL_PER_YEAR);
  for (const [pid, list] of company) announce(pid, list, COMPANY_PER_YEAR);
}

function citation(world: World, c: Candidate, reigns: Reign[], peak: number | null): string {
  // One line per belt, however many times they won it.
  const belts = new Map<string, { r: Reign; from: number; to: number | null; defenses: number; times: number }>();
  for (const r of reigns) {
    const k = `${r.promotion_id}:${r.wc}`;
    const b = belts.get(k);
    if (!b) belts.set(k, { r, from: r.start_week, to: r.end_week, defenses: r.defenses, times: 1 });
    else { b.from = Math.min(b.from, r.start_week); b.to = r.end_week === null || b.to === null ? null : Math.max(b.to, r.end_week); b.defenses += r.defenses; b.times++; }
  }
  const parts = [...belts.values()].slice(0, 3).map((b) => {
    const y0 = world.yearOf(b.from), y1 = b.to === null ? null : world.yearOf(b.to);
    return `${b.times > 1 ? `${b.times}-time ` : ""}${b.r.name} ${divisionLabel(b.r.wc).toLowerCase()} champion (${y0}${y1 !== null && y1 !== y0 ? `-${y1}` : ""}${b.defenses ? `, ${b.defenses} defense${b.defenses === 1 ? "" : "s"}` : ""})`;
  });
  if (peak !== null && peak <= 10) parts.push(`peaked at #${peak} pound-for-pound`);
  return `${parts.length ? cap(parts.join("; ")) + ". " : ""}Career record ${c.wins}-${c.losses}${c.draws ? `-${c.draws}` : ""}, ${c.ko} knockouts and ${c.sub} submissions.`;
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Legends from before the game starts, so the halls aren't empty in a new
 * world. Uses its own random stream so it doesn't change the rest of the world.
 */
export function seedLegends(world: World, seed: number) {
  const rng = new Rng(seed ^ 0x4f0f);
  const insert = world.db.prepare("INSERT INTO hall_of_fame (fighter_id, scope, week, score, citation) VALUES (?, ?, ?, ?, ?)");
  const globalPool: { id: number; score: number; citation: string; week: number }[] = [];
  for (const p of world.promotions) {
    if (p.tier !== "global" && p.tier !== "major") continue;
    const n = p.tier === "global" ? rng.int(5, 7) : rng.int(2, 4);
    for (let i = 0; i < n; i++) {
      const retiredYearsAgo = rng.int(2, 28);
      const legend = world.spawnLegend(-retiredYearsAgo * WEEKS_PER_YEAR, rng);
      const wins = rng.int(p.tier === "global" ? 20 : 17, 32), losses = rng.int(2, 9);
      const ko = Math.round(wins * rng.next() * 0.55), sub = Math.round((wins - ko) * rng.next() * 0.5);
      const defenses = rng.int(p.tier === "global" ? 2 : 1, 9);
      const reignYears = Math.max(1, Math.round(defenses / 2.2));
      const end = world.opts.startYear - retiredYearsAgo - rng.int(0, 2);
      world.db.prepare("UPDATE fighter SET wins = ?, losses = ?, ko_wins = ?, sub_wins = ?, status = 'retired', retired_week = ? WHERE person_id = ?")
        .run(wins, losses, ko, sub, -retiredYearsAgo * WEEKS_PER_YEAR, legend.id);
      const citationText = `${p.name} ${divisionLabel(legend.weightClassId).toLowerCase()} champion (${end - reignYears}-${end}, ${defenses} defenses). Career record ${wins}-${losses}, ${ko} knockouts and ${sub} submissions.`;
      const inductedWeek = -Math.max(0, retiredYearsAgo - rng.int(1, 3)) * WEEKS_PER_YEAR;
      insert.run(legend.id, p.id, inductedWeek, Math.round(wins * 1.5 + 8 * (1 + defenses * 0.5)), citationText);
      const score = wins + (ko + sub) * 0.3 - losses * 0.3 + TIER_WEIGHT[p.tier] * (1 + defenses * 0.5);
      if (score >= GLOBAL_THRESHOLD) globalPool.push({ id: legend.id, score, citation: citationText, week: inductedWeek });
    }
  }
  for (const g of globalPool.sort((a, b) => b.score - a.score).slice(0, 12)) insert.run(g.id, GLOBAL_HOF, g.week, Math.round(g.score), g.citation);
}
