import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { makeDom } from "./dom.mjs";

const BASE = process.env.BASE || "http://127.0.0.1:8000";
const WEB = new URL("../../game/web/", import.meta.url).pathname;

const { doc, walk } = makeDom(`${WEB}/index.html`);
const errors = [];

const win = {
  document: doc,
  fetch: (u, o) => globalThis.fetch(u.startsWith("http") ? u : BASE + u, o),
  URLSearchParams,
  setTimeout, clearTimeout, setInterval, clearInterval,
  console,
  scrollTo() {},
  listeners: {},
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
  location: { href: BASE + "/", reload() {} },
  requestAnimationFrame: (f) => setTimeout(() => f(0), 16),
  devicePixelRatio: 1,
  innerWidth: 1400, innerHeight: 900, scrollY: 0,
  Chart: undefined,
};
win.window = win;
win.globalThis = win;
win.self = win;

const ctx = vm.createContext(win);
ctx.window.onerror = (msg, src, line, col, err) => { errors.push("onerror: " + msg + "\n" + (err && err.stack)); };

for (const f of ["app.js", "views.js", "views_b.js", "views_c.js"]) {
  const code = fs.readFileSync(`${WEB}/${f}`, "utf8");
  try {
    vm.runInContext(code, ctx, { filename: f });
  } catch (e) {
    console.log(`LOAD ERROR in ${f}:\n${e.stack}`);
    process.exit(1);
  }
}

try {
  vm.runInContext(`
    window.dispatchEvent_ = () => {
      (document.listeners.domcontentloaded || []).forEach(f => f({}));
    };
  `, ctx);
} catch (e) { /* listener names handled below */ }

// fire DOMContentLoaded (app.js registers with addEventListener on window)
const fired = vm.runInContext(`
  (() => {
    let n = 0;
    try { (window.listeners.DOMContentLoaded || []).forEach(f => { f({}); n++; }); } catch (e) { return 'THREW ' + e.stack; }
    return 'fired ' + n;
  })()
`, ctx);
console.log("DOMContentLoaded:", fired);
// every onclick handler must actually exist (missing ones fail silently in the
// browser: the click does nothing at all)
{
  const src = ["app.js", "views.js", "views_b.js", "views_c.js"]
    .map((f) => fs.readFileSync(path.join(WEB, f), "utf8")).join("\n");
  const names = new Set();
  for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*(?:Act|Modal))\s*\(/g)) names.add(m[1]);
  const missing = [...names].filter((n) => {
    try { return vm.runInContext(`typeof ${n}`, ctx) !== "function"; } catch { return true; }
  });
  console.log("handlers:", names.size, "checked |", missing.length ? "MISSING " + missing.join(", ") : "all defined");
}

if (process.env.SAVE) {
  const r = await vm.runInContext(`api("/api/load", {slug: "${process.env.SAVE}"}, "POST").then(r => { if (r.ok) S.state = r.state; return r.ok + " " + (r.state && r.state.game.year) })`, ctx);
  console.log("probe save:", r);
  await vm.runInContext(`startShell()`, ctx);
}

await new Promise((r) => setTimeout(r, 2500));

const view = doc.getElementById("view");
const report = vm.runInContext(`JSON.stringify({
  boot: document.getElementById("boot").className,
  topbar: document.getElementById("topbar").className,
  tabs: document.getElementById("tabs").className,
  main: document.getElementById("main").className,
  tabCount: document.getElementById("tabs").children.length,
  viewKids: document.getElementById("view").children.length,
  viewText: (document.getElementById("view").textContent || "").slice(0, 120),
  need: document.getElementById("need").children.length,
  ticker: document.getElementById("ticker").children.length,
  cash: document.getElementById("s-cash").textContent,
})`, ctx);
console.log("UI:", report);
// audit the produced DOM: unknown tag names (dots) mean a selector leaked into createElement
const audit = vm.runInContext(`
  (() => {
    const bad = [], byTag = {};
    const walk = (n) => {
      for (const c of n.children || []) {
        if (c.tagName && /[.#]/.test(c.tagName)) bad.push(c.tagName);
        if (c.tagName) byTag[c.tagName.toLowerCase()] = (byTag[c.tagName.toLowerCase()] || 0) + 1;
        walk(c);
      }
    };
    walk(document.body);
    return JSON.stringify({ bad: [...new Set(bad)].slice(0, 10), byTag });
  })()
`, ctx);
console.log("DOM audit:", audit);

const viewErr = vm.runInContext(`
  Views.lot(document.getElementById("view")).then(()=> "lot ok").catch(e => "LOT THREW: " + e.stack)
`, ctx);
console.log(await viewErr);
for (const t of ["paper", "talent", "casting", "scripts", "production", "releases", "franchises", "world", "finance", "awards"]) {
  const r = await vm.runInContext(`Views["${t}"](document.getElementById("view")).then(()=>"ok").catch(e=>"THREW: "+e.stack.split("\\n").slice(0,3).join(" | "))`, ctx);
  console.log(t.padEnd(11), r);
}
// ---- action probes: click the buttons, then check the world actually changed
{
  const acts = `
    (async () => {
      const j = async (p) => (await fetch(p)).json();
      const out = [];
      const wid = ((await j("/api/writers?limit=1")).rows || [])[0];
      const beforeStaff = ((await j("/api/writers?staff=1")).rows || []).length;
      if (wid) {
        await writerAct("hire", wid.id);
        const after = ((await j("/api/writers?staff=1")).rows || []).length;
        out.push("hire writer " + (after > beforeStaff ? "ok (" + beforeStaff + "->" + after + ")"
                                    : "FAILED (still " + after + ")"));
      }
      const sid = ((await j("/api/scripts/market?sort=price&dir=asc&limit=1")).rows || [])[0];
      if (sid) {
        const b = ((await j("/api/scripts/library")).rows || []).length;
        await scriptAct("buy", sid.id);
        const a = ((await j("/api/scripts/library")).rows || []).length;
        out.push("buy script " + (a > b ? "ok (" + b + "->" + a + ")" : "FAILED (still " + a + ")"));
      }
      const st = await j("/api/state");
      out.push("cash after: " + Math.round(st.game.cash));
      return out.join(" | ");
    })()
  `;
  console.log("ACTIONS:", await vm.runInContext(acts, ctx));
}

