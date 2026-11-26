"""Awards season: four award bodies, one ceremony every January.

Every picture released last year - yours and the rivals' - is scored by the
same rules. There is no house advantage: you win because the picture was
good (or loud, or beautiful, or campaigned for) in the way that particular
body cares about. Each body has its own taste (see C.AWARD_BODIES):

  Silver Screen Academy   quality + reviews, likes drama, moved by campaigns
  Circle of Film Critics  the critics' score, ignores money, punishes bloat
  Craft Guilds Gala       production values, spend, spectacle genres
  People's Choice         audience score, box office, star power

The full ceremony (nominees, winners, who was ours) is stored so the dashboard
can stage it as a popup and replay it later from the Awards tab.
"""
from __future__ import annotations

import math

from .. import config as C
from .. import universe
from ..rng import clamp, gauss, stream, unit
from . import actors as A
from . import events as E

ACTING = ("actor", "actress", "people:star")


# --------------------------------------------------------------------------- #
#  The field
# --------------------------------------------------------------------------- #
def _log_scale(x: float) -> float:
    """0..100 from a multiple of the year's standard picture cost:
    1x -> 19, 3x -> 39, 10x -> 67, 25x -> 91."""
    return clamp(28.0 * math.log1p(max(0.0, x)), 0, 100)


def _leads(w, movie_id):
    """The top-billed man and woman of one of our pictures."""
    out = {}
    for r in w.db.q("""SELECT a.id, a.name, a.gender, a.craft, a.star_power FROM cast_members cm
                       JOIN actors a ON a.id=cm.actor_id WHERE cm.movie_id=?
                       ORDER BY CASE cm.kind WHEN 'lead' THEN 0 WHEN 'voice' THEN 1 ELSE 2 END, cm.fee DESC""",
                    (movie_id,)):
        g = "m" if r["gender"] == "m" else "f"
        out.setdefault(g, dict(r))
    return out


def _rival_leads(w, studio, rid, yr, freelance):
    """Rival pictures do not keep a cast list. Their contract faces stand in,
    or a freelance star they hired for the picture - whoever fits the
    studio's standing, a different pair for each picture."""
    out = {}
    rows = [dict(r) for r in w.db.q("""SELECT id, name, gender, craft, star_power FROM actors
                                       WHERE studio=? AND status NOT IN ('dead','retired')
                                       ORDER BY star_power DESC LIMIT 6""", (studio,))]
    for g in ("m", "f"):
        pool = [r for r in rows + freelance if (r["gender"] == "m") == (g == "m")]
        if pool:
            out[g] = pool[int(unit(w.seed, "rlead", rid, yr, g) * len(pool))]
    return out


def _with_named(leads, named):
    """The billed lead of a rival picture takes their gender's slot."""
    if named:
        leads = dict(leads)
        leads["m" if named["gender"] == "m" else "f"] = dict(named)
    return leads


