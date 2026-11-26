// Hollywood Tycoon - views A: lot, talent, casting, scripts, production.
"use strict";
const Views = {};
const TYPE_NAME = { action: "Action stars", comedy: "Comedians", drama: "Dramatic actors", horror: "Scream kings & queens",
  western: "Cowboys", musical: "Song & dance", crime: "Tough guys & femmes fatales", romance: "Romantic leads",
  "sci-fi": "Sci-fi icons", animation: "Voice actors" };

// ------------------------------------------------------------------- LOT
Views.lot = async function (v) {
  const st = S.state, g = st.game, f = st.finance;
  const slate = st.productions || [], ready = st.ready || [];
  v.innerHTML = "";
  const head = el("div.panel", {},
    el("div.panel-h", {}, el("h2", {}, `${g.name} — ${g.era}`),
      el("span.sub", {}, `week ${g.week + 1} of ${g.year}`),
      el("div.right", {},
        el("button.btn", { onclick: () => tickWeeks(4) }, "+4 weeks"),
        el("button.btn", { onclick: () => tickWeeks(13) }, "+quarter"))));
  const cards = el("div.grid3");
  const card = (label, value, note) => el("div.panel", {}, el("div.panel-h", {}, el("h2", {}, label)),
    el("div.panel-b", {}, el("div", { style: "font-size:22px" }, value),
      note ? el("div.mut", { style: "font-size:12px;margin-top:4px" }, note) : null));
  cards.appendChild(card("Cash on hand", money(g.cash), `debt ${money(f.debt)} · capacity ${money(f.capacity)}`));
  cards.appendChild(card("Studio valuation", money(g.valuation),
    `library ${money(f.library.total)} · lot ${money(f.lot)}`));
  cards.appendChild(card("Standing", `★ ${n0(g.prestige)}`, `reputation ${n0(g.reputation)} · ${n0(g.stats.releases || 0)} pictures released`));
  v.appendChild(head);
  v.appendChild(cards);

  // slate
  const slatePanel = el("div.panel", {}, el("div.panel-h", {}, el("h2", {}, "On the slate"),
    el("div.right", {}, el("button.btn.sm", { onclick: () => { S.tab = "production"; renderTabs(); renderView(); } }, "production office"))));
  const sb = el("div.panel-b");
  if (!slate.length && !ready.length) sb.appendChild(el("div.empty", {}, "No pictures in the works. Buy a script and greenlight something."));
  const tbl = el("table");
  tbl.appendChild(el("tbody", {}, slate.map((p) => el("tr.click", {
    onclick: () => productionModal(p.id) },
    el("td", {}, p.title),
    el("td", {}, p.genre),
    el("td", {}, el("span.pill", {}, p.phase_label || p.phase || p.status)),
    el("td", { class: "right-cell" }, money(p.budget)),
    el("td", { style: "width:150px" }, el("div.bar.q", {}, el("i", { style: `width:${Math.max(0, Math.min(100, p.quality || 0))}%` }))),
    el("td", { class: "right-cell nowrap" }, `${n0(p.weeks_left)} wk left`)))));
  sb.appendChild(tbl);
  ready.forEach((r) => sb.appendChild(el("div", { style: "margin-top:8px" },
    el("span.pill.gold", {}, `READY: ${r.title}`), " ",
    el("button.btn.sm.gold", { onclick: () => doRelease(r.id) }, "Release it"))));
  slatePanel.appendChild(sb);
  v.appendChild(slatePanel);

  // charts + top films
  const grid = el("div.grid2");
  const chartHost = el("div.panel-b");
  const yrs = ((st.charts || {}).years || []);
  chart(chartHost, [
    { label: "cash", color: "#6ac46a", values: yrs.map((y) => y.cash) },
    { label: "valuation", color: "#d9a441", values: yrs.map((y) => y.valuation) },
    { label: "gross", color: "#6aa8d8", values: yrs.map((y) => y.gross) },
  ], { labels: yrs.map((y) => y.year), h: 150 });
  grid.appendChild(el("div.panel", {}, el("div.panel-h", {}, el("h2", {}, "Trajectory")), chartHost));

  const topPanel = el("div.panel", {}, el("div.panel-h", {}, el("h2", {}, "Biggest pictures")));
  const tb2 = el("div.panel-b");
  if (!(st.top || []).length) tb2.appendChild(el("div.empty", {}, "nothing released yet"));
  else tb2.appendChild(el("table", {}, el("tbody", {}, st.top.map((m) => el("tr", {},
    el("td", {}, m.title), el("td", {}, m.genre),
    el("td", { class: "right-cell num" }, money(m.gross)),
    el("td", { class: `right-cell out-${m.outcome}` }, m.outcome))))));
  topPanel.appendChild(tb2);
  grid.appendChild(topPanel);
  v.appendChild(grid);

  // trends strip
  const tp = el("div.panel", {}, el("div.panel-h", {}, el("h2", {}, "What audiences want"),
    el("div.right", {}, el("button.btn.sm", { onclick: () => { S.tab = "world"; renderTabs(); renderView(); } }, "world"))));
  const tpb = el("div.panel-b", {}, el("div.chips", {},
    (st.trends || []).map((t) => el("span.chip", {}, `${t.label} `,
      el("b", { class: t.heat > 1.08 ? "pos" : t.heat < 0.92 ? "neg" : "mut" }, `${Math.round(t.heat * 100)}`)))));
  tp.appendChild(tpb);
  v.appendChild(tp);
};

// ---------------------------------------------------------------- TALENT
Views.talent = async function (v) {
  v.innerHTML = "";
  v.appendChild(el("div.panel", {}, el("div.panel-h", {}, el("h2", {}, "Talent roster & the street"),
    el("div.right", {},
      el("button.btn.sm", { onclick: () => { S.tab = "casting"; renderTabs(); renderView(); } }, "open calls")))));
  await listView(v, {
    key: "talent", title: "Players", path: "/api/actors", pageSize: 25, sort: "fame",
    defaults: { status: "any", gender: "any", sort: "fame" },
    filters: [
      { type: "text", k: "q", label: "name…" },
      { type: "select", k: "status", label: "status", options: [["any", "any"], ["star", "stars"], ["available", "uncontracted"], ["signed", "under contract to you"], ["rival", "signed by rivals"], ["retired", "retired"], ["dead", "deceased"]] },
      { type: "select", k: "gender", label: "gender", options: [["any", "any"], ["m", "male"], ["f", "female"]] },
      { type: "select", k: "label", label: "type", options: [["", "any type"], ["none", "unassigned"], ["range", "wide range (3+)"]]
          .concat((S.cfg.genres || []).map((g) => [g.id, TYPE_NAME[g.id] || g.label])) },
      { type: "select", k: "sort", label: "sort", options: [["fame", "fame"], ["star_power", "star power"], ["fee", "fee"], ["age", "age"], ["craft", "craft"], ["total_gross", "lifetime gross"], ["awards", "awards"]] },
    ],
    columns: [
      { k: "name", label: "Name", sortKey: "name" },
      { k: "age", label: "Age", cls: "right-cell", sortKey: "age" },
      { k: "sex", label: "", fmt: (r) => (r.gender === "f" ? "♀" : "♂") },
      { k: "fame", label: "Fame", cls: "right-cell", sortKey: "fame", fmt: (r) => n0(r.fame) },
      { k: "star_power", label: "Star power", cls: "right-cell", sortKey: "star_power", fmt: (r) => n0(r.star_power) },
      { k: "craft", label: "Craft", cls: "right-cell", sortKey: "craft", fmt: (r) => n0(r.craft) },
      { k: "fee", label: "Fee", cls: "right-cell num", sortKey: "fee", fmt: (r) => money(r.fee) },
      { k: "films", label: "Films", cls: "right-cell", sortKey: "films", fmt: (r) => n0(r.films) },
      { k: "awards", label: "Awards", cls: "right-cell", sortKey: "awards", fmt: (r) => r.awards ? el("b.gold-t", {}, `★ ${n0(r.awards)}`) : el("span.mut", {}, "—") },
      { k: "type", label: "Known as", sortable: false, fmt: (r) => typecastPills(r.typecast, { quiet: true }) || el("span.mut", {}, "—") },
      { k: "status", label: "Status", fmt: (r) => el("span.pill" + (r.studio === "player" ? ".gold" : r.studio ? ".bad" : ""), {},
        r.studio === "player" ? `yours · ${n0(r.contract_films)} left` : r.studio ? r.studio : (r.status || "—")) },
    ],
    onRow: (r) => actorModal(r.id),
  });
};

