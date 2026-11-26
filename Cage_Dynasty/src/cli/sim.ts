/**
 * Headless runner: generate a world and simulate it with no UI.
 *   npm run sim -- --years 30 --scale 1 --seed 42 --out saves/test.sqlite
 * Prints throughput and the career-length distribution so we can check the
 * sim against the design targets.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { WEEKS_PER_YEAR } from "../core/constants.js";
import { World } from "../core/world.js";
import { openSave } from "../db/db.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const years = Number(arg("years", "10"));
const scale = Number(arg("scale", "1"));
const seed = Number(arg("seed", "42"));
const out = arg("out", "saves/sim.sqlite");

mkdirSync(dirname(out), { recursive: true });
for (const ext of ["", "-wal", "-shm"]) if (existsSync(out + ext)) rmSync(out + ext);

const t0 = performance.now();
const db = openSave(out);
const world = World.create(db, { seed, startYear: 1996, scale });
const tGen = performance.now();
console.log(`Generated world: ${world.promotions.length} promotions, ${world.fighters.size} fighters (${((tGen - t0) / 1000).toFixed(1)}s)`);

for (let y = 1; y <= years; y++) {
  const ty = performance.now();
  world.advance(WEEKS_PER_YEAR);
  if (y % 5 === 0 || y === years) {
    const active = [...world.fighters.values()].filter((f) => f.status === "active").length;
    console.log(`  year ${world.year}: ${active} active fighters, ${world.stats.bouts} bouts so far (${((performance.now() - ty) / 1000).toFixed(2)}s last year)`);
  }
}
world.flush();
const tSim = performance.now();

const careers = world.stats.retiredCareerFights.slice().sort((a, b) => a - b);
const pct = (p: number) => careers[Math.min(careers.length - 1, Math.floor(p * careers.length))] ?? 0;
const veterans = careers.filter((n) => n >= 10);
const vpct = (p: number) => veterans[Math.min(veterans.length - 1, Math.floor(p * veterans.length))] ?? 0;
const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;

console.log(`\nSimulated ${years} years in ${((tSim - tGen) / 1000).toFixed(1)}s`);
console.log(`Events: ${world.stats.events}, bouts: ${world.stats.bouts}, debuts: ${world.stats.debuts}, retirements: ${world.stats.retirements}`);
console.log(`Career length (all retirees, pro fights): p25 ${pct(0.25)}, median ${pct(0.5)}, p75 ${pct(0.75)}, p95 ${pct(0.95)}, max ${careers.at(-1) ?? 0}`);
console.log(`Career length (retirees with 10+ fights): p25 ${vpct(0.25)}, median ${vpct(0.5)}, p75 ${vpct(0.75)}, share 50+: ${((veterans.filter((n) => n >= 50).length / Math.max(1, veterans.length)) * 100).toFixed(1)}%`);
const methods = db.prepare("SELECT method, COUNT(*) n FROM bout GROUP BY method ORDER BY n DESC").all() as { method: string; n: number }[];
const total = methods.reduce((s, m) => s + m.n, 0);
console.log(`Methods: ${methods.map((m) => `${m.method} ${((m.n / total) * 100).toFixed(1)}%`).join(", ")}`);
console.log(`DB rows: person ${count("SELECT COUNT(*) n FROM person")}, bout ${count("SELECT COUNT(*) n FROM bout")}, contract ${count("SELECT COUNT(*) n FROM contract")}, attr_history ${count("SELECT COUNT(*) n FROM fighter_attr_history")}`);

// Sample query the UI will run constantly: one fighter's fight history.
const sample = db.prepare("SELECT red_id AS person_id FROM bout GROUP BY red_id ORDER BY COUNT(*) DESC LIMIT 1").get() as { person_id: number } | undefined;
if (sample) {
  const tq = performance.now();
  const rows = db.prepare(`SELECT * FROM bout WHERE red_id = @id UNION ALL SELECT * FROM bout WHERE blue_id = @id ORDER BY week`).all({ id: sample.person_id });
  console.log(`Fight-history query for a long career (${rows.length} bouts): ${(performance.now() - tq).toFixed(2)}ms`);
}
db.close();
