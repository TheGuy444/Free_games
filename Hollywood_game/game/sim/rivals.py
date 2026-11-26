"""Rival studios.

They are deliberately shallow (cash, prestige, aggression) but they keep the
world honest: they compete for genre heat and talent, they win awards, they buy
your rights, they farm the franchises you sold them - and sometimes they go
bust and their library goes up for auction.
"""
from __future__ import annotations

from .. import config as C
from .. import names as N
from .. import universe
from ..rng import clamp, gauss, stream


def alive(w):
    return [dict(r) for r in w.db.q("SELECT * FROM rivals WHERE alive=1 ORDER BY cash DESC")]


def monthly(w):
    """Rivals put pictures out; some of them are sequels to what you sold them,
    some are sequels to their own hits."""
    rnd = stream(w.seed, "rivals", w.year, w.week)
    trends = w.trends()
    for r in alive(w):
        rival = dict(r)
        # a studio with money in the bank keeps a busier slate
        std = C.standard_cost(w.year)
        busy = 0.16 + 0.06 * clamp(rival["cash"] / max(1.0, std * 25), 0, 1)
        if rnd.random() > busy:
            continue
        # do they have a franchise of their own to farm?
        owned = [dict(x) for x in w.db.q("SELECT * FROM franchises WHERE rights=?",
                                         (rival["name"],))]
        owned.sort(key=lambda f: -(f["last_year"] or f["created_year"]))
        gap = w.year - (owned[0]["last_year"] or owned[0]["created_year"]) if owned else 99
        own = _ready_series(w, rival)
        team = _maybe_teamup(w, rival, rnd)
        if team:
            own = team
        if owned and rnd.random() < 0.55 and gap >= 2:
            f = owned[0]
            make_film(w, rival, rnd, genre=f["genre"], franchise=f, trend=trends.get(f["genre"], 1.0))
            w.db.execute("UPDATE franchises SET installments=installments+1, last_year=? WHERE id=?",
                         (w.year, f["id"]))
        elif own and (own is team or rnd.random() < C.interp(C.SERIES_APPETITE, w.year)):
            make_film(w, rival, rnd, genre=own["genre"], series=own,
                      trend=trends.get(own["genre"], 1.0))
        else:
            genre = _pick_genre(w, rnd, trends)
            make_film(w, rival, rnd, genre=genre, franchise=None, trend=trends.get(genre, 1.0))


# --------------------------------------------------------------------------- #
#  Rival home-grown series (kept off your franchise desk: they are not for sale)
# --------------------------------------------------------------------------- #
def _series(w, rival) -> list:
    return list(w.db.kv_get(f"rival_series:{rival['id']}", None) or [])


def _ready_series(w, rival):
    """Their best live series that is due another picture, if any. There is
    no cap on length: a series runs as long as the audience keeps coming."""
    ok = [s for s in _series(w, rival) if w.year - s["last_year"] >= 2 and s["fan"] >= 25]
    # an announced spin-off or team-up gets made before the old warhorses
    return max(ok, key=lambda s: s["fan"] + (60 if s["n"] == 0 else 0)) if ok else None


