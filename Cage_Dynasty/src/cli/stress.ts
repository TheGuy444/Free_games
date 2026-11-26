/**
 * Stress test: run a career (player plus every AI promotion) for several years
 * and print what the calendar, money and roster look like each year, plus any
 * broken invariants.
 *   npm run stress -- --years 8 --scale 1 --seed 3
 */
import { WEEKS_PER_YEAR } from "../core/constants.js";
import { MIN_REST_WEEKS, World } from "../core/world.js";
import { openSave } from "../db/db.js";

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback; };
const years = Number(arg("years", "8")), scale = Number(arg("scale", "1")), seed = Number(arg("seed", "3"));
const db = openSave(arg("out", ":memory:"));
const t0 = performance.now();
const world = World.create(db, { seed, startYear: 2024, scale, playerTier: "major" });
console.log(`World: ${world.promotions.length} promotions, ${world.fighters.size} fighters (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
const money = (n: number) => (Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1000)}k`);
const problems: string[] = [];
const me = world.playerPromotionId;

for (let y = 1; y <= years; y++) {
  const from = world.week, ty = performance.now();
  world.advance(WEEKS_PER_YEAR);
  const secs = (performance.now() - ty) / 1000;
  const yr = world.year - 1;
  const rows = db.prepare(`SELECT p.tier, p.flavor, e.broadcast, COUNT(*) n, AVG(e.profit) profit, AVG(e.gate) gate, AVG(e.ppv_buys) buys,
                                  AVG(e.tv_viewers) tv, AVG(e.rating) rating, AVG((SELECT COUNT(*) FROM bout b WHERE b.event_id = e.id)) bouts
                           FROM event e JOIN promotion p ON p.id = e.promotion_id
                           WHERE e.week >= ? AND e.week < ? AND e.status = 'completed' AND p.id != ?
                           GROUP BY p.tier, p.flavor, e.broadcast
                           ORDER BY CASE p.tier WHEN 'global' THEN 0 WHEN 'major' THEN 1 WHEN 'regional' THEN 2 ELSE 3 END, p.flavor, e.broadcast`)
    .all(from, world.week, me) as { tier: string; flavor: string; broadcast: string; n: number; profit: number; gate: number; buys: number; tv: number; rating: number; bouts: number }[];
  const promos = db.prepare("SELECT tier, flavor, COUNT(*) n FROM promotion WHERE id != ? GROUP BY tier, flavor").all(me) as { tier: string; flavor: string; n: number }[];
  const cash = db.prepare("SELECT tier, MIN(cash) lo, AVG(cash) avg, SUM(cash < 0) broke, COUNT(*) n FROM promotion WHERE id != ? GROUP BY tier").all(me) as
    { tier: string; lo: number; avg: number; broke: number; n: number }[];
  const active = [...world.fighters.values()].filter((f) => f.status === "active");
  const signed = active.filter((f) => f.promotionId !== null).length;
  const pops = active.map((f) => f.popularity).sort((a, b) => b - a);
  const top50 = pops.slice(0, 50).reduce((a, b) => a + b, 0) / 50, mean = pops.reduce((a, b) => a + b, 0) / pops.length;
  console.log(`\n=== ${yr}: ${secs.toFixed(1)}s, ${active.length} active fighters, ${signed} signed, popularity top-50 ${top50.toFixed(0)} mean ${mean.toFixed(1)} ===`);
  for (const r of rows) {
    const per = promos.find((p) => p.tier === r.tier && p.flavor === r.flavor)?.n ?? 1;
    const reach = r.broadcast === "ppv" ? `buys ${Math.round(r.buys).toLocaleString("en-US")}` : `tv ${Math.round(r.tv).toLocaleString("en-US")}`;
    console.log(`  ${r.tier.padEnd(8)} ${String(r.flavor).padEnd(11)} ${r.broadcast.padEnd(4)} ${(r.n / per).toFixed(1).padStart(5)}/promo  ${r.bouts.toFixed(1)} bouts  rating ${r.rating?.toFixed(0)}  gate ${money(r.gate)}  ${reach}  profit ${money(r.profit)}`);
  }
  for (const c of cash) console.log(`  cash ${c.tier.padEnd(8)} avg ${money(c.avg)}  lowest ${money(c.lo)}  in the red ${c.broke}/${c.n}`);

  // Invariants.
  const twice = db.prepare(`SELECT fid, e.week, COUNT(*) n FROM (SELECT red_id fid, event_id FROM bout UNION ALL SELECT blue_id, event_id FROM bout) x
                            JOIN event e ON e.id = x.event_id WHERE e.week >= ? GROUP BY fid, e.week HAVING n > 1`).all(from);
  if (twice.length) problems.push(`${yr}: ${twice.length} fighters fought twice in one week`);
  const quick = db.prepare(`SELECT COUNT(*) n FROM (SELECT fid, week, LAG(week) OVER (PARTITION BY fid ORDER BY week) prev FROM
                              (SELECT b.red_id fid, e.week FROM bout b JOIN event e ON e.id = b.event_id UNION ALL SELECT b.blue_id, e.week FROM bout b JOIN event e ON e.id = b.event_id))
                            WHERE prev IS NOT NULL AND week >= ? AND week - prev < ?`).get(from, MIN_REST_WEEKS) as { n: number };
  if (quick.n) problems.push(`${yr}: ${quick.n} fights inside the ${MIN_REST_WEEKS}-week rest window`);
  for (const t of world.titles.values()) {
    if (t.champion === null) continue;
    const f = world.fighters.get(t.champion);
    if (!f || f.status === "retired") problems.push(`${yr}: title ${t.id} held by a retired or missing fighter`);
    else if (f.promotionId !== t.promotionId) problems.push(`${yr}: ${f.name} holds a title of a promotion he isn't signed to`);
  }
  const empty = db.prepare("SELECT COUNT(*) n FROM event e WHERE e.week >= ? AND e.status = 'completed' AND NOT EXISTS (SELECT 1 FROM bout b WHERE b.event_id = e.id)").get(from) as { n: number };
  if (empty.n) problems.push(`${yr}: ${empty.n} completed events with no bouts`);
  const nulls = db.prepare("SELECT COUNT(*) n FROM event WHERE week >= ? AND status = 'completed' AND (gate IS NULL OR rating IS NULL)").get(from) as { n: number };
  if (nulls.n) problems.push(`${yr}: ${nulls.n} events missing gate or rating`);
}
console.log(`\nTotal ${((performance.now() - t0) / 1000).toFixed(1)}s.`);
console.log(problems.length ? `Problems:\n  ${problems.join("\n  ")}` : "No invariant problems.");
