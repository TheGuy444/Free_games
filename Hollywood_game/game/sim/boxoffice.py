"""Release, reception, box office, cult classics and the annual awards.

gross  = BASE_K * standard_cost(year) * scale_reach * quality_mult * star_mult
         * trend * marketing_mult * hype_mult * fanbase_mult * legs / difficulty
net    = gross * STUDIO_SHARE  (exhibitor cut + distribution fee already taken out)

Everything is nominal dollars, so a 1931 hit reads as $400k and a 2012 hit reads
as $400M - and both are measured against what their budget had to be.
"""
from __future__ import annotations

import json

from .. import config as C
from .. import names as N
from .. import universe
from ..rng import clamp, stream, unit
from . import actors as A
from . import charts
from . import events as E
from . import press
from . import typecast
from . import production as P
from . import world


# --------------------------------------------------------------------------- #
#  Release
# --------------------------------------------------------------------------- #
def release(w, pid: int, stream_dump: bool = False):
    p = P.get(w, pid)
    if not p:
        return dict(ok=False, error="no such production")
    if p["status"] == "released":
        return dict(ok=False, error="already released")
    if p["status"] not in ("ready", "post_production"):
        return dict(ok=False, error="the picture is not ready")
    comp = P.components(w, p)
    rnd = stream(w.seed, "release", pid, w.year, w.week)
    luck = rnd.gauss(0, 4.2)
    q = clamp(P.quality_from(w, p, comp) + luck, 1, 99)

    # --- who is carrying it
    cast = [r for r in comp["roles"] if r["actor_id"]]
    sps = sorted((r.get("star_power") or 0) for r in cast)
    peak = sps[-1] if sps else 0.0
    mean = sum(sps) / len(sps) if sps else 0.0
    draw = 0.45 * peak + 0.35 * mean
    critics = clamp(q * 0.70 + comp["direction"] * 0.12 + 14 + rnd.gauss(0, 6.5)
                    - (10 if p["genre"] in ("horror", "comedy") else 0)
                    + (6 if p["genre"] == "drama" else 0), 1, 99)
    audience = clamp(q * 0.48 + peak * 0.26 + p["hype"] * 0.26 + rnd.gauss(0, 6.0), 1, 99)
    from . import formats as FM
    from . import characters as CH
    fmt = FM.release_effects(w, p)
    critics = clamp(critics + fmt["critics"], 1, 99)

    heat = w.trend(p["genre"])
    std = C.standard_cost(w.year)
    scale = C.SCALES[p["scale"]]
    legs = clamp(C.LEGS_MIN + (C.LEGS_MAX - C.LEGS_MIN) * (audience / 100.0) ** 1.3,
                 C.LEGS_MIN, C.LEGS_MAX)
    fan = 1.0
    fatigue = 0.0
    franchise = None
    if p["franchise_id"]:
        franchise = w.db.q1("SELECT * FROM franchises WHERE id=?", (p["franchise_id"],))
        if franchise:
            fan = C.fan_mult(franchise["fan_base"] * clamp(franchise["heat"], 0.3, 1.7))
            if p["seq_index"] > 1:
                fat = _fatigue_penalty(w, franchise)
                fatigue = fat
                fan *= max(0.62, 1.0 - fat)
            # the audience drifts away from a long-running continuity: after
            # four pictures each new one draws a little less - unless it is
            # very good. A reboot starts the count over.
            from . import franchise as F
            in_run = w.db.scalar("SELECT COUNT(*) FROM movies WHERE franchise_id=? AND year>=?",
                                 (franchise["id"], F.era_start(w, franchise["id"])), 0) or 0
            drag = max(0, in_run - 4) * 0.035 * (0.5 if q >= 80 else 1.0)
            fan *= max(0.55, 1.0 - drag)
    reboot_bonus = 1.0
    is_reboot = False
    cast_back = None
    if franchise and p["seq_index"] > 1:
        srow = w.db.q1("SELECT origin FROM scripts WHERE id=?", (p["script_id"],))
        if srow and srow["origin"] in ("reboot", "remake"):
            is_reboot = True
            reboot_bonus = 1.12 + 0.10 * heat
            # a reboot too soon after the last picture reads as a cash grab
            prior = w.db.scalar("""SELECT MAX(year) FROM movies WHERE franchise_id=?""",
                                (franchise["id"],), None)
            if prior is not None and w.year - prior < 5:
                reboot_bonus *= 0.80 + 0.04 * (w.year - prior)
            backlash = E.fx(w, "reboot_penalty_mult")
            if backlash > 1.2:
                q = clamp(q - 5 * (backlash - 1.0), 1, 99)
        else:
            # sequels: fans came for the faces. Bring the leads back or pay for it.
            from . import franchise as F
            prev = F.returning_cast(w, franchise["id"])
            prev_leads = {k for k, v in prev.items() if v["lead"]}
            if prev_leads:
                now = {r["actor_id"] for r in comp["roles"] if r["actor_id"]}
                cast_back = len(prev_leads & now) / len(prev_leads)
                # an icon is bigger than whoever plays them: recasting costs little
                iconic = any(r.get("character_id") and CH.get(w, r["character_id"]) and
                             CH.get(w, r["character_id"])["icon"] for r in comp["roles"])
                fan *= (0.95 + 0.07 * cast_back) if iconic else (0.86 + 0.20 * cast_back)
    # the characters on the poster: their own fans (a reboot keeps them,
    # a team-up pools them)
    chx = CH.fan_effect(w, p, comp, franchise, is_reboot) if franchise else dict(mult=1.0)
    fan *= chx["mult"]

    # Word of mouth: the opening weekend is a coin toss, the second weekend is a
    # verdict. Most pictures land near 1.0; a picture an audience falls in love
    # with runs away from itself, and this is where blockbusters come from.
    dev = (audience - 62.0) / 38.0       # 0 = an audience that shrugged
    wom = clamp(1.0 + 0.55 * dev + 0.85 * dev ** 3 + rnd.gauss(0, 0.08), 0.50, 2.30)
    if audience >= 86 and critics >= 72 and heat > 1.02:
        wom *= 1.15                      # the thing nobody stopped talking about
    wom = min(wom, 2.40)

    gross = (C.BASE_K * std * scale["reach"] * C.quality_mult(q) * C.star_mult(draw * 1.6)
             * heat * _marketing_power(w, p) * C.hype_mult(p["hype"])
             * fan * legs / C.difficulty(w.year))
    gross *= E.fx(w, "attendance_mult") * E.fx(w, "revenue_mult") * reboot_bonus * wom
    gross *= fmt["mult"]                 # Technicolor, CinemaScope, IMAX... or the lack of them
    if stream_dump:
        gross *= 0.62
        legs *= 0.8
    gross = max(0.0, gross)

    foreign = clamp(0.22 + 0.30 * ((w.year - 1920) / 100.0)
                    + (0.10 if p["genre"] in ("action", "sci-fi", "animation") else 0)
                    + (E.fx(w, "foreign_mult") - 1.0) * 0.5, 0.1, 0.68)
    # `share` is our cut of the gross; `run` is the return on everything the
    # picture cost us; `net` is the cash profit we book (the budget, cast and
    # P&A already left the account during production).
    share = gross * C.STUDIO_SHARE * E.fx(w, "revenue_mult")
    dist = gross * C.DISTRIBUTION_FEE
    era_extra = FM.picture_costs(w, p["id"])     # formats, era overheads, bond
    total_cost = p["budget"] + p["marketing"] + p["cast_spend"] + era_extra
    run = share / max(1.0, total_cost)
    net = share - dist - total_cost

    outcome, badge, rep_delta = _outcome(run)
    cult, cult_classic = cult_score(w, p, q, critics, audience, run, rnd)
    stinker = 1 if (outcome in ("STINKER", "FLOP") and (critics < 32 or run < 0.45)) else 0

    # --- book the money
    w.earn(share - dist, "gross", f"Box office: {p['title']} ({C.GENRE_LABEL[p['genre']]})")
    cast_json = json.dumps([dict(id=r["actor_id"], name=r.get("actor_name"), role=r["name"], kind=r["kind"])
                            for r in comp["roles"] if r["actor_id"]])
    d = w.db.q1("SELECT name FROM directors WHERE id=?", (p["director_id"],))
    cur = w.db.execute("""INSERT INTO movies(title,genre,subgenre,scale,year,week,budget,marketing,
                    gross,gross_domestic,net,secondary,critics,audience,wom,quality,outcome,cult,
                    cult_classic,stinker,franchise_id,seq_index,writer_id,director_name,cast,rights,
                    noms,wins,razzies,foreign_share)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'player',0,0,0,?)""",
                       (p["title"], p["genre"], p["subgenre"], p["scale"], w.year, w.week,
                        p["budget"], p["marketing"], gross, gross * (1 - foreign), net, 0.0,
                        round(critics, 0), round(audience, 0), round(wom, 2), round(q, 1), outcome,
                        round(cult, 1), 1 if cult_classic else 0, stinker, p["franchise_id"],
                        p["seq_index"],
                        w.db.scalar("SELECT writer_id FROM scripts WHERE id=?", (p["script_id"],), None),
                        (d["name"] if d else None), cast_json, round(foreign, 2)))
    mid = cur.lastrowid
    w.db.kv_set(f"mfmt:{mid}", fmt["formats"])
    # what the craft guilds will look at come awards season
    w.db.kv_set(f"tech:{mid}", round(float(comp.get("values") or 0), 1))
    for r in comp["roles"]:
        if r["actor_id"]:
            w.db.execute("""INSERT INTO cast_members(movie_id,actor_id,role,kind,fee,fit,franchise_id)
                            VALUES(?,?,?,?,?,?,?)""",
                         (mid, r["actor_id"], r["name"], r["kind"], r["fee"] or 0,
                          round(A.fit_for_genre(r, p["genre"]), 1), p["franchise_id"]))
    w.db.execute("UPDATE productions SET status='released', quality=? WHERE id=?", (round(q, 1), pid))
    w.db.execute("UPDATE scripts SET status='produced' WHERE id=?", (p["script_id"],))
    cast_ids = [r["actor_id"] for r in w.db.q(
        "SELECT actor_id FROM roles WHERE production_id=? AND actor_id IS NOT NULL", (pid,))]
    for aid in cast_ids:
        w.db.execute("UPDATE actors SET busy_until=-1 WHERE id=?", (aid,))
    A.finish_picture(w, cast_ids)
    if p["director_id"]:
        w.db.execute("""UPDATE directors SET busy_until=-1, films=films+1,
                        prestige=MIN(99,prestige+?), hits=hits+? WHERE id=?""",
                     (2.2 if run > 1.5 else 0.6 if run > 1.0 else -0.8,
                      1 if run > 2.0 else 0, p["director_id"]))

    # --- people consequences
    for r in comp["roles"]:
        if not r["actor_id"]:
            continue
        weight = r["weight"]
        gain = (clamp((run - 0.7) * 7.0, -6.0, 16.0) * (1.6 if r["kind"] in ("lead", "voice") else 0.8)
                + (2.0 if outcome in ("HIT", "BLOCKBUSTER", "PHENOMENON") and r["kind"] == "lead" else 0))
        A.credit_performance(w, r["actor_id"], gross, q, r["kind"] in ("lead", "voice"),
                             cult_classic, gain)
        from . import legacy
        legacy.performance(w, r["actor_id"], q, run, gross, p["scale"], r["kind"] in ("lead", "voice"))
    # --- the critics have their say: verdict, named performances, the bumps
    rv = press.review_release(w, p, comp, mid, q, critics, audience, outcome, run, gross, wom,
                              heat, peak, cult_classic, cast_back, fatigue)
    grades = {x["actor_id"]: x["grade"] for x in rv["performances"]}
    for r in comp["roles"]:
        if r["actor_id"]:
            typecast.credit(w, r["actor_id"], p["genre"], r["kind"],
                            standout=grades.get(r["actor_id"]) == "Standout")
    opening, open_rank = 0.0, None
    if not stream_dump:
        star = rv.get("star")
        crun = charts.open_run(w, "player", p["title"], w.name, p["genre"], gross, legs, wom,
                               movie_id=mid, lead_name=(star or {}).get("name"),
                               critics=int(round(critics)))
        if crun:
            opening = crun["opening"]
            open_rank = charts.projected_rank(w, opening)
    press.save_review(w, rv, opening, open_rank)

    wid = w.db.scalar("SELECT writer_id FROM scripts WHERE id=?", (p["script_id"],), None)
    if wid:
        w.db.execute("""UPDATE writers SET skill=MIN(97, skill+?), awards=awards
                        WHERE id=?""", (1.4 if q > 72 else 0.5 if q > 52 else 0.1, wid))

    # --- the characters: fans, breakouts, icons
    if franchise:
        CH.on_release(w, p, mid, comp, q, run, grades, franchise, cult_classic)

    # --- franchise upkeep
    if franchise:
        # fans come back for quality, but every installment asks a little more
        # of them (fatigue grows with the count in this continuity) and a rush
        # job wears them out - so series die when the audience goes away
        from . import franchise as F
        n_run = w.db.scalar("SELECT COUNT(*) FROM movies WHERE franchise_id=? AND year>=?",
                            (franchise["id"], F.era_start(w, franchise["id"])), 0) or 1
        gap = w.year - (franchise["last_year"] or w.year)
        grow = 0.80 + 0.22 * min(2.5, run)
        if grow > 1.0:
            grow = 1.0 + (grow - 1.0) * max(0.0, 1.0 - franchise["fan_base"] / 450.0)
        new_fan = clamp(franchise["fan_base"] * grow + (18 if cult_classic else 0) + (q - 58) * 0.5
                        - 1.8 * n_run - (6 if gap < 3 else 0), 5, 420)
        new_heat = clamp(franchise["heat"] * (0.75 + 0.28 * min(2.2, run)) * E.fx(w, "franchise_heat_mult"),
                         0.2, 2.4)
        w.db.execute("""UPDATE franchises SET installments=installments+1, last_year=?,
                        total_gross=total_gross+?, total_net=total_net+?, fan_base=?, heat=?,
                        status='active' WHERE id=?""",
                     (w.year, gross, net, new_fan, new_heat, franchise["id"]))

    # --- world consequence
    patriotic = E.fx(w, "sum:prestige_bonus_patriotic")
    if patriotic and p["genre"] in ("drama", "action", "western") and q >= 50:
        w.add_prestige(8.0 * patriotic)
        w.add_reputation(4.0 * patriotic)
    world.count_supply(w, p["genre"])
    w.add_reputation(rep_delta)
    if outcome == "PHENOMENON":
        w.add_prestige(6)
        w.db.execute("UPDATE trends SET heat=MIN(2.3, heat+0.25), drift=drift+0.10 WHERE genre=?",
                     (p["genre"],))
    if stinker:
        w.add_prestige(-2)
    w.stats["releases"] = w.stats.get("releases", 0) + 1
    w.db.kv_set("releases_year", w.db.kv_get("releases_year", 0) + 1)
    if run >= 2.0:
        w.stats["hits"] = w.stats.get("hits", 0) + 1
    if run < 0.6:
        w.stats["flops"] = w.stats.get("flops", 0) + 1
    if cult_classic:
        w.stats["cult"] = w.stats.get("cult", 0) + 1

    headline = f"{p['title']} — {outcome}: {rv['headline']}"
    body = (f"{rv['verdict']} ({rv['score10']:.1f}/10). Gross ${gross:,.0f} on a ${total_cost:,.0f} spend; studio take ${net:,.0f}. "
            f"Critics {critics:.0f}, audiences {audience:.0f}, legs {legs:.2f}x.")
    if cult_classic:
        body += "  Nobody went to see it, and it will never stop earning."
    if fmt["notes"]:
        body += "  " + "; ".join(fmt["notes"]).capitalize() + "."
    if cast_back is not None:
        body += ("  The original stars are back and the fans showed up." if cast_back >= 0.99 else
                 "  Without the original leads, a lot of fans stayed home." if cast_back <= 0.01 else
                 "  Half the old gang is back; the fans noticed who was missing.")
    universe.log(w.year, w.week, "release", headline, body,
                 weight=3 if outcome in ("PHENOMENON", "BLOCKBUSTER") else 2 if cult_classic else 1)
    return dict(ok=True, movie_id=mid, gross=gross, net=net, run=run, outcome=outcome,
                critics=round(critics, 0), audience=round(audience, 0), quality=round(q, 1),
                cult=round(cult, 1), cult_classic=cult_classic, legs=round(legs, 2),
                title=p["title"], cast_back=cast_back, headline=rv["headline"],
                verdict=rv["verdict"], score10=rv["score10"], review=True)


