"""The press: critics, headlines, the newspaper and the gossip columns.

* ``review_release`` runs when one of our pictures opens. It turns the
  numbers the box-office model already rolled (quality, critics, audience,
  outcome) into a verdict people can read: four outlets score it out of ten
  (Game Dev Tycoon style), a critic writes it up and names who was good and
  who was not, and the people named get a bump - up or down.
* ``add`` files a story in the paper (table ``news``). The Newspaper tab reads
  it by section: front, release, review, boxoffice, stars, world, awards,
  records, business.
* ``people_yearly`` / ``gossip`` keep the stars section alive with the town's
  births, deaths, retirements and scandals, not only ours.
"""
from __future__ import annotations

import json

from .. import config as C
from ..rng import clamp, stream

SECTIONS = ["front", "release", "review", "boxoffice", "stars", "world", "awards",
            "records", "business"]


def add(w, section, headline, body="", movie_id=None, actor_id=None, run_id=None,
        weight=1, mine=0, year=None, week=None):
    year = w.year if year is None else year
    week = w.week if week is None else week
    absw = (year - w.start_year) * 52 + week
    w.db.execute("""INSERT INTO news(year,week,abs_week,section,headline,body,movie_id,actor_id,
                    run_id,weight,mine) VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
                 (year, week, absw, section, headline, body, movie_id, actor_id, run_id,
                  int(weight), 1 if mine else 0))


# --------------------------------------------------------------------------- #
#  Who reviews pictures (fictional outlets; they come and go with the eras)
# --------------------------------------------------------------------------- #
# name, first year, last year, taste
OUTLETS = [
    ("The Hollywood Ledger", 1900, 3000, "neutral"),
    ("Silver Screen Weekly", 1900, 1968, "popcorn"),
    ("The Trade Daily", 1912, 3000, "neutral"),
    ("The Sunset Courier", 1918, 3000, "popcorn"),
    ("Marquee Magazine", 1930, 3000, "neutral"),
    ("Celluloid Quarterly", 1946, 3000, "snob"),
    ("The Late Show Review", 1956, 3000, "popcorn"),
    ("Frame Rate", 1997, 3000, "snob"),
    ("The Couch Critic", 2004, 3000, "popcorn"),
    ("Reel Talk", 2012, 3000, "neutral"),
]

VERDICT = {10: "Masterpiece!", 9: "Triumph", 8: "Terrific", 7: "Good", 6: "Decent",
           5: "Middling", 4: "Disappointing", 3: "A Mess", 2: "Disaster", 1: "Unwatchable"}

QUOTES = {
    "top": ["An instant classic.", "{lead} has never been better.", "The picture of the year.",
            "Go. Go now. Take your mother.", "Pure cinema.", "They will be studying this one.",
            "{title} is why we go to the movies."],
    "great": ["Terrific entertainment.", "{director} at the top of the game.",
              "Smart, stirring and a lot of fun.", "A crowd-pleaser with a brain.",
              "{lead} is magnetic."],
    "good": ["Solid {genre} fare.", "Good, not great.", "Worth the ticket, if not the hype.",
             "Does exactly what it says on the poster.", "A pleasant two hours."],
    "meh": ["Uneven.", "Never quite comes together.", "A long sit for a short story.",
            "Some good scenes in search of a picture.", "Forgettable, and soon forgotten."],
    "bad": ["A mess.", "{lead} deserved better.", "Where did the money go?",
            "Two hours I will not get back.", "Dead on arrival."],
    "awful": ["Avoid.", "An endurance test.", "We want our money back.",
              "Not so much a picture as a hostage situation.", "Burn the negative."],
}


def _band(s):
    return ("top" if s >= 9 else "great" if s >= 8 else "good" if s >= 6 else
            "meh" if s >= 4.5 else "bad" if s >= 2.5 else "awful")


def _score10(critics):
    return 1.0 + 9.0 * clamp((critics - 8.0) / 84.0, 0.0, 1.0)


def _outlets(w, rnd, critics, audience, genre, fill):
    live = [o for o in OUTLETS if o[1] <= w.year <= o[2]]
    rnd.shuffle(live)
    out, used = [], set()
    for name, _a, _b, taste in live[:4]:
        base = critics
        bias = 0.0
        if taste == "popcorn":
            base = critics * 0.45 + audience * 0.55
            bias = 0.2
        elif taste == "snob":
            bias = -0.5 + (0.9 if genre in ("drama", "crime") else -0.5
                           if genre in ("action", "horror", "comedy", "animation") else 0)
        s = int(round(clamp(_score10(base) + bias + rnd.gauss(0, 0.7), 1, 10)))
        pool = [q for q in QUOTES[_band(s)] if q not in used]
        q = rnd.choice(pool or QUOTES[_band(s)])
        used.add(q)
        out.append(dict(outlet=name, score=s, quote=q.format(**fill)))
    return out


# --------------------------------------------------------------------------- #
#  Performances: who was good, who was not
# --------------------------------------------------------------------------- #
def _grade(perf):
    return ("Standout" if perf >= 72 else "Strong" if perf >= 57 else "Fine" if perf >= 42
            else "Weak" if perf >= 30 else "Miscast")


def _pron(g):
    return ("she", "her", "actress") if g == "f" else ("he", "his", "actor")


def performances(w, comp, genre, q, rnd):
    from . import actors as A
    out = []
    for r in comp["roles"]:
        if not r.get("actor_id"):
            continue
        fit = A.role_fit(r, r, genre)
        perf = clamp(fit * 0.45 + (r.get("craft") or 20) * 0.15 + (r.get("t_charisma") or 30) * 0.08
                     + q * 0.22 - 8.0 + rnd.gauss(0, 8.0), 1, 99)
        out.append(dict(actor_id=r["actor_id"], name=r.get("actor_name") or "?", role=r["name"],
                        kind=r["kind"], gender=r.get("gender") or "m", perf=round(perf, 1),
                        grade=_grade(perf), fame_delta=0.0, note=""))
    return out


# --------------------------------------------------------------------------- #
#  The review
# --------------------------------------------------------------------------- #
def review_release(w, p, comp, mid, q, critics, audience, outcome, run, gross, wom,
                   heat, peak, cult_classic, cast_back, fatigue, gross_open=None):
    rnd = stream(w.seed, "review", p["id"], w.year, w.week)
    genre = p["genre"]
    glabel = C.GENRE_LABEL[genre].lower()
    perfs = performances(w, comp, genre, q, rnd)
    leads = sorted([x for x in perfs if x["kind"] in ("lead", "voice")], key=lambda x: -x["perf"])
    supp = sorted([x for x in perfs if x["kind"] not in ("lead", "voice")], key=lambda x: -x["perf"])
    star = leads[0] if leads else (supp[0] if supp else None)
    support = supp[0] if supp and supp[0]["perf"] >= 68 and supp[0] is not star else None
    weak = min(perfs, key=lambda x: x["perf"]) if perfs else None
    if weak and (weak is star or weak is support or weak["perf"] >= 42):
        weak = None
    d = w.db.q1("SELECT name FROM directors WHERE id=?", (p["director_id"],)) if p["director_id"] else None
    director = d["name"] if d else "the director"
    fill = dict(title=p["title"], lead=(star["name"] if star else "the cast"), genre=glabel,
                director=director)

    outlets = _outlets(w, rnd, critics, audience, genre, fill)
    score10 = round(sum(o["score"] for o in outlets) / max(1, len(outlets)), 1)
    verdict = VERDICT[int(clamp(round(score10), 1, 10))]

    # --- the write-up
    lines = []
    if star:
        he, his, word = _pron(star["gender"])
        if star["perf"] >= 70:
            lines.append(rnd.choice([f"{star['name']} was the star of this movie.",
                                     f"{star['name']} owns every frame {he} is in.",
                                     f"{star['name']} gives the performance of {his} career."]))
        elif star["perf"] >= 58:
            lines.append(rnd.choice([f"{star['name']} is reliably good as {star['role']}.",
                                     f"{star['name']} holds the picture together."]))
        elif score10 >= 6:
            lines.append(f"{star['name']} is the weak link in an otherwise fine picture.")
        else:
            lines.append(rnd.choice([f"{star['name']} never finds the character.",
                                     f"{star['name']} sleepwalks through it."]))
    if support:
        he, his, word = _pron(support["gender"])
        lines.append(rnd.choice([f"The supporting {word} {support['name']} was also fantastic.",
                                 f"{support['name']} steals every scene {he} is in.",
                                 f"In support, {support['name']} is a revelation."]))
    if weak:
        lines.append(rnd.choice([f"{weak['name']} looked lost as {weak['role']}.",
                                 f"{weak['name']} was badly miscast.",
                                 f"{weak['name']} seems to be acting in a different movie."]))
    extra = []
    if len(leads) >= 2:
        a, b = leads[0]["name"], leads[1]["name"]
        if comp["chem"] >= 72:
            extra.append((comp["chem"] - 60, f"{a} and {b} light up the screen together."))
        elif comp["chem"] < 36:
            extra.append((50 - comp["chem"], f"{a} and {b} have all the chemistry of a tax audit."))
    if comp["script"] >= 74:
        extra.append((comp["script"] - 60, "The script crackles."))
    elif comp["script"] < 34:
        extra.append((50 - comp["script"], "The script needed another draft - or a match."))
    if comp["direction"] >= 70:
        extra.append((comp["direction"] - 58, f"{director} directs with total confidence."))
    elif comp["direction"] < 28:
        extra.append((48 - comp["direction"], "Nobody seems to be steering this ship."))
    if genre in ("action", "sci-fi", "musical", "western", "animation"):
        if comp["values"] >= 58:
            extra.append((comp["values"] - 45, "The production values are spectacular."))
        elif comp["values"] < 22:
            extra.append((40 - comp["values"], "It looks cheap, and it was."))
    extra.sort(key=lambda x: -x[0])
    lines += [t for _, t in extra[:2]]
    if not lines:
        lines.append(f"A {glabel} picture, competently assembled.")
    consensus = " ".join(lines)

    aud_line = ("Audiences are cheering in the aisles." if audience >= 85 else
                "Audiences love it." if audience >= 70 else
                "Audiences are warm to it." if audience >= 55 else
                "Audiences shrug." if audience >= 40 else
                "Audiences are walking out.")

    # --- the bumps: the people the critics name feel it
    for x in perfs:
        delta = 0.0
        if star is x and x["perf"] >= 70:
            delta = 1.5 + 0.9 * max(0.0, score10 - 5.0)
            x["note"] = "named star of the picture"
        elif support is x:
            delta = 1.0 + 0.7 * max(0.0, score10 - 5.0)
            x["note"] = "praised in support"
        elif weak is x:
            delta = -(1.0 + (42 - x["perf"]) * 0.06)
            x["note"] = "singled out by the critics"
        elif x["grade"] == "Standout":
            delta = 1.0
        x["fame_delta"] = round(delta, 1)
        if delta:
            w.db.execute("UPDATE actors SET fame=MIN(100.0, MAX(0.0, fame+?)) WHERE id=?",
                         (delta, x["actor_id"]))
        if x["grade"] == "Standout" or delta > 0:
            w.db.execute("UPDATE actors SET standouts=standouts+1, craft=MIN(99, craft+0.5) WHERE id=?",
                         (x["actor_id"],))
        w.db.execute("UPDATE cast_members SET perf=?, grade=? WHERE movie_id=? AND actor_id=?",
                     (x["perf"], x["grade"], mid, x["actor_id"]))

    headline, subhead = headline_for(p, outcome, critics, audience, run, wom, heat, peak, star,
                                     cult_classic, cast_back, fatigue, w.name, rnd)
    return dict(movie_id=mid, title=p["title"], outcome=outcome, critics=round(critics),
                audience=round(audience), score10=score10, verdict=verdict, headline=headline,
                subhead=subhead, consensus=consensus, audience_line=aud_line, outlets=outlets,
                performances=sorted(perfs, key=lambda x: (x["kind"] not in ("lead", "voice"), -x["perf"])),
                star=star, support=support, weak=weak)


def headline_for(p, outcome, critics, audience, run, wom, heat, peak, star, cult, cast_back,
                 fatigue, studio, rnd):
    t = f"‘{p['title']}’"
    g = C.GENRE_LABEL[p["genre"]]
    lead = star["name"] if star else None
    good = outcome in ("PHENOMENON", "BLOCKBUSTER", "HIT")
    bad = outcome in ("FLOP", "STINKER")
    if critics >= 75 and run < 1.0:
        head = f"Critics' darling {t} can't find an audience"
    elif critics < 42 and audience >= 70 and run >= 1.15:
        head = f"Critics hate {t}. Audiences don't care."
    elif cult and bad:
        head = f"{t} bombs - but its fans are already obsessed"
    else:
        head = {
            "PHENOMENON": rnd.choice([f"{t} is a phenomenon: lines around the block",
                                      f"{t} breaks the box office", f"The whole country is talking about {t}"]),
            "BLOCKBUSTER": rnd.choice([f"{t} is the blockbuster of the season",
                                       f"{t} prints money for {studio}"]),
            "HIT": rnd.choice([f"{t} is a hit for {studio}", f"Audiences turn out for {t}"]),
            "SOLID": rnd.choice([f"{t} earns its keep", f"Steady business for {t}"]),
            "TROUGH": rnd.choice([f"{t} underwhelms", f"{t} limps out of the gate"]),
            "FLOP": rnd.choice([f"{t} flops; {studio} counts the cost", f"Empty seats for {t}"]),
            "STINKER": rnd.choice([f"{t} bombs - {studio}'s worst in years",
                                   f"Disaster: {t} is the stinker of the year"]),
        }.get(outcome, f"{t} opens")
    mkt = (p["marketing"] or 0) / max(1.0, p["budget"] or 1.0)
    pros, cons = [], []
    if heat >= 1.15:
        pros.append(f"perfect timing - {g.lower()} is hot")
    if heat <= 0.85:
        cons.append(f"audiences tired of {g.lower()}")
    if lead and peak >= 60:
        pros.append(f"{lead}'s drawing power")
    if peak < 25:
        cons.append("a cast nobody had heard of")
    if critics >= 78:
        pros.append("rave reviews")
    if critics < 40:
        cons.append("brutal reviews")
    if wom >= 1.3:
        pros.append("glowing word of mouth")
    if wom <= 0.8:
        cons.append("poisonous word of mouth")
    if mkt >= 0.5:
        pros.append("a saturation ad campaign")
    if mkt < 0.1:
        cons.append("an ad campaign nobody saw")
    if fatigue and fatigue > 0.1:
        cons.append("series fatigue")
    if cast_back is not None and cast_back <= 0.01:
        cons.append("the missing original stars")
    if cast_back is not None and cast_back >= 0.99:
        pros.append("the original stars coming back")
    sub = ""
    if good and pros:
        sub = "Insiders credit " + " and ".join(pros[:2]) + "."
    elif bad and cons:
        sub = "Analysts blame " + " and ".join(cons[:2]) + "."
    elif outcome == "TROUGH" and cons:
        sub = f"Held back by {cons[0]}."
    elif pros and cons:
        sub = f"{pros[0][0].upper() + pros[0][1:]} helped; {cons[0]} did not."
    elif pros:
        sub = f"Helped by {pros[0]}."
    elif cons:
        sub = f"Held back by {cons[0]}."
    return head, sub


def save_review(w, rv, opening, open_rank):
    perfs = [dict((k, v) for k, v in x.items()) for x in rv["performances"]]
    w.db.execute("""INSERT OR REPLACE INTO reviews(movie_id,year,week,title,outcome,critics,audience,
                    score10,verdict,headline,subhead,consensus,audience_line,outlets,performances,
                    opening,open_rank,seen) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)""",
                 (rv["movie_id"], w.year, w.week, rv["title"], rv["outcome"], rv["critics"],
                  rv["audience"], rv["score10"], rv["verdict"], rv["headline"], rv["subhead"],
                  rv["consensus"], rv["audience_line"], json.dumps(rv["outlets"]), json.dumps(perfs),
                  opening or 0.0, open_rank))
    big = rv["outcome"] in ("PHENOMENON", "BLOCKBUSTER") or rv["outcome"] == "STINKER"
    add(w, "review", rv["headline"],
        f"{rv['verdict']} - {rv['score10']:.1f}/10. {rv['consensus']} {rv['subhead']}".strip(),
        movie_id=rv["movie_id"], weight=3 if big else 2, mine=1)


def get_review(w, mid):
    r = w.db.q1("""SELECT rv.*, m.genre, m.scale, m.gross, m.net, m.budget, m.marketing, m.cult_classic,
                   m.franchise_id, m.seq_index, m.quality
                   FROM reviews rv JOIN movies m ON m.id=rv.movie_id WHERE rv.movie_id=?""", (mid,))
    if not r:
        return None
    d = dict(r)
    d["outlets"] = json.loads(d["outlets"] or "[]")
    d["performances"] = json.loads(d["performances"] or "[]")
    d["fresh"] = d["critics"] >= 60
    d["popcorn"] = d["audience"] >= 60
    d["gilded"] = d["critics"] >= 85 and d["audience"] >= 75
    run = w.db.q1("""SELECT rank, w1, cume, wk, best_rank, active FROM box_runs
                     WHERE movie_id=? AND kind='player'""", (mid,))
    d["run"] = dict(run) if run else None
    return d


# --------------------------------------------------------------------------- #
#  The stars section: the town's people, not just ours
# --------------------------------------------------------------------------- #
def snapshot_people(w):
    """Notable living actors before the yearly pass, so we can tell who died,
    retired or broke out when it is done."""
    rows = w.db.q("""SELECT id, status FROM actors WHERE status IN ('available','working','star')
                     AND (fame >= 38 OR awards > 0 OR status='star')""")
    stars = {r["id"] for r in w.db.q("SELECT id FROM actors WHERE status='star'")}
    return dict(notable={r["id"]: r["status"] for r in rows}, stars=stars)


def _best_known(w, aid):
    m = w.db.q1("""SELECT mo.title FROM cast_members cm JOIN movies mo ON mo.id=cm.movie_id
                   WHERE cm.actor_id=? ORDER BY mo.gross DESC LIMIT 1""", (aid,))
    r = w.db.q1("SELECT title FROM rival_releases WHERE lead_id=? ORDER BY gross DESC LIMIT 1", (aid,))
    return (m["title"] if m else None) or (r["title"] if r else None)


def people_yearly(w, before):
    from . import typecast
    ids = list(before["notable"].keys())
    if ids:
        for i in range(0, len(ids), 500):
            chunk = ids[i:i + 500]
            marks = ",".join("?" * len(chunk))
            for a in w.db.q(f"""SELECT id,name,gender,age,status,films,awards,fame,labels FROM actors
                               WHERE id IN ({marks}) AND status IN ('dead','retired')""", chunk):
                known = _best_known(w, a["id"])
                lab = typecast.parse(a["labels"])
                he, his, word = _pron(a["gender"])
                tag = typecast.label_name(lab[0], a["gender"]).lower() if lab else word
                if a["status"] == "dead":
                    head = (f"Screen legend {a['name']} dies at {a['age']}" if a["fame"] >= 60
                            or a["awards"] else f"{a['name']} dies at {a['age']}")
                    cause = w.db.scalar("SELECT cause FROM legacy WHERE actor_id=?", (a["id"],), None)
                    if cause and a["age"] < 45:
                        head = f"Tragedy: {a['name']} dies at {a['age']}"
                    body = ((f"{a['name']} {cause}. " if cause else "")
                            + f"The {tag} made {a['films']} pictures"
                            + (f" and won {a['awards']} award{'s' if a['awards'] != 1 else ''}" if a["awards"] else "")
                            + (f"; best remembered for ‘{known}’." if known else "."))
                    add(w, "stars", head, body, actor_id=a["id"], weight=3 if a["fame"] >= 60 else 2,
                        week=0)
                else:
                    add(w, "stars", f"{a['name']} retires from the screen",
                        f"After {a['films']} pictures the {tag} hangs up {his} costume"
                        + (f". Best known for ‘{known}’." if known else "."),
                        actor_id=a["id"], weight=2 if a["fame"] >= 55 else 1, week=0)
    new = w.db.q("""SELECT id,name,gender,age,films,labels,studio FROM actors
                    WHERE status='star' ORDER BY fame DESC LIMIT 60""")
    born = [a for a in new if a["id"] not in before["stars"]][:4]
    for a in born:
        lab = typecast.parse(a["labels"])
        tag = typecast.label_name(lab[0], a["gender"]) if lab else "new face"
        who = ("one of ours" if a["studio"] == "player" else
               f"under contract to {a['studio']}" if a["studio"] else "and nobody has signed them")
        add(w, "stars", f"A star is born: {a['name']}",
            f"{a['age']}, a {tag} with {a['films']} pictures behind them - {who}.",
            actor_id=a["id"], weight=2, week=0)


GOSSIP = [
    # (template, fame delta, needs scandal-prone)
    ("{name} spotted dancing until dawn at the Coconut Grove", 0.5, False),
    ("{name} marries in a hush-hush ceremony in Palm Springs", 1.0, False),
    ("{name} and {other} feuding on set, say insiders", 0.5, False),
    ("{name} buys a ranch and swears off the city", 0.0, False),
    ("{name} lands the cover of every magazine in town", 1.5, False),
    ("{name} fires {his} agent", 0.0, False),
    ("{name} arrested after a brawl outside a nightclub", -2.0, True),
    ("{name} divorce gets ugly", -1.0, True),
    ("{name} checks into a 'rest cure' upstate", -1.0, True),
    ("{name} caught in a gambling scandal", -2.5, True),
]


def gossip(w):
    """Monthly gossip column: a famous face does something the papers like."""
    rnd = stream(w.seed, "gossip", w.year, w.week)
    if rnd.random() > 0.55:
        return
    rows = w.db.q("""SELECT id,name,gender,t_scandal FROM actors WHERE fame >= 45
                     AND status IN ('working','star') ORDER BY fame DESC LIMIT 40""")
    if len(rows) < 2:
        return
    a = rnd.choice(rows)
    other = rnd.choice([x for x in rows if x["id"] != a["id"]])
    risky = rnd.random() < (a["t_scandal"] or 20) / 110.0
    pool = [g for g in GOSSIP if g[2] == risky]
    tpl, delta, _ = rnd.choice(pool)
    he, his, _ = _pron(a["gender"])
    head = tpl.format(name=a["name"], other=other["name"], his=his)
    if delta:
        w.db.execute("UPDATE actors SET fame=MIN(100, MAX(0, fame+?)) WHERE id=?", (delta, a["id"]))
    add(w, "stars", head, "", actor_id=a["id"], weight=1)


def awards_news(w, yr):
    rows = w.db.q("""SELECT * FROM awards WHERE year=? AND won=1 AND category IN
                     ('picture','actor','razzie_picture','razzie_actor')""", (yr,))
    for r in rows:
        mine = r["studio"] == w.name
        if r["category"] == "picture":
            add(w, "awards", f"‘{r['movie_title']}’ wins Best Picture of {yr}",
                f"{r['studio']} takes the night's top prize." + (" Champagne on our lot." if mine else ""),
                movie_id=r["movie_id"], weight=3, mine=mine)
        elif r["category"] == "actor" and r["actor_name"]:
            n = w.db.scalar("SELECT COUNT(*) FROM awards WHERE actor_id=? AND won=1 AND category='actor'",
                            (r["actor_id"],), 1)
            add(w, "awards", f"{r['actor_name']} wins {r['label']}",
                f"For ‘{r['movie_title']}’ ({r['studio']}). "
                + (f"That is statuette number {n}." if n > 1 else "A first win."),
                actor_id=r["actor_id"], movie_id=r["movie_id"], weight=3, mine=mine)
        elif r["category"].startswith("razzie"):
            add(w, "awards", f"Golden Raspberry: {r['label'].replace('Golden Raspberry ', '')}",
                f"‘{r['movie_title']}’" + (f" - {r['actor_name']}" if r["actor_name"] else "")
                + ". Nobody came to collect it.", movie_id=r["movie_id"], actor_id=r["actor_id"],
                weight=2, mine=mine)


# --------------------------------------------------------------------------- #
#  Reading the paper
# --------------------------------------------------------------------------- #
def stories(w, section=None, upto=None, limit=12, since=None):
    where, args = [], []
    if section:
        where.append("section=?")
        args.append(section)
    if upto is not None:
        where.append("abs_week<=?")
        args.append(upto)
    if since is not None:
        where.append("abs_week>=?")
        args.append(since)
    wsql = (" WHERE " + " AND ".join(where)) if where else ""
    rows = w.db.q(f"""SELECT * FROM news{wsql} ORDER BY abs_week DESC, weight DESC, id DESC LIMIT ?""",
                  tuple(args) + (limit,))
    return [dict(r) for r in rows]