async function actorModal(id) {
  const a = await api("/api/actor", { id });
  if (!a.ok) return;
  const skillRow = (name, sk) => {
    const est = sk ? sk.est : null, pm = sk ? sk.pm : 0;
    return el("div", { style: "display:flex;gap:8px;align-items:center;margin:2px 0" },
      el("span", { style: "width:88px;font-size:11px;color:#8b96a2" }, name),
      el("div.bar", { style: "flex:1" }, el("i", { style: `width:${est || 0}%` })),
      el("span.num", { style: "width:74px;font-size:11px;color:#7d8894" }, est === null ? "—" : `${n0(est)} ±${n0(pm)}`));
  };
  const alive = ["available", "working", "star"].includes(a.status);
  const filmsSel = el("select", {}, Object.keys(a.sign_bonus || { 1: 0 }).map((n) =>
    el("option", { value: n }, `${n} pic · ${money(a.sign_bonus[n])} down, ${money(a.sign_rate[n])}/pic`)));
  const coachSel = el("select", {}, (a.coach_options || []).map((c) =>
    el("option", { value: c.id }, `${c.label} · ${money(c.cost)}`)));
  const go = (action, extra = {}) => actorAct(action, a.id, extra);
  const actions = [];
  if (alive && !a.rival) actions.push(el("button.btn.sm.gold", { onclick: () => go("sign", { films: +filmsSel.value }) }, a.yours ? "Extend deal" : "Sign"), filmsSel);
  if (a.rival && alive) actions.push(el("button.btn.sm", { onclick: () => go("hire_rival") }, `Poach from ${a.studio} (${money(a.fee * 1.9)})`));
  if (alive || a.status === "blacklisted") actions.push(el("button.btn.sm", { onclick: () => go("develop", { kind: coachSel.value }) }, "Coach"), coachSel);
  if (alive) actions.push(el("button.btn.sm", { onclick: () => go("publicity") }, "Publicity"));
  if (a.yours && a.loan_out && !a.busy) actions.push(el("button.btn.sm", { title: `${a.loan_out.weeks} weeks with a rival; you keep the contract`,
    onclick: () => go("loan_out") }, `Loan out (+${money(a.loan_out.fee)})`));
  if (a.yours) actions.push(el("button.btn.sm", { onclick: () => go("release") }, "Buy out contract"));
  if (alive) actions.push(el("button.btn.sm.red", { onclick: () => { if (confirm(`Blacklist ${a.name}? Your reputation takes a hit.`)) go("blacklist"); } }, "Blacklist"));
  const body = el("div.panel", {},
    el("div.panel-h", {}, el("h2", {}, a.name),
      el("span.sub", {}, `${a.age} · ${a.gender === "f" ? "female" : "male"} · ${a.status}${a.studio ? " · " + (a.studio === "player" ? "your studio" : a.studio) : ""}`),
      el("div.right", {}, el("button.btn.sm", { onclick: hideModal }, "close"))),
    el("div.panel-b", {},
      el("div.tc-line", {}, el("span.mut.cap", {}, "KNOWN AS "),
        typecastPills(a.typecast, { range: true }),
        el("span.mut", { style: "font-size:11px" }, (a.typecast && a.typecast.range)
          ? `${a.typecast.range === 1 ? " · Specialist" : ""}${a.standouts ? ` · ${n0(a.standouts)} standout performance${a.standouts === 1 ? "" : "s"}` : ""}`
          : " · nothing has stuck yet: keep casting them in one genre and it will")),
      el("div.grid2", {},
        el("div", {},
          el("dl.kv", {},
            el("dt", {}, "Fee"), el("dd", {}, money(a.fee), " ", el("span.mut", {}, `(${money(a.fee_est)} typical today)`)),
            el("dt", {}, "Fame / star power"), el("dd", {}, `${n0(a.fame)} / ${n0(a.star_power)}`),
            el("dt", {}, "Pictures · leads"), el("dd", {}, `${n0(a.films)} · ${n0(a.leads)}`),
            el("dt", {}, "Lifetime gross"), el("dd", {}, money(a.total_gross)),
            el("dt", {}, "Awards"), el("dd", {}, `${n0(a.awards)} win${a.awards === 1 ? "" : "s"}, ${n0(a.noms)} nominations`),
            el("dt", {}, "Cult following"), el("dd", {}, n0(a.cult)),
            el("dt", {}, "Schedule"), el("dd", {}, a.busy ? `shooting until ~${a.busy_until_year}` : "free"),
            el("dt", {}, "Contract"), el("dd", {}, a.contract_films
              ? `${a.studio === "player" ? "yours" : a.studio}: ${a.contract_films} picture${a.contract_films === 1 ? "" : "s"} @ ${money(a.contract_fee)}, until ${a.contract_until_year}`
              : "free agent"),
            el("dt", {}, "Discovered by"), el("dd", {}, a.discoverer || "—"),
            (a.legacy || {}).hof_year ? [el("dt", {}, "Hall of Fame"), el("dd", {}, el("b.gold-t", {}, `★ inducted ${a.legacy.hof_year}`))] : null,
            (a.legacy || {}).died_year ? [el("dt", {}, "Died"), el("dd", {}, `${a.legacy.died_year}, aged ${a.legacy.died_age}: ${a.legacy.cause || ""}`)] : null,
            (a.legacy || {}).standing && !(a.legacy || {}).hof_year ? [el("dt", {}, "Legacy"), el("dd", {}, el("span.mut", {}, a.legacy.standing))] : null),
          el("div.row-actions", {}, actions)),
        el("div", {},
          el("div.mut", { style: "font-size:11px;letter-spacing:.14em" }, "SCOUT REPORT · GENRE FIT"),
          el("div", {}, Object.entries(a.scout || {}).map(([k, sk]) => skillRow(k, sk))),
          el("div", { style: "margin-top:8px;font-size:12px" },
            el("span.pill", {}, `best: ${(a.best_genre || "—")}`),
            a.notes ? el("div.mut", { style: "margin-top:6px" }, a.notes) : null),
          (a.genre_profile || []).length ? el("div", { style: "margin-top:10px" },
            el("div.mut.cap", {}, "WHAT THEY GET CAST IN"),
            a.genre_profile.slice(0, 5).map((g) => el("div", { style: "display:flex;gap:8px;align-items:center;margin:2px 0" },
              el("span", { style: "width:88px;font-size:11px;color:#8b96a2" }, g.label),
              el("div.bar" + ((a.typecast && (a.typecast.genres || []).includes(g.genre)) ? ".tc-bar" : ""), { style: "flex:1" }, el("i", { style: `width:${g.share}%` })),
              el("span.num", { style: "width:74px;font-size:11px;color:#7d8894" }, `${g.share}% · ${g.films} pic`)))) : null)),
      (a.award_list || []).length ? el("div", { style: "margin-top:14px" },
        el("div.mut.cap", {}, `AWARDS · ${n0(a.awards)} won, ${n0(a.noms)} nominations`),
        el("table", {}, el("tbody", {}, a.award_list.slice(0, 12).map((x) => el("tr", {},
          el("td", {}, String(x.year)),
          el("td", {}, x.label),
          el("td", {}, x.movie_title || "—", el("span.mut", {}, ` · ${x.studio}`)),
          el("td", {}, el("span.pill" + (x.won ? (String(x.category).startsWith("razzie") ? ".bad" : ".gold") : ".dim"), {},
            String(x.category).startsWith("razzie") ? "RAZZIE" : x.won ? "WON" : "nominated"))))))) : null,
      el("div", { style: "margin-top:14px" },
        el("div.mut", { style: "font-size:11px;letter-spacing:.14em" }, "FILMOGRAPHY"),
        (a.filmography || []).length ? el("table", {}, el("tbody", {},
          a.filmography.slice(0, 16).map((m) => el("tr", { class: m.movie_id ? "click" : "",
              onclick: () => { if (m.movie_id) releaseModal(m.movie_id); } },
            el("td", {}, String(m.year)), el("td", {}, m.title, m.wins ? el("span.gold-t", {}, ` ★${m.wins}`) : null),
            el("td", {}, m.genre || ""),
            el("td", {}, m.ours ? (m.role || "") : el("span.mut", {}, `lead · ${m.studio}`)),
            el("td", {}, m.grade ? el("span.pill" + (GRADE_CLASS[m.grade] ? "." + GRADE_CLASS[m.grade] : ""), {}, m.grade) : ""),
            el("td", { class: `right-cell out-${m.outcome}` }, m.outcome || ""),
            el("td", { class: "right-cell num" }, money(m.gross))))))
          : el("div.mut", {}, "no credits"))));
  showModal(body);
}

