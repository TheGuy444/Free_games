"""Actor universe: careers, aging, fame, contracts, scouting.

Heavy lifting is done with *set-based* SQL so a decade of 4,000+ careers costs a
handful of statements.  Per-row noise comes from a stored LCG state column `r`
advanced inside the same UPDATE (the RHS sees the old value, so noise is
deterministic and independent of iteration order).
"""
from __future__ import annotations

from .. import config as C
from .. import universe
from ..rng import clamp, stream

NOISE = "((r % 1000) / 1000.0)"        # 0..1 from current row LCG state
ADV = "r = (r * 1103515245 + 12345) % 2147483648"
ALIVE = "('available','working','star','blacklisted')"
MARKET = "('available','working','star')"


# --------------------------------------------------------------------------- #
#  Yearly career pass (set based)
# --------------------------------------------------------------------------- #
def yearly_pass(w, mortality_mult=1.0, fame_mult=1.0, salary_inflation=0.0,
                star_making=2.5):
    db = w.db

    # fame drift + bankability, and advance every row's LCG exactly once
    # A career is a floor under your name: 30 pictures and a statuette keep you
    # remembered even after the marquee stops burning.
    db.execute(f"""
      UPDATE actors SET
        age = age + 1,
        fame = MAX(0.0, MIN(100.0, MAX(
                   (fame * {C.FAME_DECAY}
                    + ({NOISE} - 0.44) * 2.6 * (1.0 + fame / 55.0)) * ?,
                   MIN(42.0, films * 0.85 + awards * 4.5 + cult * 0.30)))),
        t_bankability = MAX(0.0, MIN(100.0, t_bankability * 0.86
                   + (fame * 0.55 + t_charisma * 0.30 + {NOISE} * 12.0) * 0.14)),
        t_charisma = MAX(2.0, MIN(99.0, t_charisma - CASE WHEN age > 55 THEN 0.12 ELSE 0 END)),
        {ADV}
      WHERE status IN {ALIVE}
    """, (max(0.0, fame_mult),))

    # craft / skill aging
    db.execute(f"""
      UPDATE actors SET
        craft = MAX(3.0, MIN(99.0, craft - CASE WHEN age > 58 THEN (age - 58) * 0.05 ELSE 0 END)),
        s_dance = MAX(3.0, s_dance - CASE WHEN age > 34 THEN 0.5 + (age-34)*0.05 ELSE 0.05 END),
        s_stunts = MAX(3.0, s_stunts - CASE WHEN age > 38 THEN 0.5 + (age-38)*0.06 ELSE 0.05 END),
        s_voice = MAX(3.0, s_voice - CASE WHEN age > 70 THEN 0.4 ELSE 0.02 END),
        s_action = MAX(3.0, s_action - CASE WHEN age > 48 THEN 0.35 ELSE 0.02 END),
        s_drama = MIN(99.0, s_drama + CASE WHEN age < 45 THEN 0.25 ELSE 0.02 END),
        s_comedy = MIN(99.0, s_comedy + CASE WHEN age < 50 THEN 0.22 ELSE 0.02 END),
        s_musicality = MIN(99.0, s_musicality + 0.03)
      WHERE status IN {ALIVE}
    """)

    # retirement (per-row threshold via LCG -> staggered, no cliff edge).
    # Leads work on: a star with a name can hold the screen into his sixties.
    db.execute(f"""
      UPDATE actors SET status='retired', fame=fame*0.9
      WHERE status IN {ALIVE}
        AND age >= CASE WHEN fame >= 62 THEN 66 ELSE 58 END + (r % 22)
    """)

    # mortality: natural deaths, illness, and the rare life cut short (with
    # causes and obituaries - see legacy.py)
    from . import legacy
    legacy.mortality(w, mortality_mult)

    # star power, then repricing (fees scale with the era's nominal costs)
    db.execute(f"""
      UPDATE actors SET
        star_power = MAX(0.0, MIN(100.0, {C.STAR_POWER_W['fame']} * fame
                        + {C.STAR_POWER_W['bankability']} * t_bankability
                        + {C.STAR_POWER_W['craft']} * craft)),
        status = CASE WHEN status='blacklisted' THEN 'blacklisted'
                      WHEN fame >= 62 THEN 'star'
                      WHEN films > 0 OR fame >= 14 THEN 'working'
                      ELSE 'available' END
      WHERE status IN {ALIVE}
    """)
    # the town keeps making its own stars: rival pictures create names whether
    # you are watching or not, so there is always a new face to discover first
    db.execute("""
      UPDATE actors SET fame = MIN(100.0, fame + 4 + (r % 10)),
                        films = films + 1 + (r % 3),
                        leads = leads + CASE WHEN (r % 4) = 0 THEN 1 ELSE 0 END
      WHERE status IN ('working','available') AND age BETWEEN 20 AND 55
        AND fame >= 6 AND fame <= 58 AND (r % 100) < ?
    """, (star_making,))

    std = C.standard_cost(w.year)
    db.execute(f"""
      UPDATE actors SET
        fee = ? * (0.030 + 0.16 * POW(MAX(0.0, fame) / 100.0, 1.8)) * (1.0 + ?),
        contract_fee = CASE WHEN studio='player' AND contract_films > 0
                       THEN ? * (0.04 + 0.55 * POW(MAX(0.0, star_power)/100.0,2.4))
                            * (1.0 + ?) * 0.86 ELSE contract_fee END
      WHERE status IN {ALIVE}
    """, (std, salary_inflation, std, salary_inflation))

    db.execute("UPDATE actors SET busy_until=-1 WHERE busy_until > -1 AND busy_until < ?",
               (w.abs_week,))
    db.execute("""UPDATE actors SET studio=NULL, contract_films=0, contract_fee=0,
                  contract_until=0 WHERE studio IS NOT NULL AND contract_until < ?
                  AND contract_films <= 0""", (w.abs_week,))


