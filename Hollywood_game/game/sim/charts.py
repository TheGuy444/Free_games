"""The weekly box office chart and its record book.

Every picture that opens in town gets a *run*: its total gross spread over
the weeks it plays, front-loaded or leggy depending on word of mouth. Each
week the runs are ranked (top 100), and the counters that feed the record
book tick over: weeks at #1, longest #1 streak, weeks in the top 10/50/100.

Our own pictures still book their money on release (the economy is
unchanged); the run is how the town *sees* them play out. Rival studios'
pictures and a steady stream of independents fill out the rest of the chart.

All the weekly work is a handful of set-based statements over the ~100 runs
in release at any one time.
"""
from __future__ import annotations

import math

from .. import config as C
from .. import names as N
from ..rng import clamp, gauss, stream
from . import press

CHART_SIZE = 100
INDIE_DISTRIBUTORS = ["Poverty Row Releasing", "Gower Gulch Pictures", "Lone Star Features",
                      "Bijou Distributing", "Starlight Independents", "Eastside Film Exchange",
                      "Harbor Light Pictures", "Red Rock Releasing", "Mesa Films",
                      "Northlight Pictures", "Bluebird Releasing", "Orchard Street Films"]

RECORDS = [
    # key, label, column, format
    ("w1", "Most weeks at #1", "w1", "weeks"),
    ("streak1", "Longest unbroken run at #1", "best_streak1", "weeks"),
    ("w10", "Most weeks in the top 10", "w10", "weeks"),
    ("w50", "Most weeks in the top 50", "w50", "weeks"),
    ("w100", "Most weeks in the top 100", "w100", "weeks"),
    ("opening", "Biggest opening week", "opening", "money"),
    ("cume", "Biggest total gross", "cume", "money"),
]


# --------------------------------------------------------------------------- #
#  Opening a run
# --------------------------------------------------------------------------- #
def schedule(total: float, legs: float, wom: float = 1.0):
    """Decay per week and run length for a picture with these legs. Legs are
    the box-office model's 0.68..1.55; word of mouth 0.5..2.4."""
    norm = clamp((legs - C.LEGS_MIN) / (C.LEGS_MAX - C.LEGS_MIN), 0, 1)
    d = clamp(0.42 + 0.30 * norm + 0.12 * (wom - 1.0), 0.32, 0.88)
    n = 1
    while n < 40 and d ** n > 0.004:      # play until a week earns ~0.4% of the opening
        n += 1
    n = max(10, n)
    opening = total * (1 - d) / max(1e-9, 1 - d ** n)
    return d, n, opening