def _update_series(w, rival, name, genre, quality, run, series=None):
    """A hit becomes a series; every sequel feeds or bleeds the audience.

    Fans come back for quality, but each installment asks a little more of
    them (fatigue grows with the count), and sequels rushed out too close
    together wear them out faster. When the audience drifts away the series
    is shelved - and a famous one may be rebooted a generation later."""
    rows = _series(w, rival)
    dead = list(w.db.kv_get(f"rival_series_dead:{rival['id']}", None) or [])
    if series:
        for s in rows:
            if s["name"] == series["name"]:
                gap = w.year - s["last_year"]
                fatigue = (1.6 * s["n"] + (6 if gap < 3 else 0)) * (0.6 if s.get("icon") else 1.0)
                grow = (0.72 + 0.20 * min(2.5, run)) if run < 1 else 1 + (0.20 * min(2.5, run) - 0.28) * (1 - s["fan"] / 320)
                s["fan"] = clamp(s["fan"] * grow + (quality - 58) * 0.45 - fatigue, 0, 260)
                s["n"] += 1
                s["total"] = s.get("total", s["n"] - 1) + 1
                s["peak"] = max(s.get("peak", 0), s["fan"])
                s["last_year"] = w.year
                if s.get("kind") == "universe":
                    _feed_members(rows, s, quality, run)
                elif not s.get("icon") and s["total"] >= 10 and w.year - s.get("born", w.year) >= 25 \
                        and s["fan"] >= 60:
                    # a long run through several faces: the Bond road
                    s["icon"] = True
                    universe.log(w.year, w.week, "world", f"{s['name']} is an icon",
                                 f"{s['total']} pictures over {w.year - s['born']} years at {rival['name']}. "
                                 "Bigger than whoever plays the part.", weight=2)
                spun = _maybe_spinoff(w, rival, s, quality, run)
                if spun:
                    rows.append(spun)
    elif run >= 2.2 and quality >= 55:
        fan = clamp(10 + 40 * (min(4.0, run) - 1.0) + (quality - 55) * 0.5, 15, 200)
        rows.append(dict(name=name, genre=genre, n=1, total=1, last_year=w.year, born=w.year,
                         fan=fan, peak=fan, reboots=0, kind="series"))
    # series whose audience has gone (or nobody has made one in 14 years) are shelved
    keep = []
    for s in rows:
        if w.year - s["last_year"] < 14 and s["fan"] > 12:
            keep.append(s)
        else:
            s["died"] = w.year
            dead.append(s)
    w.db.kv_set(f"rival_series:{rival['id']}", keep[-10:])
    w.db.kv_set(f"rival_series_dead:{rival['id']}", dead[-12:])


def _maybe_reboot(w, rival, rnd):
    """A shelved series with a big enough past comes back: new cast, new
    continuity, the same name on the poster."""
    dead = list(w.db.kv_get(f"rival_series_dead:{rival['id']}", None) or [])
    for s in sorted(dead, key=lambda x: -x.get("peak", 0)):
        icon = bool(s.get("icon"))
        if s.get("kind") == "universe":
            continue
        if w.year - s["last_year"] < (8 if icon else 12) or s.get("peak", 0) < (60 if icon else 90):
            continue
        p = 0.05 * (s["peak"] / 200.0) * C.interp(C.SERIES_APPETITE, w.year) / 0.4 * (2.0 if icon else 1.0)
        if rnd.random() < p:
            dead.remove(s)
            if s.get("reboots", 0) >= 1 and not icon:
                # back for a third life: bigger than any one version now
                s["icon"] = True
                universe.log(w.year, 0, "world", f"{s['name']} is an icon",
                             f"{rival['name']} brings it back again. Audiences no longer care who "
                             "plays the part - only that someone does.", weight=2)
            s.update(n=0, fan=s["peak"] * (0.65 if s.get("icon") else 0.45),
                     reboots=s.get("reboots", 0) + 1, last_year=w.year - 2, rebooted=w.year)
            rows = _series(w, rival)
            rows.append(s)
            w.db.kv_set(f"rival_series:{rival['id']}", rows[-10:])
            w.db.kv_set(f"rival_series_dead:{rival['id']}", dead)
            universe.log(w.year, 0, "world", f"{rival['name']} reboots {s['name']}",
                         f"{s.get('total', 0)} pictures and {w.year - s.get('born', w.year)} years after it "
                         "began, the series is back with a new cast.", weight=2)
            return s
    return None


def _maybe_spinoff(w, rival, s, quality, run):
    """A big sequel whose supporting character stole it: that character gets
    a series of their own."""
    if s.get("kind") == "universe" or run < 2.2 or quality < 68:
        return None
    rnd = stream(w.seed, "rspin", rival["id"], s["name"], w.year, w.week)
    if rnd.random() > 0.10 * C.interp(C.SERIES_APPETITE, w.year) / 0.4:
        return None
    from . import characters as CH
    taken = {x["name"] for x in _series(w, rival)}
    nm = CH.name_for(rnd, s["genre"], rnd.choice(["m", "f"]), taken)
    fan = clamp(s["fan"] * 0.45, 20, 180)
    universe.log(w.year, w.week, "world", f"{rival['name']} spins off {nm}",
                 f"The breakout of the latest {s['name']} picture gets a series of their own.", weight=2)
    return dict(name=nm, genre=s["genre"], n=0, total=0, last_year=w.year - 2, born=w.year,
                fan=fan, peak=fan, reboots=0, kind="spinoff", parent=s["name"])