# --------------------------------------------------------------------------- #
#  Genre fit + scouting (player knowledge is deliberately imperfect)
# --------------------------------------------------------------------------- #
def fit_for_genre(a, genre: str, labels: bool = True) -> float:
    weights = C.GENRE_SKILL_WEIGHT[genre]
    tot = wsum = 0.0
    for sk, wt in weights.items():
        tot += (a.get("s_" + sk) or 10) * wt
        wsum += wt
    base = tot / max(wsum, 0.001)
    fit = base * (0.80 + 0.30 * ((a.get("t_versatility") or 40) / 100.0))
    if labels:
        # a Cowboy plays a cowboy better; an actor with range is better at everything
        from . import typecast
        fit += typecast.fit_bonus(a, genre)
    return clamp(fit, 0, 100)


def role_fit(a, role, genre: str) -> float:
    """True fit of an actor for one specific part: genre fit plus whatever the
    part specifically asks for (stunts, dancing, a voice). The production's
    quality model and the audition shortlist both use this, so what the
    casting screen ranks is what the picture actually gets."""
    fit = fit_for_genre(a, genre)
    if role.get("want_stunts"):
        fit = fit * 0.7 + (a.get("s_stunts") or 10) * 0.3
    if role.get("want_dance"):
        fit = fit * 0.65 + (a.get("s_dance") or 10) * 0.35
    if role.get("want_voice"):
        fit = fit * 0.6 + (a.get("s_voice") or 10) * 0.4
    return clamp(fit, 0, 100)


def scout_accuracy(w) -> float:
    office = w.db.scalar("SELECT count FROM buildings WHERE kind='casting_office'", 0) or 0
    return clamp(0.40 + office * 0.14 + w.prestige * 0.004 + max(0, w.reputation) * 0.002, 0.3, 0.96)


