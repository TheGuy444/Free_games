// Hollywood Tycoon - views C: the press. Release reviews pop-up, the
// newspaper (The Daily Marquee), typecast labels.
"use strict";

// ------------------------------------------------------------ small helpers
const GRADE_CLASS = { Standout: "good", Strong: "info", Fine: "", Weak: "bad", Miscast: "bad" };

function typecastPills(tc, opts = {}) {
  if (!tc) return null;
  const names = tc.names || [];
  if (!names.length) return opts.quiet ? null : el("span.pill.dim", {}, "unassigned");
  return el("span.tc", {},
    names.map((n) => el("span.pill.tc-pill", {}, n)),
    opts.range && names.length >= 2 ? el("span.pill.gold", {}, tc.range_word) : null);
}

function dateline(r) {
  return `${r.year} · wk ${(r.week || 0) + 1}`;
}

function arrow(move) {
  return { up: el("span.mv.up", {}, "▲"), down: el("span.mv.down", {}, "▼"), same: el("span.mv", {}, "="),
           new: el("span.mv.new", {}, "NEW"), re: el("span.mv.new", {}, "RE") }[move] || el("span.mv", {}, "");
}

// ------------------------------------------------------------ release review
// Pops after every one of our releases (manual or automatic). Shows the
// critics' and the audience's verdict, four outlets' scores out of ten, the
// write-up that names who was good and who was not, and their fame bumps.
async function maybeShowReviews() {
  const st = S.state;
  if (!st || S.modalOpen || S.reviewing) return;
  const ids = st.reviews_unseen || [];
  if (!ids.length) return;
  await reviewModal(ids[0]);
}