def _maybe_teamup(w, rival, rnd):
    """Several of a studio's own series in one picture: rare before the
    blockbuster age, a habit after 2000."""
    if w.year < 1975:
        return None
    rows = _series(w, rival)
    if any(x.get("kind") == "universe" for x in rows):
        return None
    big = sorted([x for x in rows if x.get("kind") != "universe" and x["fan"] >= 60],
                 key=lambda x: -x["fan"])[:4]
    if len(big) < 2:
        return None
    p = (0.02 if w.year < 2000 else 0.08) * C.interp(C.SERIES_APPETITE, w.year) / 0.5
    if rnd.random() > p:
        return None
    from . import characters as CH
    vals = sorted((x["fan"] for x in big), reverse=True)
    fan = min(420.0, sum(v * wt for v, wt in zip(vals, [1.0, 0.6, 0.4, 0.3])))
    nm = f"The {rnd.choice(CH.CODE_A)} {rnd.choice(CH.TEAM_WORD)}"
    t = dict(name=nm, genre=big[0]["genre"], n=0, total=0, last_year=w.year - 2, born=w.year, fan=fan,
             peak=fan, reboots=0, kind="universe", members=[x["name"] for x in big])
    rows.append(t)
    w.db.kv_set(f"rival_series:{rival['id']}", rows[-10:])
    universe.log(w.year, w.week, "world", f"{rival['name']} announces {nm}",
                 "A team-up: " + ", ".join(x["name"] for x in big) + " in one picture.", weight=3)
    return t


def _feed_members(rows, team, quality, run):
    boost = clamp((run - 1.0) * 6.0 + (quality - 60) * 0.25, -20.0, 15.0)
    for x in rows:
        if x["name"] in (team.get("members") or []):
            gain = boost * max(0.0, 1.0 - x["fan"] / 320.0) if boost > 0 else boost
            x["fan"] = clamp(x["fan"] * (0.9 if run < 0.8 else 1.0) + gain, 0, 260)


def _roster_power(w, rival) -> float:
    """Star power of the best two faces the studio has under contract."""
    rows = w.db.q("""SELECT star_power FROM actors WHERE studio=? AND status NOT IN ('dead','retired')
                     ORDER BY star_power DESC LIMIT 2""", (rival["name"],))
    sps = [r["star_power"] or 0 for r in rows]
    return sum(sps) / len(sps) if sps else 0.0


def _pick_genre(w, rnd, trends):
    genres = list(trends.keys()) or C.GENRES
    weights = [max(0.05, trends.get(g, 1.0) ** 2) for g in genres]
    tot = sum(weights)
    x = rnd.random() * tot
    acc = 0.0
    for g, wt in zip(genres, weights):
        acc += wt
        if x <= acc:
            return g
    return genres[0]