def perceived(w, true_val: float, actor_id: int, fame: float, field: str, spread: float = 24.0):
    from ..rng import unit
    acc = scout_accuracy(w)
    vis = clamp(0.30 + fame / 90.0, 0.30, 1.0)
    err = spread * (1.0 - acc * vis)
    u = unit(w.seed, "scout", actor_id, field)
    est = clamp(true_val + (u - 0.5) * 1.5 * err, 0, 99)
    return round(est, 0), round(err, 0)


# --------------------------------------------------------------------------- #
#  Chemistry between two cast members
# --------------------------------------------------------------------------- #
def chemistry(a, b) -> float:
    v = (a.get("t_charisma", 30) + b.get("t_charisma", 30)) * 0.28
    v += (a.get("t_likeability", 40) + b.get("t_likeability", 40)) * 0.22
    v += 14.0 if abs(a.get("age", 30) - b.get("age", 30)) <= 12 else 4.0
    v += min(a.get("craft", 20), b.get("craft", 20)) * 0.25
    v -= abs(a.get("t_ego", 30) - b.get("t_ego", 30)) * 0.12
    v += 8.0 if a.get("gender") != b.get("gender") else 3.0
    return clamp(v, 0, 100)


# --------------------------------------------------------------------------- #
#  Listing / detail for the dashboard
# --------------------------------------------------------------------------- #
SORTABLE = {"name": "name", "fame": "fame", "star_power": "star_power", "age": "age",
            "fee": "fee", "films": "films", "craft": "craft", "cult": "cult",
            "awards": "awards", "total_gross": "total_gross", "status": "status",
            "drama": "s_drama", "comedy": "s_comedy", "action": "s_action",
            "musicality": "s_musicality", "dance": "s_dance", "voice": "s_voice",
            "stunts": "s_stunts", "charisma": "t_charisma", "bankability": "t_bankability",
            "versatility": "t_versatility", "discipline": "t_discipline"}

LIST_COLS = """id,name,gender,age,status,studio,fame,star_power,craft,fee,films,leads,awards,
  cult,total_gross,best_gross,hue,busy_until,contract_films,contract_until,contract_fee,
  s_drama,s_comedy,s_action,s_musicality,s_dance,s_voice,s_stunts,
  t_charisma,t_bankability,t_versatility,t_discipline,t_scandal,t_substance,labels,standouts"""


