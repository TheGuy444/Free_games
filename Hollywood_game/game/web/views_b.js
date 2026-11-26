// Hollywood Tycoon - views B: releases, franchises, world, finance, awards.
"use strict";

// --------------------------------------------------------------- RELEASES
Views.releases = async function (v) {
  v.innerHTML = "";
  const st = S.state;
  const cat = await api("/api/catalogue", { limit: 8 });
  if (cat.ok && (cat.rows || []).length) {
    v.appendChild(el("div.panel", {}, el("div.panel-h", {}, el("h2", {}, "Library desk"),
        el("span.sub", {}, "titles that would pay to put out on today's home formats")),
      el("div.panel-b", {}, el("table", {}, el("tbody", {}, cat.rows.map((m) => el("tr", {},
        el("td", {}, el("span.click-name", { onclick: () => releaseModal(m.id) }, m.title), el("span.mut", {}, ` ${m.year}`)),
        el("td", { class: `out-${m.outcome}` }, m.outcome),
        el("td", {}, m.options.map((o) => el("button.btn.sm", { style: "margin-right:4px",
          title: `${o.blurb} About ${money(o.extra)} a year extra for ${o.years} years.`,
          onclick: async () => {
            const r = await api("/api/home", { id: m.id, kind: o.id }, "POST");
            if (r.ok) { toast(`${o.label}: ${m.title}.`); await refreshState(); renderView(); }
          } }, `${o.label} ${money(o.cost)} → +${money(o.extra)}/yr`))))))))));
  }
  const yrs = ((st.charts || {}).years || []);
  const ch = el("div.panel", {}, el("div.panel-h", {}, el("h2", {}, "Studio trajectory")));
  const chb = el("div.panel-b");
  chart(chb, [
    { label: "gross", color: "#6aa8d8", values: yrs.map((y) => y.gross) },
    { label: "net", color: "#6ac46a", values: yrs.map((y) => y.net) },
    { label: "cash", color: "#d9a441", values: yrs.map((y) => y.cash) },
  ], { labels: yrs.map((y) => y.year), h: 140 });
  ch.appendChild(chb); v.appendChild(ch);

  const gch = el("div.panel", {}, el("div.panel-h", {}, el("h2", {}, "Where the money came from")));
  const gtb = el("div.panel-b");
  const genres = (st.charts || {}).genres || [];
  if (!genres.length) gtb.appendChild(el("div.empty", {}, "release something first"));
  else genres.forEach((g) => gtb.appendChild(el("div", { style: "display:flex;gap:8px;align-items:center;margin:3px 0" },
    el("span", { style: "width:90px;font-size:12px" }, g.genre),
    el("div.bar", { style: "flex:1" }, el("i", { style: `width:${100 * (g.g || 0) / Math.max(1, genres[0].g)}%` })),
    el("span.num", { style: "width:110px;font-size:11px" }, `${money(g.g)} · ${g.n} pic`))));
  ch.appendChild(gtb);

  await listView(v, {
    key: "releases", title: "Catalogue", path: "/api/releases", pageSize: 25, sort: "year",
    defaults: { sort: "year", dir: "desc", rights: "player" },
    filters: [
      { type: "text", k: "q", label: "title…" },
      { type: "select", k: "outcome", label: "outcome", options: [["", "all"], ["PHENOMENON", "phenomenon"], ["BLOCKBUSTER", "blockbuster"], ["HIT", "hit"], ["SOLID", "solid"], ["TROUGH", "trough"], ["FLOP", "flop"], ["STINKER", "stinker"]] },
      { type: "select", k: "genre", label: "genre", options: [["", "all genres"]].concat((S.cfg.genres || []).map((g) => [g.id, g.label])) },
      { type: "select", k: "rights", label: "rights", options: [["player", "owned"], ["sold", "sold off"], ["any", "everything"]] },
      { type: "select", k: "sort", label: "sort", options: [["year", "year"], ["gross", "gross"], ["net", "profit"], ["quality", "quality"], ["critics", "critics"], ["cult", "cult"]] },
      { type: "select", k: "dir", label: "", options: [["desc", "high first"], ["asc", "low first"]] },
    ],
    columns: [
      { k: "year", label: "Year", cls: "right-cell", sortKey: "year" },
      { k: "title", label: "Picture", sortKey: "title", fmt: (r) => el("span", {}, r.title,
        r.cult_classic ? el("span.pill.cult", {}, " cult") : null,
        r.franchise_name ? el("span.pill.dim", {}, " " + r.franchise_name) : null) },
      { k: "genre", label: "Genre" },
      { k: "quality", label: "Q", cls: "right-cell", sortKey: "quality", fmt: (r) => n0(r.quality) },
      { k: "critics", label: "Crit", cls: "right-cell", sortKey: "critics", fmt: (r) => n0(r.critics) },
      { k: "audience", label: "Aud", cls: "right-cell", sortKey: "audience", fmt: (r) => n0(r.audience) },
      { k: "budget", label: "Cost", cls: "right-cell num", sortKey: "budget", fmt: (r) => money((r.budget || 0) + (r.marketing || 0)) },
      { k: "gross", label: "Gross", cls: "right-cell num", sortKey: "gross", fmt: (r) => money(r.gross) },
      { k: "net", label: "Profit", cls: "right-cell num", sortKey: "net", fmt: (r) => el("span", { class: signClass(r.net) }, money(r.net)) },
      { k: "outcome", label: "Result", sortKey: "outcome", fmt: (r) => el("span", { class: "out-" + r.outcome }, r.outcome) },
      { k: "seq", label: "Series", sortable: false, fmt: (r) => r.rights !== "player" ? el("span.mut", {}, "sold")
        : r.franchise_id ? el("span.mut", {}, `#${n0(r.seq_index)}`)
        : el("button.btn.sm", { onclick: (e) => { e.stopPropagation(); seriesLaunchModal({ movie: r, kind: "sequel" }); } }, "Sequel") },
    ],
    onRow: (r) => releaseModal(r.id),
  });
};