def _marketing_power(w, p) -> float:
    """What the prints & ads buy: the base curve, sharpened by a marketing
    department and by eras that run on hype (the blockbuster years)."""
    base = C.marketing_mult(p["marketing"], p["budget"])
    dept = w.db.scalar("SELECT count FROM buildings WHERE kind='marketing_dept'", 0) or 0
    lift = (base - 1.0) * (1.0 + 0.10 * dept) * E.fx(w, "marketing_mult")
    return max(0.5, 1.0 + lift) if base >= 1.0 else base


def _fatigue_penalty(w, f):
    recent = w.db.scalar("SELECT COUNT(*) FROM movies WHERE franchise_id=? AND year > ?",
                         (f["id"], w.year - 4), 0)
    return max(0.0, recent - 1) * 0.11


def _outcome(run):
    for thr, label, badge, rep in C.OUTCOMES:
        if run >= thr:
            return label, badge, rep
    return "STINKER", "stink", -14


# --------------------------------------------------------------------------- #
#  Cult classics & stinkers
# --------------------------------------------------------------------------- #
def cult_score(w, p, q, critics, audience, run, rnd):
    """Misunderstood masterpieces and glorious garbage both find their audience."""
    cult = 0.0
    genre = p["genre"]
    camp = clamp((60 if genre in ("horror", "sci-fi", "musical", "action") else 25)
                 + (p["budget"] / max(1.0, C.standard_cost(w.year)) > 1.8 and 15 or 0)
                 + rnd.uniform(-8, 12), 0, 99)
    rr = run / 1.15          # 1.0 = the line where a picture is called SOLID
    if q >= 58 and rr < 1.10:
        cult += (q - 56) * 1.30 + (74 - critics) * 0.40 + (1.10 - rr) * 30.0
    if q <= 38 and rr < 0.85 and genre in ("horror", "sci-fi", "action", "musical",
                                           "western", "comedy", "crime"):
        cult += (38 - q) * 1.05 + camp * 0.36 + (0.85 - rr) * 15.0
    if rr < 0.30 and q < 44:
        cult += 10.0
    if p["franchise_id"]:
        f = w.db.q1("SELECT fan_base FROM franchises WHERE id=?", (p["franchise_id"],))
        if f:
            cult += min(14.0, (f["fan_base"] or 0) * 0.05)
    cult = clamp(cult + rnd.uniform(-6, 8), 0, 100)
    return cult, cult >= 40.0