// ---- modal probes with real ids from this save
const probes = `
  (async () => {
    const j = async (p) => (await fetch(p)).json();
    const out = [];
    const st = await j("/api/state");
    const acts = await j("/api/actors?limit=1");
    const mkt = await j("/api/scripts/market?limit=1");
    const rel = await j("/api/releases?limit=1");
    const prods = st.productions || [], ready = st.ready || [];
    const fr = await j("/api/franchises");
    const tryIt = async (label, fn) => {
      try {
        await fn();
        const b = document.getElementById("modal-body");
        const m = document.getElementById("modal");
        const n = (b.innerHTML || "").length + (b.children.length ? 1 : 0);
        out.push(label + (m.className.indexOf("hidden") < 0 ? " shown" : " NOT-SHOWN") +
                 " (" + n + " html)");
      } catch (e) { out.push(label + " THREW: " + e.message); }
      hideModal();
    };
    if (acts.rows && acts.rows[0]) await tryIt("actorModal", () => actorModal(acts.rows[0].id));
    if (mkt.rows && mkt.rows[0]) await tryIt("scriptModal", () => scriptModal(mkt.rows[0].id));
    if (mkt.rows && mkt.rows[0]) await tryIt("greenlightModal", () => greenlightModal(mkt.rows[0].id));
    out.push("ids: prod=" + JSON.stringify(prods.map((p) => p.id)) +
             " ready=" + JSON.stringify(ready.map((p) => p.id)) +
             " rel=" + JSON.stringify((rel.rows || []).slice(0, 2).map((r) => r.id)) +
             " fr=" + JSON.stringify((fr.rows || []).slice(0, 2).map((r) => r.id)));
    if (prods[0]) await tryIt("productionModal", () => productionModal(prods[0].id));
    if (prods[0]) {
      const d = await j("/api/production?id=" + prods[0].id);
      const role = (d.roles || [])[0];
      if (role) await tryIt("auditionsModal", () => auditionsModal(prods[0].id, role.id));
    }
    if (rel.rows && rel.rows[0]) await tryIt("releaseModal", () => releaseModal(rel.rows[0].id));
    if (fr.rows && fr.rows[0]) await tryIt("franchiseModal", () => franchiseModal(fr.rows[0].id));
    await tryIt("studioMenu", () => studioMenu());
    const rv = (await j("/api/releases?limit=5")).rows || [];
    for (const m of rv) {
      const d = await j("/api/movie?id=" + m.id);
      if (d.has_review) { await tryIt("reviewModal", () => reviewModal(m.id, { archive: true })); break; }
    }
    S.paper = { abs: 0, chart: 10 };
    const pv = await Views.paper(document.getElementById("view")).then(() => "ok").catch((e) => "THREW " + e.message);
    out.push("paper back issue " + pv);
    S.paper = { abs: null, chart: 100 };
    const pv2 = await Views.paper(document.getElementById("view")).then(() => "ok").catch((e) => "THREW " + e.message);
    out.push("paper top100 " + pv2);
    return out.join(" | ");
  })()
`;
console.log("MODALS:\n  " + (await vm.runInContext(probes, ctx)));
// casting list must show your own people first, split by a separator
{
  const aud = `(async () => {
    const st = await (await fetch("/api/state")).json();
    const prod = (st.productions || [])[0]; if (!prod) return "no production on the slate";
    const d = await (await fetch("/api/production?id=" + prod.id)).json();
    const role = (d.roles || [])[0]; if (!role) return "no role";
    await auditionsModal(prod.id, role);
    const b = document.getElementById("modal-body");
    const t = (b.textContent || "").replace(/\\s+/g, " ");
    // the shim only matches simple selectors, so find the bars by class
    const seps = b.querySelectorAll("tr").filter((n) => n.classList.contains("sep"));
    const own = seps.filter((n) => n.classList.contains("own")).length;
    const town = seps.filter((n) => n.classList.contains("town")).length;
    const ownAt = t.indexOf("Your studio");
    const townAt = t.indexOf("Outside talent");
    const inhouseRows = b.querySelectorAll("tr").filter((n) => n.classList.contains("inhouse")).length;
    return "separators=" + seps.length + " (own=" + own + " town=" + town + ")" +
           " own-first=" + (ownAt >= 0 && townAt > ownAt) + " inhouse-rows=" + inhouseRows +
           " | " + t.slice(0, 150);
  })()`;
  console.log("CASTING:", await vm.runInContext(aud, ctx));
}

if (errors.length) console.log("ERRORS:\n" + errors.join("\n---\n"));
process.exit(0);