async function actorAct(action, id, extra = {}) {
  const r = await api("/api/actor", Object.assign({ action, id }, extra), "POST");
  if (!r.ok) return;
  const msg = r.msg || r.note || ({
    sign: `Signed — ${money(r.bonus)} down, ${money(r.per_picture)} a picture.`,
    release: `Contract bought out for ${money(r.buyout)}.`,
    hire_rival: `Poached for ${money(r.cost)}.`,
    loan_out: `Loaned to ${r.rival} for ${r.weeks} weeks: ${money(r.fee)} to you.`,
    blacklist: "Blacklisted.",
  })[action] || `Done: ${action}`;
  toast(msg);
  await refreshState();
  if (S.modalOpen) actorModal(id); else await renderView();
  if (S.tab === "casting" || S.tab === "talent") await renderView();
}

// --------------------------------------------------------------- CASTING
Views.casting = async function (v) {
  v.innerHTML = "";
  const p = await api("/api/casting/pool", { industry: 1 });
  const cost = p.cost || 0;
  const panel = el("div.panel", {},
    el("div.panel-h", {}, el("h2", {}, "Open calls & discoveries"),
      el("div.right", {},
        el("button.btn.sm", { onclick: () => openCall(0) }, `Street ${money((p.costs || [])[0] || cost * 0.4)}`),
        el("button.btn.sm", { onclick: () => openCall(1) }, `Backlot ${money(cost)}`),
        el("button.btn.sm", { onclick: () => openCall(2) }, `Dining rooms ${money((p.costs || [])[2] || cost * 2)}`),
        el("button.btn.sm", { onclick: () => openCall(3) }, `Nationwide ${money((p.costs || [])[3] || cost * 4)}`))));
  const signed = await api("/api/actors", { status: "signed", limit: 60, sort: "fame" });
  const b = el("div.panel-b");
  b.appendChild(el("div.mut", { style: "font-size:12px;margin-bottom:8px" },
    "Scouting is a guessing game: the promise column is your reader's opinion, not the truth. Unclaimed faces expire at the end of the season."));
  if (!(p.rows || []).length) b.appendChild(el("div.empty", {}, "Nobody waiting on the bench. Hold an open call."));
  else b.appendChild(el("table", {},
    el("thead", {}, el("tr", {}, ["Name", "Age", "Sex", "Fame", "Promise", "Est. fee", "Found", "Expires", ""].map((h) => el("th", {}, h)))),
    el("tbody", {}, p.rows.map((r) => el("tr.click", { onclick: () => actorModal(r.id) },
      el("td", {}, r.name), el("td", { class: "right-cell" }, n0(r.age)),
      el("td", {}, r.gender === "f" ? "♀" : "♂"),
      el("td", { class: "right-cell" }, n0(r.fame)),
      el("td", { class: "right-cell" }, el("b", {}, n0(r.promise))),
      el("td", { class: "right-cell num" }, money(r.fee)),
      el("td", {}, r.source || "open call"),
      el("td", {}, String(r.expires_year)),
      el("td", { onclick: (e) => e.stopPropagation() },
        el("button.btn.sm.gold", { onclick: () => actorAct("sign", r.id, { films: 2 }) }, "Sign (2 pics)"), " ",
        el("button.btn.sm", { onclick: async () => { await api("/api/casting/waive", { id: r.id }, "POST"); await refreshState(); renderView(); } }, "Waive")))))));
  panel.appendChild(b);
  v.appendChild(panel);

  // who you already have: the people who show up first on every audition list
  const sp = el("div.panel", {}, el("div.panel-h", {}, el("h2", {}, "Your contract players"),
    el("span.sub", {}, `${n0(signed.total || 0)} under contract · they top every audition list they fit`)));
  const sb = el("div.panel-b");
  if (!(signed.rows || []).length) sb.appendChild(el("div.empty", {}, "Nobody under contract. Sign a discovery above, or a name from the Talent tab."));
  else sb.appendChild(el("table", {},
    el("thead", {}, el("tr", {}, ["Name", "Age", "Sex", "Fame", "Craft", "Films left", "Per picture", "Status"].map((h) => el("th", {}, h)))),
    el("tbody", {}, signed.rows.map((r) => el("tr.click", { onclick: () => actorModal(r.id) },
      el("td", {}, r.name), el("td", { class: "right-cell" }, n0(r.age)),
      el("td", {}, r.gender === "f" ? "♀" : "♂"),
      el("td", { class: "right-cell" }, n0(r.fame)), el("td", { class: "right-cell" }, n0(r.craft)),
      el("td", { class: "right-cell" }, n0(r.contract_films)),
      el("td", { class: "right-cell num" }, money(r.contract_fee)),
      el("td", {}, el("span.pill" + (r.busy ? ".info" : ".good"), {}, r.busy ? "on a picture" : "free")))))));
  sp.appendChild(sb);
  v.appendChild(sp);
};

async function openCall(tier) {
  const r = await api("/api/casting/open_call", { tier }, "POST");
  if (r.ok) { toast(`Open call held: ${r.n || 0} interesting faces found for ${money(r.cost)}.`); await refreshState(); renderView(); }
}

