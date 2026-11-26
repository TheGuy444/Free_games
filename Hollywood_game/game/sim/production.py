"""Productions: greenlight, budgeting, upgrades, casting, the shoot, hazards.

Economics of one picture
------------------------
budget (nominal $) covers crew/shoot, production values (upgrade tiers) and
contingency.  Cast fees and marketing come out of the studio account on top.
Overspending the budget is possible - it just drains the studio and invites
audits, cost blowouts and a quality penalty for the money you could not spend.
"""
from __future__ import annotations

import json

from .. import config as C
from .. import names as N
from .. import universe
from ..rng import clamp, stream, unit
from . import actors as A
from . import events as E

# quality weights per genre: script, cast, direction, production values
GENRE_QW = {
    "drama":     dict(script=0.38, cast=0.30, direction=0.14, values=0.12, chem=0.06),
    "comedy":    dict(script=0.40, cast=0.28, direction=0.10, values=0.10, chem=0.12),
    "action":    dict(script=0.18, cast=0.24, direction=0.16, values=0.34, chem=0.08),
    "sci-fi":    dict(script=0.22, cast=0.20, direction=0.16, values=0.36, chem=0.06),
    "horror":    dict(script=0.26, cast=0.22, direction=0.16, values=0.30, chem=0.06),
    "western":   dict(script=0.24, cast=0.26, direction=0.16, values=0.28, chem=0.06),
    "musical":   dict(script=0.20, cast=0.38, direction=0.14, values=0.28, chem=0.10),
    "crime":     dict(script=0.30, cast=0.28, direction=0.16, values=0.20, chem=0.06),
    "romance":   dict(script=0.30, cast=0.30, direction=0.12, values=0.16, chem=0.22),
    "animation": dict(script=0.24, cast=0.20, direction=0.14, values=0.44, chem=0.04),
}

ROLE_NAMES = {
    "lead": ["The Lead", "The Protagonist", "The Hero", "The Outsider", "The Star"],
    "lead_f": ["The Ingenue", "The Heroine", "The Femme Fatale", "The Leading Lady"],
    "support": ["The Mentor", "The Sidekick", "The Veteran", "The Heavy", "The Confidant",
                "The Reporter", "The Boss", "The Rival", "The Neighbor", "The Doctor"],
    "cameo": ["Cameo", "Curtain Call", "Small Role", "Uncredited Walk-On"],
}

DEFAULT_UPGRADES = {k: 1 for k in C.UPGRADES}
DEFAULT_UPGRADES["marketing"] = 1


# --------------------------------------------------------------------------- #
#  Costing helpers
# --------------------------------------------------------------------------- #
def _weights(genre: str) -> dict:
    w = C.GENRE_UPGRADE_WEIGHT[genre]
    mx = max(w.values())
    return {k: v / mx for k, v in w.items()}


def upgrade_cost(w, budget: float, genre: str, cat: str, tier: int) -> float:
    if tier <= 0:
        return 0.0
    weights = _weights(genre)
    share = 0.24 * weights.get(cat, 0.5)
    cost = budget * C.TIER_COST[min(tier, 6)] * share
    # your own backlot builds sets in-house; an effects lab does the same for SFX
    shop = {"sets": "backlot", "sfx": "vfx_lab"}.get(cat)
    if shop and w is not None:
        n = w.db.scalar("SELECT count FROM buildings WHERE kind=?", (shop,), 0) or 0
        cost *= max(0.6, 1.0 - 0.08 * n)
    return cost


def tech_ok(w, cat: str, tier: int) -> bool:
    need = C.TIER_TECH.get(cat, {}).get(tier)
    return (not need) or w.tech_on(need)


def max_tier(w, cat: str) -> int:
    top = 6
    for t in range(1, 7):
        if not tech_ok(w, cat, t):
            return t - 1
    return top


def budget_split(p):
    """Where the money on this picture is going, for the dashboard."""
    budget = max(1.0, p["budget"])
    return dict(
        budget=budget,
        cast=p["cast_spend"],
        crew=budget * 0.50,
        values=budget * 0.30,
        contingency=budget * 0.20,
        marketing=p["marketing"],
        spent=p["spent"],
        over=max(0.0, p["spent"] + p["cast_spend"] - budget),
    )