def make_film(w, rival, rnd, genre="drama", franchise=None, trend=1.0, series=None):
    """One rival picture. A rival is a real studio now: it chases the hot
    genre, spends more when it is flush, puts its contract stars in front of
    the camera, and turns its own hits into series."""
    std = C.standard_cost(w.year)
    cash_std = rival["cash"] / max(1.0, std)
    fan = franchise["fan_base"] if franchise else (series["fan"] if series else 0.0)
    scale = "standard"
    r_scale = rnd.random()
    if (franchise or series) and fan > 120 and r_scale < 0.6:
        scale = "epic"
    elif cash_std > 15 and r_scale < 0.15 + 0.08 * (w.year > 1950):
        scale = "epic"
    elif cash_std < 3 and r_scale < 0.30:
        scale = "indie"
    if (franchise or series) and fan > 200 and rnd.random() < 0.35:
        scale = "blockbuster"
    elif w.year >= 1975 and cash_std > 40 and rnd.random() < 0.08:
        scale = "blockbuster"
    # star power: their contract roster, or a star they can afford to rent
    sp_base = clamp(gauss(w.seed, 22 + rival["prestige"] * 0.5, 14, "rrsp", rival["id"], w.year, w.week), 0, 98)
    sp = max(sp_base, _roster_power(w, rival) * 0.85)
    if cash_std > 8:
        sp = min(98.0, sp + 4.0)
    # quality: prestige buys better writers and directors; money buys polish;
    # the hot genre gets the studio's best people
    quality = gauss(w.seed, 49 + rival["prestige"] * 0.22, 12, "rrq", rival["id"], w.year, w.week)
    quality += 3.0 * clamp(cash_std / 20.0, 0, 1) + 4.0 * clamp(trend - 1.0, -0.5, 0.5)
    quality += {"indie": -3, "standard": 0, "epic": 2, "blockbuster": 3}[scale]
    quality = clamp(quality, 5, 96)
    if franchise or series:
        quality = clamp(quality + 4, 5, 96)
    legs = clamp(C.LEGS_MIN + (C.LEGS_MAX - C.LEGS_MIN) * (quality / 100.0) ** 1.3,
                 C.LEGS_MIN, C.LEGS_MAX)
    base = C.SCALES[scale]["mult"] * 1.25          # their all-in cost
    budget = std * base
    # word of mouth works for them too: a picture people love runs and runs
    dev = (quality - 62.0) / 38.0
    wom = clamp(1.0 + 0.30 * dev + 0.40 * dev ** 3 + rnd.gauss(0, 0.08), 0.60, 1.70)
    gross = (C.BASE_K * std * C.SCALES[scale]["reach"] * C.quality_mult(quality)
             * C.star_mult(sp * 1.6) * trend * 1.15 * wom
             * (C.fan_mult(fan) if (franchise or series) else 1.0)
             * legs / C.difficulty(w.year))
    gross *= E_att(w)
    if franchise:
        # a series bought from you still sells on its name: the audience it
        # had (your last pictures, in today's money) carries over, wearing
        # thinner with every picture they make of it
        from . import franchise as F
        tg, _cost = F.series_track_record(w, franchise)
        if tg > 0:
            theirs = w.db.scalar("SELECT COUNT(*) FROM rival_releases WHERE franchise=? AND studio=?",
                                 (franchise["name"], rival["name"]), 0) or 0
            anchor = (tg * C.quality_mult(quality) / max(0.05, C.quality_mult(62.0))
                      * 0.92 ** theirs)
            gross = max(gross, 0.65 * anchor)
    if series and series.get("kind") == "universe":
        gross *= 1.0 + min(0.25, 0.07 * max(0, len(series.get("members") or []) - 1))
    # their whole cost now comes out of the take (it used to be a third of
    # it, and they still went broke: the pictures were that bad)
    net = gross * C.STUDIO_SHARE - budget * 0.65
    if franchise:
        title = N.unique_sequel(franchise["name"], (franchise["installments"] or 0) + 1, rnd)
    elif series:
        title = (N.reboot_title(series["name"], rnd) if series["n"] == 0
                 else N.unique_sequel(series["name"], series["n"] + 1, rnd))
    else:
        title = N.movie_title(rnd, genre)
    # a script they bought from you? (the one that got away)
    bought = None
    if not franchise and not series:
        bought = w.db.q1("SELECT * FROM scripts WHERE owner=? AND status='owned' ORDER BY quality DESC LIMIT 1",
                         (rival["name"],))
        if bought and rnd.random() < 0.6:
            title, genre = bought["title"], bought["genre"]
            q0 = quality
            quality = clamp(bought["quality"] * 0.75 + quality * 0.25, 3, 97)
            gross *= C.quality_mult(quality) / max(0.05, C.quality_mult(q0))
            net = gross * C.STUDIO_SHARE - budget * 0.65
            w.db.execute("UPDATE scripts SET status='produced' WHERE id=?", (bought["id"],))
        else:
            bought = None
    N.take(title)
    lead = _pick_lead(w, rival, rnd)
    series_name = franchise["name"] if franchise else (series["name"] if series else None)
    cur = w.db.execute("""INSERT INTO rival_releases(studio,title,genre,subgenre,year,week,quality,gross,
                    star_power,franchise,lead_id,lead_name) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
                       (rival["name"], title, genre, None, w.year, w.week, round(quality, 1),
                        max(0.0, gross), round(sp, 1), series_name,
                        lead["id"] if lead else None, lead["name"] if lead else None))
    _credit_lead(w, lead, genre, quality, gross)
    if lead:
        # their leads build a legacy too (Hall of Fame)
        from . import legacy
        legacy.performance(w, lead["id"], quality, gross * C.STUDIO_SHARE / max(1.0, budget * 0.6),
                           gross, scale, True)
    from . import charts, press
    critics = clamp(quality * 0.85 + 10 + gauss(w.seed, 0, 6, "rrc", rival["id"], w.year, w.week), 1, 99)
    run = charts.open_run(w, "rival", title, rival["name"], genre, max(0.0, gross), legs,
                          lead_name=lead["name"] if lead else None, critics=int(critics))
    s10 = press._score10(critics)
    press.add(w, "release", f"{rival['name']} opens \u2018{title}\u2019",
              f"{C.GENRE_LABEL[genre]}" + (f" starring {lead['name']}" if lead else "")
              + (f", the latest {series_name} picture" if series_name else "")
              + f". The critics give it {s10:.0f}/10.",
              actor_id=lead["id"] if lead else None, run_id=run["id"] if run else None,
              weight=2 if series_name or quality > 75 else 1)
    w.db.execute("""UPDATE rivals SET cash=cash+?, films=films+1, gross=gross+?,
                    prestige=MIN(100, MAX(0, prestige + ?)) WHERE id=?""",
                 (net, gross, 1.8 if quality > 75 else 0.7 if quality > 60 else 0.2 if quality > 48 else -0.6,
                  rival["id"]))
    if not franchise:
        _update_series(w, rival, title, genre, quality, gross * C.STUDIO_SHARE / max(1.0, budget * 0.6),
                       series)
    from . import world
    world.count_supply(w, genre)
    if bought and w.db.kv_get(f"sold_script:{bought['id']}", None):
        sold = w.db.kv_get(f"sold_script:{bought['id']}")
        universe.log(w.year, w.week, "world",
                     f"{rival['name']} films {title} - the script you sold them",
                     f"You got ${sold['price']:,.0f} for it in {sold['year']}. It grossed ${gross:,.0f}."
                     + ("  Ouch." if gross > std * 6 else "  You sold it at the right time."
                        if gross < std * 1.5 else ""), weight=3 if gross > std * 6 else 2)
    elif gross > std * 12 and rnd.random() < 0.5:
        universe.log(w.year, w.week, "world", f"{rival['name']}: {title} — ${gross:,.0f}",
                     f"Quality {quality:.0f}. The town is already writing the sequel.", weight=2)


def _pick_lead(w, rival, _rnd=None):
    """Their own contract players first; failing that, a freelancer. Uses its
    own random stream so casting never changes what the rivals decide to make."""
    rnd = stream(w.seed, "rivallead", rival["id"], w.year, w.week)
    rows = w.db.q("""SELECT id,name,gender,fame FROM actors WHERE studio=?
                     AND status IN ('available','working','star') AND age BETWEEN 17 AND 72
                     ORDER BY fame DESC LIMIT 6""", (rival["name"],))
    if not rows or rnd.random() < 0.25:
        rows = w.db.q("""SELECT id,name,gender,fame FROM actors WHERE fame BETWEEN 25 AND 85
                         AND studio IS NULL AND status IN ('working','star') AND age BETWEEN 18 AND 66
                         ORDER BY fame DESC LIMIT 8 OFFSET ?""", (int(rnd.random() * 60),))
    if not rows:
        return None
    return dict(rnd.choice(rows))


def _credit_lead(w, lead, genre, quality, gross):
    if not lead:
        return
    w.db.execute("""UPDATE actors SET films=films+1, leads=leads+1, total_gross=total_gross+?,
                    best_gross=MAX(best_gross,?), last_work_year=?,
                    fame=MIN(100.0, MAX(0.0, fame + ?)) WHERE id=?""",
                 (gross * 0.12, gross, w.year, (quality - 50) * 0.04, lead["id"]))
    from . import typecast
    typecast.credit(w, lead["id"], genre, "lead", standout=quality >= 78)


def E_att(w):
    from . import events as E
    return E.fx(w, "attendance_mult")


def yearly(w):
    rnd = stream(w.seed, "rivalyear", w.year)
    std = C.standard_cost(w.year)
    for r in alive(w):
        # overhead follows how big the studio runs NOW (its last three years of
        # output), not every picture it ever made - lifetime counts bankrupted
        # every rival in town within a decade
        recent = w.db.scalar("SELECT COUNT(*) FROM rival_releases WHERE studio=? AND year>=?",
                             (r["name"], w.year - 3), 0) / 3.0
        drain = std * (0.55 + 0.22 * recent) * rnd.uniform(0.6, 1.4)
        # their back catalogue pays too (re-releases, then TV, then video)
        lib = w.db.scalar("SELECT COALESCE(SUM(gross),0) FROM rival_releases WHERE studio=? AND year>=?",
                          (r["name"], w.year - 8), 0)
        lib_rate = 0.015 if w.year < 1952 else 0.025 if w.year < 1978 else 0.035
        newcash = r["cash"] - drain + lib * lib_rate
        # acquisition loans: interest plus a slice of the principal, every year
        debt = r.get("debt") or 0.0
        if debt > 0:
            from .franchise import LOAN_RATE, LOAN_AMORTISE
            repay = debt * LOAN_AMORTISE if debt > std * 0.05 else debt
            newcash -= debt * LOAN_RATE + repay
            w.db.execute("UPDATE rivals SET debt=? WHERE id=?", (max(0.0, debt - repay), r["id"]))
        # a fat war chest goes back to the owners (or into real estate, or a
        # racehorse) - studios do not hoard cash forever
        if newcash > std * 40:
            newcash -= (newcash - std * 40) * 0.25
        if newcash < -std * 0.5 and rnd.random() < 0.35:
            # a studio in trouble is usually bought, not buried: by a rich
            # rival (the library and series go with it) or, in the
            # conglomerate decades, by a parent company that pays the bills
            if not _taken_over(w, r, rnd, std):
                bankrupt(w, r, rnd)
        else:
            w.db.execute("UPDATE rivals SET cash=? WHERE id=?", (newcash, r["id"]))
        # standing fades unless the pictures keep renewing it (as yours does)
        w.db.execute("UPDATE rivals SET prestige=prestige*0.95 WHERE id=?", (r["id"],))
        _maybe_reboot(w, r, rnd)
        if rnd.random() < 0.25:
            w.db.execute("UPDATE rivals SET aggression=?, appetite=? WHERE id=?",
                         (clamp(rnd.uniform(0.25, 0.95), 0, 1), clamp(rnd.uniform(0.25, 0.95), 0, 1),
                          r["id"]))
    # the odd newcomer studio arrives
    alive_n = w.db.scalar("SELECT COUNT(*) FROM rivals WHERE alive=1", (), 0)
    if alive_n < C.RIVAL_COUNT - 1:
        # the emptier the town, the faster someone opens a studio in it
        if rnd.random() < (0.25 if alive_n >= 4 else 0.6 if alive_n >= 2 else 1.0):
            name = studio_name_unused(w, rnd)
            w.db.execute("""INSERT INTO rivals(name,cash,prestige,aggression,appetite,alive,films,gross,ip)
                            VALUES(?,?,?,0.6,0.6,1,0,0,0)""",
                         (name, std * rnd.uniform(6, 20), rnd.uniform(0, 10)))
            universe.log(w.year, 0, "world", f"{name} opens its doors",
                         "Another studio on the coast. Another buyer, another rival.", weight=2)


CONGLOMERATES = ["a Gulf Coast oil company", "an insurance giant", "a parking-garage empire",
                 "a soft-drink company", "a Japanese electronics maker", "a cable-TV group",
                 "a funeral-home chain", "a hotel and casino group", "a telephone company"]


def _taken_over(w, r, rnd, std):
    """Mergers and rescues, Hollywood style. Returns True if the studio was saved
    (or swallowed) instead of going to the receivers."""
    buyers = [b for b in alive(w) if b["id"] != r["id"] and b["cash"] > std * 25]
    if buyers and rnd.random() < 0.45:
        b = max(buyers, key=lambda x: x["cash"])
        price = std * (2 + 0.02 * max(0.0, r["prestige"]) * 10)
        w.db.execute("UPDATE rivals SET cash=cash-?, prestige=MIN(100, prestige + ?), debt=debt+? WHERE id=?",
                     (price, r["prestige"] * 0.3, r.get("debt") or 0.0, b["id"]))
        w.db.execute("UPDATE rivals SET alive=0, cash=0, debt=0 WHERE id=?", (r["id"],))
        w.db.execute("UPDATE franchises SET rights=? WHERE rights=?", (b["name"], r["name"]))
        w.db.execute("UPDATE movies SET rights=? WHERE rights=?", (b["name"], r["name"]))
        w.db.execute("UPDATE actors SET studio=? WHERE studio=?", (b["name"], r["name"]))
        mine = list(w.db.kv_get(f"rival_series:{b['id']}", None) or [])
        theirs = list(w.db.kv_get(f"rival_series:{r['id']}", None) or [])
        w.db.kv_set(f"rival_series:{b['id']}", (mine + theirs)[-10:])
        w.db.kv_set(f"rival_series:{r['id']}", [])
        universe.log(w.year, 0, "world", f"{b['name']} swallows {r['name']}",
                     f"${price:,.0f} for a studio in trouble: its contracts, its library and "
                     f"{len(theirs)} live series.", weight=3)
        return True
    rescue = 0.35 if 1958 <= w.year <= 1992 else 0.15
    if rnd.random() < rescue:
        parent = rnd.choice(CONGLOMERATES)
        w.db.execute("UPDATE rivals SET cash=?, prestige=prestige*0.85, debt=0 WHERE id=?",
                     (std * rnd.uniform(6, 14), r["id"]))
        universe.log(w.year, 0, "world", f"{r['name']} sold to {parent}",
                     "The new owners pay the debts and promise not to interfere. They will interfere.",
                     weight=2)
        return True
    return False


def studio_name_unused(w, rnd):
    used = {r["name"] for r in w.db.q("SELECT name FROM rivals")}
    for n in C.RIVAL_NAMES:
        if n not in used:
            return n
    return N.studio_name(rnd)


def bankrupt(w, rival, rnd):
    w.db.execute("UPDATE rivals SET alive=0, cash=0, debt=0 WHERE id=?", (rival["id"],))
    frs = [dict(r) for r in w.db.q("SELECT * FROM franchises WHERE rights=?", (rival["name"],))]
    universe.log(w.year, 0, "world", f"{rival['name']} is liquidated",
                 f"{len(frs)} series and a library of titles go to the receivers. "
                 f"Prices are, let us say, sympathetic.", weight=3)
    for f in frs:
        from . import franchise as F
        # receivers sell cheap, but not for pocket change when the series is a hit
        ask = max(C.standard_cost(w.year) * 0.3, f["fan_base"] * C.standard_cost(w.year) * 0.02,
                  F.franchise_value(w, f) * 0.35)
        w.db.execute("""UPDATE franchises SET status='dormant', rights=?,
                        note='estate of '||? WHERE id=?""", (f"estate of {rival['name']}",
                                                             rival["name"], f["id"]))
        w.db.execute("""INSERT INTO offers(kind,asset_id,asset_label,buyer,price,terms,year,
                        expires_year,status,opportunity,hidden_buyer_interest)
                        VALUES('acquire_franchise',?,?,?,?,?,?,?,'open',?,1.0)""",
                     (f["id"], f["name"], f"estate of {rival['name']}", ask,
                      "buy outright from the receivers: series name, library and sequel rights",
                      w.year, w.year + 4, ask * 1.6)
        )
    # their catalogue too, as one lot
    lot = w.db.scalar("SELECT COUNT(*) FROM movies WHERE rights=?", (rival["name"],), 0)
    if lot:
        w.db.execute("""INSERT INTO offers(kind,asset_id,asset_label,buyer,price,terms,year,
                        expires_year,status,opportunity,hidden_buyer_interest)
                        VALUES('acquire_library',?,?,'estate of '||?,?,?,?,?,'open',?,1.0)""",
                     (0, f"{rival['name']} catalogue ({lot} titles)", rival["name"],
                      C.standard_cost(w.year) * 2.0, "the whole catalogue, as is", w.year, w.year + 4,
                      C.standard_cost(w.year) * 4.0))


def acquire(w, offer_id: int):
    """Buy IP off an estate (or a competitor) while it is cheap."""
    o = w.db.q1("SELECT * FROM offers WHERE id=? AND status='open'", (offer_id,))
    if not o:
        return dict(ok=False, error="offer is gone")
    if not w.can_afford(o["price"]):
        return dict(ok=False, error=f"needs ${o['price']:,.0f}")
    if o["kind"] == "acquire_franchise":
        f = w.db.q1("SELECT * FROM franchises WHERE id=?", (o["asset_id"],))
        if not f:
            return dict(ok=False, error="no such series")
        w.spend(o["price"], "ip_buy", f"Acquire {f['name']} from {o['buyer']}")
        w.db.execute("""UPDATE franchises SET rights='player', status='dormant',
                        note='acquired from '||? WHERE id=?""", (o["buyer"], f["id"]))
        w.db.execute("UPDATE movies SET rights='player' WHERE franchise_id=?", (f["id"],))
        w.db.execute("UPDATE offers SET status='accepted' WHERE id=?", (offer_id,))
        universe.log(w.year, w.week, "offer", f"{f['name']} acquired",
                     f"${o['price']:,.0f} to the receivers. Fan base {f['fan_base']:.0f}. "
                     f"Reboot when you are ready.", weight=3)
        return dict(ok=True, price=o["price"], franchise=f["name"])
    if o["kind"] == "acquire_library":
        seller = o["buyer"][len("estate of "):] if o["buyer"].startswith("estate of ") else o["buyer"]
        w.spend(o["price"], "ip_buy", o["asset_label"])
        # only the dead studio's own catalogue - not titles other rivals still hold
        w.db.execute("UPDATE movies SET rights='player' WHERE rights=?", (seller,))
        w.db.execute("UPDATE offers SET status='accepted' WHERE id=?", (offer_id,))
        universe.log(w.year, w.week, "offer", o["asset_label"] + " acquired",
                     f"${o['price']:,.0f} for the lot. A studio with a past, bought outright.",
                     weight=3)
        return dict(ok=True, price=o["price"])
    return dict(ok=False, error="not an acquisition")


def poaching(w):
    """Contract war: rivals occasionally buy a player actor out."""
    if w.db.scalar("""SELECT COUNT(*) FROM active_events WHERE def_id='talent_poach'
                      AND resolved=0""", (), 0) <= 0:
        return
    rnd = stream(w.seed, "poach", w.year, w.week)
    mine = [dict(r) for r in w.db.q("""SELECT id,name FROM actors WHERE studio='player'
                                       AND contract_films > 0 ORDER BY fame DESC LIMIT 12""")]
    if not mine:
        return
    odds = max(0.02, E_poach(w))
    for a in mine:
        if rnd.random() < odds:
            from . import actors as A
            rivals = [r["name"] for r in alive(w)]
            if rivals:
                A.poach(w, a["id"], rnd.choice(rivals))
            break


def E_poach(w):
    from . import events as E
    return E.fx(w, "sum:poach_chance")


def table(w):
    rows = [dict(r) for r in w.db.q("SELECT * FROM rivals ORDER BY alive DESC, cash DESC")]
    for r in rows:
        r["franchises"] = w.db.q1("""SELECT COUNT(*) c FROM franchises WHERE rights=?""",
                                   (r["name"],))["c"]
        r["titles"] = w.db.q1("""SELECT COUNT(*) c FROM movies WHERE rights=?""", (r["name"],))["c"]
        r["best_recent"] = w.db.scalar("""SELECT title FROM rival_releases WHERE studio=?
                                          ORDER BY gross DESC LIMIT 1""", (r["name"],), None)
    return rows