def open_run(w, kind, title, studio, genre, total, legs, wom=1.0, movie_id=None,
             lead_name=None, critics=None):
    if total <= 0:
        return None
    d, n, opening = schedule(total, legs, wom)
    cur = w.db.execute("""INSERT INTO box_runs(kind,movie_id,title,studio,genre,lead_name,year,week,
                          open_abs,total,decay,weeks_max,opening,critics)
                          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                       (kind, movie_id, title, studio, genre, lead_name, w.year, w.week, w.abs_week,
                        total, d, n, opening, critics))
    return dict(id=cur.lastrowid, opening=opening, decay=d, weeks=n)


def projected_rank(w, opening: float) -> int:
    """Where an opening of this size would sit on this week's chart."""
    ahead = w.db.scalar("SELECT COUNT(*) FROM box_runs WHERE active=1 AND wk>0 AND week_gross > ?",
                        (opening,), 0)
    return int(ahead) + 1


def _indie_gross(w, rnd, q, scale="indie"):
    std = C.standard_cost(w.year)
    sp = clamp(rnd.gauss(16, 10), 0, 70)
    heat = 1.0
    return (C.BASE_K * std * C.SCALES[scale]["reach"] * C.quality_mult(q) * C.star_mult(sp * 1.6)
            * heat / C.difficulty(w.year)) * rnd.uniform(0.25, 1.0)


def indie_releases(w, n=None):
    """Independents, foreign pictures and B-features: the rest of the chart."""
    rnd = stream(w.seed, "indies", w.year, w.week)
    trends = w.trends()
    genres = list(trends.keys()) or C.GENRES
    if n is None:
        n = 7 + int(rnd.random() * 4)
    std = C.standard_cost(w.year)
    base = C.BASE_K * std / C.difficulty(w.year)
    rows = []
    for _ in range(n):
        g = max(genres, key=lambda x: trends.get(x, 1.0) * rnd.uniform(0.3, 1.0))
        q = clamp(rnd.gauss(40, 15), 4, 92)
        scale = "standard" if rnd.random() < 0.10 else "indie"
        sp = clamp(rnd.gauss(16, 10), 0, 70)
        gross = (base * C.SCALES[scale]["reach"] * C.quality_mult(q) * C.star_mult(sp * 1.6)
                 * trends.get(g, 1.0) * rnd.uniform(0.25, 1.0))
        if gross <= 0:
            continue
        legs = C.LEGS_MIN + (C.LEGS_MAX - C.LEGS_MIN) * (q / 100.0) ** 1.3
        d, weeks, opening = schedule(gross, legs)
        rows.append(("indie", N.movie_title(rnd, g), rnd.choice(INDIE_DISTRIBUTORS), g, w.year, w.week,
                     w.abs_week, gross, d, weeks, opening, int(clamp(q + rnd.gauss(4, 9), 1, 99))))
    w.db.executemany("""INSERT INTO box_runs(kind,title,studio,genre,year,week,open_abs,total,decay,
                        weeks_max,opening,critics) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""", rows)


# --------------------------------------------------------------------------- #
#  The week
# --------------------------------------------------------------------------- #
def _rank(w):
    w.db.execute("""UPDATE box_runs SET rank = r.rk FROM
                    (SELECT id, ROW_NUMBER() OVER (ORDER BY week_gross DESC, id) AS rk
                     FROM box_runs WHERE active=1) AS r
                    WHERE box_runs.id = r.id""")


def weekly(w):
    indie_releases(w)
    db = w.db
    # this week's take (wk is still last week's count on the right-hand side)
    db.execute("""UPDATE box_runs SET prev_rank = CASE WHEN wk > 0 THEN rank END,
                    week_gross = opening * POW(decay, wk),
                    cume = cume + opening * POW(decay, wk),
                    wk = wk + 1
                  WHERE active=1""")
    # rank the week and tick the record-book counters in one pass
    db.execute(f"""UPDATE box_runs SET rank = r.rk,
                    w1 = w1 + (r.rk = 1),
                    w10 = w10 + (r.rk <= 10),
                    w50 = w50 + (r.rk <= 50),
                    w100 = w100 + (r.rk <= {CHART_SIZE}),
                    best_streak1 = MAX(best_streak1, CASE WHEN r.rk = 1 THEN streak1 + 1 ELSE 0 END),
                    streak1 = CASE WHEN r.rk = 1 THEN streak1 + 1 ELSE 0 END,
                    best_rank = MIN(COALESCE(best_rank, 9999), r.rk)
                  FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY week_gross DESC, id) AS rk
                        FROM box_runs WHERE active=1) AS r
                  WHERE box_runs.id = r.id""")
    db.execute("""INSERT OR REPLACE INTO chart_hist(abs_week, rank, run_id, gross, cume, weeks)
                  SELECT ?, rank, id, week_gross, cume, wk FROM box_runs WHERE active=1 AND rank <= 10""",
               (w.abs_week,))
    _headlines(w)
    # a picture leaves cinemas when its run is over or it has fallen off the chart
    db.execute(f"""UPDATE box_runs SET active=0 WHERE active=1
                   AND (wk >= weeks_max OR (rank > {CHART_SIZE} AND wk >= 3))""")


def _headlines(w):
    top = w.db.q1("SELECT * FROM box_runs WHERE active=1 AND rank=1")
    if not top:
        return
    std = C.standard_cost(w.year)
    mine = top["kind"] == "player"
    t = f"‘{top['title']}’"
    if top["streak1"] == 1 and not (top["kind"] == "indie" and top["wk"] == 1):
        if top["wk"] == 1:
            head = f"{t} opens at #1"
        else:
            head = (f"Sleeper hit: {t} climbs to #1 in its {_ordinal(top['wk'])} week"
                    if top["kind"] == "indie" else
                    f"{t} climbs to #1 in its {_ordinal(top['wk'])} week")
        press.add(w, "boxoffice", head,
                  f"{top['studio']} takes the top spot with ${top['week_gross']:,.0f} this week "
                  f"(${top['cume']:,.0f} so far).", movie_id=top["movie_id"], run_id=top["id"],
                  weight=3 if mine else 2, mine=mine)
    elif top["streak1"] in (4, 8, 12, 16, 20, 26, 30, 40, 52):
        press.add(w, "boxoffice", f"{t}: {top['streak1']} weeks at #1 and counting",
                  f"Nobody can knock it off. ${top['cume']:,.0f} and still drawing.",
                  movie_id=top["movie_id"], run_id=top["id"], weight=2, mine=mine)
    # milestone grosses, relative to what a picture costs this year
    for mult, label in ((25, "a monster"), (10, "a giant")):
        line = std * mult
        crossed = w.db.q("""SELECT * FROM box_runs WHERE active=1 AND cume >= ? AND cume - week_gross < ?""",
                         (line, line))
        for r in crossed:
            press.add(w, "boxoffice", f"‘{r['title']}’ passes ${line:,.0f}",
                      f"{r['studio']} has {label} on its hands - {r['wk']} weeks in release.",
                      movie_id=r["movie_id"], run_id=r["id"], weight=2, mine=r["kind"] == "player")
            break
    _check_records(w)


def _ordinal(n):
    return f"{n}{'th' if 11 <= n % 100 <= 13 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


def _check_records(w):
    """The record book: news when a picture takes a record off someone else."""
    rec = w.db.kv_get("records_v1", {}) or {}
    tops = w.db.q1("""SELECT MAX(w1) w1, MAX(best_streak1) best_streak1, MAX(w10) w10, MAX(w50) w50,
                      MAX(w100) w100, MAX(opening) opening FROM box_runs WHERE active=1""")
    if not tops:
        return
    changed = False
    told = set()                          # one story per picture per week
    for key, label, col, fmt in RECORDS:
        if col == "cume":
            continue                      # nominal grosses always grow; not news
        if rec.get(key) and (tops[col] or 0) <= rec[key][0]:
            continue                      # nobody near the record this week
        row = w.db.q1(f"SELECT id, title, studio, kind, {col} AS v, movie_id FROM box_runs "
                      f"WHERE active=1 ORDER BY {col} DESC LIMIT 1")
        if not row or not row["v"]:
            continue
        best = rec.get(key)
        if best is None:
            rec[key] = [row["v"], row["id"]]
            changed = True
            continue
        if row["v"] <= best[0]:
            continue
        mine = row["kind"] == "player"
        if best[1] != row["id"]:
            if key == "opening":
                if row["v"] > best[0] * 1.05:
                    press.add(w, "records", f"Record opening: \u2018{row['title']}\u2019",
                              f"${row['v']:,.0f} in its first week beats the old mark of "
                              f"${best[0]:,.0f} ({row['studio']}).", movie_id=row["movie_id"],
                              run_id=row["id"], weight=3, mine=mine)
            elif row["v"] >= {"w1": 4, "streak1": 4, "w10": 10, "w50": 16, "w100": 20}[key] \
                    and row["id"] not in told:
                told.add(row["id"])
                press.add(w, "records", f"\u2018{row['title']}\u2019 sets a record: {label.lower()}",
                          f"{row['v']} weeks and still in cinemas ({row['studio']}). "
                          f"The old mark was {best[0]}.", movie_id=row["movie_id"], run_id=row["id"],
                          weight=3, mine=mine)
        rec[key] = [row["v"], row["id"]]
        changed = True
    if changed:
        w.db.kv_set("records_v1", rec)


# --------------------------------------------------------------------------- #
#  Reading the chart
# --------------------------------------------------------------------------- #
def current(w, limit=10):
    rows = w.db.q("""SELECT * FROM box_runs WHERE active=1 AND wk>0 AND rank IS NOT NULL
                     ORDER BY rank LIMIT ?""", (int(limit),))
    return [_row(dict(r)) for r in rows]


def past(w, abs_week):
    rows = w.db.q("""SELECT h.rank, h.gross AS week_gross, h.cume, h.weeks AS wk, r.id, r.kind, r.title,
                     r.studio, r.genre, r.lead_name, r.movie_id, r.w1, r.critics, r.total,
                     (SELECT h2.rank FROM chart_hist h2 WHERE h2.abs_week=h.abs_week-1
                        AND h2.run_id=h.run_id) AS prev_rank
                     FROM chart_hist h JOIN box_runs r ON r.id=h.run_id
                     WHERE h.abs_week=? ORDER BY h.rank""", (abs_week,))
    return [_row(dict(r)) for r in rows]


def _row(r):
    r["mine"] = r.get("kind") == "player"
    r["genre_label"] = C.GENRE_LABEL.get(r.get("genre"), r.get("genre"))
    pr = r.get("prev_rank")
    r["move"] = ("new" if r.get("wk") == 1 else "re" if not pr else
                 "up" if pr > r["rank"] else "down" if pr < r["rank"] else "same")
    return r


def records(w, limit=5):
    out = []
    for key, label, col, fmt in RECORDS:
        rows = w.db.q(f"""SELECT id, title, studio, kind, year, movie_id, {col} AS v FROM box_runs
                          WHERE {col} > 0 ORDER BY {col} DESC, id LIMIT ?""", (limit,))
        mine = w.db.q1(f"""SELECT id, title, year, {col} AS v FROM box_runs WHERE kind='player'
                           AND {col} > 0 ORDER BY {col} DESC LIMIT 1""")
        out.append(dict(key=key, label=label, fmt=fmt,
                        rows=[dict(r, mine=r["kind"] == "player") for r in rows],
                        ours=dict(mine) if mine else None))
    return out


def movie_run(w, movie_id):
    r = w.db.q1("SELECT * FROM box_runs WHERE movie_id=? AND kind='player'", (movie_id,))
    return dict(r) if r else None


# --------------------------------------------------------------------------- #
#  First open of a save: give the town a chart to read on day one
# --------------------------------------------------------------------------- #
def seed(w):
    if w.db.scalar("SELECT COUNT(*) FROM box_runs", 0):
        return
    rnd = stream(w.seed, "chartseed", w.year)
    # the town has been releasing pictures for a while already
    for back in range(12, 0, -1):
        for _ in range(4 + int(rnd.random() * 4)):
            q = clamp(rnd.gauss(42, 16), 4, 94)
            g = rnd.choice(C.GENRES)
            gross = _indie_gross(w, rnd, q, "standard" if rnd.random() < 0.35 else "indie")
            legs = C.LEGS_MIN + (C.LEGS_MAX - C.LEGS_MIN) * (q / 100.0) ** 1.3
            run = open_run(w, "indie", N.movie_title(rnd, g), rnd.choice(INDIE_DISTRIBUTORS), g, gross,
                           legs, critics=int(clamp(q + rnd.gauss(4, 9), 1, 99)))
            if not run:
                continue
            # pretend it opened `back` weeks ago
            wk = min(back, run["weeks"])
            cume = sum(run["opening"] * run["decay"] ** i for i in range(wk))
            w.db.execute("""UPDATE box_runs SET wk=?, cume=?, week_gross=?, open_abs=open_abs-?,
                            active=CASE WHEN ? >= weeks_max THEN 0 ELSE 1 END WHERE id=?""",
                         (wk, cume, run["opening"] * run["decay"] ** (wk - 1), back, wk, run["id"]))
    _rank(w)
    w.db.execute("""UPDATE box_runs SET best_rank=rank, w100=1, w50=(rank<=50), w10=(rank<=10),
                    w1=(rank=1), streak1=(rank=1), best_streak1=(rank=1) WHERE active=1""")
    w.db.execute("""INSERT OR REPLACE INTO chart_hist(abs_week, rank, run_id, gross, cume, weeks)
                    SELECT ?, rank, id, week_gross, cume, wk FROM box_runs WHERE active=1 AND rank <= 10""",
                 (w.abs_week,))