def field(w, yr, campaign_spend=0.0):
    """Every eligible picture of the year with the numbers the juries read."""
    std = C.standard_cost(yr)
    camp_mult = E.fx(w, "campaign_mult")
    entries = []
    for m in w.db.q("SELECT * FROM movies WHERE year=? AND rights='player'", (yr,)):
        m = dict(m)
        leads = _leads(w, m["id"])
        tech = w.db.kv_get(f"tech:{m['id']}", None)
        if tech is None:                 # released before tech scores were kept
            tech = clamp(m["quality"] * 0.6 + {"indie": 0, "standard": 8, "epic": 18,
                                                "blockbuster": 26}.get(m["scale"], 8), 0, 100)
        star = max([l["star_power"] or 0 for l in leads.values()] or [0])
        entries.append(dict(
            kind="player", studio=w.name, id=m["id"], title=m["title"], genre=m["genre"],
            director=m["director_name"], franchise_id=m["franchise_id"],
            quality=m["quality"], critics=m["critics"], audience=m["audience"], tech=float(tech),
            spend=_log_scale((m["budget"] + m["marketing"]) / max(1.0, std)),
            flash=_log_scale(m["gross"] / max(1.0, std)), star=star, leads=leads,
            prestige=w.prestige,
            # For Your Consideration: worth up to ~9 points at 10% of a standard picture
            campaign=min(9.0, campaign_spend / max(1.0, std) * 90.0) * camp_mult))
    rivals = {r["name"]: dict(r) for r in w.db.q("SELECT * FROM rivals")}
    freelance = [dict(r) for r in w.db.q("""SELECT id, name, gender, craft, star_power FROM actors
                                            WHERE studio IS NULL AND status IN ('available','working','star')
                                            AND age BETWEEN 18 AND 70
                                            ORDER BY star_power DESC LIMIT 24""")]
    for r in w.db.q("SELECT * FROM rival_releases WHERE year=?", (yr,)):
        r = dict(r)
        named = None
        if r.get("lead_id"):
            named = w.db.q1("SELECT id, name, gender, craft, star_power FROM actors WHERE id=?",
                            (r["lead_id"],))
        q, sp = r["quality"], r["star_power"]
        rv = rivals.get(r["studio"], {})
        # rivals only store quality: reviews and audiences are read off it the
        # same way the box office reads yours, with the same kind of noise
        critics = clamp(q * 0.70 + 14 + gauss(w.seed, 0, 6.5, "awcr", r["id"])
                        - (10 if r["genre"] in ("horror", "comedy") else 0)
                        + (6 if r["genre"] == "drama" else 0), 1, 99)
        audience = clamp(q * 0.48 + sp * 0.26 + 18 + gauss(w.seed, 0, 6.0, "awau", r["id"]), 1, 99)
        gross_x = r["gross"] / max(1.0, std)
        # on the same scale as your production values (upgrade tiers + stages)
        tech = clamp(8 + q * 0.30 + 5 * math.log1p(gross_x) + gauss(w.seed, 0, 5, "awte", r["id"]), 0, 65)
        # their directors are about as good as their standing
        critics = clamp(critics + 0.12 * (45 + (rv.get("prestige", 0) or 0) * 0.4), 1, 99)
        entries.append(dict(
            kind="rival", studio=r["studio"], id=None, rid=r["id"], title=r["title"], genre=r["genre"],
            director=None, franchise_id=None, quality=q, critics=critics, audience=audience,
            tech=tech, spend=_log_scale(gross_x * 0.45), flash=_log_scale(gross_x), star=sp,
            leads=_with_named(_rival_leads(w, r["studio"], r["id"], yr, freelance), named),
            prestige=rv.get("prestige", 0) or 0,
            # rivals campaign too: the bigger the studio's standing, the louder
            campaign=min(6.0, (rv.get("prestige", 0) or 0) * 0.12) * camp_mult))
    return entries


_WINS_CACHE = {}


def _recent_wins(w, aid, body, label, yr):
    key = (id(w), yr, body["id"], label)
    if key not in _WINS_CACHE:
        _WINS_CACHE.clear() if len(_WINS_CACHE) > 64 else None
        full = label if body["id"] == "academy" else f"{body['short']}: {label}"
        _WINS_CACHE[key] = {r["actor_id"]: r["n"] for r in w.db.q(
            """SELECT actor_id, COUNT(*) n FROM awards WHERE won=1 AND label=? AND year>=?
               AND actor_id IS NOT NULL GROUP BY actor_id""", (full, yr - 8))}
    return _WINS_CACHE[key].get(aid, 0)


def body_score(w, body, e, yr, cat):
    wt = body["weights"]
    s = sum(wt.get(k, 0.0) * e[k] for k in ("quality", "critics", "audience", "tech", "spend",
                                             "flash", "star"))
    s += body["genre"].get(e["genre"], 0)
    s += e["campaign"] * body["campaign"]
    s += min(4.0, e["prestige"] * 0.05) * (1.0 if body["id"] == "academy" else 0.4)
    key = e.get("id") or -(e.get("rid") or 0)
    return s + gauss(w.seed, 0, 3.2, "aw", body["id"], cat, key, yr)