async function releaseModal(id) {
  const row = await api("/api/movie", { id });
  if (!row.ok) return;
  showModal(el("div.panel", {},
    el("div.panel-h", {}, el("h2", {}, row.title || "Picture"),
      el("span.sub", {}, `${row.year} · ${row.genre} · ${row.scale}`),
      el("div.right", {}, el("button.btn.sm", { onclick: hideModal }, "close"))),
    el("div.panel-b", {},
      el("dl.kv", {},
        el("dt", {}, "Result"), el("dd", {}, el("span", { class: "out-" + row.outcome }, row.outcome || "—")),
        el("dt", {}, "Domestic / foreign"), el("dd", {}, `${money(row.domestic)} / ${money(row.foreign)}`),
        el("dt", {}, "Gross"), el("dd", {}, money(row.gross)),
        el("dt", {}, "Cost"), el("dd", {}, `${money(row.budget)} + ${money(row.marketing)} P&A`),
        el("dt", {}, "Studio net"), el("dd", {}, el("span", { class: signClass(row.net) }, money(row.net))),
        el("dt", {}, "Library income so far"), el("dd", {}, money(row.secondary)),
        el("dt", {}, "Critics / audience"), el("dd", {}, `${n0(row.critics)} / ${n0(row.audience)}`),
        row.chart ? el("dt", {}, "Chart run") : null,
        row.chart ? el("dd", {}, row.chart.active
          ? `in release: #${row.chart.rank || "—"} in week ${row.chart.wk}`
          : `${n0(row.chart.wk)} weeks in cinemas`,
          ` · peaked at #${row.chart.best_rank || "—"}`,
          row.chart.w1 ? ` · ${row.chart.w1} week${row.chart.w1 === 1 ? "" : "s"} at #1` : "",
          row.chart.w10 ? ` · ${row.chart.w10} in the top 10` : "") : null,
        el("dt", {}, "Quality"), el("dd", {}, n0(row.quality)),
        el("dt", {}, "Awards"), el("dd", {}, `${n0(row.wins)} won · ${n0(row.noms)} nominations${row.razzies ? ` · ${row.razzies} Razzie` : ""}`),
        el("dt", {}, "Cult"), el("dd", {}, `${n0(row.cult)}${row.cult_classic ? " — cult classic" : ""}`),
        el("dt", {}, "Director"), el("dd", {}, row.director_name || "—"),
        el("dt", {}, "Series"), el("dd", {}, row.franchise_name || "—"),
        el("dt", {}, "Rights"), el("dd", {}, row.rights === "player" ? "you own it" : `owned by ${row.rights}`)),
      (row.cast || []).length ? el("div", { style: "margin-top:10px" },
        el("div.mut", { style: "font-size:11px;letter-spacing:.14em" }, "PRINCIPALS"),
        el("div.chips", {}, row.cast.map((c) => typeof c === "string" ? el("span.chip", {}, c)
          : el("span.chip", { onclick: () => c.id && actorModal(c.id) }, `${c.name || "?"} as ${c.role || c.label || ""}`)))) : null,
      (row.formats || []).length ? el("div", { style: "margin-top:8px;font-size:12px" }, "Shot in: ",
        row.formats.map((f) => el("span.pill", { style: "margin-right:4px" }, f))) : null,
      (row.home || []).length ? el("div.era", { style: "margin-top:10px" },
        el("div.era-h", {}, "HOME FORMATS"),
        ...row.home.map((h) => el("div.fmt", {},
          el("b", {}, h.label), el("span.mut", {}, ` — ${h.blurb} `),
          h.done ? el("span.pill.good", {}, h.active ? `on the shelves until ${h.until}` : `done (ran to ${h.until})`)
            : el("span", {}, el("span.mut", {}, `${money(h.cost)} for about ${money(h.extra)} a year extra, ${h.years} years `),
              el("button.btn.sm" + (h.expected > h.cost * 1.3 ? ".gold" : ""), { onclick: async () => {
                const r = await api("/api/home", { id: row.id, kind: h.id }, "POST");
                if (r.ok) { toast(`${h.label}: on the shelves until ${r.until}.`); await refreshState(); releaseModal(row.id); }
              } }, "Do it"))))) : null,
      row.can_series ? el("div.mut", { style: "font-size:11px;margin-top:10px" },
        `As a series this picture would start with a fan base of about ${n0(row.series_fan)} `
        + `(setting up the rights costs ${money(row.series_fee)}). Bigger hits make bigger fan bases.`) : null,
      el("div.modal-actions", {},
        row.has_review ? el("button.btn", { onclick: () => reviewModal(row.id, { archive: true }) }, "Read the reviews") : null,
        row.can_series ? el("button.btn.gold", { onclick: () => seriesLaunchModal({ movie: row, kind: "sequel" }) }, "Make a sequel") : null,
        row.can_series ? el("button.btn", { onclick: async () => { hideModal(); await franchiseCreateFrom(row.id, row.title); } }, "Start a series (no sequel yet)") : null,
        row.series && row.series.mine ? el("button.btn.gold", { onclick: () => seriesLaunchModal({ fid: row.series.id, kind: "sequel" }) }, `Next ${row.series.name}`) : null,
        row.series && row.series.mine ? el("button.btn", { onclick: () => seriesLaunchModal({ fid: row.series.id, kind: "reboot" }) }, "Reboot the series") : null,
        row.series ? el("button.btn", { onclick: () => franchiseModal(row.series.id) }, "Open the series") : null,
        row.can_sell ? el("button.btn.red", { onclick: () => solicitModal("movie", row.id, row.title) }, "Shop the rights") : null))));
}

