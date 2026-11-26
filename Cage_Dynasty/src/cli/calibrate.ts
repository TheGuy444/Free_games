/**
 * Engine calibration: overall finish rates and output, then how each martial
 * art plays out (shots vs clinch takedowns, top vs bottom, where subs come from).
 *   npm run calibrate [-- --n 3000]
 */
import { DISCIPLINES, type DisciplineCode } from "../core/constants.js";
import { simulateFight } from "../core/fight/engine.js";
import { sampleFighter } from "../core/fight/sample.js";
import { overall } from "../core/model.js";
import { Rng } from "../core/rng.js";

const arg = (n: string, d: number) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const N = arg("n", 3000);
const rng = new Rng(2024);

// ---- Overall, random fighters
let ko = 0, sub = 0, dec = 0, sigLand = 0, minutes = 0, td = 0;
for (let i = 0; i < N; i++) {
  const r = simulateFight(sampleFighter(rng, 1), sampleFighter(rng, 2), 3, rng.seed(), { log: false });
  if (r.method === "KO" || r.method === "TKO") ko++; else if (r.method === "SUB") sub++; else dec++;
  minutes += ((r.endRound - 1) * 300 + r.endTimeS) / 60;
  for (const rs of r.stats) for (const c of rs) { sigLand += c.sigLand; td += c.tdLand; }
}
const pct = (x: number, n = N) => `${((100 * x) / n).toFixed(0)}%`;
console.log(`Overall (${N} three-round fights): KO/TKO ${pct(ko)}, SUB ${pct(sub)}, DEC ${pct(dec)}`);
console.log(`  sig strikes landed per fighter-minute ${(sigLand / minutes / 2).toFixed(2)}, takedowns per fighter per 15 min ${(td / minutes / 2 * 15).toFixed(2)}`);

// ---- Each style vs a random field
const STYLES = DISCIPLINES.map((d) => d.code as DisciplineCode);
console.log("\nStyle vs random field, same talent distribution; ovrΔ = average overall edge (per fighter per 15 min unless noted)");
console.log("style        ovrΔ  win%  KO%  SUB%  shots  clinchTD  pulls  TD%   top%  bottom%  topSubAtt  botSubAtt  subWins top/bot");
for (const style of STYLES) {
  const n = Math.round(N / 4);
  let gapSum = 0, wins = 0, kos = 0, subs = 0, shots = 0, clinchTd = 0, pulls = 0, tdLand = 0, tdAtt = 0, topT = 0, botT = 0, topSub = 0, botSub = 0, subTop = 0, subBot = 0, mins = 0;
  for (let i = 0; i < n; i++) {
    const a = sampleFighter(rng, 1, 28, style), b = sampleFighter(rng, 2);
    gapSum += overall(a.attrs) - overall(b.attrs);
    const r = simulateFight(a, b, 3, rng.seed(), { log: true });
    if (r.winner === 0) { wins++; if (r.method === "KO" || r.method === "TKO") kos++; if (r.method === "SUB") subs++; }
    mins += ((r.endRound - 1) * 300 + r.endTimeS) / 60;
    let top: 0 | 1 | null = null, last = 0, round = 1;
    const close = (t: number) => { if (top === 0) topT += t - last; else if (top === 1) botT += t - last; };
    for (const e of r.events) {
      if (e.r !== round) { round = e.r; top = null; last = 0; }
      if (e.a === 0 && e.k === "td_attempt") { tdAtt++; if (e.x === "trip" || e.x === "throw") clinchTd++; else shots++; }
      if (e.a === 0 && e.k === "td_land") tdLand++;
      if (e.a === 0 && e.k === "pull_guard") pulls++;
      if (e.k === "sub_attempt" && e.a === 0) { if (top === 0) topSub++; else if (top === 1) botSub++; }
      if (e.k === "sub_win" && e.a === 0) { if (top === 0) subTop++; else if (top === 1) subBot++; }
      const ground = e.k === "td_land" || e.k === "sweep" || e.k === "pull_guard" || (e.k === "knockdown");
      const stand = e.k === "get_up" || e.k === "ref_standup" || e.k === "round_end" || e.k === "clinch_break";
      if (ground) { close(e.t); last = e.t; top = e.k === "pull_guard" ? (e.a === 0 ? 1 : 0) : (e.a === 0 ? 0 : 1); }
      else if (stand) { close(e.t); top = null; last = e.t; }
    }
    void topT;
  }
  const per15 = (x: number) => (x / mins * 15).toFixed(2).padStart(5);
  const secs = mins * 60;
  console.log(`${style.padEnd(11)} ${(gapSum / n).toFixed(1).padStart(5)} ${pct(wins, n).padStart(4)} ${pct(kos, n).padStart(4)} ${pct(subs, n).padStart(5)}  ${per15(shots)}  ${per15(clinchTd).padStart(8)}  ${per15(pulls)}  ${pct(tdLand, Math.max(1, tdAtt)).padStart(4)}  ${pct(topT, secs).padStart(4)}  ${pct(botT, secs).padStart(7)}  ${per15(topSub).padStart(9)}  ${per15(botSub).padStart(9)}  ${subTop}/${subBot}`);
}

// ---- Traits: a fighter with the trait vs a random field (either corner's finishes count)
console.log("\nTraits vs random field");
console.log("trait            win%  fights ending KO/TKO  SUB  DEC   shots/15  power share");
for (const trait of ["ko_artist", "lives_on_shot", "loves_to_strike", "brawler", "safe_fighter", "slow_starter"]) {
  const n = Math.round(N / 4);
  let wins = 0, ko = 0, subs = 0, dec = 0, shots = 0, power = 0, strikes = 0, mins = 0;
  for (let i = 0; i < n; i++) {
    const a = sampleFighter(rng, 1, 28, trait === "lives_on_shot" || trait === "loves_to_strike" ? "WRES_FREE" : undefined), b = sampleFighter(rng, 2);
    a.traits = [trait];
    const r = simulateFight(a, b, 3, rng.seed(), { log: true });
    if (r.winner === 0) wins++;
    if (r.method === "KO" || r.method === "TKO") ko++; else if (r.method === "SUB") subs++; else dec++;
    mins += ((r.endRound - 1) * 300 + r.endTimeS) / 60;
    for (const e of r.events) if (e.a === 0) {
      if (e.k === "td_attempt" && e.x !== "trip" && e.x !== "throw") shots++;
      if (e.k === "strike_land" || e.k === "strike_miss" || e.k === "strike_block" || e.k === "big_strike") { strikes++; if (["cross", "hook", "uppercut", "overhand", "combo", "head_kick"].includes(e.x ?? "")) power++; }
    }
  }
  console.log(`${trait.padEnd(16)} ${pct(wins, n).padStart(4)}  ${pct(ko, n).padStart(19)}  ${pct(subs, n).padStart(4)} ${pct(dec, n).padStart(4)}   ${(shots / mins * 15).toFixed(2).padStart(7)}  ${pct(power, Math.max(1, strikes)).padStart(10)}`);
}
