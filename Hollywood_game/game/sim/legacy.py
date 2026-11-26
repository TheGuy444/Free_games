"""Legacies: a hidden career rating, the Academy Hall of Fame, and the way
careers end - sometimes far too early.

Career rating
    Every performer carries a hidden, Elo-style rating (starts at 1000).
    Each picture is a "match" against the size of the job: carry a
    blockbuster brilliantly and you gain a lot; sink one and you lose.
    Award races are matches between the nominees - the winner takes points
    from the others. The wider town (rival pictures we do not simulate shot
    by shot) is folded in once a year from how famous the actor stayed.

Hall of Fame
    Each January the Silver Screen Academy inducts at most three performers
    whose careers are over (retired, dead, or 62+). The bar is high. A life
    cut short lowers it - but only for someone who did something
    unforgettable first: a statuette, a monster hit, or a run of nominations.

Deaths
    Old age takes most people. A few go early: illness, the coast highway,
    a party that ended in the water, a small plane in bad weather, and -
    extremely rarely - an accident on a set. Notable deaths make the news.
"""
from __future__ import annotations

import math

from .. import config as C
from .. import universe
from ..rng import clamp, stream, unit

START = 1000.0
HOF_BAR = 1230.0            # career score needed for the Hall of Fame
HOF_MIN_FILMS = 14
HOF_PER_YEAR = 3
SHORT_LIFE_AGE = 45         # died before this: the bar is lowered...
SHORT_LIFE_SOFTEN = 7.0     # ...by this many points per year short of it
SHORT_LIFE_MAX_SOFTEN = 120.0
SHORT_LIFE_MIN_FILMS = 5
NEWS_FAME = 40              # deaths below this fame do not make the papers
ALIVE = "('available','working','star','blacklisted')"
SCALE_OPP = {"short": -120, "indie": -60, "standard": 0, "epic": 80, "blockbuster": 150}


# --------------------------------------------------------------------------- #
#  The rating
# --------------------------------------------------------------------------- #
def _row(w, aid):
    r = w.db.q1("SELECT * FROM legacy WHERE actor_id=?", (aid,))
    if r:
        return dict(r)
    # a performer we meet for the first time arrives with the reputation they
    # already have: fame, a body of work, statuettes on the shelf
    a = w.db.q1("SELECT fame, films, awards FROM actors WHERE id=?", (aid,))
    seed = START + ((a["fame"] or 0) * 2.5 + min(40, a["films"] or 0) * 2.0 + (a["awards"] or 0) * 10
                    if a else 0.0)
    w.db.execute("INSERT OR IGNORE INTO legacy(actor_id, rating, peak) VALUES(?,?,?)", (aid, seed, seed))
    return dict(w.db.q1("SELECT * FROM legacy WHERE actor_id=?", (aid,)))


def rating(w, aid) -> float:
    return w.db.scalar("SELECT rating FROM legacy WHERE actor_id=?", (aid,), START) or START


def expected(ra: float, rb: float) -> float:
    return 1.0 / (1.0 + 10 ** ((rb - ra) / 400.0))


def adjust(w, aid, opponent: float, score: float, k: float):
    """One Elo result for one performer."""
    if not aid or aid < 0:
        return 0.0
    r = _row(w, aid)
    delta = k * (score - expected(r["rating"], opponent))
    new = r["rating"] + delta
    w.db.execute("""UPDATE legacy SET rating=?, peak=MAX(peak, ?), matches=matches+1
                    WHERE actor_id=?""", (new, new, aid))
    return delta


def performance(w, aid, quality, run, gross, scale, lead):
    """A released picture of ours: how well did this performer carry it?"""
    std = C.standard_cost(w.year)
    score = 0.5 + (quality - 60.0) / 55.0 + 0.10 * math.log2(max(0.1, run))
    k = 28.0 if lead else 12.0
    if gross >= std * 12:            # a monster hit: the whole town remembers who was in it
        score = max(score, 0.95)
        k *= 1.5
    adjust(w, aid, START + SCALE_OPP.get(scale, 0), clamp(score, 0.0, 1.0), k)