// ------------------------------------------------------------- FRANCHISES
Views.franchises = async function (v) {
  v.innerHTML = "";
  const off = await api("/api/offers");
  const op = el("div.panel", {}, el("div.panel-h", {}, el("h2", {}, "Rights desk — offers in"),
    el("span.sub", {}, `${off.open || 0} open`)));
  const ob = el("div.panel-b");
  const open = (off.rows || []).filter((r) => r.status === "open" && !r.buyable);
  if (!open.length) ob.appendChild(el("div.empty", {}, "Rivals are not begging you for anything right now."));
  else ob.appendChild(el("table", {},
    el("thead", {}, el("tr", {}, ["From", "Asset", "Kind", "Money", "Expires", ""].map((h) => el("th", {}, h)))),
    el("tbody", {}, open.map((o) => el("tr", {},
      el("td", {}, o.from),
      el("td", {}, o.asset_label || o.title || o.asset,
        o.financing ? el("div.mut", { style: "font-size:10.5px" }, o.financing) : null),
      el("td", {}, o.kind, o.verdict ? el("div.mut", { style: "font-size:10px" }, o.verdict) : null),
      el("td", { class: "right-cell num" }, el("b", {}, money(o.amount))),
      el("td", {}, String(o.expires_year || "—")),
      el("td", {}, el("button.btn.sm.gold", { onclick: () => sellOffer(o.id, true) }, "Sell"), " ",
        el("button.btn.sm", { onclick: () => sellOffer(o.id, false) }, "Refuse")))))));
  op.appendChild(ob); v.appendChild(op);

  const acq = (off.rows || []).filter((r) => r.buyable && r.status === "open");
  if (acq.length) {
    const ap = el("div.panel", {}, el("div.panel-h", {}, el("h2", {}, "Estate sales & bankruptcies")));
    ap.appendChild(el("div.panel-b", {}, el("table", {}, el("tbody", {}, acq.map((o) => el("tr", {},
      el("td", {}, o.asset_label || o.title, el("div.mut", { style: "font-size:11px" }, o.terms || "")), el("td", {}, o.from),
      el("td", { class: "right-cell num" }, money(o.amount)),
      el("td", {}, el("button.btn.sm", { onclick: async () => {
        const r = await api("/api/franchise", { action: "acquire", offer_id: o.id }, "POST");
        if (r.ok) { toast(`Acquired for ${money(r.price)}.`); await refreshState(); renderView(); }
      } }, "Buy"))))))));
    v.appendChild(ap);
  }

  const fr = await api("/api/franchises");
  const fp = el("div.panel", {}, el("div.panel-h", {}, el("h2", {}, "Series & libraries"),
    el("div.right", {}, el("button.btn.sm.gold", { onclick: () => teamupModal() }, "Team-up…"))));
  const fb = el("div.panel-b");
  if (!(fr.rows || []).length) fb.appendChild(el("div.empty", {}, "No series yet. Open any released picture in Releases and hit \u201cMake a sequel\u201d."));
  else fb.appendChild(el("table", {},
    el("thead", {}, el("tr", {}, ["Series", "Films", "Fan base", "Heat", "Fatigue", "Box office", "Rights", ""].map((h) => el("th", {}, h)))),
    el("tbody", {}, (fr.rows || []).map((f) => el("tr.click", { onclick: () => franchiseModal(f.id) },
      el("td", {}, f.name, el("div.mut", { style: "font-size:11px" }, `${f.genre} · ${f.status}${f.continuity > 1 ? ` · reboot #${f.continuity - 1}` : ""}`
          + (f.kind === "spinoff" ? ` · spin-off${f.parent_name ? " of " + f.parent_name : ""}` : f.kind === "universe" ? " · team-up" : "")),
        (f.icons || []).length ? el("div", { style: "font-size:11px;color:#d9a441" }, "★ " + f.icons.join(", ")) : null),
      el("td", { class: "right-cell" }, n0(f.installments)),
      el("td", { class: "right-cell" }, n0(f.fan_base)),
      el("td", { class: "right-cell" }, n1(f.heat)),
      el("td", { class: "right-cell" }, n0((f.fatigue || 0) * 100) + "%"),
      el("td", { class: "right-cell num" }, money(f.gross)),
      el("td", {}, el("span.pill" + (f.rights === "player" ? ".gold" : ".bad"), {}, f.rights === "player" ? "yours" : f.rights)),
      el("td", { class: "nowrap", onclick: (e) => e.stopPropagation() },
        f.can_sequel ? el("button.btn.sm.gold", { onclick: () => seriesLaunchModal({ fid: f.id, kind: "sequel" }) }, "Sequel") : null, " ",
        f.can_reboot ? el("button.btn.sm", { onclick: () => seriesLaunchModal({ fid: f.id, kind: "reboot" }) }, "Reboot") : null, " ",
        f.can_sell ? el("button.btn.sm.red", { onclick: () => solicitModal("franchise", f.id, f.name) }, "Sell") : null,
        f.rights !== "player" ? el("span.mut", {}, f.status) : f.in_production ? el("span.pill.info", {}, `#${n0(f.next_index - 1)} shooting`) : null))))));
  fp.appendChild(fb); v.appendChild(fp);

  const sold = (fr.rows || []).filter((f) => f.rights !== "player");
  if (sold.length) {
    const sp = el("div.panel", {}, el("div.panel-h", {}, el("h2", {}, "Sold — you may regret this")));
    sp.appendChild(el("div.panel-b", {}, el("div.chips", {}, sold.map((f) => el("span.chip", {},
      `${f.name} (${f.rights}${f.note ? " — " + f.note : ""}) `,
      el("button.btn.sm", { onclick: async () => {
        const r = await api("/api/franchise", { action: "buyback", kind: "franchise", asset_id: f.id }, "POST");
        if (r.ok) { toast("Bought back."); await refreshState(); renderView(); }
      } }, "buy back"))))));
    v.appendChild(sp);
  }
};

async function franchiseCreateFrom(movieId, title) {
  const name = prompt("Series name (what the marquee says):", title || "");
  if (name === null) return;
  const r = await api("/api/franchise", { action: "create", movie_id: movieId, name }, "POST");
  if (r.ok) { toast("Now a series: " + (r.name || name)); await refreshState(); renderView(); }
}

async function franchiseModal(fid) {
  const f = await api("/api/franchise", { id: fid });
  if (!f.ok) return;
  const mine = f.rights === "player";
  showModal(el("div.panel", {},
    el("div.panel-h", {}, el("h2", {}, f.name || "Series"),
      el("span.sub", {}, `${f.genre} · ${n0(f.installments)} film${f.installments === 1 ? "" : "s"} · ${f.status}${f.continuity > 1 ? ` · rebooted ${f.continuity - 1}×` : ""}`),
      el("div.right", {}, el("button.btn.sm", { onclick: hideModal }, "close"))),
    el("div.panel-b", {},
      el("div.grid2", {},
        el("dl.kv", {},
          el("dt", {}, "Fan base"), el("dd", {}, el("b", {}, n0(f.fan_base))),
          el("dt", {}, "Heat"), el("dd", {}, n1(f.heat)),
          el("dt", {}, "Fatigue"), el("dd", { class: f.fatigue > 0 ? "neg" : "" }, `${n0((f.fatigue || 0) * 100)}%${f.fatigue_note ? " — " + f.fatigue_note : ""}`),
          el("dt", {}, "Series box office"), el("dd", {}, money(f.gross)),
          el("dt", {}, "Library income / yr"), el("dd", {}, money(f.annual)),
          el("dt", {}, "Worth to you"), el("dd", {}, money(f.value)),
          el("dt", {}, "Rights"), el("dd", {}, mine ? "yours" : f.rights),
          f.note ? el("dt", {}, "Note") : null, f.note ? el("dd", {}, f.note) : null),
        el("div", {},
          el("div.mut", { style: "font-size:11px;letter-spacing:.14em" }, f.continuity > 1 ? "STARS OF THIS CONTINUITY" : "STARS OF THE SERIES"),
          (f.cast || []).length ? el("div.chips", {}, f.cast.slice(0, 12).map((c) =>
            el("span.chip" + (c.lead ? ".on" : ""), { onclick: () => actorModal(c.id) }, `${c.name} · ${c.films} film${c.films === 1 ? "" : "s"}`)))
            : el("div.mut", {}, "nobody yet"),
          el("div.mut", { style: "font-size:11px;margin-top:6px" }, "Sequels sell on returning leads: bring them back and the fans come with them."))),
      characterTable(f, mine),
      el("div.mut", { style: "font-size:11px;letter-spacing:.14em;margin-top:12px" }, "INSTALLMENTS"),
      (f.movies || []).length ? el("table", {}, el("tbody", {}, f.movies.map((m) => el("tr.click", { onclick: () => releaseModal(m.id) },
          el("td", { class: "right-cell" }, `#${n0(m.seq_index)}`), el("td", {}, String(m.year)), el("td", {}, m.title),
          el("td", { class: "right-cell num" }, money(m.gross)),
          el("td", { class: `right-cell out-${m.outcome}` }, m.outcome),
          el("td", {}, m.rights === "player" ? "" : el("span.pill.bad", {}, m.rights))))))
        : el("div.mut", {}, "none released yet"),
      f.in_production ? el("div.mut", { style: "margin-top:6px" }, `${f.in_production} installment(s) in production now.`) : null,
      mine && (f.tv || f.tv_quote) ? el("div", { style: "margin-top:12px" },
        el("div.mut", { style: "font-size:11px;letter-spacing:.14em" }, "TELEVISION"),
        f.tv ? el("div", {}, `On the air since ${f.tv.start}, through ${f.tv.until} — about ${money(f.tv_quote.annual)} a year, and the fans never drift away. `,
            el("button.btn.sm", { onclick: async () => { const r = await api("/api/franchise", { action: "tv_cancel", id: fid }, "POST"); if (r.ok) { toast("Cancelled."); franchiseModal(fid); } } }, "cancel the show"))
          : el("div", {}, `A weekly TV series: ${money(f.tv_quote.cost)} for the pilot, then about ${money(f.tv_quote.annual)} a year for ${f.tv_quote.seasons} seasons, and the fan base holds while it airs. `,
            el("button.btn.sm.gold", { onclick: async () => { const r = await api("/api/franchise", { action: "tv", id: fid }, "POST"); if (r.ok) { toast("The TV series is on the air."); await refreshState(); franchiseModal(fid); } } }, "Make the TV series"))) : null,
      f.merch_sold ? el("div.mut", { style: "font-size:11px;margin-top:6px" }, "Merchandise licence sold — toy money now goes to someone else.") : null,
      (f.offers || []).length ? el("div", { style: "margin-top:12px" },
        el("div.mut", { style: "font-size:11px;letter-spacing:.14em" }, "BIDS ON THE TABLE"),
        bidTable(f.offers, () => franchiseModal(fid))) : null,
      el("div.modal-actions", {},
        f.can_sequel ? el("button.btn.gold", { onclick: () => seriesLaunchModal({ fid, kind: "sequel" }) }, `Make #${n0(f.next_index)}`) : null,
        f.can_reboot ? el("button.btn", { onclick: () => seriesLaunchModal({ fid, kind: "reboot" }) }, "Reboot") : null,
        f.can_sell ? el("button.btn.red", { onclick: () => solicitModal("franchise", fid, f.name) }, "Sell the series") : null,
        mine && !f.in_production ? el("button.btn", { onclick: async () => {
          if (!confirm(`Option ${f.name} to a rival for 7 years? If they film one in time, it is theirs for good.`)) return;
          const r = await api("/api/franchise", { action: "option_out", id: fid, years: 7 }, "POST");
          if (r.ok) { toast(`Optioned to ${r.buyer} for ${money(r.fee)}.`); hideModal(); await refreshState(); renderView(); }
        } }, "Option it out") : null,
        !mine && f.rights && !String(f.rights).startsWith("estate") ? el("button.btn", { onclick: async () => {
          const r = await api("/api/franchise", { action: "buyback", kind: "franchise", asset_id: fid }, "POST");
          if (r.ok) { toast(`Bought back for ${money(r.price)}.`); await refreshState(); franchiseModal(fid); }
        } }, "Try to buy it back") : null))));
}