// ------------------------------------------------------- SCRIPTS & WRITERS
Views.scripts = async function (v) {
  v.innerHTML = "";
  const lib = await api("/api/scripts/library");
  const lp = el("div.panel", {}, el("div.panel-h", {}, el("h2", {}, "Your script library"),
    el("span.sub", {}, `${(lib.rows || []).length} in the vault`)));
  const lb = el("div.panel-b");
  if (!(lib.rows || []).length) lb.appendChild(el("div.empty", {}, "No scripts. Buy one below or put a staff writer to work."));
  else lb.appendChild(el("table", {},
    el("thead", {}, el("tr", {}, ["Title", "Genre", "Coverage", "Gut", "Scale", "Cost to shoot", "Status", ""].map((h) => el("th", {}, h)))),
    el("tbody", {}, (lib.rows || []).map((s) => el("tr.click", { onclick: () => scriptModal(s.id) },
      el("td", {}, s.title, s.in_use ? el("span.pill.dim", {}, " in production") : null,
        s.source_franchise ? el("span.pill.gold", { style: "margin-left:4px" }, "series") : null),
      el("td", {}, s.genre),
      el("td", {}, s.known ? el("b", {}, `${n0(s.coverage)} ±${n0(s.coverage_pm)}`) : el("span.mut", {}, "unread")),
      el("td", { class: "right-cell" }, n0(s.fp)),
      el("td", {}, s.scale),
      el("td", { class: "right-cell num" }, money((s.shoot_cost || 0))),
      el("td", {}, s.option_expires ? `option to ${s.option_expires}` : "owned"),
      el("td", { class: "nowrap", onclick: (e) => e.stopPropagation() }, s.in_use ? "" : el("span", {},
        el("button.btn.sm.gold", { onclick: () => greenlightModal(s.id) }, "Greenlight"), " ",
        s.status === "owned" && !s.source_franchise ? el("button.btn.sm", { onclick: () => scriptModal(s.id) }, "Sell…") : null)))))));
  lp.appendChild(lb);
  v.appendChild(lp);

  await listView(v, {
    key: "market", title: "Script market", path: "/api/scripts/market", pageSize: 20, sort: "price",
    defaults: { genre: "", sort: "price", dir: "asc" },
    controls: [el("button.btn.sm", { onclick: () => { S.filters.market.page = 1; renderView(); } }, "↻ refresh")],
    filters: [
      { type: "text", k: "q", label: "title…" },
      { type: "select", k: "genre", label: "genre", options: [["", "all genres"]].concat((S.cfg.genres || []).map((g) => [g.id, g.label])) },
      { type: "select", k: "sort", label: "sort", options: [["price", "price"], ["quality", "coverage"], ["fp", "producer's gut"], ["year", "newest"]] },
      { type: "select", k: "dir", label: "", options: [["asc", "low first"], ["desc", "high first"]] },
    ],
    columns: [
      { k: "title", label: "Title", sortKey: "title" },
      { k: "genre", label: "Genre", sortKey: "genre" },
      { k: "quality", label: "Reader guess", cls: "right-cell", fmt: (r) => r.coverage !== null && r.coverage !== undefined ? `${n0(r.coverage)} ±${n0(r.coverage_pm)}` : el("span.mut", {}, "unread") },
      { k: "fp", label: "Gut", cls: "right-cell", fmt: (r) => n0(r.fp) },
      { k: "scale", label: "Scale" },
      { k: "price", label: "Price", cls: "right-cell num", sortKey: "price", fmt: (r) => money(r.price) },
      { k: "writer", label: "Writer", fmt: (r) => r.writer || "—" },
      { k: "actions", label: "", sortable: false, fmt: (r) => el("span", {},
        el("button.btn.sm", { onclick: (e) => { e.stopPropagation(); scriptAct("coverage", r.id); } }, "Read coverage"),
        " ", el("button.btn.sm.gold", { onclick: (e) => { e.stopPropagation(); scriptAct("buy", r.id); } }, "Buy"),
        " ", el("button.btn.sm", { title: `${money(r.option_price)} holds it for three years`, onclick: (e) => { e.stopPropagation(); scriptAct("option", r.id); } }, "Option")) },
    ],
    onRow: (r) => scriptModal(r.id),
  });

  await listView(v, {
    key: "writers", title: "Writers for hire", path: "/api/writers", pageSize: 12, sort: "skill",
    defaults: { sort: "skill" },
    columns: [
      { k: "name", label: "Writer", sortKey: "name" },
      { k: "skill", label: "Skill (est.)", cls: "right-cell", sortKey: "skill", fmt: (r) => `${n0(r.est_skill ?? r.skill)} ±${n0(r.est_pm || 0)}` },
      { k: "best", label: "Best at", fmt: (r) => r.best || "—" },
      { k: "speed", label: "Speed", cls: "right-cell", fmt: (r) => n0(r.speed) },
      { k: "week_rate", label: "Pay/week", cls: "right-cell num", sortKey: "week_rate", fmt: (r) => money(r.week_rate) },
      { k: "quirk", label: "Quirk", fmt: (r) => el("span.mut", {}, r.quirk || "") },
      { k: "a", label: "", sortable: false, fmt: (r) => el("button.btn.sm", {
        onclick: (e) => { e.stopPropagation(); writerAct("hire", r.id); } }, "Hire") },
    ],
  });

  const staff = await api("/api/writers", { staff: 1 });
  const sp = el("div.panel", {}, el("div.panel-h", {}, el("h2", {}, "On payroll")));
  const sb = el("div.panel-b");
  const rows = (staff.rows || []).filter((r) => r.studio === "player");
  if (!rows.length) sb.appendChild(el("div.empty", {}, "No staff writers. They deliver a script every few weeks and you assign their genre."));
  else sb.appendChild(el("table", {}, el("tbody", {}, rows.map((r) => el("tr", {},
    el("td", {}, r.name), el("td", {}, `skill ${n0(r.skill)}`),
    el("td", {}, el("select", { onchange: (e) => writerAct("assign", r.id, e.target.value) },
      [["", `own speciality (${r.genre})`]].concat((S.cfg.genres || []).map((g) => [g.id, g.label])).map(([v, l]) =>
        el("option", { value: v, selected: (r.assigned || "") === v ? "selected" : null }, l)))),
    el("td", { class: "right-cell num" }, money(r.week_rate)),
    el("td", {}, el("button.btn.sm.red", { onclick: () => writerAct("fire", r.id) }, "Let go")))))));
  sp.appendChild(sb);
  v.appendChild(sp);
};

async function writerAct(action, id, val) {
  const body = { action, id };
  if (action === "assign") body.genre = val || null;
  const r = await api("/api/writer", body, "POST");
  if (!r.ok) return;
  toast(r.note || (action === "hire" ? `${r.name || "The writer"} is on payroll.`
    : action === "fire" ? "Writer let go."
    : `Genre focus: ${r.genre || "their own speciality"}.`));
  await refreshState();
  await renderView();
}

async function scriptAct(action, id, extra = {}) {
  const r = await api("/api/script", Object.assign({ action, id }, extra), "POST");
  if (r.ok) {
    toast(r.note || (action === "coverage" ? `Coverage says ${n0(r.coverage)} (±${n0(r.coverage_pm || r.pm)}).` :
      action === "buy" ? `Bought for ${money(r.price)}.` : action === "option" ? `Optioned for ${money(r.price)}.` : `Script ${action} done.`));
    await refreshState(); await renderView();
  }
}