async function reviewModal(id, opts = {}) {
  S.reviewing = true;
  try {
    const r = await api("/api/review", { id });
    if (!r.ok) return;
    if (!opts.archive) {
      const s = await api("/api/review/seen", { id }, "POST");
      if (s.ok && S.state) {
        S.state.reviews_unseen = (S.state.reviews_unseen || []).filter((x) => x !== id);
        S.state.reviews_unseen_count = s.unseen;
      }
    }
    const left = opts.archive ? 0 : Math.max(0, (r.unseen || 1) - 1);
    const meter = (label, value, good, kind) => el("div.meter", {},
      el("div", { class: `icon ${kind}-${good ? "good" : "bad"}` }),
      el("div", {},
        el("div.meter-v", {}, `${n0(value)}%`),
        el("div.meter-k", {}, label),
        el("div.meter-w", {}, kind === "crit" ? (good ? "Fresh" : "Rotten") : (good ? "Full bucket" : "Spilled"))));
    const perfs = r.performances || [];
    const run = r.run;
    const body = el("div.panel.review", {},
      el("div.panel-h", {}, el("h2", {}, "The critics have spoken"),
        left ? el("span.sub", {}, `${left} more review${left === 1 ? "" : "s"} waiting`) : null,
        el("div.right", {}, el("button.btn.sm", { onclick: hideModal }, "close"))),
      el("div.panel-b", {},
        el("div.rv-title", {},
          el("div", {}, el("div.rv-name", {}, r.title),
            el("div.mut", { style: "font-size:12px" },
              `${r.genre} · ${r.scale} · opened ${r.year}, week ${(r.week || 0) + 1}`)),
          el("div.rv-outcome", { class: "out-" + r.outcome }, r.outcome,
            r.cult_classic ? el("div.pill.cult", {}, "cult classic") : null)),
        el("div.rv-headline", {},
          el("div.rv-kicker", {}, "THE DAILY MARQUEE"),
          el("div.rv-head", {}, r.headline),
          r.subhead ? el("div.rv-sub", {}, r.subhead) : null),
        el("div.rv-scores", {},
          meter("Critics", r.critics, r.fresh, "crit"),
          meter("Audience", r.audience, r.popcorn, "aud"),
          el("div.verdict", {},
            el("div.verdict-n", {}, `${n1(r.score10)}`, el("span", {}, "/10")),
            el("div.verdict-w", {}, r.verdict),
            r.gilded ? el("div.pill.gold", {}, "★ GILDED REEL") : null)),
        el("div.outlets", {}, (r.outlets || []).map((o) => el("div.outlet", {},
          el("div.outlet-s", { class: o.score >= 8 ? "pos" : o.score <= 4 ? "neg" : "" }, `${o.score}`, el("span", {}, "/10")),
          el("div.outlet-q", {}, `“${o.quote}”`),
          el("div.outlet-n", {}, o.outlet)))),
        el("blockquote.consensus", {},
          el("b", {}, r.verdict + (r.verdict.endsWith("!") ? " " : ". ")),
          r.consensus, " ", el("i", {}, r.audience_line)),
        perfs.length ? el("div", {},
          el("div.mut.cap", {}, "PERFORMANCES"),
          el("table", {}, el("tbody", {}, perfs.map((p) => el("tr.click", { onclick: () => actorModal(p.actor_id) },
            el("td", {}, el("span.click-name", {}, p.name), p.note ? el("div.mut", { style: "font-size:11px" }, p.note) : null),
            el("td", {}, p.role, el("span.mut", {}, ` · ${p.kind}`)),
            el("td", {}, el("span.pill" + (GRADE_CLASS[p.grade] ? "." + GRADE_CLASS[p.grade] : ""), {}, p.grade)),
            el("td", { class: "right-cell num" }, p.fame_delta
              ? el("span", { class: p.fame_delta > 0 ? "pos" : "neg" }, `${p.fame_delta > 0 ? "▲ +" : "▼ "}${n1(p.fame_delta)} fame`)
              : el("span.mut", {}, "—"))))))) : null,
        el("dl.kv", { style: "margin-top:10px" },
          el("dt", {}, "Box office"), el("dd", {}, `${money(r.gross)} gross · studio net `,
            el("span", { class: signClass(r.net) }, money(r.net))),
          r.opening ? el("dt", {}, "Opening week") : null,
          r.opening ? el("dd", {}, `${money(r.opening)}`, r.open_rank ? ` — projected #${r.open_rank} on this week's chart` : "") : null,
          run ? el("dt", {}, "On the chart") : null,
          run ? el("dd", {}, run.active
            ? `${run.wk ? `#${run.rank} in week ${run.wk}` : "opens this week"}${run.w1 ? ` · ${run.w1} week${run.w1 === 1 ? "" : "s"} at #1` : ""}`
            : `played ${run.wk} weeks, peaked at #${run.best_rank || "—"}${run.w1 ? `, ${run.w1} at #1` : ""}`) : null),
        el("div.modal-actions", {},
          left ? el("button.btn.gold", { onclick: async () => { S.reviewing = false; hideModal(); await refreshState(); maybeShowReviews(); } }, `Next review (${left})`) : null,
          el("button.btn", { onclick: () => { hideModal(); S.tab = "paper"; renderTabs(); renderView(); } }, "Read the paper"),
          el("button.btn", { onclick: () => { hideModal(); releaseModal(r.movie_id); } }, "Picture details"),
          left > 1 ? el("button.btn.sm", { onclick: async () => {
            await api("/api/review/seen", { all: 1 }, "POST"); hideModal(); await refreshState(); } }, "Mark all read") : null)));
    showModal(body);
  } finally { S.reviewing = false; }
}

// ---------------------------------------------------------------- NEWSPAPER
Views.paper = async function (v) {
  v.innerHTML = "";
  S.paper = S.paper || { abs: null, chart: 10 };
  const P = S.paper;
  const d = await api("/api/paper", { abs: P.abs === null ? "" : P.abs, chart: P.chart });
  if (!d.ok) return;
  const rec = await api("/api/records", { limit: 3 });
  const live = d.abs === d.now;
  const go = (abs) => { P.abs = abs >= d.now ? null : Math.max(0, abs); renderView(); };

  const story = (r, big) => el("div" + (big ? ".story.lead" : ".story"), {
      class: (r.mine ? "mine " : "") + (r.actor_id || r.movie_id ? "click" : ""),
      onclick: () => {
        if (r.section === "review" && r.mine && r.movie_id) return reviewModal(r.movie_id, { archive: true });
        if (r.mine && r.movie_id) return releaseModal(r.movie_id);
        if (r.actor_id) return actorModal(r.actor_id);
      } },
    el("div.st-kick", {}, `${SECTION_LABEL[r.section] || r.section} · ${dateline(r)}${r.mine ? " · OUR LOT" : ""}`),
    el("div.st-head", {}, r.headline),
    r.body ? el("div.st-body", {}, r.body) : null);

  const page = el("div.paper");
  page.appendChild(el("div.mast", {},
    el("div.mast-side", {}, `No. ${n0(d.issue)}`, el("br"), `${d.price < 1 ? Math.round(d.price * 100) + "¢" : "$" + d.price.toFixed(2)}`),
    el("div.mast-c", {}, el("div.mast-t", {}, "The Daily Marquee"),
      el("div.mast-s", {}, `Hollywood's paper of record · ${d.era}`)),
    el("div.mast-side.r", {}, d.date, el("br"), live ? "this week" : "back issue")));
  page.appendChild(el("div.paper-nav", {},
    el("button.btn.sm", { onclick: () => go(d.abs - 1), disabled: d.abs <= 0 ? "disabled" : null }, "‹ previous issue"),
    el("button.btn.sm", { onclick: () => go(d.abs - 52), disabled: d.abs < 52 ? "disabled" : null }, "« a year back"),
    live ? el("span.mut", {}, "today's edition") : el("button.btn.sm.gold", { onclick: () => go(d.now) }, "today's edition"),
    el("button.btn.sm", { onclick: () => go(d.abs + 52), disabled: live ? "disabled" : null }, "a year on »"),
    el("button.btn.sm", { onclick: () => go(d.abs + 1), disabled: live ? "disabled" : null }, "next issue ›")));

  // front page
  const front = d.front || [];
  if (!front.length) page.appendChild(el("div.empty", {}, "A slow news week. Nobody in town did anything worth printing."));
  else page.appendChild(el("div.front", {}, story(front[0], true),
    el("div.front-side", {}, front.slice(1, 5).map((r) => story(r)))));

  // box office + reviews
  const sizes = [10, 50, 100];
  const chartBox = el("div.psec", {},
    el("div.psec-h", {}, live ? "Box office" : "Box office (top 10 that week)",
      live ? el("span.right", {}, sizes.map((n) => el("button.btn.sm" + (P.chart === n ? ".on" : ""), {
        onclick: () => { P.chart = n; renderView(); } }, `Top ${n}`))) : null),
    (d.chart || []).length ? el("div.scroll" + (P.chart > 10 && live ? "" : ".noscroll"), {}, el("table.chart", {},
      el("thead", {}, el("tr", {}, ["TW", "LW", "Picture", "Wk", "#1", "This week", "Total"].map((h) => el("th", {}, h)))),
      el("tbody", {}, d.chart.map((r) => el("tr", { class: (r.mine ? "mine " : "") + (r.mine && r.movie_id ? "click" : ""),
          onclick: () => { if (r.mine && r.movie_id) releaseModal(r.movie_id); } },
        el("td", { class: "right-cell rk" }, String(r.rank)),
        el("td", { class: "right-cell" }, arrow(r.move), r.prev_rank && r.move !== "new" ? el("span.mut", { style: "font-size:10px" }, ` ${r.prev_rank}`) : null),
        el("td", {}, el("b", {}, r.title),
          el("div.mut", { style: "font-size:11px" }, `${r.studio} · ${r.genre_label}${r.lead_name ? " · " + r.lead_name : ""}`)),
        el("td", { class: "right-cell" }, n0(r.wk)),
        el("td", { class: "right-cell" }, r.w1 ? el("b.gold-t", {}, n0(r.w1)) : el("span.mut", {}, "—")),
        el("td", { class: "right-cell num" }, money(r.week_gross)),
        el("td", { class: "right-cell num" }, money(r.cume)))))))
      : el("div.empty", {}, "No pictures in release."),
    el("div.mut", { style: "font-size:11px;margin-top:6px" },
      live ? `${n0(d.in_release)} pictures in release · ${money(d.total_week)} at the box office this week`
           : `top ten took ${money(d.total_week)} that week`));
  const right = el("div", {},
    sectionBox("Reviews", (d.sections.review || []).slice(0, 4), story, "No reviews of ours yet."),
    sectionBox("Now playing", (d.sections.release || []).slice(0, 5), story, "Nothing opened."));
  page.appendChild(el("div.pgrid", {}, chartBox, right));

  page.appendChild(el("div.pgrid3", {},
    sectionBox("The stars", (d.sections.stars || []).slice(0, 7), story, "Quiet on the gossip front."),
    sectionBox("World & industry", (d.sections.world || []).slice(0, 7), story, "The world carries on without us."),
    el("div", {},
      sectionBox("Awards", (d.sections.awards || []).slice(0, 5), story, "The academy has not met yet."),
      sectionBox("Box office wire", (d.sections.boxoffice || []).slice(0, 4), story, "—"))));

  // record book
  const recs = rec.records || [];
  page.appendChild(el("div.psec", {},
    el("div.psec-h", {}, "The record book", el("span.mut", { style: "font-size:11px;margin-left:8px" }, "all-time, every studio")),
    el("table.records", {},
      el("thead", {}, el("tr", {}, ["Record", "Holder", "", "Our best"].map((h) => el("th", {}, h)))),
      el("tbody", {}, recs.map((x) => {
        const top = (x.rows || [])[0];
        const fmt = (v) => x.fmt === "money" ? money(v) : `${n0(v)} wk`;
        return el("tr", {},
          el("td", {}, x.label),
          el("td", { class: top && top.mine ? "gold-t" : "" }, top ? `${top.title} (${top.studio}, ${top.year})` : "—",
            (x.rows || []).length > 1 ? el("div.mut", { style: "font-size:11px" },
              x.rows.slice(1).map((y) => `${y.title} ${fmt(y.v)}`).join(" · ")) : null),
          el("td", { class: "right-cell num" }, top ? el("b", {}, fmt(top.v)) : "—"),
          el("td", { class: "right-cell num" }, x.ours ? `${fmt(x.ours.v)} · ${x.ours.title}` : el("span.mut", {}, "—")));
      }))),
    (d.sections.records || []).length ? el("div", { style: "margin-top:8px" },
      d.sections.records.slice(0, 4).map((r) => story(r))) : null));
  v.appendChild(page);
};

const SECTION_LABEL = { front: "Front page", release: "Now playing", review: "Review", boxoffice: "Box office",
  stars: "The stars", world: "World", awards: "Awards", records: "Records", business: "Business" };

function sectionBox(title, rows, story, empty) {
  return el("div.psec", {}, el("div.psec-h", {}, title),
    (rows || []).length ? (rows || []).map((r) => story(r)) : el("div.mut", { style: "font-style:italic;font-size:12px" }, empty));
}