// The characters of a series: who audiences actually come back for. Their
// fans survive reboots and recasts; a breakout can be spun off; an icon is
// bigger than any one series.
function characterTable(f, mine) {
  const rows = f.characters || [];
  const box = el("div", { style: "margin-top:12px" },
    el("div.mut", { style: "font-size:11px;letter-spacing:.14em" }, f.kind === "universe" ? "THE TEAM" : "CHARACTERS"));
  if (!rows.length) { box.appendChild(el("div.mut", {}, "No named characters yet: they come from the cast of the first picture.")); return box; }
  box.appendChild(el("table", {}, el("thead", {}, el("tr", {}, ["Character", "Played by", "Fans", "Films", "Lives", ""].map((h) => el("th", {}, h)))),
    el("tbody", {}, rows.map((c) => el("tr", {},
      el("td", {}, el("b", {}, c.name), " ",
        c.icon ? el("span.pill.gold", { title: `An icon since ${c.icon_year}: fades slowly, reboots well, shrugs off recasting, earns licensing money` }, "★ icon") : null, " ",
        c.breakout >= 1 && !c.spun_off && c.role !== "lead" ? el("span.pill.good", { title: "Stole a picture: ready for a series of their own" }, "breakout") : null,
        el("div.mut", { style: "font-size:11px" }, `${c.role === "lead" ? "lead" : "supporting"}`
          + (f.kind === "universe" ? ` · from ${c.series_name}` : c.origin_name && c.origin_name !== c.series_name ? ` · first seen in ${c.origin_name}` : "")
          + ((c.teams || []).length ? ` · team-ups: ${c.teams.join(", ")}` : ""))),
      el("td", {}, c.actor_name ? el("span.click-name", { onclick: () => actorModal(c.actor_id) }, c.actor_name + (c.actor_dead ? " †" : "")) : "—",
        c.actors > 1 ? el("div.mut", { style: "font-size:11px" }, `${c.actors} faces so far`) : null),
      el("td", { class: "right-cell" }, n0(c.fan), el("div.mut", { style: "font-size:10px" }, `peak ${n0(c.peak)}`)),
      el("td", { class: "right-cell" }, n0(c.appearances)),
      el("td", { class: "right-cell" }, n0(c.lives)),
      el("td", { class: "nowrap" }, mine && f.kind !== "universe" && c.can_spinoff
        ? el("button.btn.sm.gold", { onclick: () => spinoffModal(c) }, "Spin off") : null))))));
  box.appendChild(el("div.mut", { style: "font-size:11px;margin-top:6px" },
    "Characters keep their own fans through reboots and recasts. A second life on screen (a reboot or their own series) with a loyal audience makes them an icon."));
  return box;
}

async function spinoffModal(c) {
  const std = (await api("/api/world")).era.standard_cost;
  const nameIn = el("input", { type: "text", value: c.name, maxlength: 50, style: "width:240px" });
  const scales = S.cfg.scales || [];
  const scaleSel = el("select", {}, scales.map((sc) => el("option", { value: sc.id, selected: sc.id === "standard" ? "selected" : null }, `${sc.label} (${sc.mult}×)`)));
  showModal(el("div.panel", {},
    el("div.panel-h", {}, el("h2", {}, `Spin off ${c.name}`), el("div.right", {}, el("button.btn.sm", { onclick: hideModal }, "cancel"))),
    el("div.panel-b", {},
      el("div", { style: "margin-bottom:10px" }, `${c.name} leaves ${c.series_name} for a series of their own, bringing about ${n0(c.fan * 0.9)} fans. `
        + `Rights work ${money(std * 0.03)} plus the script. The first picture goes into development.`),
      el("div", { style: "display:flex;flex-direction:column;gap:8px" }, el("label.f", {}, "Series name", nameIn), el("label.f", {}, "Scale", scaleSel)),
      el("div.modal-actions", {}, el("button.btn.gold", { onclick: async () => {
        const r = await api("/api/franchise", { action: "spinoff", character_id: c.id, name: nameIn.value.trim() || null, scale: scaleSel.value }, "POST");
        if (r.ok) { toast(`${c.name} has a series of their own.`); S.tab = "production"; renderTabs(); await refreshState(); await renderView(); productionModal(r.id); }
      } }, "Greenlight the spin-off")))));
}