# --------------------------------------------------------------------------- #
#  The ceremony
# --------------------------------------------------------------------------- #
def ceremony(w, campaign_spend=0.0):
    yr = w.year - 1
    if yr < w.start_year:
        return None
    if w.db.scalar("SELECT COUNT(*) FROM awards WHERE year=?", (yr,), 0):
        return None
    entries = field(w, yr, campaign_spend)
    if not entries:
        return None
    rnd = stream(w.seed, "awards", yr)
    show = dict(year=yr, studio=w.name, bodies=[], ours=[], noms=0, razzies=[])
    winners = []
    prestige_gain = 0.0

    def book(cat, label, e, actor, won):
        db_cat = "actor" if cat == "actress" else cat
        w.db.execute("""INSERT INTO awards(year,category,label,movie_id,movie_title,actor_id,
                        actor_name,studio,won,franchise_id) VALUES(?,?,?,?,?,?,?,?,?,?)""",
                     (yr, db_cat, label, e.get("id"), e["title"], actor["id"] if actor else None,
                      actor["name"] if actor else None, e["studio"], 1 if won else 0, e.get("franchise_id")))
        if e["kind"] != "player":
            # every performer in town keeps a trophy shelf
            if actor and actor.get("id"):
                w.db.execute("UPDATE actors SET noms=noms+1, awards=awards+? WHERE id=?",
                             (1 if won else 0, actor["id"]))
                if won:
                    A.bump_fame(w, actor["id"], rnd.uniform(5, 11) * body_prestige[0])
            return
        show["noms"] += 1
        if e.get("id"):
            w.db.execute("UPDATE movies SET noms=noms+1, wins=wins+? WHERE id=?", (1 if won else 0, e["id"]))
        if actor and actor.get("id"):
            w.db.execute("UPDATE actors SET noms=noms+1, awards=awards+? WHERE id=?",
                         (1 if won else 0, actor["id"]))

    body_prestige = [1.0]
    for body in C.AWARD_BODIES:
        body_prestige[0] = body["prestige"]
        bshow = dict(id=body["id"], name=body["name"], short=body["short"], blurb=body["blurb"],
                     categories=[])
        for cat, label in body["categories"]:
            pool = []
            for e in entries:
                base = body_score(w, body, e, yr, cat)
                if cat in ACTING:
                    genders = ("m",) if cat == "actor" else ("f",) if cat == "actress" else ("m", "f")
                    for g in genders:
                        a = e["leads"].get(g)
                        if not a:
                            continue
                        perf = (base * 0.62 + (a["craft"] or 0) * 0.24 + (a["star_power"] or 0) * 0.14
                                if cat != "people:star" else base * 0.5 + (a["star_power"] or 0) * 0.5)
                        # juries like to spread the statuettes around: each recent win
                        # in this race counts against a repeat
                        perf -= 3.0 * _recent_wins(w, a["id"], body, label, yr)
                        pool.append((perf + gauss(w.seed, 0, 2.0, "awa", cat, a["id"], yr), e, a))
                elif cat == "screenplay":
                    pool.append((base * 0.6 + e["quality"] * 0.25 + e["critics"] * 0.15, e, None))
                elif cat in ("craft", "guild:visuals", "guild:design"):
                    tilt = (0.65 if cat == "guild:visuals" else 0.5)
                    pool.append((base * (1 - tilt) + e["tech"] * tilt
                                 + (e["spend"] * 0.08 if cat == "guild:visuals" else e["quality"] * 0.08), e, None))
                elif cat in ("director", "critics:director"):
                    pool.append((base + e["quality"] * 0.06, e, None))
                else:
                    pool.append((base, e, None))
            if not pool:
                continue
            # one performer is only nominated once per category
            pool.sort(key=lambda t: -t[0])
            noms, seen = [], set()
            for sc, e, a in pool:
                k = ("a", a["id"]) if a else ("m", e["title"], e["studio"])
                if k in seen:
                    continue
                seen.add(k)
                noms.append((sc, e, a))
                if len(noms) >= 5:
                    break
            cshow = dict(category=cat, label=label, nominees=[])
            if cat in ACTING:
                # the race itself moves careers: the winner takes points off the field
                from . import legacy
                legacy.award_race(w, noms[0][2]["id"], [a["id"] for _, _, a in noms[1:]],
                                  {"academy": 40, "critics": 24, "guild": 16, "people": 14}[body["id"]])
            for i, (sc, e, a) in enumerate(noms):
                won = i == 0
                book(cat, f"{label}" if body["id"] == "academy" else f"{body['short']}: {label}", e, a, won)
                person = a["name"] if a else (e["director"] if "director" in cat else None)
                cshow["nominees"].append(dict(title=e["title"], studio=e["studio"], person=person,
                                              mine=e["kind"] == "player", won=won, genre=e["genre"]))
                if won and e["kind"] == "player":
                    full = label if body["id"] == "academy" else f"{body['short']}: {label}"
                    winners.append(full)
                    show["ours"].append(dict(body=body["short"], label=label, title=e["title"],
                                             person=person))
                    prestige_gain += C.AWARD_PRESTIGE.get(cat, 2) * (1.0 if body["id"] == "academy"
                                                                       else 1.0)
                    if a and a.get("id"):
                        A.bump_fame(w, a["id"], rnd.uniform(6, 13) * body["prestige"])
                    if body["id"] == "people":
                        w.add_reputation(2.0)
            bshow["categories"].append(cshow)
        show["bodies"].append(bshow)
    if prestige_gain:
        w.add_prestige(prestige_gain)

    _razzies(w, yr, entries, show)
    from . import legacy
    show["hof"] = legacy.inductions(w, yr)
    from . import press
    press.awards_news(w, yr)
    for h in show["hof"]:
        press.add(w, "awards", f"Hall of Fame: {h['name']}",
                  f"The Silver Screen Academy inducts {h['name']} - {h['text']}.",
                  actor_id=h["id"], weight=3 if h["cut_short"] or h["ours"] >= 3 else 2,
                  mine=h["ours"] >= 3)
    w.stats["awards"] = w.stats.get("awards", 0) + len(winners)
    if winners:
        universe.log(yr, 40, "award", f"Awards of {yr}", "Ours: " + ", ".join(winners) + ".", weight=3)
    elif show["noms"]:
        universe.log(yr, 40, "award", f"Awards of {yr}",
                     f"{show['noms']} nomination(s), no wins. The speech stays in the pocket.", weight=2)
    w.db.kv_set(f"ceremony:{yr}", show)
    w.db.kv_set("ceremony_pending", yr)
    return dict(year=yr, won=winners, noms=show["noms"])