# --------------------------------------------------------------------------- #
#  Greenlight
# --------------------------------------------------------------------------- #
def create(w, script_id: int, title: str = None, scale: str = None, budget: float = None,
           marketing: float = None, director_id: int = None, upgrades: dict = None,
           franchise_id: int = None, kind: str = "new", formats=None, bond: bool = False):
    s = w.db.q1("SELECT * FROM scripts WHERE id=?", (script_id,))
    if not s:
        return dict(ok=False, error="no such script")
    if s["owner"] != "player" or s["status"] not in ("owned", "optioned"):
        return dict(ok=False, error="you must own or option that script")
    # a script written for one of our series is that series' next picture,
    # however it is greenlit (it used to become a stray one-off with the
    # series' name on it)
    if not franchise_id and s["source_franchise"]:
        fr0 = w.db.q1("SELECT id, rights FROM franchises WHERE id=?", (s["source_franchise"],))
        if fr0 and fr0["rights"] == "player":
            franchise_id = fr0["id"]
            if kind == "new":
                kind = "reboot" if s["origin"] in ("reboot", "remake") else "sequel"
    scale = scale or s["scale"]
    if scale not in C.SCALES:
        return dict(ok=False, error="unknown scale")
    std = C.standard_cost(w.year)
    ideal = std * C.SCALES[scale]["mult"]
    budget = float(budget) if budget else round(ideal * 1.0, -3)
    if budget < ideal * 0.18:
        return dict(ok=False, error=f"this scale needs at least ${ideal*0.18:,.0f}")
    marketing = float(marketing) if marketing is not None else round(budget * 0.25, -3)
    from . import economy
    slots = economy.max_productions(w)
    busy = w.db.scalar("""SELECT COUNT(*) FROM productions WHERE status IN
                          ('development','pre_production','shooting','post_production')""", (), 0)
    if busy >= slots:
        return dict(ok=False, error=f"every sound stage is booked ({busy}/{slots} pictures in work) "
                                    f"- build another stage or wait for a wrap")
    dcost = 0.0
    if director_id:
        d = w.db.q1("SELECT * FROM directors WHERE id=?", (director_id,))
        if not d:
            return dict(ok=False, error="no such director")
        why = _director_unavailable(w, d)
        if why:
            return dict(ok=False, error=why)
        dcost = director_fee(d, scale)
    from . import formats as FM
    fmts = [f for f in (formats or []) if f in FM.FORMATS and FM.available(w, f) and not FM.is_standard(w, f)]
    fcost = sum(budget * FM.cost_frac(w, f) for f in fmts)
    ecost = sum(c["amount"] for c in FM.era_costs(w, budget))
    bcost = FM.bond_cost(budget) if (bond and FM.bond_available(w)) else 0.0
    need = (budget * 0.18 + marketing + dcost + max(0.0, fcost) + ecost + bcost
            + (0.0 if s["status"] == "owned" else s["price"] * 0.82))
    if not w.can_afford(need):
        return dict(ok=False, error=f"needs ${need:,.0f} down (budget draw + prints + director + script)")
    title = (title or s["title"]).strip()[:80] or N.movie_title(stream(w.seed, "title", script_id), s["genre"])
    N.take(title)

    if s["status"] == "optioned":
        remainder = s["price"] * 0.82
        w.spend(remainder, "script", f"Option exercise: {s['title']}")
    w.db.execute("UPDATE scripts SET owner='player', status='in_production', title=? WHERE id=?",
                 (title, script_id))
    if not w.can_afford(marketing):
        marketing = max(0.0, w.cash * 0.5)
    w.spend(marketing, "marketing", f"Prints & ads committed: {title}")
    w.spend(budget * 0.18, "production", f"Greenlight draw: {title}")

    ups = dict(DEFAULT_UPGRADES)
    if upgrades:
        for k, v in upgrades.items():
            if k in ups:
                v = max(0, min(max_tier(w, k), int(v)))
                ups[k] = v
    r_lo, r_hi = C.SCALES[scale]["weeks"]
    weeks = int((r_lo + r_hi) / 2)
    dev_w = 3 + (2 if scale in ("epic", "blockbuster") else 0)
    pre_w = 3 + (1 if scale in ("epic", "blockbuster") else 0)
    post_w = 4 + (2 if scale in ("epic", "blockbuster") else 0)
    weeks_all = dev_w + pre_w + weeks + post_w
    fr = w.db.q1("SELECT * FROM franchises WHERE id=?", (franchise_id,)) if franchise_id else None
    seq_index = 1
    if fr:
        from . import franchise as F
        seq_index = F.next_index(w, fr)
    cur = w.db.execute("""INSERT INTO productions(title,script_id,genre,subgenre,scale,budget,spent,
                    marketing,cast_spend,upgrades,director_id,status,phase_weeks,weeks_total,
                    weeks_left,weeks_all,quality,hype,craft,created_year,start_week,franchise_id,
                    seq_index,log)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,'development',?,?,?,?,0,?,?,?,?,?,?,?)""",
                       (title, script_id, s["genre"], s["subgenre"], scale, budget, 0.0, marketing,
                        0.0, json.dumps(ups), None, dev_w, weeks, dev_w, weeks_all,
                        _initial_hype(w, s, seq_index, fr), 0.0, w.year, w.abs_week,
                        franchise_id, seq_index,
                        json.dumps([f"{w.year}: greenlit as {C.SCALES[scale]['label']}"])))
    pid = cur.lastrowid
    make_roles(w, pid, s, scale)
    if franchise_id:
        from . import characters
        characters.bind_roles(w, pid, franchise_id)     # the parts are the series' characters
    if director_id:
        set_director(w, pid, director_id)      # charges the fee and books them
    FM.charge_era_costs(w, pid, budget, title)
    if fmts:
        FM.set_formats(w, pid, fmts)
    if bcost:
        FM.take_bond(w, pid)
    apply_upgrades(w, pid)
    universe.log(w.year, w.week, "finance", f"Greenlight: {title}",
                 f"{C.GENRE_LABEL[s['genre']]} {C.SCALES[scale]['label']}, budget ${budget:,.0f} "
                 f"(+${marketing:,.0f} prints). Shooting {weeks} weeks.", weight=2)
    if franchise_id:
        from . import franchise
        franchise.mark_in_production(w, franchise_id, pid)
    return dict(ok=True, id=pid, budget=budget, marketing=marketing, weeks=weeks)


def _initial_hype(w, s, seq_index, fr):
    hype = 8.0 + s["fp"] * 0.18 + s["quality"] * 0.06
    if fr:
        hype += min(40.0, fr["fan_base"] * 0.35) * (1.0 + 0.08 * (seq_index - 1))
    return clamp(hype, 0, 70)