async function teamupModal() {
  const d = await api("/api/characters");
  const opts = (d.teamup || []).filter((c) => c.series_kind !== "universe");
  const picked = new Set();
  const nameIn = el("input", { type: "text", value: "", maxlength: 50, placeholder: "leave blank: marketing picks one", style: "width:260px" });
  const scales = S.cfg.scales || [];
  const scaleSel = el("select", {}, el("option", { value: "" }, "let the fans decide (epic or blockbuster)"),
    scales.map((sc) => el("option", { value: sc.id }, `${sc.label} (${sc.mult}×)`)));
  const note = el("div", { style: "font-size:12.5px;margin-top:6px" });
  function redraw() {
    const ch = opts.filter((c) => picked.has(c.id));
    const series = new Set(ch.map((c) => c.franchise_id));
    note.textContent = ch.length < 2 ? "Pick at least two characters from different series."
      : series.size < 2 ? "They all come from one series - that is just a sequel. Add someone from another series."
      : ch.length > d.max_team ? `At most ${d.max_team}.`
      : `${ch.length} characters from ${series.size} series. If it works, every one of those series gains fans; if it flops, they all pay.`
        + (ch.length > 3 ? " A crowded picture is harder to write." : "");
  }
  const list = opts.length ? el("table", {}, el("tbody", {}, opts.map((c) => el("tr", {},
      el("td", {}, el("input", { type: "checkbox", onchange: (e) => { e.target.checked ? picked.add(c.id) : picked.delete(c.id); redraw(); } })),
      el("td", {}, el("b", {}, c.name), c.icon ? " ★" : "", el("div.mut", { style: "font-size:11px" }, c.series)),
      el("td", {}, c.actor_name || "—"),
      el("td", { class: "right-cell" }, `${n0(c.fan)} fans`)))))
    : el("div.empty", {}, `No characters with ${n0(d.min_fan)}+ fans yet. Build a couple of series first.`);
  redraw();
  showModal(el("div.panel", {},
    el("div.panel-h", {}, el("h2", {}, "Team-up"), el("div.right", {}, el("button.btn.sm", { onclick: hideModal }, "cancel"))),
    el("div.panel-b", {},
      el("div", { style: "margin-bottom:8px" }, "Put characters from your different series in one picture. It pools their audiences, and it becomes a series of its own."),
      list, note,
      el("div", { style: "display:flex;flex-direction:column;gap:8px;margin-top:10px" }, el("label.f", {}, "Title", nameIn), el("label.f", {}, "Scale", scaleSel)),
      el("div.modal-actions", {}, el("button.btn.gold", { onclick: async () => {
        const r = await api("/api/franchise", { action: "teamup", character_ids: [...picked], name: nameIn.value.trim() || null, scale: scaleSel.value || null }, "POST");
        if (r.ok) { toast(`${r.series}: the team-up is in development.`); S.tab = "production"; renderTabs(); await refreshState(); await renderView(); productionModal(r.id); }
      } }, "Greenlight the team-up")))));
}

// One screen for every "next picture in a series": a sequel or a reboot,
// from an existing series (opts.fid) or straight off a released picture
// that is not a series yet (opts.movie).
async function seriesLaunchModal(opts) {
  const kind = opts.kind || "sequel";
  let f = null;
  if (opts.fid) { f = await api("/api/franchise", { id: opts.fid }); if (!f.ok) return; }
  // catalogue rows lack the series estimates: fetch the full picture when needed
  const movie = !opts.movie ? null
    : opts.movie.series_fan !== undefined ? opts.movie : await api("/api/movie", { id: opts.movie.id });
  const lib = (await api("/api/scripts/library")).rows || [];
  const std = f ? f.std_cost : (await api("/api/world")).era.standard_cost;
  const spare = f ? lib.filter((s) => !s.in_use && s.source_franchise === f.id) : [];
  const scales = S.cfg.scales || [];
  const def = f && f.fan_base > 120 ? "epic" : "standard";
  const nameIn = el("input", { type: "text", value: movie ? movie.title : "", maxlength: 50, style: "width:240px" });
  const titleIn = el("input", { type: "text", value: "", maxlength: 60, placeholder: "leave blank: the writers pick one", style: "width:260px" });
  const scriptSel = el("select", {}, el("option", { value: "" }, `commission a ${kind} script (${money(std * (kind === "reboot" ? 0.085 : 0.045))})`),
    spare.map((s) => el("option", { value: s.id }, `from the vault: ${s.title}`)));
  const scaleSel = el("select", { onchange: () => redraw() }, scales.map((sc) =>
    el("option", { value: sc.id, selected: sc.id === def ? "selected" : null }, `${sc.label} (${sc.mult}×)`)));
  const budgetIn = el("input", { type: "number", step: 1000, style: "width:130px", oninput: () => cost() });
  const mktIn = el("input", { type: "number", step: 1000, style: "width:130px", oninput: () => cost() });
  const note = el("div", { style: "font-size:12.5px" });
  function cost() {
    const down = (+budgetIn.value || 0) * 0.18 + (+mktIn.value || 0) + (scriptSel.value ? 0 : std * (kind === "reboot" ? 0.085 : 0.045))
      + (movie && !movie.franchise_id ? (movie.series_fee || Math.max(std * 0.05, (movie.gross || 0) * 0.05)) : 0);
    note.textContent = `Due today: about ${money(down)}. Then hire a director and cast it in the production office.`;
    note.className = down > S.state.game.cash ? "neg" : "";
  }
  function redraw() {
    const sc = scales.find((x) => x.id === scaleSel.value) || { mult: 1 };
    budgetIn.value = Math.round(std * sc.mult / 1000) * 1000;
    mktIn.value = Math.round(+budgetIn.value * 0.25 / 1000) * 1000;
    cost();
  }
  redraw();
  const what = kind === "reboot"
    ? (f && f.reboot_soon ? "A fresh start with new leads. It has been under five years since the last one, so audiences may call it a cash grab."
                          : "A fresh start: new continuity, new leads, and the old name.")
    : f ? `Installment #${n0(f.next_index)}. Fan base ${n0(f.fan_base)}${f.fatigue > 0 ? `, fatigue ${n0(f.fatigue * 100)}%` : ""}. Bring back the leads: ${(f.cast || []).filter((c) => c.lead).map((c) => c.name).join(", ") || "—"}.`
        : `“${movie.title}” becomes a series with a fan base of about ${n0(movie.series_fan || 0)}, and its sequel goes into development.`;
  showModal(el("div.panel", {},
    el("div.panel-h", {}, el("h2", {}, kind === "reboot" ? `Reboot ${f ? f.name : ""}` : f ? `${f.name}: next installment` : `Sequel to ${movie.title}`),
      el("div.right", {}, el("button.btn.sm", { onclick: hideModal }, "cancel"))),
    el("div.panel-b", {},
      el("div", { style: "margin-bottom:10px" }, what),
      el("div", { style: "display:flex;flex-direction:column;gap:8px" },
        !f ? el("label.f", {}, "Series name", nameIn) : null,
        el("label.f", {}, "Title", titleIn),
        el("label.f", {}, "Script", scriptSel),
        el("label.f", {}, "Scale", scaleSel),
        el("label.f", {}, "Production budget", budgetIn),
        el("label.f", {}, "Prints & ads", mktIn),
        note),
      el("div.modal-actions", {}, el("button.btn.gold", {
        onclick: async () => {
          const body = { kind, scale: scaleSel.value, budget: +budgetIn.value, marketing: +mktIn.value,
                         title: titleIn.value.trim() || null, script_id: scriptSel.value ? +scriptSel.value : null };
          const r = f ? await api("/api/franchise", Object.assign({ action: "launch", id: f.id }, body), "POST")
                      : await api("/api/franchise", Object.assign({ action: "sequel_from_movie", movie_id: movie.id, name: nameIn.value.trim() || null }, body), "POST");
          if (r.ok) {
            toast(r.series_created ? "New series — and the sequel is in development." : kind === "reboot" ? "The reboot is in development." : "Sequel in development.");
            S.tab = "production"; renderTabs(); await refreshState(); await renderView(); productionModal(r.id);
          }
        } }, kind === "reboot" ? "Greenlight the reboot" : "Greenlight the sequel")))));
}