def dump_slate_to_streaming(w, discount=0.35):
    """Pandemic-style event choice: sell the can to a streamer for immediate cash."""
    n = 0
    total = 0.0
    for r in P.ready_pictures(w):
        res = release(w, r["id"], stream_dump=True)
        if res.get("ok"):
            n += 1
            total += res["net"]
    if n:
        universe.log(w.year, w.week, "finance", "The slate goes to streaming",
                     f"{n} picture(s) sold straight to a platform. ${total:,.0f} today, "
                     f"nothing in the re-release column ever.", weight=3)
    return dict(ok=True, released=n, total=total)


# --------------------------------------------------------------------------- #
#  Catalogue revenue (the library)
# --------------------------------------------------------------------------- #
def secondary_yearly(w):
    from . import franchise as F
    total = 0.0
    lines = []
    rows = w.db.q("SELECT * FROM movies WHERE rights='player'")
    cult_cast = {}
    for m in rows:
        m = dict(m)
        amt = F.movie_annual(w, m)
        if amt <= 0:
            continue
        w.db.execute("UPDATE movies SET secondary=secondary+? WHERE id=?", (amt, m["id"]))
        total += amt
        if len(lines) < 6 and amt > C.standard_cost(w.year) * 0.02:
            lines.append((m["title"], amt))
        if m["cult_classic"]:
            for cm in w.db.q("SELECT actor_id FROM cast_members WHERE movie_id=?", (m["id"],)):
                cult_cast[cm["actor_id"]] = cult_cast.get(cm["actor_id"], 0) + 0.35
    if total > 0:
        w.earn(total, "secondary", "Library: TV, home video, streaming, reissues")
        from . import formats as FM
        res = total * FM.residual_rate(w.year)
        if res > 0:
            w.spend(res, "residuals", f"Residuals to talent ({FM.residual_rate(w.year) * 100:.0f}% of library)")
        w.db.execute("UPDATE movies SET secondary=secondary+0 WHERE 1=0")
    # cult titles creep into the culture: fame for their casts, year on year
    for aid, amt in cult_cast.items():
        A.bump_fame(w, aid, amt)
    return dict(total=total, lines=lines)