def award_race(w, winner_id, loser_ids, k):
    """The winner beats every other nominee; being nominated at all is a
    small win against the field."""
    losers = [x for x in loser_ids if x and x != winner_id]
    if not winner_id and not losers:
        return
    ratings = {a: rating(w, a) for a in [winner_id] + losers if a}
    each = k / max(1.0, math.sqrt(len(losers)))
    for lid in losers:
        if winner_id:
            adjust(w, winner_id, ratings[lid], 1.0, each)
            adjust(w, lid, ratings[winner_id], 0.0, each * 0.4)
        adjust(w, lid, START + 100, 1.0, k * 0.2)
    if winner_id:
        adjust(w, winner_id, START + 100, 1.0, k * 0.2)


def season(w):
    """The rest of the town: careers we do not follow picture by picture are
    scored once a year from how famous the performer stayed."""
    rows = w.db.q(f"""SELECT id, fame, films FROM actors WHERE status IN {ALIVE}
                      AND fame >= 30 AND films > 0""")
    for r in rows:
        score = clamp(0.5 + (r["fame"] - 50.0) / 55.0, 0.0, 1.0)
        adjust(w, r["id"], START + 60, score, 10.0)


# --------------------------------------------------------------------------- #
#  How careers end
# --------------------------------------------------------------------------- #
ACCIDENTS = [
    # (min_year, weight, substance-driven, text)
    (1915, 3.0, False, "was killed when their car left the coast highway at night"),
    (1928, 1.6, False, "was killed with the pilot when a small plane came down in fog"),
    (1920, 1.8, True, "drowned after going over the side of a yacht during a party"),
    (1920, 2.4, True, "was found dead of an accidental overdose"),
    (1950, 1.4, False, "was killed in a motorcycle crash on a canyon road"),
    (1920, 0.8, False, "died in a house fire"),
    (1955, 0.7, False, "was killed in a skiing accident"),
    (1920, 0.9, True, "died in a fall from a hotel balcony after a long night out"),
]
ILLNESS = ["died of a sudden heart attack", "died after a short, brutal illness",
           "died of complications after surgery", "died of an aneurysm no one saw coming"]
OLD_AGE = ["died of natural causes", "died after a long illness", "died of heart failure",
           "died of pneumonia", "died after a stroke"]
ON_SET = {
    1920: "was killed when a stunt horse fell during a chase sequence",
    1940: "was killed when a lighting rig collapsed on the stage",
    1960: "was killed when a stunt car rolled during a take",
    1980: "was killed in a helicopter accident during an action sequence",
    2000: "was killed when a pyrotechnic effect went wrong on set",
}


def _pick(rnd, rows):
    tot = sum(r[1] for r in rows)
    x = rnd.random() * tot
    for r in rows:
        x -= r[1]
        if x <= 0:
            return r
    return rows[-1]


def on_set_text(year: int) -> str:
    return ON_SET[max(y for y in ON_SET if y <= max(1920, year))]


def mortality(w, mortality_mult=1.0):
    """Replaces the old silent mortality pass. Same natural death rates, plus
    a rare early-death risk that rises with fame, partying and bad habits."""
    m = max(0.2, mortality_mult)
    natural = [dict(r) for r in w.db.q(f"""
        SELECT id, age, t_substance FROM actors WHERE status IN {ALIVE}
          AND ((r % 10000)/10000.0) < (CASE WHEN age < 42 THEN 0.0006
                ELSE 0.0006 + (age - 42) * 0.0042 + t_substance * 0.00035
                     + t_scandal * 0.00012 END) * ?""", (m,))]
    # misadventure: young, famous and reckless is the dangerous combination
    reckless = [dict(r) for r in w.db.q(f"""
        SELECT id, age, t_substance FROM actors WHERE status IN {ALIVE}
          AND age BETWEEN 17 AND 55
          AND (((r / 7) % 10000)/10000.0) < (0.00012 * (1.0 + fame / 40.0)
                + MAX(0.0, t_substance - 40) * 0.00002 * (1.0 + fame / 50.0)) * ?""", (m,))]
    rnd = stream(w.seed, "deaths", w.year)
    done = set()
    for r in natural:
        if r["age"] >= 62:
            record_death(w, r["id"], rnd.choice(OLD_AGE), "natural")
        elif (r["t_substance"] or 0) > 55 and rnd.random() < 0.5:
            record_death(w, r["id"], "was found dead of an accidental overdose", "misadventure")
        elif rnd.random() < 0.35:
            record_death(w, r["id"], _pick(rnd, [a for a in ACCIDENTS if a[0] <= w.year])[3], "accident")
        else:
            record_death(w, r["id"], rnd.choice(ILLNESS), "illness")
        done.add(r["id"])
    for r in reckless:
        if r["id"] in done:
            continue
        pool = [a for a in ACCIDENTS if a[0] <= w.year]
        if (r["t_substance"] or 0) > 50:
            pool = [(a[0], a[1] * (2.5 if a[2] else 1.0), a[2], a[3]) for a in pool]
        acc = _pick(rnd, pool)
        record_death(w, r["id"], acc[3], "misadventure" if acc[2] else "accident")


