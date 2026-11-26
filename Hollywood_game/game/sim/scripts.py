"""Writers and the script market.

Staff writers keep producing while on payroll (you own the output); freelancers
hit the open market.  Coverage gives an imperfect read on quality - buying blind
is how you find a bargain masterpiece or a bargain disaster.
"""
from __future__ import annotations

from .. import config as C
from .. import universe
from ..rng import clamp, stream, unit
from . import actors as A


# --------------------------------------------------------------------------- #
#  Market / library listing
# --------------------------------------------------------------------------- #
def market(w, genre=None, scale=None, max_price=None, unread=False, q=None,
           sort="price", dirn="asc", page=1, limit=30, fp_min=None):
    where = ["owner='market'", "status='market'"]
    args = []
    if genre:
        where.append("genre=?")
        args.append(genre)
    if scale:
        where.append("scale=?")
        args.append(scale)
    if max_price is not None:
        where.append("price<=?")
        args.append(float(max_price))
    if fp_min is not None:
        where.append("fp>=?")
        args.append(int(fp_min))
    if unread:
        where.append("coverage IS NULL")
    if q:
        where.append("title LIKE ?")
        args.append(f"%{q}%")
    wsql = " WHERE " + " AND ".join(where)
    col = {"price": "price", "title": "title", "year": "created_year",
           "fp": "fp", "genre": "genre", "quality": "coverage"}.get(sort, "price")
    d = "ASC" if str(dirn).lower().startswith("a") else "DESC"
    total = w.db.scalar(f"SELECT COUNT(*) FROM scripts{wsql}", tuple(args), 0)
    limit = max(1, min(100, int(limit)))
    page = max(1, int(page))
    rows = w.db.q(f"""SELECT id,title,genre,subgenre,scale,fp,owner,status,price,option_price,
                      created_year,coverage,coverage_pm,writer_id,origin,developed,tags
                      FROM scripts{wsql} ORDER BY {col} {d}, id DESC LIMIT ? OFFSET ?""",
                  tuple(args) + (limit, (page - 1) * limit))
    out = [dict(r) for r in rows]
    for r in out:
        r["writer"] = w.db.scalar("SELECT name FROM writers WHERE id=?", (r["writer_id"],), None)
        r["heat"] = round(w.trend(r["genre"]), 2)
    return dict(rows=out, total=total, page=page, pages=max(1, (total + limit - 1) // limit))


def library(w, page=1, limit=60):
    limit = max(1, min(200, int(limit)))
    page = max(1, int(page))
    rows = w.db.q("""SELECT s.id,s.title,s.genre,s.subgenre,s.scale,s.fp,s.status,s.price,
                     s.created_year,s.coverage,s.coverage_pm,s.developed,s.origin,s.tags,
                     s.writer_id, s.source_franchise, s.option_price, wr.name AS writer
                     FROM scripts s LEFT JOIN writers wr ON wr.id=s.writer_id
                     WHERE s.owner='player' AND s.status IN ('owned','optioned')
                     ORDER BY s.created_year DESC, s.fp DESC, s.id DESC LIMIT ? OFFSET ?""",
                  (limit, (page - 1) * limit))
    out = [dict(r) for r in rows]
    for r in out:
        r["heat"] = round(w.trend(r["genre"]), 2)
    return out


def script_detail(w, sid: int):
    r = w.db.q1("SELECT * FROM scripts WHERE id=?", (sid,))
    if not r:
        return None
    d = dict(r)
    d["heat"] = round(w.trend(d["genre"]), 2)
    if d["writer_id"]:
        wr = w.db.q1("SELECT id,name,skill,genre,genre2,awards FROM writers WHERE id=?",
                     (d["writer_id"],))
        d["writer"] = dict(wr) if wr else None
    else:
        d["writer"] = None
    if d["coverage"] is None:
        d["readable"] = False
    return d


# --------------------------------------------------------------------------- #
#  Coverage / buying
# --------------------------------------------------------------------------- #
def coverage_cost(w) -> float:
    return C.standard_cost(w.year) * 0.006


def coverage(w, sid: int):
    s = w.db.q1("SELECT * FROM scripts WHERE id=?", (sid,))
    if not s:
        return dict(ok=False, error="no such script")
    cost = coverage_cost(w)
    if not w.can_afford(cost):
        return dict(ok=False, error=f"needs ${cost:,.0f}")
    w.spend(cost, "development", f"Coverage: {s['title']}")
    acc = clamp(0.45 + 0.10 * (w.db.scalar("SELECT count FROM buildings WHERE kind='writers_room'", 0) or 0)
                + w.prestige * 0.003, 0.4, 0.95)
    spread = 22.0 * (1.0 - acc)
    u = unit(w.seed, "coverage", sid)
    est = clamp(s["quality"] + (u - 0.5) * 1.6 * spread, 0, 99)
    w.db.execute("UPDATE scripts SET coverage=?, coverage_pm=? WHERE id=?", (round(est, 0), round(spread, 0), sid))
    return dict(ok=True, coverage=round(est, 0), pm=round(spread, 0), cost=cost,
                fp_band=[max(0, s["fp"] - int(spread / 2)), min(100, s["fp"] + int(spread / 2))])


def buy(w, sid: int):
    s = w.db.q1("SELECT * FROM scripts WHERE id=?", (sid,))
    if not s:
        return dict(ok=False, error="no such script")
    if s["owner"] != "market":
        return dict(ok=False, error="not for sale")
    price = s["price"]
    if not w.can_afford(price):
        return dict(ok=False, error=f"needs ${price:,.0f}")
    w.spend(price, "script", f"Script purchase: {s['title']}")
    w.db.execute("UPDATE scripts SET owner='player', status='owned' WHERE id=?", (sid,))
    from .. import universe as U
    U.log(w.year, w.week, "finance", f"Script bought: {s['title']}",
          f"{C.GENRE_LABEL[s['genre']]}, {s['scale']}, ${price:,.0f}.")
    return dict(ok=True, price=price)


def option(w, sid: int):
    s = w.db.q1("SELECT * FROM scripts WHERE id=?", (sid,))
    if not s or s["owner"] != "market":
        return dict(ok=False, error="not available")
    if not w.can_afford(s["option_price"]):
        return dict(ok=False, error=f"needs ${s['option_price']:,.0f}")
    w.spend(s["option_price"], "script", f"Option: {s['title']}")
    w.db.execute("UPDATE scripts SET owner='player', status='optioned' WHERE id=?", (sid,))
    w.db.kv_set(f"option_due:{sid}", w.year + 3)
    return dict(ok=True, price=s["option_price"], expires=w.year + 3)


def expire_options(w):
    for r in w.db.q("SELECT id,title FROM scripts WHERE owner='player' AND status='optioned'"):
        due = w.db.kv_get(f"option_due:{r['id']}", None)
        if due and w.year > due:
            w.db.execute("""UPDATE scripts SET owner='market', status='market', coverage=NULL
                            WHERE id=?""", (r["id"],))
            from .. import universe as U
            U.log(w.year, w.week, "finance", f"Option lapsed: {r['title']}",
                  "The ink dried up on the option. Somebody else can have it now.")


# --------------------------------------------------------------------------- #
#  Development
# --------------------------------------------------------------------------- #
DEVELOPMENT = {
    "polish":     dict(label="Polish draft", cost=0.030, dq=(3, 9), dfp=(0, 2), risk=0.10),
    "structure":  dict(label="Structural rewrite", cost=0.055, dq=(6, 16), dfp=(0, 4), risk=0.26),
    "punchup":    dict(label="Comedy punch-up", cost=0.025, dq=(2, 7), dfp=(0, 1), risk=0.12),
    "franchise":  dict(label="Franchise seeding pass", cost=0.060, dq=(-2, 4), dfp=(10, 26), risk=0.22),
    "scale_up":   dict(label="Scale up (event picture)", cost=0.075, dq=(0, 6), dfp=(4, 14), risk=0.24),
    "cheapen":    dict(label="Rewrite cheap", cost=0.018, dq=(-8, -1), dfp=(0, 2), risk=0.14),
}


# --------------------------------------------------------------------------- #
#  Selling scripts to other studios
# --------------------------------------------------------------------------- #
def sale_quote(w, sid: int):
    """What the town would pay for one of your scripts this week.

    Buyers read it themselves, so the price follows the script's TRUE quality
    (not your reader's coverage), the genre's heat and the scale. Your best
    bidder is whichever rival has the money and the appetite this week."""
    s = w.db.q1("SELECT * FROM scripts WHERE id=?", (sid,))
    if not s or s["owner"] != "player":
        return None
    if s["status"] not in ("owned",):
        return None
    if s["source_franchise"]:
        return None                       # series scripts are part of the series' rights
    rivals = [dict(r) for r in w.db.q("SELECT * FROM rivals WHERE alive=1 ORDER BY cash DESC")]
    if not rivals:
        return None
    std = C.standard_cost(w.year)
    heat = w.trend(s["genre"])
    q = s["quality"]
    value = std * (0.03 + 0.10 * (q / 100) ** 2.0) * C.SCALES[s["scale"]]["mult"] * (0.75 + 0.5 * heat)
    rnd = stream(w.seed, "scriptsale", sid, w.abs_week // 4)     # a quote holds for a month
    buyer = rivals[rnd.randrange(min(4, len(rivals)))]
    price = value * rnd.uniform(0.70, 1.10) * (1.15 if q > 75 else 1.0)
    price = min(price, max(std * 0.01, buyer["cash"] * 0.08))
    paid = w.db.scalar("SELECT COALESCE(SUM(-amount),0) FROM ledger WHERE kind='script' "
                       "AND label LIKE ?", (f"%{s['title']}%",), 0) or 0
    return dict(price=round(price, 0), buyer=buyer["name"], paid=round(paid, 0),
                verdict=("they love it" if q > 75 else "solid interest" if q > 55
                         else "a polite offer" if q > 38 else "a mercy bid"))


def sell(w, sid: int):
    s = w.db.q1("SELECT * FROM scripts WHERE id=?", (sid,))
    if not s or s["owner"] != "player":
        return dict(ok=False, error="that is not your script")
    if s["status"] != "owned":
        return dict(ok=False, error="only scripts sitting in your vault can be sold "
                                    f"(this one is {s['status'].replace('_', ' ')})")
    if s["source_franchise"]:
        return dict(ok=False, error="a series script goes with the series - sell the series instead")
    q = sale_quote(w, sid)
    if not q:
        return dict(ok=False, error="nobody is buying right now")
    w.earn(q["price"], "script", f"Script sold: {s['title']} to {q['buyer']}")
    w.db.execute("UPDATE scripts SET owner=?, status='owned' WHERE id=?", (q["buyer"], sid))
    w.db.kv_set(f"sold_script:{sid}", dict(year=w.year, buyer=q["buyer"], price=q["price"]))
    universe.log(w.year, w.week, "offer", f"Script sold: {s['title']}",
                 f"{q['buyer']} pays ${q['price']:,.0f}. Let us hope they make a mess of it.")
    return dict(ok=True, price=q["price"], buyer=q["buyer"])


def development_options(w):
    std = C.standard_cost(w.year)
    return [dict(id=k, label=v["label"], cost=round(std * v["cost"], 0), risk=v["risk"])
            for k, v in DEVELOPMENT.items()]


def develop(w, sid: int, kind: str):
    s = w.db.q1("SELECT * FROM scripts WHERE id=?", (sid,))
    if not s:
        return dict(ok=False, error="no such script")
    if s["owner"] != "player":
        return dict(ok=False, error="you do not own this script")
    if s["status"] not in ("owned", "optioned"):
        return dict(ok=False, error="that script is " + s["status"].replace("_", " "))
    if kind not in DEVELOPMENT:
        return dict(ok=False, error="unknown rewrite")
    spec = DEVELOPMENT[kind]
    room = w.db.scalar("SELECT count FROM buildings WHERE kind='writers_room'", 0) or 0
    cost = C.standard_cost(w.year) * spec["cost"]
    if not w.can_afford(cost):
        return dict(ok=False, error=f"needs ${cost:,.0f}")
    w.spend(cost, "development", f"{spec['label']}: {s['title']}")
    rnd = stream(w.seed, "devscript", sid, w.abs_week, kind)
    dq = rnd.uniform(*spec["dq"]) * (1.0 + 0.12 * room)
    dfp = rnd.uniform(*spec["dfp"])
    hell = rnd.random() < spec["risk"] * (1.0 - 0.06 * room)
    note = ""
    if hell:
        loss = rnd.uniform(4, 14)
        dq = -loss
        note = "The draft collapses. The writer walks; you keep the ashes."
        if rnd.random() < 0.15:
            w.db.execute("UPDATE scripts SET status='dead', quality=MAX(3,quality-?) WHERE id=?",
                         (abs(dq), sid))
            from .. import universe as U
            U.log(w.year, w.week, "finance", f"Development hell: {s['title']}",
                  "Nothing will ever come of this picture.", weight=2)
            return dict(ok=True, dead=True, cost=cost, note=note)
    newq = clamp(s["quality"] + dq, 3, 99)
    newfp = int(clamp(s["fp"] + dfp, 0, 100))
    scale = s["scale"]
    if kind == "scale_up":
        order = ["short", "indie", "standard", "epic", "blockbuster"]
        scale = order[min(len(order) - 1, order.index(scale) + 1)]
    if kind == "cheapen":
        order = ["short", "indie", "standard", "epic", "blockbuster"]
        scale = order[max(0, order.index(scale) - 1)]
    w.db.execute("""UPDATE scripts SET quality=?, fp=?, developed=developed+1, scale=?,
                    coverage=NULL WHERE id=?""", (newq, newfp, scale, sid))
    if s["writer_id"]:
        w.db.execute("UPDATE writers SET skill=MIN(97,skill+?) WHERE id=?",
                     (0.4 if dq > 0 else 0.1, s["writer_id"]))
    from .. import universe as U
    U.log(w.year, w.week, "finance", f"{spec['label']}: {s['title']}",
          note or f"Quality {'+' if dq >= 0 else ''}{dq:.0f}, franchise potential now {newfp}.")
    return dict(ok=True, cost=cost, quality=round(newq, 1), fp=newfp, scale=scale,
                note=note or "the pages are better")


# --------------------------------------------------------------------------- #
#  Writers
# --------------------------------------------------------------------------- #
def writers_market(w, sort="skill", dirn="desc", page=1, limit=30, genre=None):
    where = ["status='market'"]
    args = []
    if genre:
        where.append("(genre=? OR genre2=?)")
        args += [genre, genre]
    col = {"skill": "skill", "fee": "fee", "name": "name", "weeks": "weeks_per_script",
           "awards": "awards", "week_rate": "salary", "salary": "salary"}.get(sort, "skill")
    d = "ASC" if str(dirn).lower().startswith("a") else "DESC"
    wsql = " WHERE " + " AND ".join(where)
    total = w.db.scalar(f"SELECT COUNT(*) FROM writers{wsql}", tuple(args), 0)
    limit = max(1, min(100, int(limit)))
    rows = w.db.q(f"""SELECT id,name,skill,genre,genre2,fee,salary,weeks_per_script,ego,drink,
                      awards,scripts_written,status FROM writers{wsql}
                      ORDER BY {col} {d}, id ASC LIMIT ? OFFSET ?""",
                  tuple(args) + (limit, (max(1, int(page)) - 1) * limit))
    out = []
    for r in rows:
        d = dict(r)
        est, pm = A.perceived(w, d["skill"], 1_000_000 + d["id"], min(60, d["awards"] * 20), "writer")
        d["est_skill"] = est
        d["est_pm"] = pm
        out.append(d)
    return dict(rows=out, total=total, page=page, pages=max(1, (total + limit - 1) // limit))


def staff(w):
    return [dict(r) for r in w.db.q("""SELECT * FROM writers WHERE studio='player'
                                       ORDER BY skill DESC""")]


def hire_writer(w, wid: int, staff_pos: bool = True):
    wr = w.db.q1("SELECT * FROM writers WHERE id=?", (wid,))
    if not wr:
        return dict(ok=False, error="no such writer")
    if wr["status"] == "staff":
        return dict(ok=False, error="already under contract")
    if staff_pos:
        bonus = wr["salary"] * 1.5
        if not w.can_afford(bonus):
            return dict(ok=False, error=f"needs ${bonus:,.0f} retainer")
        w.spend(bonus, "payroll", f"Writer retainer: {wr['name']}")
        w.db.execute("""UPDATE writers SET status='staff', studio='player', busy_until=?,
                        salary=? WHERE id=?""", (w.abs_week + int(wr["weeks_per_script"]),
                                                 wr["salary"], wid))
    else:
        if not w.can_afford(wr["fee"]):
            return dict(ok=False, error=f"needs ${wr['fee']:,.0f}")
        w.spend(wr["fee"], "payroll", f"Freelance writer: {wr['name']}")
        w.db.execute("UPDATE writers SET busy_until=? WHERE id=?",
                     (w.abs_week + int(wr["weeks_per_script"]), wid))
        w.db.kv_set(f"comm:{wid}", 1)   # this one's draft comes to us, then they are free again
    from .. import universe as U
    U.log(w.year, w.week, "talent", f"{'Hired on staff' if staff_pos else 'Commissioned'}: {wr['name']}",
          f"{C.GENRE_LABEL[wr['genre']]}/{C.GENRE_LABEL[wr['genre2']]}, "
          f"{'salary $' + format(wr['salary'], ',.0f') + '/wk' if staff_pos else 'fee $' + format(wr['fee'], ',.0f')}.")
    return dict(ok=True)


def fire_writer(w, wid: int):
    wr = w.db.q1("SELECT * FROM writers WHERE id=? AND studio='player'", (wid,))
    if not wr:
        return dict(ok=False, error="not on your payroll")
    sev = wr["salary"] * 2
    if not w.can_afford(sev):
        return dict(ok=False, error=f"severance ${sev:,.0f}")
    w.spend(sev, "payroll", f"Severance: {wr['name']}")
    w.db.execute("UPDATE writers SET status='market', studio=NULL, busy_until=-1 WHERE id=?", (wid,))
    return dict(ok=True)


def assign_genre(w, wid: int, genre: str):
    wr = w.db.q1("SELECT * FROM writers WHERE id=? AND studio='player'", (wid,))
    if not wr:
        return dict(ok=False, error="not on your payroll")
    if not genre:
        w.db.kv_set(f"wassign:{wid}", None)      # back to their own speciality
        return dict(ok=True, genre=None)
    if genre not in C.GENRES:
        return dict(ok=False, error="unknown genre")
    w.db.kv_set(f"wassign:{wid}", genre)
    return dict(ok=True, genre=genre)


def weekly_writers(w):
    """Staff (and paid freelancers) deliver scripts when their clock runs out."""
    rows = w.db.q("""SELECT * FROM writers WHERE studio='player' AND busy_until <= ?
                     UNION SELECT * FROM writers WHERE studio IS NULL AND busy_until > -1
                     AND busy_until <= ?""", (w.abs_week, w.abs_week))
    for wr in rows:
        wr = dict(wr)
        genre = w.db.kv_get(f"wassign:{wr['id']}", None) or wr["genre"]
        commissioned = bool(w.db.kv_get(f"comm:{wr['id']}", 0))
        rnd = stream(w.seed, "script", wr["id"], w.abs_week)
        room = w.db.scalar("SELECT count FROM buildings WHERE kind='writers_room'", 0) or 0
        bias = (4.0 + 1.5 * room) if wr["studio"] == "player" else 0.0
        s = universe.make_script(rnd, w.year, writer=wr, genre=genre,
                                 trends=w.trends(), quality_bias=bias)
        mine = wr["studio"] == "player" or commissioned
        owner, status = ("player", "owned") if mine else ("market", "market")
        if commissioned:
            w.db.kv_set(f"comm:{wr['id']}", 0)
        w.db.execute("""INSERT INTO scripts(title,genre,subgenre,scale,quality,fp,writer_id,owner,
                        status,price,option_price,created_year,developed,origin,tags)
                        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,'',?)""",
                     (s["title"], s["genre"], s["subgenre"], s["scale"], s["quality"], s["fp"],
                      wr["id"], owner, status, s["price"], s["option_price"], w.year, s["tags"]))
        w.db.execute("""UPDATE writers SET scripts_written=scripts_written+1, busy_until=?,
                        best_picture=COALESCE(best_picture,?) WHERE id=?""",
                     (w.abs_week + max(4, int(wr["weeks_per_script"] * (max(0.6, 1.0 - 0.08 * room)
                                                                     if wr["studio"] == "player" else 1.0))),
                      s["title"], wr["id"]))
        if wr["drink"] and rnd.random() < wr["drink"] / 320.0:
            w.db.execute("UPDATE writers SET skill=MAX(5,skill-2) WHERE id=?", (wr["id"],))
    # clear stale busy markers
    w.db.execute("UPDATE writers SET busy_until=-1 WHERE studio='market' AND busy_until > -1 AND busy_until <= ?",
                 (w.abs_week,))


def monthly_market(w):
    """Freelance supply and demand: rivals snap up scripts, the market churns."""
    rnd = stream(w.seed, "scriptmarket", w.year, w.week)
    trends = w.trends()
    from . import events as E
    supply_mult = 1.0 / max(0.2, E.fx(w, "script_supply_mult"))
    n = max(1, int(rnd.uniform(3, 7) * supply_mult))
    freelancers = [dict(r) for r in w.db.q("SELECT * FROM writers WHERE studio IS NULL ORDER BY (r % 991) LIMIT 40")]
    for _ in range(n):
        wr = rnd.choice(freelancers) if freelancers and rnd.random() < 0.75 else None
        s = universe.make_script(rnd, w.year, writer=wr, trends=trends)
        w.db.execute("""INSERT INTO scripts(title,genre,subgenre,scale,quality,fp,writer_id,owner,
                        status,price,option_price,created_year,developed,origin,tags)
                        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,'',?)""",
                     (s["title"], s["genre"], s["subgenre"], s["scale"], s["quality"], s["fp"],
                      (wr["id"] if wr else None), "market", "market", s["price"], s["option_price"],
                      w.year, s["tags"]))
    # the town buys what is hot: cheap scripts leave the market
    listings = [dict(r) for r in w.db.q("SELECT id,title,price,quality,genre,fp FROM scripts WHERE owner='market' AND status='market'")]
    if len(listings) > 55:
        listings.sort(key=lambda r: (r["price"] / max(1.0, r["quality"] * w.trend(r["genre"]))))
        for r in listings[: max(1, len(listings) - 55)]:
            w.db.execute("UPDATE scripts SET owner='rival', status='produced' WHERE id=?", (r["id"],))


def rival_script(w, genre=None, quality_floor=40, fp_floor=0, origin="new", franchise=None):
    """Used by the franchise module to fake a rival-authored reboot script."""
    rnd = stream(w.seed, "rivalscript", w.year, w.week, genre or "x", origin)
    s = universe.make_script(rnd, w.year, genre=genre, trends=w.trends(),
                             quality_bias=max(0, quality_floor - 45), origin=origin,
                             franchise=franchise)
    if s["fp"] < fp_floor:
        s["fp"] = fp_floor
    return s
