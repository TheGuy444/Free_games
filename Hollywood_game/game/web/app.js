// Hollywood Tycoon - dashboard core: API client, shell, clock, ticker.
"use strict";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

// el("div.panel-h.gold", {onclick}, ...kids) builds <div class="panel-h gold">.
// document.createElement() does not understand selector syntax, so the tag
// string is parsed here - tag, optional #id and any number of .classes.
function el(tag, attrs = {}, ...kids) {
  // "div.panel-h.mut extra" -> <div class="panel-h mut extra">; attrs.class is merged in.
  const toks = String(tag).trim().split(/\s+/).filter(Boolean);
  const head = toks.shift() || "div";
  const m = /^(\w+)((?:[#.][\w-]+)*)$/.exec(head);
  if (!m) throw new Error("el(): bad tag " + tag);
  const n = document.createElement(m[1]);
  const cls = toks.slice();
  let id = null;
  for (const p of (m[2] || "").match(/[#.][\w-]+/g) || []) {
    if (p[0] === "#") id = p.slice(1);
    else cls.push(p.slice(1));
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") cls.push(...String(v).split(/\s+/).filter(Boolean));
    else if (k === "id") id = String(v);
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  if (cls.length) n.className = cls.join(" ");
  if (id) n.id = id;
  for (let kid of kids.flat(4)) {
    if (kid === null || kid === undefined || kid === false || kid === "") continue;
    n.appendChild(kid && kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

// Put a node (not a string) into a host element, clearing whatever was there.
function setHTML(host, node) {
  host.innerHTML = "";
  if (node) host.appendChild(node);
}

// ---------------------------------------------------------------- formatting
const money = (v, dp) => {
  if (v === null || v === undefined || isNaN(v)) return "—";
  const s = v < 0 ? "-" : "", a = Math.abs(v);
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e4) return `${s}$${(a / 1e3).toFixed(0)}K`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(1)}K`;
  return `${s}$${a.toFixed(dp === undefined ? 0 : dp)}`;
};
const n0 = (v) => (v === null || v === undefined || isNaN(v) ? "—" : Math.round(v).toLocaleString());
const n1 = (v) => (v === null || v === undefined || isNaN(v) ? "—" : (+v).toFixed(1));
const pc = (v) => (v === null || v === undefined || isNaN(v) ? "—" : `${v >= 0 ? "" : "-"}${Math.abs(v).toFixed(0)}%`);
const signClass = (v) => (v > 0 ? "pos" : v < 0 ? "neg" : "mut");
const esc = (s) => String(s === null || s === undefined ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ------------------------------------------------------------------ API
async function api(path, params = {}, method = "GET") {
  let url = path;
  const opt = { method, headers: {} };
  if (method === "GET") {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== null && v !== undefined && v !== "") qs.append(k, v);
    }
    const q = qs.toString();
    if (q) url += "?" + q;
  } else {
    opt.headers["Content-Type"] = "application/json";
    opt.body = JSON.stringify(params);
  }
  const res = await fetch(url, opt);
  let data;
  try { data = await res.json(); } catch (e) { data = { ok: false, error: "bad json" }; }
  if (data.ok === false && data.error && !data.soft) toast(data.error, true);
  return data;
}

let toastTimer = null;
function toast(msg, bad = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (bad ? " bad" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 3400);
}

// ------------------------------------------------------------------- state
const S = {
  state: null,
  cfg: null,
  tab: "lot",
  speed: 0,          // 0 paused, 1..3 running
  busy: false,
  filters: {},
  modalOpen: false,
};
const TABS = [
  ["lot", "Lot"], ["paper", "Newspaper"], ["talent", "Talent"], ["casting", "Casting"], ["scripts", "Scripts"],
  ["production", "Production"], ["releases", "Releases"], ["franchises", "Franchises"],
  ["world", "World"], ["finance", "Finances"], ["awards", "Awards"],
];
const SPEED_MS = { 1: 1500, 2: 700, 3: 260 };
const SPEED_LABEL = { 0: "paused", 1: "1×", 2: "2×", 3: "4×" };

// ------------------------------------------------------------------ shell
async function boot() {
  S.cfg = await api("/api/config");
  // If the launcher already opened a studio (run.py --new / --load), that wins.
  // Never quietly load some other save over the player's shoulder.
  if (S.cfg.current) {
    const st = await api("/api/state");
    if (st.ok && st.game) S.state = st;
  }
  if (!S.state) showNewGame();
  else startShell();
}

function showNewGame() {
  $("#boot").classList.add("hidden");
  $("#topbar").classList.add("hidden");
  $("#tabs").classList.add("hidden");
  $("#main").classList.remove("hidden");
  const v = $("#view");
  v.innerHTML = "";
  const presets = [["indie", "Garage", "scrape together a negative"],
                   ["studio", "Row Studio", "a real lot, real debts"],
                   ["major", "Backlot Major", "money, and everyone knows it"]];
  const years = (S.cfg.start_years || [1928]);
  let chosen = { preset: "studio", start: 1928, name: "Meridian Pictures", actors: 5200 };
  const presetRow = el("div.opt-row");
  presets.forEach(([id, label, note]) => {
    const o = el("div.opt", { class: chosen.preset === id ? "opt on" : "opt",
      onclick: () => { chosen.preset = id; sync(); } }, label, el("span.s", {}, note));
    o.dataset.k = "preset:" + id; presetRow.appendChild(o);
  });
  const yearRow = el("div.opt-row");
  years.forEach((y) => {
    const o = el("div.opt", { class: chosen.start === y ? "opt on" : "opt",
      onclick: () => { chosen.start = y; sync(); } }, String(y));
    o.dataset.k = "start:" + y; yearRow.appendChild(o);
  });
  const nameIn = el("input", { type: "text", value: chosen.name, maxlength: 40,
    oninput: (e) => chosen.name = e.target.value });
  const sizeIn = el("select", { onchange: (e) => chosen.actors = +e.target.value },
    el("option", { value: 3000 }, "Small town · 3,000 players"),
    el("option", { value: 5200, selected: "selected" }, "Tinseltown · 5,200 players"),
    el("option", { value: 9000 }, "Studio city · 9,000 players"),
    el("option", { value: 15000 }, "Golden age sprawl · 15,000 players"));
  function sync() {
    $$(".opt", v).forEach((o) => {
      const [k, val] = o.dataset.k.split(":");
      o.classList.toggle("on", (k === "preset" && chosen.preset === val) ||
                               (k === "start" && chosen.start === +val));
    });
  }
  async function go() {
    $("#boot").classList.remove("hidden");
    const r = await api("/api/new_game", chosen, "POST");
    if (r.ok) { S.state = r.state; startShell(); toast(`${r.state.game.name} opens its doors.`); }
    else $("#boot").classList.add("hidden");
  }
  const saveRow = el("div.chips");
  (S.cfg.saves || []).forEach((s) => saveRow.appendChild(
    el("div.chip", { onclick: async () => {
      const r = await api("/api/load", { slug: s.slug }, "POST");
      if (r.ok) { S.state = r.state; startShell(); }
    } }, `${s.name} · ${s.year}`)));
  v.appendChild(el("div.newgame", {},
    el("div.panel", {},
      el("div.panel-h", {}, el("h2", {}, "Open a studio")),
      el("div.panel-b", {},
        el("div.title-big", {}, "HOLLYWOOD TYCOON"),
        el("div.filmstrip"),
        el("div.mut", {}, "Buy the scripts. Cast the faces. Ride the depressions, the wars, the talkies, the tube. Own the century."),
        el("div", {}, el("label.f", {}, "Studio name"), el("br"), nameIn),
        el("div", {}, el("label.f", {}, "Starting money"), presetRow),
        el("div", {}, el("label.f", {}, "Begin in"), yearRow),
        el("div", {}, el("label.f", {}, "Talent pool"), sizeIn),
        el("div.modal-actions", {},
          el("button.btn.gold", { onclick: go }, "Found the studio")),
        (S.cfg.saves || []).length ? el("div", { style: "margin-top:14px" },
          el("label.f", {}, "or resume"), el("div.chips", {}, saveRow)) : null))));
  $("#side").classList.add("hidden");   // hide it - never destroy #need / #ticker
}

function startShell() {
  $("#boot").classList.add("hidden");
  ["#topbar", "#tabs", "#main", "#side"].forEach((s) => $(s).classList.remove("hidden"));
  renderTabs();
  renderTop();
  renderSide();
  renderView();
}

function renderTabs() {
  const t = $("#tabs");
  if (!S.state) { t.innerHTML = ""; return; }
  t.innerHTML = "";
  for (const [id, label] of TABS) {
    let badge = null;
    if (id === "production" && (S.state.ready || []).length) badge = S.state.ready.length;
    if (id === "franchises" && S.state.offers_open) badge = S.state.offers_open;
    if (id === "world" && (S.state.events || []).some((e) => e.choice)) badge = S.state.events.filter((e) => e.choice).length;
    if (id === "paper" && S.state.reviews_unseen_count) badge = S.state.reviews_unseen_count;
    t.appendChild(el("button.tab" + (S.tab === id ? " on" : ""), {
      onclick: () => { S.tab = id; renderTabs(); renderView(); } },
      label, badge ? el("span.badge", {}, badge) : null));
  }
}

function renderTop() {
  if (!S.state) return;
  const g = S.state.game;
  $("#studio-name").textContent = g.name;
  $("#era-line").textContent = `${g.era} · ${g.start_year} start`;
  $("#s-date").textContent = `${g.year} · wk ${g.week + 1}`;
  const cash = $("#s-cash");
  cash.textContent = money(g.cash);
  cash.className = "v " + (g.cash < 0 ? "neg" : "");
  $("#s-val").textContent = money(g.valuation);
  $("#s-prestige").textContent = n0(g.prestige);
  const rep = $("#s-rep");
  rep.textContent = n0(g.reputation);
  rep.className = "v " + (g.reputation < -10 ? "neg" : g.reputation > 10 ? "pos" : "");
  $("#s-films").textContent = n0((g.stats || {}).releases || 0);
  $("#clock-dot").className = "clock-dot" + (S.speed ? " run" : "");
}

function renderSide() {
  if (!S.state) return;
  const need = $("#need"), tick = $("#ticker");
  need.innerHTML = ""; tick.innerHTML = "";
  const st = S.state;
  const items = [];
  for (const r of st.ready || [])
    items.push({ t: `"${r.title}" is finished`, d: `${r.genre} · quality ${n0(r.quality)} · release it when you're ready`,
      btns: [["Release", () => doRelease(r.id)],] });
  for (const o of (st.offers || []).filter((x) => x.status === "open"))
    items.push(o.buyable
      ? { t: `For sale: ${o.asset_label}`, d: `${o.from} asks ${money(o.amount)}`,
          btns: [["Buy", () => buyOffer(o.id)], ["Rights desk", () => { S.tab = "franchises"; renderTabs(); renderView(); }]] }
      : { t: `${o.from} wants ${o.asset_label || o.asset || "something"}`,
          d: `${money(o.amount)} on the table · ${o.kind}${o.verdict ? " · " + o.verdict : ""}`,
          btns: [["Accept", () => sellOffer(o.id, true)], ["Tear it up", () => sellOffer(o.id, false)]] });
  for (const e of (st.events || []).filter((x) => x.choice))
    items.push({ t: e.name, d: e.choice.question || "The board wants a decision.",
      btns: (e.choice.options || []).map((op) => [op.label, () => eventChoice(e.id, op.id)]) });
  if (st.game.cash < 0)
    items.push({ t: "The bank is calling", d: `overdraft ${money(st.game.cash)} — borrow or sell something`,
      btns: [["Finances", () => { S.tab = "finance"; renderTabs(); renderView(); }]] });
  for (const p of (st.productions || []).filter((x) => x.status !== "ready" && (x.cast_count || 0) < (x.roles_total || 0)))
    items.push({ t: `"${p.title}" needs a cast`, d: `${n0(p.cast_count)}/${n0(p.roles_total)} parts filled · empty parts drag quality down`,
      btns: [["Cast it", () => productionModal(p.id)]] });
  if (!(st.productions || []).length && !(st.ready || []).length)
    items.push({ t: "Nothing on the slate", d: "greenlight a script from the Scripts tab",
      btns: [["Scripts", () => { S.tab = "scripts"; renderTabs(); renderView(); }]] });
  if (!items.length) items.push({ t: "All quiet on the lot.", d: "roll the calendar forward." });
  items.forEach((it) => need.appendChild(el("div.need-item", {},
    el("div.t", {}, it.t), el("div.d", {}, it.d),
    el("div.row", {}, (it.btns || []).map(([label, fn]) =>
      el("button.btn.sm", { onclick: fn }, label))))));

  for (const l of st.log || []) {
    const cls = "tick-item" + (l.weight >= 3 ? " big" : "") +
      (["bankrupt", "flop", "death", "scandal", "strike", "blacklist"].includes(l.kind) ? " bad" : "");
    tick.appendChild(el("div", { class: cls },
      el("div.d", {}, `${l.year}${l.week ? "·w" + (l.week + 1) : ""} · ${l.kind}`),
      el("div", {}, l.title),
      l.text ? el("div.d", { html: esc(l.text) }) : null));
  }
}

async function renderView() {
  if (!S.state) { setHTML($("#view"), el("div.empty", {}, "no studio yet - pick one from the menu")); return; }
  const y = window.scrollY;
  const v = $("#view");
  setHTML(v, el("div.empty", {}, "loading…"));
  try {
    await Views[S.tab](v);
  } catch (e) {
    setHTML(v, el("div.empty", {}, "this tab broke: " + e.message));
    console.error("view " + S.tab, e);
  }
  window.scrollTo(0, y);
}

// --------------------------------------------------------------- refreshers
async function refreshState() {
  const s = await api("/api/state");
  if (s.ok) { S.state = s; renderTop(); renderTabs(); renderSide(); checkCeremony(); }
}

// ------------------------------------------------------------ awards night
// A new ceremony pauses the clock and takes the stage. It is marked as seen
// the moment it opens, so closing it any way (button, Escape, backdrop) is fine.
function checkCeremony() {
  const c = S.state && S.state.ceremony;
  if (!c || S.modalOpen || S.ceremonyShown === c.year) return;
  S.ceremonyShown = c.year;
  api("/api/ceremony", { action: "seen" }, "POST");
  showCeremony(c);
}

function showCeremony(c, replay = false) {
  const mineWins = (c.ours || []).length;
  let step = 0;
  const delay = () => `animation-delay:${(0.35 + 0.55 * step++).toFixed(2)}s`;
  const card = el("div.panel.ceremony", {},
    el("div.panel-h", {}, el("h2", {}, replay ? `${c.year} ceremony (replay)` : "Awards night"),
      el("div.right", {},
        el("button.btn.sm", { onclick: () => card.classList.add("instant") }, "skip to results"),
        el("button.btn.sm", { onclick: hideModal }, "close"))),
    el("div.panel-b", {},
      el("div.cer-title", {}, `THE ${c.year} AWARDS`),
      el("div.cer-sub", {}, "Four juries, one long night, and every studio in town in black tie."),
      el("div.cer-tally" + (mineWins ? "" : ".shut"), {},
        mineWins
          ? `${c.studio} takes home ${mineWins} award${mineWins === 1 ? "" : "s"} from ${c.noms} nomination${c.noms === 1 ? "" : "s"}.`
          : c.noms ? `${c.noms} nomination${c.noms === 1 ? "" : "s"} for ${c.studio}, and not a single statuette. Next year.`
            : `${c.studio} was not nominated for anything. The town noticed.`),
      (c.bodies || []).map((b) => el("div.cer-body", {},
        el("h3", {}, b.name),
        el("div.blurb", {}, b.blurb),
        (b.categories || []).map((cat) => {
          const win = cat.nominees.find((n) => n.won) || cat.nominees[0];
          const rest = cat.nominees.filter((n) => n !== win);
          const who = (n) => (n.person ? `${n.person}, ` : "") + `${n.title} (${n.studio})`;
          return el("div.cer-cat", {},
            el("div.lab", {}, cat.label),
            el("div", {},
              el("div.cer-win" + (win.mine ? ".mine" : ""), { style: delay() }, who(win)),
              rest.length ? el("div.cer-noms", {}, "also nominated: ",
                rest.map((n, i) => el("span" + (n.mine ? ".mine" : ""), {}, (i ? " · " : "") + who(n)))) : null));
        }))),
      (c.hof || []).length ? el("div.cer-body", {},
        el("h3", {}, `Hall of Fame · class of ${c.year}`),
        el("div.blurb", {}, "The Academy honours careers that are over - and lives that ended too soon."),
        c.hof.map((h) => el("div.cer-cat", {},
          el("div.lab", {}, h.cut_short ? "In memoriam" : h.status === "dead" ? "Posthumous" : "Inducted"),
          el("div.cer-win" + (h.ours >= 3 ? ".mine" : ""), { style: delay() }, `${h.name}: ${h.text}`)))) : null,
      (c.razzies || []).length ? el("div.cer-razz", {}, "Golden Raspberry: " +
        c.razzies.map((r) => `${r.label}, ${r.person ? r.person + " in " : ""}${r.title}`).join("; ")) : null,
      el("div.modal-actions", {},
        el("button.btn.gold", { onclick: hideModal }, mineWins ? "Back to the lot (with the statuettes)" : "Back to the lot"),
        el("button.btn", { onclick: () => { hideModal(); S.tab = "awards"; renderTabs(); renderView(); } }, "Awards tab"))));
  showModal(card);
}

async function tickWeeks(weeks, reRender = true) {
  if (S.busy) return;
  S.busy = true;
  try {
    const r = await api("/api/tick", { weeks }, "POST");
    if (r.ok) {
      S.state = r.state; renderTop(); renderTabs(); renderSide();
      if (r.tick && r.tick.over) { endGame(r.tick.over); }
      if (reRender) await renderView();
      // a picture opened while the calendar ran: the critics want a word
      if (!(r.tick && r.tick.over)) await maybeShowReviews();
      if (!(r.tick && r.tick.over)) checkCeremony();
    }
  } finally { S.busy = false; }
}

function endGame(kind) {
  const g = S.state.game;
  showModal(el("div.panel", {},
    el("div.panel-h", {}, el("h2", {}, kind === "bankrupt" ? "The studio closes" : "The curtain falls")),
    el("div.panel-b", {},
      el("p", {}, kind === "bankrupt"
        ? `Three years in the red. ${g.name} is sold at auction; the gadgets go to a museum in New Jersey.`
        : `${g.name} bows out.`),
      el("dl.kv", {},
        el("dt", {}, "Pictures"), el("dd", {}, n0(g.stats.releases || 0)),
        el("dt", {}, "Hits"), el("dd", {}, n0(g.stats.hits || 0)),
        el("dt", {}, "Awards"), el("dd", {}, n0(g.stats.awards || 0)),
        el("dt", {}, "Peak valuation"), el("dd", {}, money(g.valuation)),
        el("dt", {}, "Prestige"), el("dd", {}, n0(g.prestige))),
      el("div.modal-actions", {},
        el("button.btn.gold", { onclick: () => { hideModal(); showNewGame(); } }, "Found a new studio")))));
}

// ------------------------------------------------------------- shared actions
async function doRelease(pid) {
  const r = await api("/api/release", { production: pid }, "POST");
  if (r.ok) {
    await refreshState(); await renderView();
    if (r.review && r.movie_id) await reviewModal(r.movie_id);
    else toast(`${r.outcome} · ${money(r.gross)} gross · studio net ${money(r.net)}`);
  }
}
async function buyOffer(id) {
  const r = await api("/api/franchise", { action: "acquire", offer_id: id }, "POST");
  if (r.ok) { toast(`Acquired for ${money(r.price)}.`); await refreshState(); await renderView(); }
}
async function sellOffer(id, accept) {
  const r = await api("/api/franchise", { action: accept ? "sell" : "decline", offer_id: id }, "POST");
  if (r.ok) { toast(accept ? `Sold. ${money(r.price || r.amount || 0)} wired.` : "Offer torn up."); await refreshState(); await renderView(); }
}
async function eventChoice(id, choiceId) {
  const r = await api("/api/event", { id, choice: choiceId }, "POST");
  if (r.ok) { toast(r.text || "The studio has spoken."); await refreshState(); await renderView(); }
}

// ---------------------------------------------------------------- clock loop
function setSpeed(v) {
  S.speed = v;
  $("#clock-dot").className = "clock-dot" + (v ? " run" : "");
  $("#clock-dot").title = SPEED_LABEL[v] || "";
  const b = $("#btn-play");
  if (b) b.textContent = v ? `▶ ${SPEED_LABEL[v]}` : "▶";
}
function loop() {
  if (S.speed && !S.busy && !S.modalOpen) tickWeeks(1, S.tab === "production" || S.tab === "lot");
  setTimeout(loop, SPEED_MS[S.speed] || 1200);
}

// ---------------------------------------------------------------- modal glue
function showModal(node) {
  $("#modal-body").innerHTML = "";
  $("#modal-body").appendChild(node);
  $("#modal").classList.remove("hidden");
  S.modalOpen = true;
}
function hideModal() { $("#modal").classList.add("hidden"); S.modalOpen = false; }

// ----------------------------------------------------------------- generic list
// cfg: {path, params, columns:[{k,label,cls,fmt}], onRow, filters:[...], pageSize}
async function listView(host, cfg) {
  const key = cfg.key;
  S.filters[key] = S.filters[key] || Object.assign({}, cfg.defaults || {});
  const F = S.filters[key];
  const bar = el("div.panel-h", {}, el("h2", {}, cfg.title));
  const controls = el("div.right");
  (cfg.controls || []).forEach((c) => controls.appendChild(c));
  (cfg.filters || []).forEach((f) => {
    if (f.type === "text") {
      controls.appendChild(el("input", { type: "search", placeholder: f.label, value: F[f.k] || "",
        oninput: debounce((e) => { F[f.k] = e.target.value; F.page = 1; reload(); } , 260) }));
    } else if (f.type === "select") {
      const sel = el("select", { onchange: (e) => { F[f.k] = e.target.value; F.page = 1; reload(); } },
        f.options.map(([val, lab]) => el("option", { value: val, selected: F[f.k] === val ? "selected" : null }, lab)));
      controls.appendChild(sel);
    }
  });
  if (cfg.extra) controls.appendChild(cfg.extra);
  bar.appendChild(controls);

  const wrap = el("div.scroll");
  const pager = el("div.pager");
  const panel = el("div.panel", {}, bar, wrap, pager);
  host.appendChild(panel);

  let sort = F.sort || cfg.sort || null;
  let dir = F.dir || "desc";

  async function reload() {
    setHTML(wrap, el("div.empty", {}, "…"));
    const params = Object.assign({}, cfg.params || {}, F, { sort, dir, page: F.page || 1, limit: cfg.pageSize || 25 });
    const r = await api(cfg.path, params);
    wrap.innerHTML = "";
    if (!r.ok) { setHTML(wrap, el("div.empty", {}, r.error || "error")); return; }
    const rows = r.rows || [];
    if (!rows.length) { setHTML(wrap, el("div.empty", {}, cfg.empty || "nothing here")); pager.innerHTML = ""; return; }
    const table = el("table");
    const tr = el("tr");
    cfg.columns.forEach((c) => tr.appendChild(el("th", {
      class: c.cls || "",
      onclick: c.sortable === false ? null : () => {
        if (c.sortKey) { if (sort === c.sortKey) dir = dir === "desc" ? "asc" : "desc"; else { sort = c.sortKey; dir = "desc"; } }
        else return;
        F.sort = sort; F.dir = dir; reload();
      } }, c.label)));
    table.appendChild(el("thead", {}, tr));
    const tb = el("tbody");
    rows.forEach((row) => {
      const r2 = el("tr", { class: cfg.onRow ? "click" : "" },
        cfg.columns.map((c) => el("td", { class: c.cls || "" }, c.fmt ? c.fmt(row) : row[c.k] ?? "—")));
      if (cfg.onRow) r2.addEventListener("click", () => cfg.onRow(row));
      tb.appendChild(r2);
    });
    table.appendChild(tb);
    wrap.appendChild(table);
    const pages = r.pages || 1, page = r.page || 1;
    pager.innerHTML = "";
    pager.appendChild(el("span", {}, `${n0(r.total || rows.length)} rows`));
    pager.appendChild(el("button.btn.sm", { disabled: page <= 1 ? "disabled" : null,
      onclick: () => { F.page = page - 1; reload(); } }, "‹ prev"));
    pager.appendChild(el("span", {}, `${page} / ${pages}`));
    pager.appendChild(el("button.btn.sm", { disabled: page >= pages ? "disabled" : null,
      onclick: () => { F.page = page + 1; reload(); } }, "next ›"));
  }
  await reload();
  panel.reload = reload;
  return panel;
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// Canvas charts. The tricky part is sizing: the box must be measured after it
// is in the document, and the backing store matched to devicePixelRatio, or the
// axis text renders smeared and the lines stretch.
const _charts = [];

function niceCeil(v) {
  if (!isFinite(v) || v <= 0) return 1;
  const e = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * e >= v - 1e-9) return m * e;
  return 10 * e;
}

function chart(host, series, opts = {}) {
  const c = el("canvas", { style: "width:100%;display:block" });
  host.appendChild(c);
  const rec = { c, host, series, opts };
  _charts.push(rec);
  if (host.clientWidth) drawChart(rec);
  else requestAnimationFrame(() => drawChart(rec));   // wait for layout
  const lg = el("div.chips");
  series.forEach((s) => lg.appendChild(el("span.pill", {
    style: `border-color:${s.color};color:${s.color}` }, s.label)));
  host.appendChild(lg);
}

function drawChart(r) {
  const { c, host, series, opts } = r;
  if (!c.parentNode) return;
  const h = opts.h || 120;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(180, Math.round(host.clientWidth || 600));
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  c.style.height = h + "px";
  const x = c.getContext("2d");
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  x.clearRect(0, 0, w, h);

  const yfmt = opts.yfmt || money;
  const all = series.flatMap((s) => (s.values || []).filter((v) => v !== null && v !== undefined));
  const labels = opts.labels || [];
  const xh = labels.length ? 16 : 6;                     // x-label strip height
  const plotH = h - 10 - xh;

  if (!all.length) {
    x.fillStyle = "#6f7a86"; x.font = "12px ui-monospace, monospace";
    x.textAlign = "left"; x.fillText("no data yet", 4, h / 2);
    return;
  }

  const loRaw = Math.min(0, ...all);
  const hi = niceCeil(Math.max(...all, loRaw + 1));
  const lo = loRaw < 0 ? -niceCeil(-loRaw) : 0;

  // room for the widest y label
  x.font = "10px ui-monospace, monospace";
  let widest = 0;
  for (let i = 0; i <= 4; i++) widest = Math.max(widest, x.measureText(yfmt(hi - (i * (hi - lo)) / 4)).width);
  const lpad = widest + 10, rpad = 8;
  const X = (i, n) => lpad + (i * (w - lpad - rpad)) / Math.max(1, n - 1);
  const Y = (v) => 10 + plotH - ((v - lo) / (hi - lo)) * plotH;

  // grid + y labels
  x.lineWidth = 1;
  x.textAlign = "right"; x.textBaseline = "middle";
  for (let i = 0; i <= 4; i++) {
    const yy = Math.round(10 + (i * plotH) / 4) + 0.5;
    x.strokeStyle = (hi - (i * (hi - lo)) / 4) === 0 ? "#39424e" : "#242c35";
    x.beginPath(); x.moveTo(lpad, yy); x.lineTo(w - rpad, yy); x.stroke();
    x.fillStyle = "#7d8894";
    x.fillText(yfmt(hi - (i * (hi - lo)) / 4), lpad - 6, yy);
  }

  // series
  x.textAlign = "left"; x.textBaseline = "alphabetic";
  series.forEach((s) => {
    const vals = s.values || [];
    const n = vals.length;
    x.strokeStyle = s.color; x.lineWidth = 1.6; x.lineJoin = "round";
    x.beginPath();
    let started = false, last = null;
    vals.forEach((v, i) => {
      if (v === null || v === undefined) { started = false; return; }
      const px = X(i, n), py = Y(v);
      if (!started) { x.moveTo(px, py); started = true; } else x.lineTo(px, py);
      last = [px, py];
    });
    x.stroke();
    if (last) {                                    // last point, so a single
      x.fillStyle = s.color;                        // year still reads as a mark
      x.beginPath(); x.arc(last[0], last[1], 2.4, 0, Math.PI * 2); x.fill();
    }
  });

  // x labels: first, last and a few inside, never crowded
  if (labels.length) {
    x.fillStyle = "#7d8894"; x.font = "10px ui-monospace, monospace";
    const n = labels.length;
    const take = Math.min(n, Math.max(2, Math.floor((w - lpad - rpad) / 52)));
    for (let k = 0; k < take; k++) {
      const i = Math.round((k * (n - 1)) / Math.max(1, take - 1));
      const px = X(i, n);
      x.textAlign = k === 0 ? "left" : (k === take - 1 ? "right" : "center");
      x.fillText(String(labels[i]), k === 0 ? lpad : (k === take - 1 ? w - rpad : px), h - 4);
    }
    x.textAlign = "left";
  }
}

window.addEventListener("resize", debounce(() => {
  for (let i = _charts.length - 1; i >= 0; i--) {
    if (!_charts[i].c.parentNode) { _charts.splice(i, 1); continue; }
    drawChart(_charts[i]);
  }
}, 180));

// --------------------------------------------------------------- studio menu
async function studioMenu() {
  const c = await api("/api/config");
  const saves = c.saves || [];
  showModal(el("div.panel", {},
    el("div.panel-h", {}, el("h2", {}, "Studio menu"),
      el("div.right", {}, el("button.btn.sm", { onclick: hideModal }, "close"))),
    el("div.panel-b", {},
      el("div.mut", { style: "font-size:11px;letter-spacing:.14em" }, "RESUME A STUDIO"),
      saves.length ? el("div.chips", {}, saves.map((s) => el("span.chip", {
        onclick: async () => {
          const r = await api("/api/load", { slug: s.slug }, "POST");
          if (r.ok) { S.state = r.state; hideModal(); startShell(); toast("Back in business: " + s.name); }
        } }, `${s.name} · ${s.year} · ${money(s.cash)}`))) : el("div.mut", {}, "no saves yet"),
      el("div.modal-actions", {},
        el("button.btn.gold", { onclick: () => { hideModal(); showNewGame(); } }, "Found a new studio"),
        el("button.btn", { onclick: () => { hideModal(); setSpeed(0); tickWeeks(52); } }, "Skip a year")),
      el("div", { style: "margin-top:14px;font-size:11px;color:#7d8894" },
        "Space = play/pause · 1 / 2 / 3 = speed · 0 = pause · Enter = four weeks · one SQLite file per studio in ./saves"))));
}

// ------------------------------------------------------------------ startup
window.addEventListener("DOMContentLoaded", () => {
  // play: start at 1×, each further press goes faster (1× → 2× → 4× → 1×)
  $("#btn-play").addEventListener("click", () => setSpeed(S.speed ? (S.speed % 3) + 1 : 1));
  $("#btn-menu").addEventListener("click", studioMenu);
  $("#btn-pause").addEventListener("click", () => setSpeed(0));
  $$(".sp").forEach((b) => b.addEventListener("click", () => {
    setSpeed(0); tickWeeks(+b.dataset.w);
  }));
  $("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") hideModal(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideModal();
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || S.modalOpen) return;
    if (e.key === " ") { e.preventDefault(); setSpeed(S.speed ? 0 : 1); }
    if (e.key === "Enter") tickWeeks(4);
    if (["1", "2", "3"].includes(e.key)) setSpeed(+e.key);
    if (e.key === "0") setSpeed(0);
  });
  boot().then(loop);
});