async function scriptModal(id) {
  const s = await api("/api/script", { id });
  if (!s.ok) return;
  const mine = s.owner === "player";
  const free = mine && ["owned", "optioned"].includes(s.status);
  const devSel = el("select", {}, (s.dev_options || []).map((o) =>
    el("option", { value: o.id }, `${o.label} · ${money(o.cost)} · ${Math.round(o.risk * 100)}% risk`)));
  showModal(el("div.panel", {},
    el("div.panel-h", {}, el("h2", {}, s.title || "Script"),
      el("span.sub", {}, `${s.genre} · ${s.subgenre || ""} · ${s.scale}`),
      el("div.right", {}, el("button.btn.sm", { onclick: hideModal }, "close"))),
    el("div.panel-b", {},
      el("dl.kv", {},
        el("dt", {}, "Owner"), el("dd", {}, mine ? `your vault (${s.status})` : (s.owner || "market")),
        el("dt", {}, "Genre / subgenre"), el("dd", {}, `${s.genre} · ${s.subgenre || "—"}`),
        el("dt", {}, "Coverage"), el("dd", {}, s.coverage !== null && s.coverage !== undefined ? `${n0(s.coverage)} ± ${n0(s.coverage_pm)}` : "unread — buy coverage to get a reader's opinion"),
        el("dt", {}, "Producer's gut"), el("dd", {}, n0(s.fp)),
        el("dt", {}, "Genre heat"), el("dd", {}, n1(s.heat)),
        el("dt", {}, "Asking price"), el("dd", {}, money(s.price)),
        el("dt", {}, "Option"), el("dd", {}, money(s.option_price)),
        el("dt", {}, "Writer"), el("dd", {}, s.writer_name || "—"),
        el("dt", {}, "Rewrites so far"), el("dd", {}, n0(s.developed)),
        el("dt", {}, "Origin"), el("dd", {}, s.origin || "—")),
      el("div.modal-actions", {},
        el("button.btn", { onclick: async () => { await scriptAct("coverage", id); scriptModal(id); } }, `Read coverage ${money(s.coverage_cost)}`),
        !mine && s.status === "market" ? el("button.btn.gold", { onclick: async () => { await scriptAct("buy", id); scriptModal(id); } }, `Buy ${money(s.price)}`) : null,
        !mine && s.status === "market" ? el("button.btn", { onclick: async () => { await scriptAct("option", id); scriptModal(id); } }, `Option ${money(s.option_price)}`) : null,
        free ? el("span", {}, devSel, " ", el("button.btn", { onclick: async () => { await scriptAct("develop", id, { kind: devSel.value }); scriptModal(id); } }, "Commission rewrite")) : null,
        free ? el("button.btn.gold", { onclick: () => { hideModal(); greenlightModal(id); } }, "Greenlight") : null,
        s.sale ? el("button.btn.red", { onclick: async () => {
          if (!confirm(`Sell "${s.title}" to ${s.sale.buyer} for ${money(s.sale.price)}? They may well film it.`)) return;
          const r = await api("/api/script", { action: "sell", id }, "POST");
          if (r.ok) { toast(`Sold to ${r.buyer} for ${money(r.price)}.`); hideModal(); await refreshState(); renderView(); }
        } }, `Sell to ${s.sale.buyer} (${money(s.sale.price)})`) : null),
      s.sale ? el("div.mut", { style: "font-size:11px;margin-top:6px" },
        `Their read: ${s.sale.verdict}.${s.sale.paid ? ` You paid ${money(s.sale.paid)} for it.` : " It cost you only your writer's time."} Buyers read it themselves, so they pay for what is really on the page. Quotes refresh monthly.`) : null,
      free ? el("div.mut", { style: "font-size:11px;margin-top:6px" }, "A rewrite clears the old coverage: the pages changed, so the reader's opinion is out of date.") : null)));
}

async function greenlightModal(sid) {
  const s = await api("/api/script", { id: sid });
  if (!s.ok) return;
  const dirs = await api("/api/directors", { limit: 40, sort: "vision", dir: "desc" });
  const scales = S.cfg.scales || [];
  const opt = { scale: scales.some((x) => x.id === s.scale) ? s.scale : "standard" };
  const scaleOf = () => scales.find((x) => x.id === opt.scale) || { mult: 1, label: opt.scale, weeks: [0, 0] };
  const scaleSel = el("select", { onchange: (e) => { opt.scale = e.target.value; redrawBudget(); } },
    scales.map((sc) => el("option", { value: sc.id, selected: sc.id === opt.scale ? "selected" : null },
      `${sc.label} (${sc.mult}×)${sc.id === s.scale ? " — as written" : ""}`)));
  const budgetIn = el("input", { type: "number", step: 1000, style: "width:130px", oninput: () => redrawCost() });
  const marketIn = el("input", { type: "number", step: 1000, style: "width:130px", oninput: () => redrawCost() });
  const dirSel = el("select", { onchange: () => redrawCost() }, el("option", { value: "" }, "no director yet (hire later)"),
    (dirs.rows || []).map((d) => el("option", { value: d.id }, `${d.name} · vision ${n0(d.vision)}`)));
  const titleIn = el("input", { type: "text", value: s.title || "", maxlength: 44, style: "width:260px" });
  const info = el("div.mut", { style: "font-size:12px" }, "");
  const cost = el("div", { style: "font-size:12.5px" }, "");
  // era: formats you can choose, overheads you cannot avoid, and the bond
  const era = { formats: [], era_costs: [], bond: { available: false, cost: 0 } };
  const picked = new Set();
  let bondOn = false;
  const eraBox = el("div", {});
  const fmtCost = () => era.formats.filter((f) => picked.has(f.id) && !f.standard).reduce((a, f) => a + f.cost, 0);
  const eraCost = () => era.era_costs.reduce((a, c) => a + c.amount, 0);
  async function loadEra() {
    const r = await api("/api/formats", { budget: +budgetIn.value || 0, genre: s.genre, scale: opt.scale });
    if (!r.ok) return;
    Object.assign(era, r);
    setHTML(eraBox, eraPanel());
    redrawCost();
  }
  function eraPanel() {
    return el("div.era", {},
      era.formats.length ? el("div.era-h", {}, `FORMATS · ${S.state.game.year}`) : null,
      ...era.formats.map((f) => el("label.fmt" + (f.standard ? ".std" : ""), { title: f.blurb },
        el("input", { type: "checkbox", checked: (f.standard || picked.has(f.id)) ? "checked" : null,
          disabled: f.standard ? "disabled" : null,
          onchange: (e) => { e.target.checked ? picked.add(f.id) : picked.delete(f.id); redrawCost(); } }),
        el("b", {}, f.label),
        el("span.mut", {}, f.standard ? " — standard now, included in every picture"
          : ` — ${f.cost < 0 ? "saves " + money(-f.cost) : money(f.cost)}`
            + (f.appeal ? ` · +${n1(f.appeal)}% audience for a ${s.genre}` : "")
            + (f.critics ? ` · critics ${f.critics}` : "")),
        f.miss ? el("span.neg", {}, ` · skip it and lose ${n1(f.miss)}%: audiences expect it now`) : null)),
      era.era_costs.length ? el("div.era-h", {}, "ERA OVERHEADS (every picture pays)") : null,
      ...era.era_costs.map((c) => el("div.fmt", { title: c.why }, el("b", {}, c.label), el("span.mut", {}, ` — ${money(c.amount)} · ${c.why}`))),
      era.bond.available ? el("label.fmt", {},
        el("input", { type: "checkbox", checked: bondOn ? "checked" : null, onchange: (e) => { bondOn = e.target.checked; redrawCost(); } }),
        el("b", {}, "Completion bond"),
        el("span.mut", {}, ` — ${money(era.bond.cost)} · the insurer pays 65% of on-set disasters, and half the spend back if you have to shut it down mid-shoot`)) : null);
  }
  const dirFee = () => {
    const d = (dirs.rows || []).find((x) => String(x.id) === dirSel.value);
    return d ? d.fee * Math.pow(scaleOf().mult, 0.7) : 0;
  };
  function redrawCost() {
    const extras = fmtCost() + eraCost() + (bondOn ? era.bond.cost : 0);
    const down = (+budgetIn.value || 0) * 0.18 + (+marketIn.value || 0) + dirFee() + extras
      + (s.status === "optioned" ? s.price * 0.82 : 0);
    cost.textContent = `Due today: ${money(down)} (18% budget draw + prints & ads${dirFee() ? " + director " + money(dirFee()) : ""}`
      + `${extras ? " + formats & era costs " + money(extras) : ""}${s.status === "optioned" ? " + option exercise" : ""}). Cast fees come later, role by role.`;
    cost.className = down > S.state.game.cash ? "neg" : "";
  }
  function redrawBudget() {
    const sc = scaleOf();
    budgetIn.value = Math.round((s.std_cost || 300000) * (sc.mult || 1) / 1000) * 1000;
    marketIn.value = Math.round(+budgetIn.value * 0.25 / 1000) * 1000;
    info.textContent = `${sc.label}: ${(sc.weeks || []).join("–")} shooting weeks; a typical ${S.state.game.year} picture costs ${money(s.std_cost)}`;
    redrawCost();
    loadEra();
  }
  budgetIn.addEventListener("change", () => loadEra());
  redrawBudget();
  const full = s.in_work >= s.slots;
  showModal(el("div.panel", {},
    el("div.panel-h", {}, el("h2", {}, "Greenlight"),
      el("div.right", {}, el("button.btn.sm", { onclick: hideModal }, "cancel"))),
    el("div.panel-b", {},
      el("dl.kv", {},
        el("dt", {}, "Script"), el("dd", {}, `${s.title} (${s.genre}${s.subgenre ? " · " + s.subgenre : ""})`),
        el("dt", {}, "Coverage"), el("dd", {}, s.coverage !== null && s.coverage !== undefined ? `${n0(s.coverage)} ± ${n0(s.coverage_pm)}` : "unread"),
        el("dt", {}, "Stages"), el("dd", { class: full ? "neg" : "" }, `${n0(s.in_work)} of ${n0(s.slots)} in use${full ? " — build a Sound Stage in Finances, or wait for a picture to finish" : ""}`)),
      el("div", { style: "margin-top:10px;display:flex;flex-direction:column;gap:8px" },
        el("label.f", {}, "Title", titleIn),
        el("label.f", {}, "Scale", scaleSel),
        el("label.f", {}, "Production budget", budgetIn),
        el("label.f", {}, "Prints & ads", marketIn),
        el("label.f", {}, "Director", dirSel),
        info, eraBox, cost),
      el("div.modal-actions", {}, el("button.btn.gold", { disabled: full ? "disabled" : null,
        onclick: async () => {
          const r = await api("/api/production", {
            action: "create", script_id: sid, scale: opt.scale, title: titleIn.value,
            budget: +budgetIn.value, marketing: +marketIn.value,
            director_id: dirSel.value ? +dirSel.value : null,
            formats: [...picked], bond: bondOn,
          }, "POST");
          if (r.ok) {
            toast("Greenlit: " + (titleIn.value || "picture") + " — now cast it.");
            S.tab = "production"; renderTabs(); await refreshState(); await renderView();
            productionModal(r.id);
          }
        } }, "Start production")))));
}