def _razzies(w, yr, entries, show):
    """The worst picture of the year - if it was ours - by quality AND reviews."""
    worst = min(entries, key=lambda e: e["quality"] * 0.5 + e["critics"] * 0.5)
    if worst["kind"] == "player" and worst["quality"] * 0.5 + worst["critics"] * 0.5 < 34:
        w.db.execute("""INSERT INTO awards(year,category,label,movie_id,movie_title,actor_id,
                        actor_name,studio,won,franchise_id) VALUES(?,?,?,?,?,NULL,NULL,?,1,?)""",
                     (yr, "razzie_picture", "Golden Raspberry Worst Picture", worst["id"], worst["title"],
                      w.name, worst.get("franchise_id")))
        w.db.execute("UPDATE movies SET razzies=razzies+1, cult=MIN(100,cult+12) WHERE id=?", (worst["id"],))
        w.add_prestige(-2)
        show["razzies"].append(dict(label="Worst Picture", title=worst["title"], person=None))
        universe.log(yr, 40, "award", "Golden Raspberry: worst picture",
                     f"{worst['title']} takes the Razzie. It will be reassessed by people in "
                     f"T-shirts twenty years from now.", weight=2)
    bad = [e for e in entries if e["kind"] == "player" and e["leads"] and e["quality"] < 34]
    if bad:
        e = min(bad, key=lambda x: x["quality"])
        lead = e["leads"].get("m") or e["leads"].get("f")
        w.db.execute("""INSERT INTO awards(year,category,label,movie_id,movie_title,actor_id,
                        actor_name,studio,won,franchise_id) VALUES(?,?,?,?,?,?,?,?,1,?)""",
                     (yr, "razzie_actor", "Golden Raspberry Worst Performance", e["id"], e["title"],
                      lead["id"], lead["name"], w.name, e.get("franchise_id")))
        A.bump_fame(w, lead["id"], -3.0, cult=4.0)
        show["razzies"].append(dict(label="Worst Performance", title=e["title"], person=lead["name"]))


# --------------------------------------------------------------------------- #
#  Dashboard
# --------------------------------------------------------------------------- #
def pending(w):
    yr = w.db.kv_get("ceremony_pending", None)
    return w.db.kv_get(f"ceremony:{yr}", None) if yr else None


def seen(w):
    w.db.kv_set("ceremony_pending", None)
    return dict(ok=True)


def get(w, year):
    show = w.db.kv_get(f"ceremony:{year}", None)
    if not show:
        return dict(ok=False, error="no ceremony on record for that year")
    return dict(ok=True, ceremony=show)


def years(w):
    return [r["year"] for r in w.db.q("SELECT DISTINCT year FROM awards ORDER BY year DESC")
            if w.db.kv_get(f"ceremony:{r['year']}", None)]