def rival_set_accident(w):
    """Extremely rare: a fatal accident on one of the rivals' sets."""
    rnd = stream(w.seed, "rivalset", w.year)
    if rnd.random() >= 0.03:
        return
    rel = w.db.q1("SELECT studio, title FROM rival_releases WHERE year=? ORDER BY gross DESC LIMIT 1",
                  (w.year - 1,))
    if not rel:
        return
    cand = [dict(r) for r in w.db.q(f"""SELECT id FROM actors WHERE studio=? AND status IN {ALIVE}
                                        AND age BETWEEN 18 AND 60""", (rel["studio"],))]
    if cand:
        record_death(w, rnd.choice(cand)["id"], on_set_text(w.year), "on_set",
                     on_set_title=f"{rel['title']} for {rel['studio']}")


def record_death(w, aid, cause, kind="natural", on_set_title=None):
    """Kill a performer, write the obituary, and tidy up what they leave."""
    a = w.db.q1("SELECT * FROM actors WHERE id=?", (aid,))
    if not a or a["status"] == "dead":
        return
    a = dict(a)
    w.db.execute("""UPDATE actors SET status='dead', fame=MIN(100.0, fame*1.15+4),
                    studio=NULL, contract_films=0, contract_fee=0, contract_until=0 WHERE id=?""", (aid,))
    _row(w, aid)
    w.db.execute("UPDATE legacy SET died_year=?, died_age=?, cause=? WHERE actor_id=?",
                 (w.year, a["age"], cause, aid))
    # anyone cast in a picture that has not been released needs replacing
    gone = [dict(r) for r in w.db.q("""SELECT r.id, p.id pid, p.title FROM roles r
                                       JOIN productions p ON p.id=r.production_id
                                       WHERE r.actor_id=? AND p.status NOT IN ('released','cancelled')""",
                                    (aid,))]
    for g in gone:
        w.db.execute("UPDATE roles SET actor_id=NULL, fee=0 WHERE id=?", (g["id"],))
    young = a["age"] < SHORT_LIFE_AGE
    notable = (a["fame"] >= NEWS_FAME or a["studio"] == "player" or gone or on_set_title
               or (young and a["fame"] >= 25))
    if not notable:
        return
    films = a["films"] or 0
    who = "a star" if a["fame"] >= 62 else "a familiar face" if a["fame"] >= 40 else "a young actor"
    line = f"{a['name']}, {who}, {cause}, aged {a['age']}."
    if on_set_title:
        line = f"{a['name']} {cause} while filming {on_set_title}, aged {a['age']}."
    extra = [f"{films} picture{'s' if films != 1 else ''}"]
    if a["awards"]:
        extra.append(f"{a['awards']} award{'s' if a['awards'] != 1 else ''}")
    if a["studio"] == "player":
        extra.append("under contract to your studio")
    if gone:
        extra.append("the role in " + ", ".join(sorted({g["title"] for g in gone})) + " must be recast")
    head = (f"Tragedy: {a['name']} dies at {a['age']}" if young or kind in ("accident", "misadventure")
            else f"{a['name']} dies at {a['age']}")
    tail = "; ".join(extra)
    universe.log(w.year, w.week, "talent", head, line + " " + tail[:1].upper() + tail[1:] + ".",
                 weight=3 if (a["fame"] >= 62 or a["studio"] == "player" or on_set_title) else 2)