// ----------------------------------------------------------- PRODUCTION
Views.production = async function (v) {
  v.innerHTML = "";
  const d = await api("/api/productions");
  const p = el("div.panel", {}, el("div.panel-h", {}, el("h2", {}, "Production office"),
    el("span.sub", {}, `${(d.rows || []).length} picture(s) in the pipeline`),
    el("div.right", {}, el("button.btn.sm", { onclick: () => { S.tab = "scripts"; renderTabs(); renderView(); } }, "script library"))));
  const b = el("div.panel-b");
  if (!(d.rows || []).length) b.appendChild(el("div.empty", {}, "Nothing shooting. Greenlight something from the Scripts tab."));
  else b.appendChild(el("table", {},
    el("thead", {}, el("tr", {}, ["Picture", "Genre", "Phase", "Budget", "Cast", "Crew", "Quality", "Weeks", ""].map((h) => el("th", {}, h)))),
    el("tbody", {}, (d.rows || []).map((r) => el("tr.click", { onclick: () => productionModal(r.id) },
      el("td", {}, r.title, r.franchise_name ? el("span.pill.dim", {}, " " + r.franchise_name) : null),
      el("td", {}, r.genre),
      el("td", {}, el("span.pill" + (r.status === "ready" ? ".gold" : ""), {}, r.phase_label || r.status)),
      el("td", { class: "right-cell num" }, money(r.budget)),
      el("td", { class: "right-cell" }, `${n0(r.cast_count || 0)}/${n0(r.roles_total || 0)}`),
      el("td", {}, r.director_name || el("span.mut", {}, "none")),
      el("td", { style: "width:120px" }, el("div.bar.q", {}, el("i", { style: `width:${Math.max(0, Math.min(100, r.quality || 0))}%` }))),
      el("td", { class: "right-cell" }, n0(r.weeks_left)),
      el("td", { onclick: (e) => e.stopPropagation() },
        r.status === "ready" ? el("button.btn.sm.gold", { onclick: () => doRelease(r.id) }, "Release")
          : el("button.btn.sm", { onclick: () => productionModal(r.id) }, "Open")))))));
  p.appendChild(b);
  v.appendChild(p);
  if ((d.library || []).length) {
    const lp = el("div.panel", {}, el("div.panel-h", {}, el("h2", {}, "Vault — ready to greenlight")));
    const lb = el("div.panel-b", {}, el("div.chips", {}, d.library.map((s) =>
      el("span.chip", { onclick: () => greenlightModal(s.id) }, `${s.title} · ${s.genre} · ${s.known ? n0(s.quality) : "?"}`))));
    lp.appendChild(lb); v.appendChild(lp);
  }
};