function bidTable(rows, after) {
  return el("table", {}, el("tbody", {}, rows.map((o) => el("tr", {},
    el("td", {}, el("b", {}, o.buyer || o.from),
      o.financing ? el("div.mut", { style: "font-size:10.5px" }, o.financing) : null),
    el("td", { class: "right-cell num" }, el("b", {}, money(o.price || o.amount))),
    el("td", {}, el("span.pill" + (o.verdict === "generous" ? ".good" : o.verdict === "very underpaid" ? ".bad" : ""), {}, o.verdict || "")),
    el("td", { class: "mut", style: "font-size:11px" }, `worth ~${money(o.opportunity)} to you · until ${o.expires_year}`),
    el("td", { class: "nowrap" },
      el("button.btn.sm.gold", { onclick: async () => {
        if (!confirm(`Sell to ${o.buyer || o.from} for ${money(o.price || o.amount)}? They can make sequels; you cannot.`)) return;
        await sellOffer(o.id, true); hideModal();
      } }, "Accept"), " ",
      el("button.btn.sm", { onclick: async () => { await sellOffer(o.id, false); if (after) after(); } }, "Refuse"))))));
}

async function solicitModal(kind, id, label) {
  const r = await api("/api/franchise", { action: "solicit", kind, id }, "POST");
  if (!r.ok) return;
  await refreshState();
  const bids = r.bids || [];
  showModal(el("div.panel", {},
    el("div.panel-h", {}, el("h2", {}, `Selling ${label}`),
      el("div.right", {}, el("button.btn.sm", { onclick: hideModal }, "close"))),
    el("div.panel-b", {},
      el("div.mut", { style: "font-size:12px;margin-bottom:8px" }, r.note ||
        (kind === "franchise"
          ? "Your agents shopped the series around town. Selling hands over every installment, the name and all future sequels. Whoever buys it will keep making them."
          : "Your agents shopped the picture around town. Selling hands over its library income for good.")),
      bids.length ? bidTable(bids, () => solicitModal(kind, id, label))
        : el("div.empty", {}, "Nobody bit. Try again next year — or make it worth more first."),
      el("div.mut", { style: "font-size:11px;margin-top:8px" }, "Bids stay open on the Franchises tab rights desk until they expire. You can shop an asset once a year."))));
}