def list_actors(w, q=None, status="any", gender="any", min_age=None, max_age=None,
                min_fame=None, max_fame=None, signed=None, alive_only=True,
                sort="fame", dirn="desc", page=1, limit=40, free_only=False, label=None):
    where, args = [], []
    if label == "none":
        where.append("labels=''")
    elif label == "range":
        where.append("labels LIKE '%,%,%'")
    elif label in C.GENRES:
        where.append("(',' || labels || ',') LIKE ?")
        args.append(f"%,{label},%")
    if q:
        where.append("name LIKE ?")
        args.append(f"%{q}%")
    if status == "market":
        where.append(f"status IN {MARKET}")
    elif status == "any":
        if not alive_only:
            pass
        else:
            where.append(f"status IN {ALIVE}")
    else:
        where.append("status=?")
        args.append(status)
    if gender in ("m", "f"):
        where.append("gender=?")
        args.append(gender)
    if min_age is not None:
        where.append("age>=?")
        args.append(int(min_age))
    if max_age is not None:
        where.append("age<=?")
        args.append(int(max_age))
    if min_fame is not None:
        where.append("fame>=?")
        args.append(float(min_fame))
    if max_fame is not None:
        where.append("fame<=?")
        args.append(float(max_fame))
    if signed == "player":
        where.append("studio='player'")
    elif signed == "rival":
        where.append("studio IS NOT NULL AND studio<>'player'")
    elif signed == "free":
        where.append("studio IS NULL")
    if free_only:
        where.append(f"status IN {MARKET} AND (busy_until < ? OR busy_until IS NULL)")
        args.append(w.abs_week)
    wsql = (" WHERE " + " AND ".join(where)) if where else ""
    col = SORTABLE.get(sort, "fame")
    d = "ASC" if str(dirn).lower().startswith("a") else "DESC"
    total = w.db.scalar(f"SELECT COUNT(*) FROM actors{wsql}", tuple(args), 0)
    try:
        limit = max(1, min(200, int(limit)))
        page = max(1, int(page))
    except Exception:
        limit, page = 40, 1
    off = (page - 1) * limit
    rows = w.db.q(f"SELECT {LIST_COLS} FROM actors{wsql} "
                  f"ORDER BY {col} {d}, id ASC LIMIT ? OFFSET ?",
                  tuple(args) + (limit, off))
    return dict(rows=[dict(r) for r in rows], total=total, page=page,
                pages=max(1, (total + limit - 1) // limit), limit=limit)


def get(w, aid):
    r = w.db.q1("SELECT * FROM actors WHERE id=?", (aid,))
    return dict(r) if r else None


def actor_detail(w, aid: int):
    a = get(w, aid)
    if not a:
        return None
    a["is_available"] = (a["status"] in ("available", "working", "star")
                         and (a["busy_until"] or -1) < w.abs_week
                         and (not a["studio"] or a["studio"] == "player"))
    rep = {}
    for g in C.GENRES:
        est, pm = perceived(w, fit_for_genre(a, g), aid, a["fame"], "fit_" + g, spread=20)
        rep[g] = dict(est=est, pm=pm)
    a["scout"] = rep
    a["best_genre"] = max(rep.items(), key=lambda kv: kv[1]["est"])[0]
    films = [dict(x, studio=None, ours=True) for x in w.db.q(
        """SELECT mo.id AS movie_id, mo.title, mo.year, mo.week, mo.genre, mo.gross, mo.outcome,
                  cm.role, cm.kind, mo.critics, mo.audience, mo.franchise_id, cm.grade, cm.perf,
                  mo.wins, mo.noms
           FROM cast_members cm JOIN movies mo ON mo.id=cm.movie_id
           WHERE cm.actor_id=? ORDER BY mo.year DESC, mo.week DESC LIMIT 30""", (aid,))]
    films += [dict(x, ours=False, outcome=None, role="lead", kind="lead", grade=None) for x in w.db.q(
        """SELECT NULL AS movie_id, title, year, week, genre, gross, studio, quality AS critics
           FROM rival_releases WHERE lead_id=? ORDER BY year DESC, week DESC LIMIT 30""", (aid,))]
    films.sort(key=lambda x: (-(x["year"] or 0), -(x["week"] or 0)))
    a["filmography"] = films[:30]
    a["fee_est"] = universe.fee_for(a.get("fame", 0), a["star_power"], w.year)
    return a


# --------------------------------------------------------------------------- #
#  Availability, contracts, development
# --------------------------------------------------------------------------- #
def away_reason(w, a):
    """World events that take people off the market: the wartime draft (young
    men) and the blacklist hearings (anyone). Deterministic per actor and year,
    so the same people stay gone for the duration."""
    from . import events as E
    from ..rng import unit
    draft = E.fx(w, "sum:draft")
    if draft and a.get("gender") == "m" and 18 <= (a.get("age") or 0) <= 38 \
            and unit(w.seed, "draft", a["id"], w.year) < min(0.75, draft * 4.0):
        return "in uniform (drafted)"
    named = E.fx(w, "sum:actor_unavailable")
    if named and unit(w.seed, "hearing", a["id"], w.year) < min(0.5, named * 3.0):
        return "named in the hearings - nobody will hire them"
    return None


def is_free(w, a) -> bool:
    if a["status"] not in ("available", "working", "star"):
        return False
    if away_reason(w, a):
        return False
    if (a["busy_until"] or -1) >= w.abs_week:
        return False
    if a["studio"] and a["studio"] != "player":
        return False
    return True


# role kinds as stored on `roles.kind` (lead|supporting|cameo|voice); the short
# aliases are kept for any older caller
KIND_FEE = {"lead": 1.0, "supporting": 0.60, "support": 0.60, "cameo": 0.30, "minor": 0.30,
            "voice": 0.50, "extra": 0.15}


def effective_fee(w, a, kind: str = "lead", scale: str = None, budget: float = None) -> float:
    """What casting this actor into *this* role actually costs.

    Fees are quoted against a standard picture and then flexed with the size of
    yours: a blockbuster pays stars more, a B-picture pays them less - which is
    exactly how a studio learned to make a Western for $180,000.
    """
    std = C.standard_cost(w.year)
    base = budget if budget and budget > 0 else std
    ratio = (base / std) ** 0.6 if std else 1.0
    if a.get("studio") == "player" and a.get("contract_films", 0) > 0:
        core = (a.get("contract_fee") or 0) / std
    else:
        core = 0.030 + 0.16 * (max(0.0, float(a.get("fame") or 0)) / 100.0) ** 1.8
    # the budget ratio above already flexes with scale; role weight does the rest
    mult = KIND_FEE.get(kind, 0.4)
    if a.get("t_scandal", 0) > 55:
        mult *= 1.12
    if a.get("t_substance", 0) > 55:
        mult *= 0.94
    return max(std * 0.004, core * ratio * mult * std)


def sign(w, aid: int, films: int = 1):
    a = get(w, aid)
    if not a:
        return dict(ok=False, error="no such actor")
    if a["status"] not in ("available", "working", "star"):
        return dict(ok=False, error=f"{a['name']} is {a['status']}")
    if a["studio"] and a["studio"] != "player":
        return dict(ok=False, error=f"{a['name']} is contracted to {a['studio']}")
    films = films if films in C.CONTRACT_DISCOUNT else 1
    bonus = a["fee"] * (0.12 + 0.23 * films)
    if not w.can_afford(bonus):
        return dict(ok=False, error=f"needs ${bonus:,.0f} signing bonus")
    w.spend(bonus, "cast", f"Signing bonus: {a['name']} ({films}-picture)")
    eff = a["fee"] * C.CONTRACT_DISCOUNT[films]
    w.db.execute("""UPDATE actors SET studio='player', contract_films=?, contract_fee=?,
                    contract_until=? WHERE id=?""", (films, eff, w.abs_week + 52 * 10, aid))
    universe.log(w.year, w.week, "talent", f"Signed {a['name']}",
                 f"{films}-picture deal at ${eff:,.0f} a picture (${bonus:,.0f} down).")
    return dict(ok=True, bonus=bonus, per_picture=eff)


def release_actor(w, aid: int):
    a = get(w, aid)
    if not a or a["studio"] != "player":
        return dict(ok=False, error="not under contract to you")
    buy = a["contract_fee"] * max(1, a["contract_films"]) * 0.25
    if not w.can_afford(buy):
        return dict(ok=False, error="cannot afford the buy-out")
    w.spend(buy, "cast", f"Buy-out: {a['name']}")
    w.db.execute("""UPDATE actors SET studio=NULL, contract_films=0, contract_fee=0,
                    contract_until=0 WHERE id=?""", (aid,))
    return dict(ok=True, buyout=buy)


# kind -> (label, cost as fraction of a standard picture, sql, gains-from-roll)
COACH = {
    "coach_drama": ("Drama & scene-work coaching", 0.035,
                    "UPDATE actors SET s_drama=MIN(99,s_drama+?), s_comedy=MIN(99,s_comedy+?), "
                    "craft=MIN(99,craft+?) WHERE id=?", (1.0, 0.5, 0.5)),
    "coach_action": ("Stunt & physical camp", 0.035,
                     "UPDATE actors SET s_action=MIN(99,s_action+?), s_stunts=MIN(99,s_stunts+?),"
                     " craft=MIN(99,craft+?) WHERE id=?", (1.0, 1.2, 0.4)),
    "coach_voice": ("Voice & musical coaching", 0.03,
                    "UPDATE actors SET s_voice=MIN(99,s_voice+?), s_musicality=MIN(99,s_musicality+?),"
                    " craft=MIN(99,craft+?) WHERE id=?", (1.0, 0.9, 0.4)),
    "rehab": ("Private clinic (rehab)", 0.05,
              "UPDATE actors SET t_substance=MAX(2,t_substance-?), t_scandal=MAX(2,t_scandal-?),"
              " t_discipline=MIN(99,t_discipline+?) WHERE id=?", (5.0, 3.2, 1.8)),
    "image": ("Image / press rebrand", 0.04,
              "UPDATE actors SET t_charisma=MIN(99,t_charisma+?), t_likeability=MIN(99,t_likeability+?),"
              " t_press=MIN(99,t_press+?) WHERE id=?", (1.0, 0.8, 1.6)),
}


# what the dashboard (and older saves' habits) may send -> programme key
COACH_ALIAS = {"coach": "coach_drama", "drama": "coach_drama", "comedy": "coach_drama",
               "action": "coach_action", "stunts": "coach_action",
               "voice": "coach_voice", "musicality": "coach_voice", "dance": "coach_voice"}


def coach_options(w):
    gym = w.db.scalar("SELECT count FROM buildings WHERE kind='gym'", 0) or 0
    std = C.standard_cost(w.year)
    return [dict(id=k, label=v[0], cost=round(std * v[1] * max(0.55, 1.0 - 0.12 * gym), 0))
            for k, v in COACH.items()]


def develop(w, aid: int, kind: str):
    a = get(w, aid)
    if not a:
        return dict(ok=False, error="no such actor")
    kind = COACH_ALIAS.get(kind, kind)
    if a["status"] not in ("available", "working", "star", "blacklisted"):
        return dict(ok=False, error=f"{a['name']} is {a['status']}")
    if kind not in COACH:
        return dict(ok=False, error="unknown programme")
    label, frac, sql, mults = COACH[kind]
    gym = w.db.scalar("SELECT count FROM buildings WHERE kind='gym'", 0) or 0
    cost = C.standard_cost(w.year) * frac * max(0.55, 1.0 - 0.12 * gym)
    if not w.can_afford(cost):
        return dict(ok=False, error=f"needs ${cost:,.0f}")
    rnd = stream(w.seed, "develop", aid, w.abs_week, kind)
    gain = rnd.uniform(2.4, 6.4) * (1.0 + 0.15 * gym)
    w.db.execute(sql, tuple(gain * m for m in mults) + (aid,))
    msg = {"rehab": "Checked in quietly. The press is told to back off.",
           "image": "New hair, new agent, new narrative."}.get(
        kind, f"Craft work pays off: +{gain:.1f} in the booth.")
    w.spend(cost, "talent", f"{label}: {a['name']}")
    universe.log(w.year, w.week, "talent", f"{a['name']}: {label}", msg)
    return dict(ok=True, cost=cost, msg=msg, gain=round(gain, 1))


def publicity(w, aid: int):
    a = get(w, aid)
    if not a:
        return dict(ok=False, error="no such actor")
    cost = C.standard_cost(w.year) * 0.018
    if not w.can_afford(cost):
        return dict(ok=False, error=f"needs ${cost:,.0f}")
    rnd = stream(w.seed, "publicity", aid, w.abs_week)
    if rnd.random() < a["t_scandal"] / 240.0:
        loss = rnd.uniform(4, 14)
        w.db.execute("UPDATE actors SET fame=MAX(0,fame-?), t_press=MAX(2,t_press-6) WHERE id=?",
                     (loss, aid))
        msg = f"The campaign collapses: fame -{loss:.0f}."
    else:
        gain = rnd.uniform(3, 10)
        w.db.execute("UPDATE actors SET fame=MIN(100,fame+?), t_press=MIN(99,t_press+3) WHERE id=?",
                     (gain, aid))
        msg = f"Magazine cover lands: fame +{gain:.0f}."
    w.spend(cost, "talent", f"Publicity: {a['name']}")
    return dict(ok=True, cost=cost, msg=msg)


def blacklist(w, aid: int):
    a = get(w, aid)
    if not a:
        return dict(ok=False, error="no such actor")
    w.db.execute("""UPDATE actors SET status='blacklisted', fame=MAX(0,fame*0.35),
                    studio=NULL, contract_films=0, contract_until=0 WHERE id=?""", (aid,))
    w.add_reputation(-3)
    universe.log(w.year, w.week, "talent", f"{a['name']} blacklisted",
                 "You would rather not hire them. The town quietly agrees. They get cheap.")
    return dict(ok=True)


def hire_from_rival(w, aid: int):
    """Buy out a rival's contract for one picture (expensive, makes enemies)."""
    a = get(w, aid)
    if not a or not a["studio"] or a["studio"] == "player":
        return dict(ok=False, error="not contracted to a rival")
    cost = a["fee"] * 1.9
    if not w.can_afford(cost):
        return dict(ok=False, error=f"needs ${cost:,.0f}")
    w.spend(cost, "cast", f"Contract buy-out: {a['name']} from {a['studio']}")
    w.db.execute("""UPDATE actors SET studio='player', contract_films=1, contract_fee=fee,
                    contract_until=? WHERE id=?""", (w.abs_week + 52, aid))
    universe.log(w.year, w.week, "talent", f"{a['name']} poached from {a['studio']}",
                 "Nobody in this town forgets a poaching.", weight=2)
    return dict(ok=True, cost=cost)


def loan_out_quote(w, a) -> dict:
    std = C.standard_cost(w.year)
    fee = max(std * 0.01, (a["fee"] or 0) * 1.25)
    return dict(fee=round(fee, 0), weeks=20)


def loan_out(w, aid: int):
    """Rent a contract player to a rival for one picture. You pocket more than
    their fee, they get screen time (and some fame) - and they are not yours to
    cast until they are back. The deal on your books is untouched."""
    a = get(w, aid)
    if not a or a["studio"] != "player" or a["contract_films"] <= 0:
        return dict(ok=False, error="only your own contract players can be loaned out")
    if (a["busy_until"] or -1) >= w.abs_week:
        return dict(ok=False, error=f"{a['name']} is already working")
    rivals = [r["name"] for r in w.db.q("SELECT name FROM rivals WHERE alive=1 ORDER BY cash DESC LIMIT 4")]
    if not rivals:
        return dict(ok=False, error="nobody to loan them to")
    rnd = stream(w.seed, "loanout", aid, w.abs_week)
    to = rnd.choice(rivals)
    q = loan_out_quote(w, a)
    w.earn(q["fee"], "cast", f"Loan-out: {a['name']} to {to}")
    w.db.execute("UPDATE actors SET busy_until=?, films=films+1 WHERE id=?", (w.abs_week + q["weeks"], aid))
    gain = rnd.uniform(1.0, 6.0) * (1.4 if a["fame"] < 30 else 1.0)
    bump_fame(w, aid, gain)
    universe.log(w.year, w.week, "talent", f"{a['name']} loaned to {to}",
                 f"${q['fee']:,.0f} to you for {q['weeks']} weeks of their time. Fame +{gain:.0f}.")
    return dict(ok=True, fee=q["fee"], rival=to, weeks=q["weeks"], fame=round(gain, 1))


def poach(w, aid: int, rival: str):
    """A rival buys one of your contract players out from under you. Anyone
    already in front of a camera for you finishes the picture first."""
    a = get(w, aid)
    if not a or a["studio"] != "player":
        return dict(ok=False)
    if (a["busy_until"] or -1) >= w.abs_week:
        return dict(ok=False)
    comp = (a["contract_fee"] or a["fee"]) * max(1, a["contract_films"]) * 0.30
    w.earn(comp, "cast", f"Contract buy-out received: {a['name']} to {rival}")
    w.db.execute("""UPDATE actors SET studio=?, contract_films=2, contract_fee=fee,
                    contract_until=? WHERE id=?""", (rival, w.abs_week + 104, aid))
    universe.log(w.year, w.week, "talent", f"{rival} poaches {a['name']}",
                 f"They bought out the contract. You get ${comp:,.0f} and an empty dressing room.",
                 weight=2)
    return dict(ok=True, rival=rival, compensation=comp)


def finish_picture(w, actor_ids):
    """A picture is out: everyone on a studio contract has one fewer to owe.
    When the last one is delivered the deal is done and they are free agents."""
    ids = [int(i) for i in actor_ids if i]
    if not ids:
        return
    marks = ",".join("?" * len(ids))
    w.db.execute(f"""UPDATE actors SET contract_films=contract_films-1
                     WHERE id IN ({marks}) AND studio='player' AND contract_films>0""", ids)
    done = w.db.q(f"""SELECT id,name FROM actors WHERE id IN ({marks}) AND studio='player'
                      AND contract_films<=0""", ids)
    for r in done:
        w.db.execute("""UPDATE actors SET studio=NULL, contract_films=0, contract_fee=0,
                        contract_until=0 WHERE id=?""", (r["id"],))
        universe.log(w.year, w.week, "talent", f"{r['name']}'s contract is fulfilled",
                     "The last picture on the deal is out. Re-sign them before somebody else does.")


def reserve(w, aid: int, weeks: int):
    w.db.execute("UPDATE actors SET busy_until=?, status=CASE WHEN status='available' THEN 'working' ELSE status END WHERE id=?",
                 (w.abs_week + weeks, aid))


def bump_fame(w, aid: int, amount: float, cult: float = 0.0):
    if aid is None or aid < 0:
        return
    w.db.execute("""UPDATE actors SET fame=MIN(100.0, MAX(0.0, fame + ?)),
                    cult=MIN(100.0, cult + ?) WHERE id=?""", (amount, cult, aid))


def credit_performance(w, aid: int, gross: float, quality: float, lead: bool, cult: bool,
                       fame_gain: float):
    w.db.execute("""UPDATE actors SET films=films+1, leads=leads+?, total_gross=total_gross+?,
                    best_gross=MAX(best_gross,?), last_work_year=? WHERE id=?""",
                 (1 if lead else 0, gross * 0.12, gross, w.year, aid))
    bump = fame_gain
    if cult:
        w.db.execute("UPDATE actors SET cult=MIN(100, cult+?) WHERE id=?",
                     (min(18, 4 + quality * 0.12), aid))
    bump_fame(w, aid, bump)


# --------------------------------------------------------------------------- #
#  Rival talent acquisition (keeps the market contested)
# --------------------------------------------------------------------------- #
def rivals_sign_talent(w, n: int = 22):
    rnd = stream(w.seed, "rivalsign", w.year)
    rivals = [r["name"] for r in w.db.q("SELECT name FROM rivals WHERE alive=1")]
    if not rivals:
        return 0
    rows = w.db.q(f"""SELECT id, name FROM actors
                      WHERE studio IS NULL AND status IN ('available','working') AND fame < 58
                        AND age BETWEEN 16 AND 46 AND films < 8
                      ORDER BY (r % 977) LIMIT ?""", (n,))
    for r in rows:
        w.db.execute("""UPDATE actors SET studio=?, contract_films=?, contract_fee=fee*0.85,
                        contract_until=? WHERE id=?""",
                     (rnd.choice(rivals), rnd.choice([2, 3, 5]),
                      w.abs_week + 52 * rnd.randint(3, 7), r["id"]))
    return len(rows)