async function productionModal(pid) {
  const p = await api("/api/production", { id: pid });
  if (!p.ok) return;
  const act = async (body, msg) => {
    const r = await api("/api/production", Object.assign({ id: pid }, body), "POST");
    if (r.ok) { if (msg) toast(typeof msg === "function" ? msg(r) : msg); await refreshState(); productionModal(pid); }
    return r;
  };
  const host = el("div.panel", {},
    el("div.panel-h", {}, el("h2", {}, p.title),
      el("span.sub", {}, `${p.genre} · ${p.phase_label}${p.halted ? " · HALTED" : ""} · ${n0(p.weeks_left)} wk left in phase`),
      el("div.right", {},
        p.status === "ready" ? el("button.btn.sm.gold", { onclick: async () => { hideModal(); doRelease(pid); } }, "Release") : null,
        el("button.btn.sm", { title: `costs ${money(p.test_cost)}`,
          onclick: () => act({ action: "test" }, (r) => `Screening: ${n0(r.score)} — ${r.verdict}`) }, `Test screening ${money(p.test_cost)}`),
        p.can_reshoot ? el("button.btn.sm", { title: "more quality, more weeks; can backfire",
          onclick: () => act({ action: "reshoot" }, (r) => `Reshoots: ${r.effect >= 0 ? "+" : ""}${n1(r.effect)} quality`) }, `Reshoot ${money(p.reshoot_cost)}`) : null,
        el("button.btn.sm.red", { onclick: async () => {
          if (!confirm(`Shut down "${p.title}"? Money spent is gone.`)) return;
          const r = await api("/api/production", { action: "cancel", id: pid }, "POST");
          if (r.ok) { toast("Picture shut down."); hideModal(); await refreshState(); renderView(); } } }, "Shut down"),
        el("button.btn.sm", { onclick: hideModal }, "close"))));
  const body = el("div.panel-b");
  const split = p.split || {};

  // director: hire or replace while the camera can still change hands
  const canDirect = ["development", "pre_production", "shooting"].includes(p.status);
  const dirHost = el("span", {}, p.director_id ? `${p.director.name} · vision ${n0(p.director.vision)}` : el("span.neg", {}, "none — hire one"));
  if (canDirect) {
    const btn = el("button.btn.sm", { style: "margin-left:6px", onclick: async () => {
      const dirs = await api("/api/directors", { limit: 40, sort: "vision", dir: "desc" });
      const mult = Math.pow((S.cfg.scales.find((x) => x.id === p.scale) || { mult: 1 }).mult, 0.7);
      const sel = el("select", {}, (dirs.rows || []).map((d) =>
        el("option", { value: d.id }, `${d.name} · vision ${n0(d.vision)} · ${money(d.fee * mult)}`)));
      setHTML(dirHost, el("span", {}, sel, " ",
        el("button.btn.sm.gold", { onclick: () => act({ action: "director", director_id: +sel.value }, (r) => `Director hired for ${money(r.cost)}.`) }, "Hire"),
        " ", el("button.btn.sm", { onclick: () => productionModal(pid) }, "×")));
    } }, p.director_id ? "replace" : "hire");
    dirHost.appendChild(btn);
  }
  const mktIn = el("input", { type: "number", step: 1000, value: Math.round(p.marketing || 0), style: "width:110px" });
  body.appendChild(el("div.grid3", {},
    el("div", {}, el("dl.kv", {},
      el("dt", {}, "Budget"), el("dd", {}, `${money(p.budget)} (spent ${money(split.spent)})`),
      el("dt", {}, "Prints & ads"), el("dd", {}, p.status === "released" ? money(p.marketing) : el("span", {}, mktIn, " ",
        el("button.btn.sm", { onclick: () => act({ action: "marketing", amount: +mktIn.value }, "Marketing revised.") }, "set"))),
      el("dt", {}, "Script"), el("dd", {}, (p.script || {}).title || "—"),
      el("dt", {}, "Director"), el("dd", {}, dirHost))),
    el("div", {}, el("dl.kv", {},
      el("dt", {}, "Quality now"), el("dd", {}, el("b", {}, `${n0(p.quality_now)} (${n0(p.q_low)}–${n0(p.q_high)})`)),
      el("dt", {}, "Cast power"), el("dd", {}, n0(p.cast_power)),
      el("dt", {}, "Chemistry"), el("dd", {}, n0(p.chemistry)),
      el("dt", {}, "Production values"), el("dd", {}, n0(p.craft)),
      el("dt", {}, "Hype"), el("dd", {}, n0(p.hype)),
      p.test_score ? el("dt", {}, "Test card") : null, p.test_score ? el("dd", {}, n0(p.test_score)) : null)),
    el("div", {},
      el("div.mut", { style: "font-size:11px;letter-spacing:.14em" }, "WHERE THE MONEY GOES"),
      ...[["Cast", split.cast], ["Crew", split.crew], ["Values", split.values], ["Overhead", split.contingency]]
        .map(([k, val]) => el("div", { style: "display:flex;gap:8px;align-items:center;margin:2px 0" },
          el("span", { style: "width:80px;font-size:11px;color:#8b96a2" }, k),
          el("div.bar", { style: "flex:1" }, el("i", { style: `width:${Math.min(100, 100 * (val || 0) / Math.max(1, p.budget))}%` })),
          el("span.num", { style: "width:70px;font-size:11px" }, money(val)))))));

  // formats & era
  if ((p.formats || []).length || (p.era_costs || []).length || (p.bond || {}).available) {
    const chosen = new Set((p.formats || []).filter((f) => f.on && !f.standard).map((f) => f.id));
    body.appendChild(el("div.era", { style: "margin-top:14px" },
      el("div.era-h", {}, p.formats_locked ? "FORMATS (locked: the cameras are rolling)" : "FORMATS (change until shooting starts; 80% back if you drop one)"),
      ...(p.formats || []).map((f) => el("label.fmt" + (f.standard ? ".std" : ""), { title: f.blurb },
        el("input", { type: "checkbox", checked: f.on ? "checked" : null,
          disabled: (f.standard || p.formats_locked) ? "disabled" : null,
          onchange: async (e) => { e.target.checked ? chosen.add(f.id) : chosen.delete(f.id);
            await act({ action: "formats", formats: [...chosen] }, "Formats updated."); } }),
        el("b", {}, f.label),
        el("span.mut", {}, f.standard ? " — standard" : ` — ${f.cost < 0 ? "saves " + money(-f.cost) : money(f.cost)}${f.appeal ? ` · +${n1(f.appeal)}% audience` : ""}`),
        !f.on && f.miss ? el("span.neg", {}, ` · without it: −${n1(f.miss)}%`) : null)),
      (p.era_costs || []).length ? el("div.mut", { style: "font-size:11px;margin-top:4px" },
        `Era overheads paid at greenlight: ${money(p.era_paid)} (${p.era_costs.map((c) => c.label).join(", ")}).`) : null,
      p.bond.available ? el("div", { style: "margin-top:4px;font-size:12px" },
        p.bond.on ? el("span.pill.good", {}, "bonded — the insurer carries most on-set disasters")
          : p.formats_locked ? el("span.mut", {}, "No completion bond.")
          : el("button.btn.sm", { onclick: () => act({ action: "bond" }, "Completion bond in place.") }, `Take out a completion bond (${money(p.bond.cost)})`)) : null));
  }

  // roles + auditions
  body.appendChild(el("div", { style: "margin-top:14px" },
    el("div", { style: "display:flex;align-items:center;gap:10px" },
      el("div.mut", { style: "font-size:11px;letter-spacing:.14em" }, "CASTING"),
      p.can_recast && (p.roles || []).some((r) => !r.actor_name)
        ? el("button.btn.sm.gold", { title: "Fill every empty role with the best affordable fit (leads first, your contract players and returning stars preferred)",
            onclick: async () => {
              const r = await api("/api/production", { action: "auto_cast", id: pid }, "POST");
              if (r.ok) {
                toast(`Cast ${r.cast.length} role${r.cast.length === 1 ? "" : "s"} for ${money(r.spent)}`
                  + (r.missed && r.missed.length ? ` · still open: ${r.missed.join(", ")}` : ""));
                await refreshState(); productionModal(pid);
              }
            } }, "Auto-cast empty roles") : null),
    el("table", {},
      el("thead", {}, el("tr", {}, ["Role", "Character", "Needs", "Cast", "Fit", "Fee", ""].map((h) => el("th", {}, h)))),
      el("tbody", {}, (p.roles || []).map((r) => el("tr", {},
        el("td", {}, r.label), el("td", {}, r.name),
        el("td", { class: "mut", style: "font-size:11px" },
          `${r.gender === "any" ? "any" : r.gender === "f" ? "female" : "male"} · ${r.min_age}-${r.max_age} · ${r.skill} · fit ${n0(r.min_skill)}+`
          + (r.want_stunts ? " · stunts" : "") + (r.want_dance ? " · dance" : "") + (r.want_voice ? " · voice" : "")),
        el("td", {}, r.actor_name
          ? el("span", {}, el("b.click-name", { onclick: () => actorModal(r.actor_id) }, r.actor_name),
              r.contract ? el("span.pill.gold", { style: "margin-left:5px" }, "yours") : null)
          : el("span.neg", {}, "empty")),
        el("td", { class: "right-cell" }, r.actor_name ? el("b", { class: r.fit >= r.min_skill ? "pos" : "neg" }, n0(r.fit)) : ""),
        el("td", { class: "num right-cell" }, r.actor_name ? money(r.fee) : ""),
        el("td", {},
          !p.can_recast ? "" : r.actor_name
            ? el("button.btn.sm", { onclick: () => act({ action: "uncast", role_id: r.id }, `${r.actor_name} is off the picture.`) }, "Swap")
            : el("button.btn.sm.gold", { onclick: () => auditionsModal(pid, r) }, "Audition"))))))));

  // upgrades
  body.appendChild(el("div", { style: "margin-top:14px" },
    el("div", { style: "display:flex;align-items:center;gap:10px" },
      el("div.mut", { style: "font-size:11px;letter-spacing:.14em" }, "PRODUCTION VALUES"),
      p.can_recast ? el("button.btn.sm.gold", { title: "Raise every line to the top tier the era allows, cheapest first, as far as the cash goes",
        onclick: async () => {
          const r = await api("/api/production", { action: "max_upgrades", id: pid }, "POST");
          if (r.ok) {
            toast(r.steps ? `Production values raised ${r.steps} tier${r.steps === 1 ? "" : "s"} for ${money(r.spent)}`
              + (r.short ? " (ran out of cash before the top)" : "") : "Already maxed out.");
            await refreshState(); productionModal(pid);
          }
        } }, "Max all") : null),
    el("table", {}, el("tbody", {}, Object.entries(p.upgrade_costs || {}).map(([cat, u]) => {
      if (cat === "marketing") return null;
      const tier = (p.upgrades || {})[cat] || 0;
      const locked = !p.can_recast;
      return el("tr", {},
        el("td", {}, (S.cfg.upgrades.find((x) => x.id === cat) || {}).label || cat),
        el("td", { style: "width:150px" }, el("div.bar", {}, el("i", { style: `width:${100 * tier / Math.max(1, u.max)}%` }))),
        el("td", { class: "right-cell" }, `${tier}/${u.max}`),
        el("td", { class: "mut right-cell", style: "font-size:11px" }, u.weight ? `impact ${u.weight}` : ""),
        el("td", { class: "right-cell num" }, tier >= u.max ? "maxed" : money(u.next_cost)),
        el("td", {},
          el("button.btn.sm", { disabled: (locked || tier <= 0) ? "disabled" : null,
            onclick: () => act({ action: "upgrade", cat, tier: tier - 1 }) }, "−"),
          " ",
          el("button.btn.sm", { disabled: (locked || tier >= u.max) ? "disabled" : null,
            onclick: () => act({ action: "upgrade", cat, tier: tier + 1 }) }, "+")));
    })))));

  const log = (p.log || []).slice(-8).reverse();
  if (log.length) body.appendChild(el("div", { style: "margin-top:12px;font-size:12px" },
    el("div.mut", { style: "font-size:11px;letter-spacing:.14em" }, "PRODUCTION LOG"),
    ...log.map((l) => el("div", {}, typeof l === "string" ? l : (l.text || l.title || JSON.stringify(l))))));

  host.appendChild(body);
  showModal(host);
}

