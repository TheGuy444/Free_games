/**
 * Fight engine CLI.
 *   npm run fight -- --seed 7 --rounds 5     print one fight's play-by-play
 *   npm run fight -- --calibrate 5000        compare engine output with real-MMA ranges
 */
import { simulateFight } from "../core/fight/engine.js";
import { narrate, toText } from "../core/fight/narrate.js";
import { sampleFighter } from "../core/fight/sample.js";
import { overall, ratings } from "../core/model.js";
import { Rng } from "../core/rng.js";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const seed = Number(arg("seed") ?? Date.now() % 100000);
const rounds = Number(arg("rounds") ?? 3);
const calibrate = arg("calibrate");

if (calibrate) {
  const n = Number(calibrate);
  const rng = new Rng(seed);
  const m: Record<string, number> = {};
  let sig = 0, mins = 0, td = 0, kd = 0, subAtt = 0;
  for (let i = 0; i < n; i++) {
    const r = simulateFight(sampleFighter(rng, 1), sampleFighter(rng, 2), 3, rng.seed(), { log: false });
    m[r.method] = (m[r.method] ?? 0) + 1;
    mins += ((r.endRound - 1) * 300 + r.endTimeS) / 60;
    for (const rs of r.stats) for (const s of rs) { sig += s.sigLand; td += s.tdLand; kd += s.kd; subAtt += s.subAtt; }
  }
  const pct = (k: string[]) => ((k.reduce((s, x) => s + (m[x] ?? 0), 0) / n) * 100).toFixed(1) + "%";
  console.log(`${n} three-round fights between random fighters`);
  console.log(`  KO/TKO ${pct(["KO", "TKO"])}   SUB ${pct(["SUB"])}   decision ${pct(["DEC_U", "DEC_S", "DEC_M"])}   draw ${pct(["DRAW"])}`);
  console.log(`  sig. strikes landed per fighter per minute: ${(sig / 2 / mins).toFixed(2)}`);
  console.log(`  takedowns per fighter per 15 min: ${((td / 2 / mins) * 15).toFixed(2)}`);
  console.log(`  knockdowns per fight: ${(kd / n).toFixed(2)}   sub attempts per fight: ${(subAtt / n).toFixed(2)}`);
} else {
  const rng = new Rng(seed);
  const red = sampleFighter(rng, 1);
  const blue = sampleFighter(rng, 2);
  const show = (f: typeof red) => {
    const r = ratings(f.attrs);
    return `${f.name} (${f.archetype.replace(/_/g, " ")}) overall ${overall(f.attrs).toFixed(0)}, striking ${r.striking.toFixed(0)}, grappling ${r.grappling.toFixed(0)}, chin ${f.attrs.chin}`;
  };
  console.log(`RED:  ${show(red)}\nBLUE: ${show(blue)}\nSeed ${seed}, ${rounds} rounds`);
  const result = simulateFight(red, blue, rounds, rng.seed());
  console.log(toText(narrate(result, [red.name, blue.name])));
  const tot = (c: 0 | 1) => result.stats.reduce((s, r) => ({ sig: s.sig + r[c]!.sigLand, att: s.att + r[c]!.sigAtt, td: s.td + r[c]!.tdLand, kd: s.kd + r[c]!.kd }), { sig: 0, att: 0, td: 0, kd: 0 });
  for (const [c, f] of [[0, red], [1, blue]] as const) {
    const t = tot(c);
    console.log(`  ${f.name}: sig. strikes ${t.sig}/${t.att}, takedowns ${t.td}, knockdowns ${t.kd}`);
  }
  const winner = result.winner === null ? "Draw" : [red, blue][result.winner]!.name;
  console.log(`\nResult: ${winner} by ${result.method}, round ${result.endRound} at ${Math.floor(result.endTimeS / 60)}:${String(result.endTimeS % 60).padStart(2, "0")}`);
}