// ------------------------------------------------------------------ WORLD
Views.world = async function (v) {
  v.innerHTML = "";
  const d = await api("/api/world");
  // the state of the art: what a picture costs and looks like this year
  const art = await api("/api/formats", { budget: (d.era || {}).standard_cost || 0, genre: "action", scale: "epic" });
  if (art.ok) v.appendChild(el("div.panel", {}, el("div.panel-h", {}, el("h2", {}, `The state of the art, ${art.year}`),
      el("span.sub", {}, `for a typical ${money((d.era || {}).standard_cost)} picture`)),
    el("div.panel-b", {}, el("div.grid2", {},
      el("div", {},
        el("div.era-h", {}, "FORMATS"),
        art.formats.length ? art.formats.map((f) => el("div.fmt", { title: f.blurb },
          el("b", {}, f.label), el("span.mut", {}, f.standard ? " — standard in every picture"
            : ` — optional, ${f.cost < 0 ? "saves " + money(-f.cost) : money(f.cost)}${f.miss ? " · audiences now expect it" : ""}`)))
          : el("div.mut", {}, "Black-and-white, mono sound, a square frame. The pictures are the pictures.")),
      el("div", {},
        el("div.era-h", {}, "THE COST OF DOING BUSINESS"),
        art.era_costs.length ? art.era_costs.map((c) => el("div.fmt", {}, el("b", {}, c.label), el("span.mut", {}, ` — ${money(c.amount)}: ${c.why}`)))
          : el("div.mut", {}, "No guild contributions, no censor's fee. Yet."),
        art.residual_rate ? el("div.fmt", {}, el("b", {}, "Residuals"), el("span.mut", {}, ` — ${n1(art.residual_rate * 100)}% of library income goes back to the talent`)) : null,
        art.bond.available ? el("div.fmt", {}, el("b", {}, "Completion bonds"), el("span.mut", {}, ` — available, about ${money(art.bond.cost)} a picture`)) : null)))));
  const ev = (d.events || []);
  const ep = el("div.panel", {}, el("div.panel-h", {}, el("h2", {}, "World events in play")));
  const eb = el("div.panel-b");
  if (!ev.length) eb.appendChild(el("div.empty", {}, "Nothing catastrophic this week. Enjoy it."));
  else ev.forEach((e) => eb.appendChild(el("div.need-item", { style: "border-left:2px solid #d9a441" },
    el("div.t", {}, e.name, el("span.pill.dim", {}, ` ${e.severity} · ${e.weeks_left} wk left`)),
    el("div.d", {}, e.headline),
    el("div.d", {}, Object.entries(e.effects || {}).map(([k, val]) => `${k}=${typeof val === "number" ? (+val).toFixed(2) : val}`).join("  ")),
    e.choice ? el("div.row", { style: "margin-top:6px" },
      el("div.mut", { style: "font-size:11px;margin-bottom:4px" }, e.choice.question || "Decision:"),
      (e.choice.options || []).map((o) => el("button.btn.sm", { onclick: () => eventChoice(e.id, o.id) }, o.label))) : null)));
  ep.appendChild(eb); v.appendChild(ep);

  const grid = el("div.grid2");
  const tp = el("div.panel", {}, el("div.panel-h", {}, el("h2", {}, "Genre appetites")),
    el("div.panel-b", {}, el("table", {}, el("tbody", {}, (d.trends || []).map((t) => el("tr", {},
      el("td", {}, t.label),
      el("td", { style: "width:45%" }, el("div.bar.heat", {}, el("i", { style: `width:${Math.min(100, t.heat * 50)}%` }))),
      el("td", { class: "right-cell" }, n1(t.heat))))))));
  grid.appendChild(tp);

  const era = d.era || {};
  const ip = el("div.panel", {}, el("div.panel-h", {}, el("h2", {}, "The industry")),
    el("div.panel-b", {},
      el("dl.kv", {},
        el("dt", {}, "Era"), el("dd", {}, era.label),
        el("dt", {}, "Typical picture costs"), el("dd", {}, money(era.standard_cost)),
        el("dt", {}, "Ticket price"), el("dd", {}, "$" + n1(era.ticket)),
        el("dt", {}, "Attendance vs 1948"), el("dd", {}, n0((era.attendance || 0) * 100) + "%"),
        el("dt", {}, "Difficulty"), el("dd", {}, n1(era.difficulty))),
      el("div", { style: "margin-top:10px" },
        el("div.mut", { style: "font-size:11px;letter-spacing:.14em" }, "TECHNOLOGY"),
        el("div.chips", {}, (d.tech || []).map((t) => el("span.chip" + (t.enabled ? " on" : ""), {
          title: t.note }, `${t.label} · ${t.on_year}${t.enabled ? " ✓" : ""}`))))));
  grid.appendChild(ip);
  v.appendChild(grid);

  const rp = el("div.panel", {}, el("div.panel-h", {}, el("h2", {}, "The other studios")));
  rp.appendChild(el("div.panel-b", {}, el("table", {},
    el("thead", {}, el("tr", {}, ["Studio", "Cash", "Prestige", "Pictures", "Aggression", "Status"].map((h) => el("th", {}, h)))),
    el("tbody", {}, (d.rivals || []).map((r) => el("tr", {},
      el("td", {}, r.name),
      el("td", { class: "right-cell num" }, money(r.cash)),
      el("td", { class: "right-cell" }, n0(r.prestige)),
      el("td", { class: "right-cell" }, n0(r.films || r.releases), r.titles ? el("span.mut", {}, ` · ${n0(r.titles)} titles held`) : null),
      el("td", { class: "right-cell" }, n1(r.aggression)),
      el("td", {}, el("span.pill" + (r.status === "bankrupt" ? ".bad" : ""), {}, r.status || "active"))))))));
  v.appendChild(rp);

  await listView(v, {
    key: "log", title: "Trade paper", path: "/api/log", pageSize: 40,
    defaults: { kind: "" },
    filters: [{ type: "select", k: "kind", label: "kind", options: [["", "everything"], ["event", "events"], ["industry", "industry"], ["release", "releases"], ["talent", "talent"], ["finance", "money"], ["award", "awards"], ["offer", "rights deals"], ["world", "world"], ["local", "on set"]] }],
    columns: [
      { k: "year", label: "When", cls: "right-cell", fmt: (r) => `${r.year}${r.week ? "·w" + (r.week + 1) : ""}` },
      { k: "kind", label: "Section" },
      { k: "title", label: "Headline", fmt: (r) => el("b", { class: r.weight >= 3 ? "out-PHENOMENON" : "" }, r.title) },
      { k: "text", label: "", fmt: (r) => el("span.mut", { style: "font-size:12px" }, r.text || "") },
    ],
  });
};

// ---------------------------------------------------------------- FINANCE
Views.finance = async function (v) {
  v.innerHTML = "";
  const f = await api("/api/finance");
  if (!f.ok) return;
  const grid = el("div.grid3");
  const card = (label, value, note) => el("div.panel", {}, el("div.panel-h", {}, el("h2", {}, label)),
    el("div.panel-b", {}, el("div", { style: "font-size:20px" }, value),
      note ? el("div.mut", { style: "font-size:11px" }, note) : null));
  grid.appendChild(card("Cash", money(f.cash), `payroll ${money(f.payroll_weekly)}/wk · lot upkeep ${money(f.upkeep_weekly)}/wk`));
  grid.appendChild(card("Debt", money(f.debt), `rate ${n1((f.loan_rate || 0) * 100)}% · can borrow ${money(f.capacity)}`));
  grid.appendChild(card(f.year + " so far", el("span", { class: signClass(f.year_profit) }, money(f.year_profit)), `stages ${n0(f.in_work)}/${n0(f.slots)} in use · library ${money(f.library.total)} · lot ${money(f.lot)}`));
  v.appendChild(grid);

  const loanAmt = el("input", { type: "number", step: 50000, value: 250000, style: "width:140px" });
  const lp = el("div.panel", {}, el("div.panel-h", {}, el("h2", {}, "Bank"),
    el("div.right", {}, el("button.btn.sm.gold", {
      onclick: async () => { const r = await api("/api/finance", { action: "loan", amount: +loanAmt.value }, "POST"); if (r.ok) { toast("Loan booked."); await refreshState(); renderView(); } }
    }, "Take loan"), loanAmt)));
  const lb = el("div.panel-b");
  if (!(f.loans || []).length) lb.appendChild(el("div.empty", {}, "No debt. The bank notices that."));
  else lb.appendChild(el("table", {},
    el("thead", {}, el("tr", {}, ["Lender", "Taken", "Balance", "Rate", "Due", ""].map((h) => el("th", {}, h)))),
    el("tbody", {}, (f.loans || []).map((l) => el("tr", {},
      el("td", {}, l.lender || "Bank"), el("td", { class: "num" }, money(l.principal || l.amount)),
      el("td", { class: "num" }, money(l.balance)),
      el("td", {}, n1((l.rate || 0) * 100) + "%"),
      el("td", {}, String(l.due_year || "—")),
      el("td", {}, el("button.btn.sm", { onclick: async () => {
        const r = await api("/api/finance", { action: "repay", id: l.id }, "POST");
        if (r.ok) { toast(`Repaid ${money(r.paid)}.`); await refreshState(); renderView(); }
      } }, "Repay")))))));
  lp.appendChild(lb); v.appendChild(lp);

  const bp = el("div.panel", {}, el("div.panel-h", {}, el("h2", {}, "The lot"),
    el("span.sub", {}, `${(f.buildings || []).length} built`)));
  bp.appendChild(el("div.panel-b", {}, el("table", {},
    el("thead", {}, el("tr", {}, ["Building", "Have", "Effect", "Next cost", ""].map((h) => el("th", {}, h)))),
    el("tbody", {}, (f.build_options || []).map((b) => el("tr", {},
      el("td", {}, b.label, el("div.mut", { style: "font-size:11px" }, b.note)),
      el("td", { class: "right-cell" }, `${b.count}/${b.max}`),
      el("td", { class: "mut", style: "font-size:11px" }, b.tech && !b.tech_ok ? el("span.neg", {}, `needs ${b.tech}`) : ""),
      el("td", { class: "right-cell num" }, b.count >= b.max ? "max" : money(b.cost)),
      el("td", {}, el("button.btn.sm", { disabled: (b.count >= b.max || !b.tech_ok) ? "disabled" : null,
        onclick: async () => { const r = await api("/api/finance", { action: "build", kind: b.kind }, "POST"); if (r.ok) { toast("Built: " + b.label); await refreshState(); renderView(); } } },
        "Build"))))))));
  v.appendChild(bp);

  const led = el("div.panel", {}, el("div.panel-h", {}, el("h2", {}, f.year + " ledger")));
  led.appendChild(el("div.panel-b", {}, el("table", {},
    el("thead", {}, el("tr", {}, ["Line", "Amount"].map((h) => el("th", {}, h)))),
    el("tbody", {}, (f.by_kind || []).map((k) => el("tr", {},
      el("td", {}, k.kind),
      el("td", { class: "right-cell num " + signClass(k.amount) }, money(k.amount))))))));
  v.appendChild(led);

  const campAmt = el("input", { type: "number", step: 10000, value: 100000, style: "width:140px" });
  v.appendChild(el("div.panel", {}, el("div.panel-h", {}, el("h2", {}, "Awards campaign"), el("span.sub", {}, "spent this year counts at next January's ceremony"),
    el("div.right", {}, el("button.btn.sm", {
      onclick: async () => { const r = await api("/api/finance", { action: "campaign", amount: +campAmt.value }, "POST"); if (r.ok) { toast(`For Your Consideration: ${money(r.total)} in the campaign this year.`); await refreshState(); } }
    }, "Spend"), campAmt))));
};