async function auditionsModal(pid, role) {
  const s = await api("/api/auditions", { production: pid, role: role.id, limit: 30 });
  if (!s.ok) return;
  const rows = s.rows || [];
  const cnt = s.counts || {};
  const own = rows.filter((r) => r.section === "inhouse");
  const town = rows.filter((r) => r.section !== "inhouse");
  const COLS = 10;
  // a full-width bar that splits the list; `kind` picks the styling
  const bar = (kind, title, note) => el("tr.sep." + kind, {},
    el("td", { colspan: String(COLS) }, el("span.sep-t", {}, title), note ? el("span.sep-n", {}, note) : null));
  const blank = (text) => el("tr.sep-empty", {}, el("td", { colspan: String(COLS) }, text));

  const rowFor = (r) => el("tr" + (r.section === "inhouse" ? ".inhouse" : ""), {},
    el("td", {}, el("span.click-name", { onclick: () => actorModal(r.id) }, r.name),
      r.section === "inhouse"
        ? el("span.pill.gold", { style: "margin-left:6px" }, `yours · ${n0(r.contract_films)} film${r.contract_films === 1 ? "" : "s"} left`)
        : null,
      r.returning ? el("span.pill.good", { style: "margin-left:6px", title: "appeared in earlier installments of this series" },
        `${r.returning_lead ? "returning star" : "returning"} · ${n0(r.returning_films)} film${r.returning_films === 1 ? "" : "s"}`) : null),
    el("td", { class: "right-cell" }, n0(r.age)),
    el("td", { class: "right-cell" }, n0(r.fame)),
    el("td", { class: "right-cell" }, n0(r.star_power)),
    el("td", { class: "right-cell", title: `part needs ${n0(r.skill_req)}` }, n0(r.skill)),
    el("td", { class: "right-cell", title: `±${n0(r.fit_pm)}` },
      el("b", { class: r.fit > 70 ? "pos" : r.fit < 45 ? "neg" : "" }, n0(r.fit))),
    el("td", { class: "right-cell" }, r.chemistry === null || r.chemistry === undefined ? "\u2014" : n0(r.chemistry)),
    el("td", { class: "right-cell num" }, money(r.fee),
      r.section === "inhouse" ? el("div.mut", { style: "font-size:10px" }, "contract rate") : null),
    el("td", {}, el("span.pill" + (r.risk > 55 ? ".bad" : r.risk > 35 ? ".info" : ""), {}, n0(r.risk))),
    el("td", {}, el("button.btn.sm.gold", {
      onclick: async () => {
        const res = await api("/api/production", { action: "cast", id: pid, role_id: role.id, actor_id: r.id }, "POST");
        if (res.ok) { toast(`${r.name} is ${role.label} (${money(res.fee)}).`); await refreshState(); productionModal(pid); }
      } }, r.section === "inhouse" ? "Cast" : "Audition & cast")));

  const body = [];
  // ---- top: people you already have under contract who are free and fit
  body.push(bar("own", `Your studio \u2014 under contract, free & right for the part (${own.length})`,
    "no audition needed · paid at their contract rate"));
  if (own.length) own.forEach((r) => body.push(rowFor(r)));
  else {
    const why = [];
    if (!cnt.payroll) why.push("you have nobody under contract yet \u2014 sign people from Talent or an open call");
    else {
      if (cnt.inhouse_elsewhere) why.push(`${cnt.inhouse_elsewhere} busy on another picture or the wrong age/sex for this part`);
      if (cnt.inhouse_unfit) why.push(`${cnt.inhouse_unfit} not good enough for it (fit below ${n0((s.role || {}).min_skill)})`);
    }
    body.push(blank(`Nobody on your payroll fits this part${why.length ? ": " + why.join("; ") : "."}`));
  }
  // ---- the separator, then outside talent to audition in
  body.push(bar("town", `Outside talent \u2014 audition in from town (${n0(cnt.market || town.length)} available)`,
    cnt.away ? `${n0(cnt.away)} away (war draft / hearings) · one-picture fee` : "one-picture fee, paid when cast"));
  if (town.length) town.forEach((r) => body.push(rowFor(r)));
  else body.push(blank("Nobody in town matches. Try an open call, or widen the part."));

  const missing = s.returning_missing || [];
  const seriesNote = s.sequel ? el("div", { style: "font-size:12px;margin-bottom:8px" },
    el("span.pill.good", {}, "sequel"), " Returning cast is marked and listed first \u2014 fans pay to see the same faces.",
    missing.length ? el("div.mut", { style: "margin-top:4px" }, "Not available from the earlier pictures: ",
      missing.map((m, i) => el("span", {}, i ? "; " : "", el("b", {}, m.name), m.lead ? " (lead)" : "", ` \u2014 ${m.why}`))) : null) : null;
  showModal(el("div.panel", {},
    el("div.panel-h", {}, el("h2", {}, `Casting: ${role.label} \u2014 ${role.name}`),
      el("span.sub", {}, `${role.gender === "any" ? "any" : role.gender === "f" ? "female" : "male"} · ages ${role.min_age}-${role.max_age} · ${role.skill} · needs fit ${n0(role.min_skill)}`),
      el("div.right", {}, el("button.btn.sm", { onclick: () => productionModal(pid) }, "back"))),
    el("div.panel-b", {},
      seriesNote,
      el("table.audition", {},
        el("thead", {}, el("tr", {}, ["Actor", "Age", "Fame", "Star", "Skill", "Fit", "Chemistry", "Fee", "Risk", ""].map((h) => el("th", {}, h)))),
        el("tbody", {}, body)),
      el("div.mut", { style: "font-size:11px;margin-top:8px" },
        "Fit and chemistry are your casting office's read, not the truth (± shown on hover). A bigger casting office reads people better."))));
}