# --------------------------------------------------------------------------- #
#  Awards season
# --------------------------------------------------------------------------- #
def awards_year(w, campaign_spend=0.0):
    from . import awards as AW
    return AW.ceremony(w, campaign_spend)


# --------------------------------------------------------------------------- #
#  Catalogue queries for the dashboard
# --------------------------------------------------------------------------- #
def catalogue(w, q=None, genre=None, outcome=None, rights="player", sort="year", dirn="desc",
              page=1, limit=40, franchise_id=None, cult_only=False):
    where, args = [], []
    if rights == "player":
        where.append("m.rights='player'")
    elif rights == "sold":
        where.append("m.rights<>'player'")
    if q:
        where.append("m.title LIKE ?")
        args.append(f"%{q}%")
    if genre:
        where.append("m.genre=?")
        args.append(genre)
    if outcome:
        where.append("m.outcome=?")
        args.append(outcome)
    if franchise_id:
        where.append("m.franchise_id=?")
        args.append(int(franchise_id))
    if cult_only:
        where.append("(m.cult_classic=1 OR m.cult>40)")
    wsql = (" WHERE " + " AND ".join(where)) if where else ""
    col = {k: f"m.{k}" for k in ("year", "gross", "net", "critics", "audience", "title",
                                 "cult", "quality", "budget", "outcome", "week")}.get(sort,
                                                                                       "m.year")
    d = "ASC" if str(dirn).lower().startswith("a") else "DESC"
    total = w.db.scalar(f"SELECT COUNT(*) FROM movies m{wsql}", tuple(args), 0)
    limit = max(1, min(200, int(limit)))
    rows = w.db.q(f"""SELECT m.*, f.name AS franchise_name FROM movies m
                      LEFT JOIN franchises f ON f.id=m.franchise_id{wsql}
                      ORDER BY {col} {d}, m.id DESC LIMIT ? OFFSET ?""",
                  tuple(args) + (limit, (max(1, int(page)) - 1) * limit))
    out = []
    for r in rows:
        x = dict(r)
        cost = (x["budget"] or 0) + (x["marketing"] or 0)
        x["run"] = round((x["net"] or 0) / cost, 2) if cost else 0
        x["return_pct"] = round(100 * ((x["net"] or 0) / cost), 0) if cost else 0
        out.append(x)
    return dict(rows=out, total=total, page=int(page), pages=max(1, (total + limit - 1) // limit))


def chart_data(w):
    rows = w.db.q("""SELECT year, releases, gross, net, profit, cash, valuation, prestige
                     FROM year_stats ORDER BY year""")
    by_year = {r["year"]: dict(r) for r in rows}
    genres = w.db.q("""SELECT genre, SUM(gross) g, COUNT(*) n FROM movies WHERE rights='player'
                       GROUP BY genre ORDER BY g DESC""")
    outcomes = w.db.q("""SELECT outcome, COUNT(*) n FROM movies WHERE rights='player'
                         GROUP BY outcome""")
    return dict(years=[by_year[y] for y in sorted(by_year)],
                genres=[dict(g) for g in genres],
                outcomes=[dict(o) for o in outcomes])