# --------------------------------------------------------------------------- #
#  The Hall of Fame
# --------------------------------------------------------------------------- #
def _bar_for(w, a, lg):
    """(bar, min_films, career score, note) for one candidate."""
    score = 0.6 * lg["peak"] + 0.4 * lg["rating"]
    died_young = lg["died_age"] is not None and lg["died_age"] < SHORT_LIFE_AGE
    if not died_young:
        return HOF_BAR, HOF_MIN_FILMS, score, None
    # a life cut short: judged on the peak, with a lower bar - but only if
    # they left something behind that nobody forgot
    yr = lg["died_year"] or w.year
    signature = ((a["awards"] or 0) >= 1 or (a["noms"] or 0) >= 3
                 or (a["best_gross"] or 0) >= C.standard_cost(yr) * 10)
    if not signature:
        return HOF_BAR, HOF_MIN_FILMS, score, None
    soften = min(SHORT_LIFE_MAX_SOFTEN, (SHORT_LIFE_AGE - lg["died_age"]) * SHORT_LIFE_SOFTEN)
    return HOF_BAR - soften, SHORT_LIFE_MIN_FILMS, lg["peak"], f"gone at {lg['died_age']}"


def inductions(w, yr):
    """The Academy's Hall of Fame class for this ceremony."""
    rows = [dict(r) for r in w.db.q(f"""
        SELECT a.*, l.rating, l.peak, l.died_age, l.died_year, l.cause
        FROM legacy l JOIN actors a ON a.id=l.actor_id
        WHERE l.hof_year IS NULL AND l.peak >= ?
          AND (a.status IN ('retired','dead') OR a.age >= 62)""", (HOF_BAR - SHORT_LIFE_MAX_SOFTEN,))]
    cands = []
    for a in rows:
        bar, min_films, score, note = _bar_for(w, a, a)
        if (a["films"] or 0) >= min_films and score >= bar:
            cands.append((score - bar, a, score, note))
    cands.sort(key=lambda t: -t[0])
    out = []
    for margin, a, score, note in cands[:HOF_PER_YEAR]:
        ours = w.db.scalar("SELECT COUNT(*) FROM cast_members WHERE actor_id=?", (a["id"],), 0) or 0
        bits = [f"{a['films']} pictures"]
        if a["awards"]:
            bits.append(f"{a['awards']} award{'s' if a['awards'] != 1 else ''}")
        if note:
            bits.append(note + (f" ({a['cause']})" if a["cause"] else ""))
        text = ", ".join(bits)
        w.db.execute("UPDATE legacy SET hof_year=?, hof_note=? WHERE actor_id=?", (yr, text, a["id"]))
        w.db.execute("UPDATE actors SET fame=MIN(100, fame+6) WHERE id=?", (a["id"],))
        if ours >= 3:
            w.add_prestige(2.0)
            text += f"; {ours} pictures for your studio"
        out.append(dict(id=a["id"], name=a["name"], text=text, ours=ours,
                        status=a["status"], cut_short=bool(note)))
        universe.log(yr, 40, "award", f"Hall of Fame: {a['name']}",
                     f"The Silver Screen Academy inducts {a['name']} - {text}.", weight=3 if ours >= 3 else 2)
    return out


def hall(w):
    rows = [dict(r) for r in w.db.q("""SELECT a.id, a.name, a.gender, a.status, a.age, a.films, a.awards,
                                              a.noms, a.debut_year, l.hof_year, l.hof_note, l.died_year,
                                              l.died_age, l.cause
                                       FROM legacy l JOIN actors a ON a.id=l.actor_id
                                       WHERE l.hof_year IS NOT NULL ORDER BY l.hof_year DESC, a.name""")]
    for r in rows:
        r["ours"] = w.db.scalar("SELECT COUNT(*) FROM cast_members WHERE actor_id=?", (r["id"],), 0) or 0
    return rows


def actor_info(w, aid):
    """What the dashboard may show about a legacy (the rating itself stays hidden)."""
    r = w.db.q1("SELECT * FROM legacy WHERE actor_id=?", (aid,))
    if not r:
        return {}
    r = dict(r)
    peak = r["peak"]
    standing = ("a legend in the making" if peak >= HOF_BAR - 40 else "a career people will remember"
                if peak >= 1180 else "a working career" if peak >= 1030 else None)
    return dict(hof_year=r["hof_year"], hof_note=r["hof_note"], died_year=r["died_year"],
                died_age=r["died_age"], cause=r["cause"], standing=standing)