// ----------------------------------------------------------------- AWARDS
Views.awards = async function (v) {
  v.innerHTML = "";
  const d = await api("/api/awards");
  const p = el("div.panel", {}, el("div.panel-h", {}, el("h2", {}, "The awards"),
    el("span.sub", {}, `ceremony for ${((d.ceremony_year || 0) - 1)} held now`)));
  const b = el("div.panel-b");
  if (!(d.rows || []).length) b.appendChild(el("div.empty", {}, "The academy has not met yet."));
  else b.appendChild(el("table", {},
    el("thead", {}, el("tr", {}, ["Year", "Award", "Picture", "Studio", "Result"].map((h) => el("th", {}, h)))),
    el("tbody", {}, d.rows.map((a) => el("tr", {},
      el("td", {}, String(a.year)),
      el("td", {}, a.award || a.category, a.actor_name ? el("div.mut", { style: "font-size:11px" }, a.actor_name) : null),
      el("td", {}, a.title || "—"),
      el("td", {}, a.studio === S.state.game.name ? el("b.gold-t", {}, a.studio) : (a.studio || "—")),
      el("td", {}, el("span.pill" + (a.won ? (a.studio === S.state.game.name ? ".gold" : "") : ".dim"), {}, a.kind === "razzie" ? "RAZZIE" : a.won ? "WON" : "nominated")))))));
  p.appendChild(b);

  // the four juries, and a replay of any past ceremony
  const yrs = d.ceremonies || [];
  const pick = el("select", {}, yrs.map((y) => el("option", { value: y }, String(y))));
  v.appendChild(el("div.panel", {}, el("div.panel-h", {}, el("h2", {}, "Awards night"),
    el("span.sub", {}, "every January, four juries with four different tastes"),
    yrs.length ? el("div.right", {}, pick, el("button.btn.sm.gold", {
      onclick: async () => { const r = await api("/api/ceremony", { year: pick.value }); if (r.ok) showCeremony(r.ceremony, true); }
    }, "Replay ceremony")) : null),
    el("div.panel-b", {}, el("div.cer-bodies", {}, (d.bodies || []).map((x) => el("div.b", {},
      el("h4", {}, x.name), el("div", {}, x.blurb)))))));
  v.appendChild(p);

  const dec = d.decorated || [];
  v.appendChild(el("div.panel", {}, el("div.panel-h", {}, el("h2", {}, "Most decorated performers"),
      el("span.sub", {}, "every studio · acting statuettes and nominations")),
    el("div.panel-b", {}, !dec.length ? el("div.empty", {}, "No acting awards handed out yet.")
      : el("table", {}, el("thead", {}, el("tr", {}, ["Performer", "Known as", "Wins", "Noms", "Won for"].map((h) => el("th", {}, h)))),
        el("tbody", {}, dec.map((a) => el("tr.click", { onclick: () => actorModal(a.id) },
          el("td", {}, a.name, a.status === "dead" ? el("span.mut", {}, " †") : a.status === "retired" ? el("span.mut", {}, " (retired)") : null),
          el("td", {}, typecastPills(a.typecast, { quiet: true }) || el("span.mut", {}, "—")),
          el("td", { class: "right-cell" }, a.wins ? el("b.gold-t", {}, `★ ${n0(a.wins)}`) : "0"),
          el("td", { class: "right-cell" }, n0(a.noms)),
          el("td", { class: "mut", style: "font-size:11px" }, a.won_for || "—"))))))));

  const hall = d.hall || [];
  v.appendChild(el("div.panel", {}, el("div.panel-h", {}, el("h2", {}, "Hall of Fame"),
    el("span.sub", {}, "Silver Screen Academy · inducted each January, at most three a year")),
    el("div.panel-b", {}, hall.length ? el("table", {},
      el("thead", {}, el("tr", {}, ["Class", "Performer", "Career", "Fate"].map((h) => el("th", {}, h)))),
      el("tbody", {}, hall.map((h) => el("tr", { style: "cursor:pointer", onclick: () => actorModal(h.id) },
        el("td", {}, String(h.hof_year)),
        el("td", {}, h.ours >= 3 ? el("b.gold-t", {}, `★ ${h.name}`) : h.name,
          h.ours ? el("div.mut", { style: "font-size:11px" }, `${h.ours} picture${h.ours === 1 ? "" : "s"} for you`) : null),
        el("td", {}, h.hof_note || `${n0(h.films)} pictures`),
        el("td", {}, h.died_year ? el("span" + (h.died_age < 45 ? ".gold-t" : ".mut"), {},
          `died ${h.died_year}, aged ${h.died_age}`) : el("span.mut", {}, h.status === "retired" ? "retired" : `age ${h.age}`))))))
      : el("div.empty", {}, "Nobody yet. The bar is high: a long great career, or a short unforgettable one."))));

  const ms = d.milestones || [];
  const got = ms.filter((m) => m.year).length;
  v.appendChild(el("div.panel", {}, el("div.panel-h", {}, el("h2", {}, "Milestones"), el("span.sub", {}, `${got} of ${ms.length}`)),
    el("div.panel-b", {}, el("div.grid3", {}, ms.map((m) => el("div.milestone" + (m.year ? ".got" : ""), {},
      el("div.t", {}, m.year ? `★ ${m.title}` : m.title),
      el("div.d", {}, m.how),
      m.year ? el("div.y", {}, String(m.year)) : null))))));
};