def make_roles(w, pid: int, s, scale: str):
    genre = s["genre"]
    rnd = stream(w.seed, "roles", pid, s["id"])
    weights = C.GENRE_SKILL_WEIGHT[genre]
    primary = max(weights.items(), key=lambda kv: kv[1])[0]
    spec = {"short": (1, 1, 0), "indie": (2, 2, 0), "standard": (2, 4, 1),
            "epic": (2, 6, 2), "blockbuster": (2, 6, 2)}[scale]
    n_lead, n_sup, n_cameo = spec
    kind_voice = "voice" if genre == "animation" else "lead"
    rows = []
    min_skill = clamp(18 + s["quality"] * 0.45 + {"short": -6, "indie": 0, "standard": 4,
                                                  "epic": 8, "blockbuster": 12}[scale], 8, 80)
    genders = ["m", "f"]
    for i in range(n_lead):
        g = genders[i % 2] if n_lead == 2 else ("any" if rnd.random() < 0.3 else rnd.choice(genders))
        rows.append(dict(idx=i, name=rnd.choice(ROLE_NAMES["lead_f"] if g == "f" else ROLE_NAMES["lead"]),
                         kind=kind_voice, skill="voice" if genre == "animation" else primary,
                         weight=0.34 if n_lead == 2 else 0.55,
                         min_skill=min_skill, min_age=22 + int(i * 2), max_age=58 if scale != "epic" else 66,
                         gender=g, want_stunts=1 if genre in ("action", "western", "sci-fi") else 0,
                         want_dance=1 if genre == "musical" else 0,
                         want_voice=1 if genre == "animation" else 0))
    for i in range(n_sup):
        rows.append(dict(idx=n_lead + i, name=rnd.choice(ROLE_NAMES["support"]), kind="supporting",
                         skill=rnd.choice([primary, "drama", "comedy"]),
                         weight=0.30 / max(1, n_sup),
                         min_skill=clamp(min_skill * 0.65, 5, 70),
                         min_age=rnd.choice([20, 25, 30, 35, 45]), max_age=rnd.choice([55, 65, 78, 88]),
                         gender=rnd.choice(["m", "f", "m", "f", "any"]),
                         want_stunts=1 if genre in ("action", "sci-fi") and rnd.random() < 0.4 else 0,
                         want_dance=1 if genre == "musical" and rnd.random() < 0.6 else 0,
                         want_voice=0, ))
    for i in range(n_cameo):
        rows.append(dict(idx=n_lead + n_sup + i, name=rnd.choice(ROLE_NAMES["cameo"]), kind="cameo",
                         skill="comedy", weight=0.04, min_skill=10,
                         min_age=18, max_age=90, gender="any",
                         want_stunts=0, want_dance=0, want_voice=0))
    # normalise weights to 1
    tot = sum(r["weight"] for r in rows) or 1.0
    for r in rows:
        r["weight"] = round(r["weight"] / tot, 4)
    w.db.executemany("""INSERT INTO roles(production_id,idx,name,kind,skill,weight,min_skill,min_age,
                        max_age,gender,want_stunts,want_dance,want_voice)
                        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                     [(pid, r["idx"], r["name"], r["kind"], r["skill"], r["weight"], r["min_skill"],
                       r["min_age"], r["max_age"], r["gender"], r["want_stunts"], r["want_dance"],
                       r["want_voice"]) for r in rows])


# --------------------------------------------------------------------------- #
#  Mutations
# --------------------------------------------------------------------------- #
def _ups(p) -> dict:
    """Upgrade tiers as a dict, whether the row is raw or already parsed."""
    u = p.get("upgrades") if hasattr(p, "get") else None
    if isinstance(u, str):
        try:
            return json.loads(u or "{}")
        except Exception:
            return {}
    return dict(u or {})


def get(w, pid: int):
    r = w.db.q1("SELECT * FROM productions WHERE id=?", (pid,))
    if not r:
        return None
    p = dict(r)
    p["upgrades"] = _ups(p)
    try:
        p["log"] = json.loads(p.get("log") or "[]")
    except Exception:
        p["log"] = []
    return p


def add_log(w, pid: int, text: str):
    p = w.db.q1("SELECT log FROM productions WHERE id=?", (pid,))
    try:
        log = json.loads(p["log"] if p else "[]")
    except Exception:
        log = []
    log.append(f"{w.year} w{w.week}: {text}")
    w.db.execute("UPDATE productions SET log=? WHERE id=?", (json.dumps(log[-40:]), pid))


def set_upgrade(w, pid: int, cat: str, tier: int):
    if cat not in C.UPGRADES:
        return dict(ok=False, error="unknown category")
    p = get(w, pid)
    if not p:
        return dict(ok=False, error="no such production")
    if p["status"] not in ("development", "pre_production", "shooting"):
        return dict(ok=False, error="too late to change " + cat)
    tier = max(0, min(max_tier(w, cat), int(tier)))
    ups = _ups(p)
    cur = int(ups.get(cat, 0))
    if tier == cur:
        return dict(ok=True, cost=0.0)
    delta = upgrade_cost(w, p["budget"], p["genre"], cat, tier) - upgrade_cost(
        w, p["budget"], p["genre"], cat, cur)
    if delta > 0 and not w.can_afford(delta):
        return dict(ok=False, error=f"needs ${delta:,.0f}")
    if delta != 0:
        w.spend(delta, "production", f"{C.UPGRADES[cat]['label']} T{tier}: {p['title']}")
    ups[cat] = tier
    w.db.execute("UPDATE productions SET upgrades=? WHERE id=?", (json.dumps(ups), pid))
    apply_upgrades(w, pid)
    return dict(ok=True, cost=delta, tier=tier)


def next_upgrade_cost(w, p, cat: str):
    """The next purchasable tier of `cat` and what it costs, or None."""
    ups = p["upgrades"] if isinstance(p["upgrades"], dict) else json.loads(p["upgrades"] or "{}")
    cur = int(ups.get(cat, 0) or 0)
    if cur >= max_tier(w, cat):
        return None
    tier = cur + 1
    need = C.TIER_TECH.get(cat, {}).get(tier)
    return dict(cat=cat, label=C.UPGRADES[cat]["label"], tier=tier,
                cost=upgrade_cost(w, p["budget"], p["genre"], cat, tier),
                needs_tech=need, unlocked=need is None or w.tech_on(need))


def upgrade_costs(w, pid: int):
    """Everything the production designer could buy, priced, with the quality
    each step is worth - the actual upgrade screen."""
    p = get(w, pid)
    if not p:
        return []
    out = []
    for cat, spec in C.UPGRADES.items():
        cur = int(p["upgrades"].get(cat, 0) or 0)
        wgt = _weights(p["genre"])[cat]
        row = dict(cat=cat, label=spec["label"], desc=spec["desc"], tier=cur,
                   max=max_tier(w, cat), weight=round(wgt, 2),
                   contrib=round(wgt * spec["floor"] * 100 * (1 + cur * 0.0), 1))
        nxt = next_upgrade_cost(w, p, cat)
        if nxt:
            row["next_tier"] = nxt["tier"]
            row["cost"] = round(nxt["cost"], 0)
            row["affordable"] = w.cash >= nxt["cost"]
            row["gain"] = round(wgt * (spec["floor"] * 100 * nxt["tier"] -
                                       spec["floor"] * 100 * cur), 1)
        out.append(row)
    out.sort(key=lambda r: -r.get("gain", 0))
    return out


def role_slots(w, pid: int):
    return [dict(r) for r in w.db.q("SELECT * FROM roles WHERE production_id=? ORDER BY idx",
                                    (pid,))]


def set_budget(w, pid: int, budget: float):
    p = get(w, pid)
    if not p:
        return dict(ok=False, error="no such production")
    if p["status"] not in ("development", "pre_production"):
        return dict(ok=False, error="the camera is already rolling")
    ideal = C.standard_cost(w.year) * C.SCALES[p["scale"]]["mult"]
    budget = max(ideal * 0.18, float(budget))
    delta = (budget - p["budget"]) * 0.18
    if delta > 0 and not w.can_afford(delta):
        return dict(ok=False, error=f"needs ${delta:,.0f} extra draw")
    if delta != 0:
        w.spend(delta, "production", f"Budget revision: {p['title']}")
    w.db.execute("UPDATE productions SET budget=? WHERE id=?", (budget, pid))
    apply_upgrades(w, pid)
    return dict(ok=True, budget=budget)


def set_marketing(w, pid: int, amount: float):
    p = get(w, pid)
    if not p:
        return dict(ok=False, error="no such production")
    amount = max(0.0, float(amount))
    delta = amount - p["marketing"]
    if delta > 0 and not w.can_afford(delta):
        return dict(ok=False, error=f"needs ${delta:,.0f}")
    if delta != 0:
        w.spend(delta, "marketing", f"Marketing revision: {p['title']}")
    w.db.execute("UPDATE productions SET marketing=? WHERE id=?", (amount, pid))
    return dict(ok=True, marketing=amount)


def director_fee(d, scale: str) -> float:
    return d["fee"] * C.SCALES[scale]["mult"] ** 0.7


def _director_unavailable(w, d):
    if (d["busy_until"] or -1) >= w.abs_week:
        return f"{d['name']} is on another picture"
    if d["status"] == "staff" and d["studio"] != "player":
        return "under contract elsewhere"
    return None


def set_director(w, pid: int, director_id: int):
    p = get(w, pid)
    if not p:
        return dict(ok=False, error="no such production")
    if p["status"] not in ("development", "pre_production", "shooting"):
        return dict(ok=False, error="too late to change the director")
    if p["director_id"] == director_id:
        return dict(ok=True, cost=0.0)
    d = w.db.q1("SELECT * FROM directors WHERE id=?", (director_id,))
    if not d:
        return dict(ok=False, error="no such director")
    why = _director_unavailable(w, d)
    if why:
        return dict(ok=False, error=why)
    cost = director_fee(d, p["scale"])
    if not w.can_afford(cost):
        return dict(ok=False, error=f"needs ${cost:,.0f}")
    w.spend(cost, "cast", f"Director: {d['name']}")
    if p["director_id"]:
        # the old director is paid off and free to work elsewhere
        w.db.execute("UPDATE directors SET busy_until=-1 WHERE id=?", (p["director_id"],))
        add_log(w, pid, f"director replaced by {d['name']}")
    w.db.execute("UPDATE productions SET director_id=? WHERE id=?", (director_id, pid))
    w.db.execute("UPDATE directors SET busy_until=? WHERE id=?", (w.abs_week + _weeks_to_wrap(p) + 4,
                                                                  director_id))
    apply_upgrades(w, pid)
    return dict(ok=True, cost=cost)


def _weeks_to_wrap(p) -> int:
    """Weeks until the picture is in the can, from wherever it is now."""
    big = p["scale"] in ("epic", "blockbuster")
    pre, post = 3 + (1 if big else 0), 4 + (2 if big else 0)
    left = p["weeks_left"] or 0
    return {"development": left + pre + p["weeks_total"] + post,
            "pre_production": left + p["weeks_total"] + post,
            "shooting": left + post,
            "post_production": left}.get(p["status"], left)


def directors_market(w, sort="vision", dirn="desc", page=1, limit=30, free_only=True):
    where = ["1=1"]
    if free_only:
        where.append("(busy_until < ? OR busy_until IS NULL)")
    col = {"vision": "vision", "fee": "fee", "prestige": "prestige", "name": "name",
           "hits": "hits", "films": "films"}.get(sort, "vision")
    d = "ASC" if str(dirn).lower().startswith("a") else "DESC"
    args = [w.abs_week]
    total = w.db.scalar(f"SELECT COUNT(*) FROM directors WHERE {' AND '.join(where)}", tuple(args), 0)
    limit = max(1, min(100, int(limit)))
    rows = w.db.q(f"""SELECT id,name,vision,discipline,temperament,prestige,fee,status,studio,
                      films,hits,busy_until FROM directors WHERE {' AND '.join(where)}
                      ORDER BY {col} {d}, id ASC LIMIT ? OFFSET ?""",
                  tuple(args) + (limit, (max(1, int(page)) - 1) * limit))
    return dict(rows=[dict(r) for r in rows], total=total, pages=max(1, (total + limit - 1) // limit),
                page=int(page))


def cast_role(w, pid: int, role_id: int, actor_id: int):
    p = get(w, pid)
    role = w.db.q1("SELECT * FROM roles WHERE id=? AND production_id=?", (role_id, pid))
    a = A.get(w, actor_id)
    if not p or not role or not a:
        return dict(ok=False, error="missing production/role/actor")
    if p["status"] not in ("development", "pre_production", "shooting"):
        return dict(ok=False, error="too late to recast")
    if not A.is_free(w, a) and not (a["studio"] == "player" and a["contract_films"] > 0):
        return dict(ok=False, error=f"{a['name']} is not available ({a['status']})")
    # remove whoever held the role
    old = role["actor_id"]
    fee = A.effective_fee(w, a, kind=role["kind"], scale=p["scale"], budget=p["budget"])
    if old and old != actor_id:
        prev = A.get(w, old)
        refund = 0.0
        if prev and prev["studio"] != "player":
            refund = role["fee"] * 0.0  # sunk
        w.db.execute("UPDATE actors SET busy_until=-1 WHERE id=? AND busy_until>=?", (old, w.abs_week))
    if a["studio"] and a["studio"] != "player":
        return dict(ok=False, error=f"{a['name']} is under contract to {a['studio']}")
    if not w.can_afford(fee):
        return dict(ok=False, error=f"needs ${fee:,.0f} for {a['name']}")
    on_deal = a["studio"] == "player" and a["contract_films"] > 0
    w.spend(fee, "cast", f"Cast {a['name']} as {role['name']}" + (" (contract rate)" if on_deal else ""))
    w.db.execute("""UPDATE roles SET actor_id=?, fee=? WHERE id=?""", (actor_id, fee, role_id))
    w.db.execute("""UPDATE productions SET cast_spend=(SELECT COALESCE(SUM(fee),0) FROM roles
                    WHERE production_id=?) WHERE id=?""", (pid, pid))
    A.reserve(w, actor_id, max(4, _weeks_to_wrap(p)))
    apply_upgrades(w, pid)
    add_log(w, pid, f"cast {a['name']} ({role['name']})")
    return dict(ok=True, fee=fee, actor=a["name"])


def uncast_role(w, pid: int, role_id: int):
    p = get(w, pid)
    if not p or p["status"] not in ("development", "pre_production", "shooting"):
        return dict(ok=False, error="too late to recast")
    role = w.db.q1("SELECT * FROM roles WHERE id=? AND production_id=?", (role_id, pid))
    if not role or not role["actor_id"]:
        return dict(ok=False, error="nobody in that role")
    w.db.execute("UPDATE roles SET actor_id=NULL, fee=0 WHERE id=?", (role_id,))
    w.db.execute("UPDATE actors SET busy_until=-1 WHERE id=?", (role["actor_id"],))
    w.db.execute("""UPDATE productions SET cast_spend=(SELECT COALESCE(SUM(fee),0) FROM roles
                    WHERE production_id=?) WHERE id=?""", (pid, pid))
    add_log(w, pid, f"recast: {role['name']} is open again")
    apply_upgrades(w, pid)
    return dict(ok=True)


# --------------------------------------------------------------------------- #
#  Live quality model
# --------------------------------------------------------------------------- #
def apply_upgrades(w, pid: int):
    """Recompute craft / cast power / chemistry and the running quality estimate."""
    p = get(w, pid)
    if not p:
        return None
    comp = components(w, p)
    q = quality_from(w, p, comp)
    spread = quality_spread(w, p)
    w.db.execute("""UPDATE productions SET craft=?, cast_power=?, chemistry=?, quality=?,
                    q_low=?, q_high=? WHERE id=?""",
                 (comp["values"], comp["cast"], comp["chem"], q, max(0, q - spread),
                  min(100, q + spread), pid))
    return q


def components(w, p):
    genre = p["genre"]
    ups = _ups(p)
    weights = _weights(genre)
    # production values (props/sets/VFX...), era-capped, building-boosted
    vals = 0.0
    wsum = 0.0
    for cat, wt in weights.items():
        tier = int(ups.get(cat, 0))
        tv = C.TIER_VALUE[min(tier, 6)] if tech_ok(w, cat, tier) else 0
        vals += tv * wt
        wsum += wt
    vals = vals / max(wsum, 0.001)
    # buildings
    for kind, bonus in (("stage", 3), ("backlot", 4), ("vfx_lab", 5)):
        n = w.db.scalar("SELECT count FROM buildings WHERE kind=?", (kind,), 0) or 0
        vals += bonus * n
    # era ceiling: early sound / pre-colour pictures cannot hit modern values
    ceiling = 42.0
    if w.tech_on("sound"):
        ceiling += 12
    if w.tech_on("colour"):
        ceiling += 14
    if w.tech_on("widescreen"):
        ceiling += 6
    if w.tech_on("cgi"):
        ceiling += 18
    if w.tech_on("imax"):
        ceiling += 5
    vals = clamp(vals, 0, ceiling)
    # formats sit on top of the era ceiling: colour or IMAX is what lifts it
    from . import formats as FM
    vals += FM.production_values_bonus(w, p["id"])

    # cast
    roles = [dict(r) for r in w.db.q("""SELECT r.*, a.name AS actor_name, a.status AS a_status, a.age AS a_age,
                    a.t_charisma, a.t_versatility, a.t_discipline, a.t_ego, a.t_scandal,
                    a.t_substance, a.t_likeability, a.craft, a.fame, a.star_power, a.gender,
                    a.labels, s_drama,s_comedy,s_action,s_musicality,s_dance,s_voice,s_stunts
                    FROM roles r LEFT JOIN actors a ON a.id=r.actor_id
                    WHERE r.production_id=? ORDER BY r.idx""", (p["id"],))]
    filled = [r for r in roles if r["actor_id"]]
    cast = 0.0
    for r in filled:
        fit = A.role_fit(r, r, genre)
        need = max(r["min_skill"], 1)
        score = clamp(fit * 0.75 + min(fit, 100) * 0.25 * min(1.2, fit / need), 0, 100)
        cast += score * r["weight"]
    cast = cast / max(0.001, sum(r["weight"] for r in filled)) if filled else 0.0
    unfilled = len(roles) - len(filled)
    if unfilled:
        cast *= max(0.25, 1.0 - 0.16 * unfilled)

    # chemistry among leads
    lead_rows = [r for r in filled if r["kind"] in ("lead", "voice")]
    chem = 45.0
    if len(lead_rows) >= 2:
        vals2 = []
        for i in range(len(lead_rows)):
            for j in range(i + 1, len(lead_rows)):
                vals2.append(A.chemistry(lead_rows[i], lead_rows[j]))
        chem = sum(vals2) / len(vals2)
    ego_clash = sum(max(0.0, (r["t_ego"] or 0) - 70) for r in filled if r["actor_id"])
    chem = clamp(chem - ego_clash * 0.35, 0, 100)
    script = w.db.q1("SELECT quality FROM scripts WHERE id=?", (p["script_id"],))
    script_q = script["quality"] if script else 40.0
    d = w.db.q1("SELECT * FROM directors WHERE id=?", (p["director_id"],)) if p["director_id"] else None
    direction = (d["vision"] * 0.8 + d["prestige"] * 0.2) if d else 22.0
    return dict(script=script_q, cast=cast, direction=direction, values=vals, chem=chem,
                unfilled=unfilled, roles=roles, ego=ego_clash,
                reliability=(sum(r["t_discipline"] or 40 for r in filled) / max(1, len(filled))))


def quality_from(w, p, comp=None):
    comp = comp or components(w, p)
    wts = GENRE_QW[p["genre"]]
    q = (comp["script"] * wts["script"] + comp["cast"] * wts["cast"]
         + comp["direction"] * wts["direction"] + comp["values"] * wts["values"]
         + comp["chem"] * wts["chem"])
    ideal = C.standard_cost(w.year) * C.SCALES[p["scale"]]["mult"]
    ratio = p["budget"] / max(1.0, ideal)
    if ratio < 0.6:
        q -= (0.6 - ratio) * 22          # visibly cheap
    elif ratio > 1.9:
        q -= (ratio - 1.9) * 6.0         # bloated
    if comp["unfilled"]:
        q -= comp["unfilled"] * 4.0
    if p["halted"]:
        q -= 4
    return clamp(q, 1, 99)


def quality_spread(w, p) -> float:
    """Uncertainty band shrinks as the picture gets made."""
    stage = {"development": 22, "pre_production": 17, "shooting": 11,
             "post_production": 6, "ready": 2.5}.get(p["status"], 20)
    if (p.get("test_score") or 0) > 0:
        stage = min(stage, 4)
    return stage


def production_detail(w, pid: int):
    p = get(w, pid)
    if not p:
        return None
    p["upgrades"] = _ups(p)
    comp = components(w, p)
    p["components"] = {k: round(v, 1) for k, v in comp.items() if isinstance(v, (int, float))}
    p["quality_now"] = round(quality_from(w, p, comp), 1)
    spread = quality_spread(w, p)
    p["q_low"] = round(max(0, p["quality_now"] - spread), 1)
    p["q_high"] = round(min(100, p["quality_now"] + spread), 1)
    p["roles"] = [dict(r) for r in w.db.q("""SELECT r.*, a.name AS actor_name, a.fame, a.star_power, a.age,
                        a.gender, a.status AS actor_status, a.hue, a.films, a.awards
                        FROM roles r LEFT JOIN actors a ON a.id=r.actor_id
                        WHERE r.production_id=? ORDER BY r.idx, r.kind""", (pid,))]
    for r in p["roles"]:
        if r.get("actor_id"):
            a = A.get(w, r["actor_id"]) or {}
            est, pm = A.perceived(w, A.role_fit(a, r, p["genre"]), r["actor_id"], a.get("fame", 0),
                                  f"role{r['id']}", spread=20)
            r["fit"], r["fit_pm"] = est, pm
            r["contract"] = a.get("studio") == "player" and (a.get("contract_films") or 0) > 0
    p["split"] = budget_split(p)
    p["script"] = dict(w.db.q1("SELECT id,title,quality,fp,scale,genre,subgenre FROM scripts WHERE id=?",
                               (p["script_id"],)) or {})
    p["director"] = dict(w.db.q1("SELECT id,name,vision,prestige,fee FROM directors WHERE id=?",
                                 (p["director_id"],)) or {})
    if p["franchise_id"]:
        p["franchise"] = dict(w.db.q1("SELECT id,name,installments,fan_base,heat,status FROM franchises WHERE id=?",
                                      (p["franchise_id"],)) or {})
    lg = p.get("log")
    if isinstance(lg, str):
        try:
            lg = json.loads(lg or "[]")
        except Exception:
            lg = []
    p["log"] = lg if isinstance(lg, list) else []
    p["upgrade_costs"] = {c: dict(tier=int(p["upgrades"].get(c, 0)),
                                  max=max_tier(w, c),
                                  cost=round(upgrade_cost(w, p["budget"], p["genre"], c,
                                                          int(p["upgrades"].get(c, 0))), 0),
                                  next_cost=round(max(0.0, upgrade_cost(
                                      w, p["budget"], p["genre"], c,
                                      min(max_tier(w, c), int(p["upgrades"].get(c, 0)) + 1)
                                  ) - upgrade_cost(w, p["budget"], p["genre"], c,
                                                   int(p["upgrades"].get(c, 0)))), 0),
                                  weight=round(_weights(p["genre"]).get(c, 0.5), 2))
                          for c in C.UPGRADES}
    p["director_cost"] = None
    p["can_recast"] = p["status"] in ("development", "pre_production", "shooting")
    p["can_reshoot"] = p["status"] in ("shooting", "post_production", "ready")
    p["reshoot_cost"] = round(p["budget"] * 0.12, 0)
    p["test_cost"] = round(p["budget"] * 0.02, 0)
    from . import formats as FM
    p["formats"] = FM.options(w, p["budget"], p["genre"], p["scale"], FM.get_chosen(w, pid))
    p["formats_locked"] = p["status"] not in ("development", "pre_production")
    p["era_costs"] = FM.era_costs(w, p["budget"])
    p["era_paid"] = w.db.kv_get(f"eracost:{pid}", 0) or 0
    p["bond"] = dict(available=FM.bond_available(w), on=FM.bonded(w, pid),
                     cost=FM.bond_cost(p["budget"]))
    return p


def list_active(w):
    rows = w.db.q("""SELECT p.id,p.title,p.genre,p.scale,p.status,p.weeks_left,p.weeks_total,
                     p.budget,p.spent,p.cast_spend,p.marketing,p.quality,p.q_low,p.q_high,p.hype,
                     p.halted,p.franchise_id,p.seq_index,p.created_year,f.name AS franchise
                     FROM productions p LEFT JOIN franchises f ON f.id=p.franchise_id
                     WHERE p.status NOT IN ('released','cancelled')
                     ORDER BY CASE p.status WHEN 'development' THEN 0 WHEN 'pre_production' THEN 1
                            WHEN 'shooting' THEN 2 WHEN 'post_production' THEN 3 ELSE 4 END, p.id""")
    out = []
    for r in rows:
        d = dict(r)
        d["progress"] = round(100.0 * (1 - d["weeks_left"] / max(1, d["weeks_total"])), 1)
        d["cast_count"] = w.db.scalar("SELECT COUNT(*) FROM roles WHERE production_id=? AND actor_id IS NOT NULL",
                                      (d["id"],), 0)
        d["role_count"] = w.db.scalar("SELECT COUNT(*) FROM roles WHERE production_id=?", (d["id"],), 0)
        out.append(d)
    return out


# --------------------------------------------------------------------------- #
#  Test screening & reshoots
# --------------------------------------------------------------------------- #
def test_screening(w, pid: int):
    p = get(w, pid)
    if not p:
        return dict(ok=False, error="no such production")
    if p["status"] in ("released", "cancelled"):
        return dict(ok=False, error="it is already out")
    cost = p["budget"] * 0.02
    if not w.can_afford(cost):
        return dict(ok=False, error=f"needs ${cost:,.0f}")
    w.spend(cost, "production", f"Test screening: {p['title']}")
    comp = components(w, p)
    true_q = quality_from(w, p, comp)
    rnd = stream(w.seed, "test", pid, w.abs_week)
    shown = clamp(true_q + rnd.gauss(0, 4.5), 1, 99)
    w.db.kv_set(f"test:{pid}", round(true_q, 1))
    w.db.execute("UPDATE productions SET test_score=?, hype=MIN(100,hype+?) WHERE id=?",
                 (round(shown, 1), rnd.uniform(0, 4), pid))
    add_log(w, pid, f"test screening scored {shown:.0f}")
    verdict = ("the audience loved it" if shown > 70 else
               "solid but no spark" if shown > 52 else
               "walkouts" if shown < 34 else "lukewarm")
    universe.log(w.year, w.week, "finance", f"Test screening: {p['title']}",
                 f"Card score {shown:.0f} - {verdict}.")
    apply_upgrades(w, pid)
    return dict(ok=True, score=round(shown, 0), cost=cost, verdict=verdict)


def reshoot(w, pid: int, amount: float = None):
    p = get(w, pid)
    if not p:
        return dict(ok=False, error="no such production")
    if p["status"] not in ("shooting", "post_production", "ready"):
        return dict(ok=False, error="nothing to reshoot")
    cost = float(amount) if amount else p["budget"] * 0.12
    if not w.can_afford(cost):
        return dict(ok=False, error=f"needs ${cost:,.0f}")
    rnd = stream(w.seed, "reshoot", pid, w.abs_week)
    eff = clamp(3.0 + 9.0 * (cost / max(1.0, p["budget"] * 0.12)) ** 0.5, 2, 16)
    if rnd.random() < 0.18:
        eff = -rnd.uniform(1, 5)
    w.spend(cost, "production", f"Reshoots: {p['title']}")
    w.db.execute("""UPDATE productions SET weeks_left=weeks_left+?, quality=MAX(1, MIN(99, quality+?)),
                    status=CASE WHEN status='ready' THEN 'post_production' ELSE status END
                    WHERE id=?""", (max(2, int(cost / max(1.0, p["budget"])) * 3), eff, pid))
    add_log(w, pid, f"reshoots for ${cost:,.0f} ({eff:+.0f} quality)")
    apply_upgrades(w, pid)
    return dict(ok=True, cost=cost, effect=round(eff, 1))


def cancel(w, pid: int):
    p = get(w, pid)
    if not p:
        return dict(ok=False, error="no such production")
    w.db.execute("UPDATE productions SET status='cancelled' WHERE id=?", (pid,))
    w.db.execute("UPDATE scripts SET status='owned' WHERE id=?", (p["script_id"],))
    for r in w.db.q("SELECT actor_id FROM roles WHERE production_id=? AND actor_id IS NOT NULL", (pid,)):
        w.db.execute("UPDATE actors SET busy_until=-1 WHERE id=?", (r["actor_id"],))
    if p["director_id"]:
        w.db.execute("UPDATE directors SET busy_until=-1 WHERE id=?", (p["director_id"],))
    w.add_reputation(-4)
    from . import formats as FM
    payout = 0.0
    if FM.bonded(w, pid) and p["status"] in ("shooting", "post_production"):
        payout = (p["spent"] or 0) * 0.5
        w.earn(payout, "production", f"Completion bond payout: {p['title']}")
    universe.log(w.year, w.week, "finance", f"Shut down: {p['title']}",
                 "The picture is dead. The write-off will hurt for a while."
                 + (f" The bond pays back ${payout:,.0f}." if payout else ""), weight=3)
    return dict(ok=True, bond_payout=payout)


# --------------------------------------------------------------------------- #
#  Weekly production tick (phases, cash, hazards)
# --------------------------------------------------------------------------- #
PHASES = ["development", "pre_production", "shooting", "post_production", "ready"]


def weekly_tick(w):
    """Advance every live picture by one week."""
    halted_globally = bool(E.fx(w, "halt"))
    speed_mult = E.fx(w, "production_speed_mult")
    rows = w.db.q("""SELECT * FROM productions WHERE status IN
                     ('development','pre_production','shooting','post_production')""")
    for r in rows:
        p = dict(r)
        st = p["status"]
        step = 2 if (speed_mult > 1.25 and w.week % 2 == 0) else 1
        left = max(0, p["weeks_left"] - step)

        if st == "development":
            _burn(w, p, p["budget"] * 0.02 / max(1, p["phase_weeks"]))
            if left <= 0:
                pre = 3 + (1 if p["scale"] in ("epic", "blockbuster") else 0)
                w.db.execute("UPDATE productions SET status='pre_production', phase_weeks=?, "
                             "weeks_left=? WHERE id=?", (pre, pre, p["id"]))
                add_log(w, p["id"], "into pre-production")
            else:
                w.db.execute("UPDATE productions SET weeks_left=? WHERE id=?", (left, p["id"]))
            apply_upgrades(w, p["id"])
            continue

        if st == "pre_production":
            if halted_globally:
                w.db.execute("UPDATE productions SET halted=1 WHERE id=?", (p["id"],))
            _burn(w, p, p["budget"] * 0.08 / max(1, p["phase_weeks"]))
            if left <= 0:
                w.db.execute("""UPDATE productions SET status='shooting', phase_weeks=weeks_total,
                                weeks_left=weeks_total, halted=0 WHERE id=?""", (p["id"],))
                add_log(w, p["id"], "camera rolling")
            else:
                w.db.execute("UPDATE productions SET weeks_left=? WHERE id=?", (left, p["id"]))
            apply_upgrades(w, p["id"])
            continue

        if st == "shooting":
            if halted_globally:
                if not p["halted"]:
                    add_log(w, p["id"], "HALTED by world events")
                w.db.execute("UPDATE productions SET halted=1 WHERE id=?", (p["id"],))
                _burn(w, p, p["budget"] * 0.014)     # standing by still costs money
                continue
            # wartime: film stock rationed, crews called up - some weeks nothing rolls
            hc = E.fx(w, "sum:halt_chance")
            if hc and unit(w.seed, "warhalt", p["id"], w.abs_week) < hc:
                add_log(w, p["id"], "lost a week: rationing and call-ups")
                _burn(w, p, p["budget"] * 0.010)
                continue
            if p["halted"]:
                add_log(w, p["id"], "cameras back on")
            w.db.execute("UPDATE productions SET halted=0 WHERE id=?", (p["id"],))
            crew = p["budget"] * 0.55 / max(1, p["weeks_total"])
            _burn(w, p, crew * step)
            hazard_roll(w, p)
            w.db.execute("UPDATE productions SET weeks_left=? WHERE id=?", (left, p["id"]))
            if left <= 0:
                post = 4 + (2 if p["scale"] in ("epic", "blockbuster") else 0)
                w.db.execute("""UPDATE productions SET status='post_production', phase_weeks=?,
                                weeks_left=? WHERE id=?""", (post, post, p["id"]))
                # prints & advertising: the marketing commitment lands at the cut
                if p["marketing"] > 0 and not w.db.kv_get(f"pa:{p['id']}", 0):
                    w.db.kv_set(f"pa:{p['id']}", 1)
                    w.accrue(p["marketing"], "marketing", f"P&A: {p['title']}")
                add_log(w, p["id"], "wrap: into post-production")
            apply_upgrades(w, p["id"])
            continue

        if st == "post_production":
            _burn(w, p, p["budget"] * 0.12 / max(1, p["phase_weeks"]))
            w.db.execute("UPDATE productions SET weeks_left=? WHERE id=?", (left, p["id"]))
            if left <= 0:
                w.db.execute("UPDATE productions SET status='ready' WHERE id=?", (p["id"],))
                universe.log(w.year, w.week, "finance", f"Delivered: {p['title']}",
                             "Answer print at the labs. Ready to release.", weight=2)
            apply_upgrades(w, p["id"])


def _burn(w, p, amount):
    """Spend real money on a picture: cash leaves the studio, cost lands on
    the production, and the ledger gets one rolled-up line per week."""
    amount = amount * E.fx(w, "cost_mult")
    w.db.execute("UPDATE productions SET spent=spent+? WHERE id=?", (amount, p["id"]))
    w.accrue(amount, "production", "Production costs")


def hazard_roll(w, p):
    """Roll production hazards; apply whichever hits."""
    rnd = stream(w.seed, "hazard", p["id"], w.year, w.week)
    roles = [dict(r) for r in w.db.q("""SELECT r.*, a.name AS actor_name, a.t_scandal, a.t_substance, a.t_ego,
                        a.t_discipline, a.age, a.fame, a.studio AS a_studio
                        FROM roles r JOIN actors a ON a.id=r.actor_id
                        WHERE r.production_id=?""", (p["id"],))]
    discipline = (sum(r["t_discipline"] for r in roles) / len(roles)) if roles else 50
    gym = w.db.scalar("SELECT count FROM buildings WHERE kind='gym'", 0) or 0
    for hz, spec in C.HAZARDS.items():
        mult = E.hazard_mult(w, hz)
        if mult <= 0:
            continue
        p_haz = spec["p"] * mult
        if hz == "scandal" and roles:
            p_haz *= max(0.4, max(r["t_scandal"] for r in roles) / 45.0)
        if hz == "substance" and roles:
            p_haz *= max(0.3, max(r["t_substance"] for r in roles) / 45.0)
        if hz in ("scandal", "substance"):
            p_haz *= max(0.5, 1.0 - 0.12 * gym)        # the Star Factory keeps them out of trouble
        if hz in ("overrun", "slowdown", "injury"):
            p_haz *= clamp(1.35 - discipline / 120.0, 0.5, 1.4)
        if p["scale"] in ("epic", "blockbuster") and hz in ("overrun", "injury", "weather"):
            p_haz *= 1.5
        if rnd.random() < p_haz:
            apply_hazard(w, p, hz, roles, rnd)
            break


def apply_hazard(w, p, hz, roles, rnd):
    if not roles and hz in ("scandal", "injury", "substance", "star_death", "poached",
                            "director_feud"):
        hz = "slowdown"          # nothing to happen to but the schedule
    label = C.HAZARDS[hz]["label"]
    sev = C.HAZARDS[hz]["severity"]
    cost = p["budget"] * (0.03 + 0.012 * sev) * E.fx(w, "cost_mult")
    delay = int(1 + sev // 4)
    quality_hit = 0.0
    txt = ""
    actor_name = roles[rnd.randrange(len(roles))]["actor_name"] if roles else "the production"
    if hz == "overrun":
        cost *= 1.8
        txt = f"Costs blow out ${cost:,.0f} deeper."
    elif hz == "scandal":
        quality_hit = rnd.uniform(1, 5)
        victim = rnd.choice(roles)
        txt = f"{victim['actor_name']} is on the front page for all the wrong reasons."
        A.bump_fame(w, victim["actor_id"], -rnd.uniform(2, 9))
        w.db.execute("UPDATE actors SET t_press=MAX(2,t_press-3) WHERE id=?", (victim["actor_id"],))
    elif hz == "injury":
        delay += 2
        txt = f"{actor_name} is hurt. The set stands by."
    elif hz == "weather":
        txt = "Rain, mud and lost days."
    elif hz == "director_feud":
        quality_hit = rnd.uniform(2, 7)
        txt = f"The director and {actor_name} barely speak."
    elif hz == "censor_cut":
        quality_hit = rnd.uniform(1, 6)
        cost *= 0.4
        txt = "The Code office demands cuts. Scenes go on the shelf."
    elif hz == "prop_fire":
        cost *= 2.2
        txt = "Sets and props destroyed. Everything rebuilt from scratch."
    elif hz == "lawsuit":
        cost *= 1.5
        txt = f"A lawsuit over {p['title']} halts the negative."
    elif hz == "substance":
        delay += 2
        txt = f"{actor_name} checked out early, twice."
    elif hz == "poached":
        # an actor walks mid-shoot if they are not on our contract
        cand = [r for r in roles if r["actor_id"] and not r.get("a_studio")]
        if cand:
            victim = rnd.choice(cand)
            w.db.execute("""UPDATE roles SET actor_id=NULL, fee=0 WHERE id=?""", (victim["id"],))
            w.db.execute("UPDATE actors SET busy_until=-1 WHERE id=?", (victim["actor_id"],))
            txt = f"{victim['actor_name']} walks off to a rival's picture."
            quality_hit = rnd.uniform(4, 10)
            delay += 4
    elif hz == "star_death":
        cand = [r for r in roles if r["actor_id"]]
        if cand:
            victim = rnd.choice(cand)
            from . import legacy
            why = legacy.on_set_text(w.year)
            legacy.record_death(w, victim["actor_id"], why, "on_set", on_set_title=p["title"])
            w.db.execute("""UPDATE roles SET actor_id=NULL, fee=0 WHERE id=?""", (victim["id"],))
            txt = f"{victim['actor_name']} {why}. The picture is in mourning."
            quality_hit = rnd.uniform(0, 6)
            delay += 6
    elif hz == "slowdown":
        txt = "Union slowdown. Half days on the floor."
    from . import formats as FM
    if FM.bonded(w, p["id"]) and cost > 0:
        covered = cost - FM.bond_cover(w, p["id"], cost)
        cost -= covered
        delay = max(0, int(round(delay * 0.6)))
        txt += f" The bond company covers ${covered:,.0f}."
    _burn(w, p, cost)
    w.db.execute("UPDATE productions SET weeks_left=weeks_left+? WHERE id=?", (delay, p["id"]))
    if quality_hit:
        w.db.execute("UPDATE productions SET quality=MAX(1,quality-?) WHERE id=?", (quality_hit, p["id"]))
    add_log(w, p["id"], f"{label}: {txt} (-${cost:,.0f}, +{delay}w)")
    universe.log(w.year, w.week, "local", f"{label}: {p['title']}", txt,
                 weight=1 if sev < 8 else 2)


def ready_pictures(w):
    """Pictures sitting in the can waiting for a release date."""
    rows = w.db.q("""SELECT id,title,genre,scale,budget,marketing,quality,q_low,q_high,hype,
                     franchise_id,seq_index FROM productions WHERE status='ready' ORDER BY id""")
    return [dict(r) for r in rows]


# ---- API-friendly aliases ------------------------------------------------- #
test_screen = test_screening
shutdown = cancel


def max_upgrades(w, pid: int):
    """'Max all': raise every production-value line to the highest tier the
    era allows - as far as the cash goes, cheapest wins first."""
    p = get(w, pid)
    if not p:
        return dict(ok=False, error="no such production")
    if p["status"] not in ("development", "pre_production", "shooting"):
        return dict(ok=False, error="too late to change production values")
    spent, raised, short = 0.0, 0, False
    while True:
        p = get(w, pid)
        opts = []
        for cat in C.UPGRADES:
            if cat == "marketing":
                continue
            nxt = next_upgrade_cost(w, p, cat)
            if nxt:
                opts.append((nxt["cost"], cat, nxt["tier"]))
        if not opts:
            break
        opts.sort()
        cost, cat, tier = opts[0]
        if not w.can_afford(cost):
            short = True
            break
        r = set_upgrade(w, pid, cat, tier)
        if not r.get("ok"):
            short = True
            break
        spent += r.get("cost", 0.0)
        raised += 1
    if not raised and short:
        return dict(ok=False, error="not enough cash for the next tier")
    return dict(ok=True, spent=spent, steps=raised, short=short)
