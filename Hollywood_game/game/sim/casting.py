"""The casting pipeline.

This is the *only* way new people enter the universe:

* **Open calls** (player funded): you pay, a pool of discoveries appears and you
  get first look.  Anyone you pass on goes to the town's agents and may turn up
  years later as a rival's moneymaker.
* **Industry calls** (automatic, monthly): the rest of the town discovers
  people too, feeding the general talent pool so the universe keeps growing.

Auditions produce a shortlist with imperfect scout reports and a chemistry
estimate against whoever you have already cast.
"""
from __future__ import annotations

from .. import config as C
from .. import names as N
from .. import universe
from ..rng import clamp, derive, stream, unit
from . import actors as A


# --------------------------------------------------------------------------- #
#  Open calls
# --------------------------------------------------------------------------- #
MAX_TIER = len(C.OPEN_CALL_POOL) - 1


def open_call_cost(w, tier: int) -> float:
    tier = max(0, min(MAX_TIER, int(tier)))
    return C.standard_cost(w.year) * C.OPEN_CALL_COST_FRAC * C.OPEN_CALL_TIER_COST[tier]


def open_call(w, tier: int = 0):
    tier = max(0, min(MAX_TIER, int(tier)))
    cost = open_call_cost(w, tier)
    if not w.can_afford(cost):
        return dict(ok=False, error=f"needs ${cost:,.0f}")
    w.spend(cost, "casting", f"Open call (tier {tier+1})")
    office = w.db.scalar("SELECT count FROM buildings WHERE kind='casting_office'", 0) or 0
    base = C.OPEN_CALL_POOL[tier] * (1.0 + 0.12 * office)
    n = max(4, int(base))
    pool = spawn_newcomers(w, n, discoverer="player",
                           bias=(0.0, 5.0, 9.0, 13.0)[tier] + office * 1.5,
                           stream_name="opencall")
    universe.log(w.year, w.week, "talent", f"Open call: {n} hopefuls on the lot",
                 ["A line round the block. Two of them might be somebody.",
                  "You watched three hundred screen tests in a hot gymnasium.",
                  "The agents sent their best. Somebody here will be a star.",
                  "Talent scouts in forty cities. The train station is full of hopefuls."][tier],
                 weight=tier + 1)
    return dict(ok=True, cost=cost, pool=pool, n=n)


def spawn_newcomers(w, n: int, discoverer: str = "agents", bias: float = 0.0,
                    stream_name: str = "newcomers", gender_bias=None, age=None,
                    announce: bool = False) -> list:
    """Create fresh actors.  Returns list of dicts (id, name, promise)."""
    rnd = stream(w.seed, stream_name, w.year, w.week, n, discoverer)
    rows, out = [], []
    for i in range(n):
        g = gender_bias or ("m" if rnd.random() < 0.5 else "f")
        a = universe.make_actor(rnd, w.year, age=rnd.randint(*C.NEWCOMER_AGE) if age is None else age,
                                gender=g, known=False)
        if bias:
            for col in universe.SKILL_COLS:
                a[col] = round(clamp(a[col] + rnd.uniform(0, bias), 3, 99), 1)
            a["craft"] = round(max(a["craft"], sum(sorted(
                [a[c] for c in universe.SKILL_COLS], reverse=True)[:3]) / 3), 1)
        if rnd.random() < C.GENERATIONAL_TALENT_P * (1.5 if discoverer == "player" else 1.0):
            # nobody is told; the scout report just reads unusually well
            for col in universe.SKILL_COLS:
                a[col] = round(clamp(a[col] + rnd.uniform(10, 24), 3, 99), 1)
            a["t_charisma"] = round(clamp(a["t_charisma"] + rnd.uniform(15, 30), 3, 99), 1)
            a["t_versatility"] = round(clamp(a["t_versatility"] + rnd.uniform(8, 20), 3, 99), 1)
            a["craft"] = round(clamp(a["craft"] + 18, 3, 99), 1)
        promise = talent_promise(a) + rnd.uniform(-6, 6)
        a["fame"] = round(clamp(a["fame"] + rnd.uniform(0, 3), 0, 100), 1)
        a["status"] = "available"
        a["r"] = derive(w.seed, "rowlcg", stream_name, w.abs_week, i, a["name"]) % (2 ** 31) or 1
        a["discoverer"] = discoverer if discoverer != "player" else "your casting office"
        a["notes"] = ""
        cur = w.db.execute(universe.ACTOR_INSERT, a)
        aid = cur.lastrowid
        w.db.execute("""INSERT INTO discoveries(actor_id,year,week,tier,source,claimed,expires_year)
                        VALUES(?,?,?,?,?,0,?)""",
                     (aid, w.year, w.week, 0 if discoverer != "player" else 1,
                      "open_call" if discoverer == "player" else "industry", w.year + 2))
        out.append(dict(id=aid, name=a["name"], age=a["age"], gender=a["gender"],
                        promise=round(promise, 1), fame=a["fame"]))
    if announce and out:
        universe.log(w.year, w.week, "talent", "New faces in town",
                     f"{len(out)} newcomers arrive via the industry's open calls.")
    return out


def talent_promise(a) -> float:
    """Untrained potential: what a good scout thinks this person could become."""
    craft = max(a.get("craft", 20), 1)
    return clamp(craft * 0.55 + a.get("t_charisma", 30) * 0.30
                 + a.get("t_versatility", 40) * 0.15 + a.get("t_discipline", 50) * 0.05, 0, 100)


def discovery_pool(w, include_industry=False):
    """Unclaimed discoveries you can still sign. Sorted by scouted promise."""
    sql = """SELECT d.actor_id AS id, d.year, d.week, d.expires_year, d.tier,
                    a.name, a.age, a.gender, a.fame, a.craft, a.fee, a.status, a.hue,
                    a.t_charisma, a.t_versatility, a.s_drama, a.s_comedy, a.s_action,
                    a.s_dance, a.s_voice, a.s_musicality, a.s_stunts, a.studio
             FROM discoveries d JOIN actors a ON a.id=d.actor_id
             WHERE d.claimed=0 AND d.expires_year >= ? AND a.status IN ('available','working')
               AND a.studio IS NULL"""
    if not include_industry:
        sql += " AND d.source='open_call'"
    rows = [dict(r) for r in w.db.q(sql + " ORDER BY d.year DESC, d.week DESC, a.id DESC LIMIT 240",
                                    (w.year,))]
    acc = A.scout_accuracy(w)
    for r in rows:
        raw = {k: r[k] for k in ("t_charisma", "t_versatility", "s_drama", "s_comedy",
                                 "s_action", "s_dance", "s_voice", "s_musicality", "s_stunts",
                                 "craft")}
        true_promise = talent_promise(raw)
        err = 26.0 * (1.0 - acc)
        u = unit(w.seed, "promise", r["id"])
        r["promise"] = round(clamp(true_promise + (u - 0.5) * 1.6 * err, 0, 99), 0)
        r["promise_pm"] = round(err, 0)
        r["taken"] = bool(r["studio"])
        r["source"] = "your open call" if r.get("tier") else "industry"
    return rows


def waive(w, actor_id: int):
    """Release a discovery from your first-look list; an agent may grab them."""
    row = w.db.q1("SELECT * FROM discoveries WHERE actor_id=? AND claimed=0", (actor_id,))
    if not row:
        return dict(ok=False, error="nothing to waive")
    w.db.execute("UPDATE discoveries SET claimed=2 WHERE actor_id=?", (actor_id,))
    rnd = stream(w.seed, "waive", actor_id, w.abs_week)
    rivals = [r["name"] for r in w.db.q("SELECT name FROM rivals WHERE alive=1")]
    a = A.get(w, actor_id)
    if rivals and a and rnd.random() < 0.35:
        pick = rnd.choice(rivals)
        w.db.execute("""UPDATE actors SET studio=?, contract_films=?, contract_fee=fee*0.9,
                        contract_until=? WHERE id=?""",
                     (pick, rnd.choice([2, 3]), w.abs_week + 52 * 5, actor_id))
        return dict(ok=True, took=pick)
    return dict(ok=True, took=None)


def industry_monthly(w):
    """The town keeps discovering people whether you pay or not."""
    rnd = stream(w.seed, "indcall", w.year, w.week)
    base = 3 + int(2 * C.attendance_index(w.year))
    n = max(1, int(base * (0.6 + rnd.random() * 0.9)))
    spawn_newcomers(w, n, discoverer="agents", stream_name="indcall", announce=True)
    # expire stale first-looks: whoever you ignored goes to the town
    stale = w.db.q("""SELECT actor_id FROM discoveries WHERE claimed=0 AND expires_year < ?""",
                   (w.year,))
    for r in stale:
        w.db.execute("UPDATE discoveries SET claimed=1 WHERE actor_id=?", (r["actor_id"],))


# --------------------------------------------------------------------------- #
#  Auditions
# --------------------------------------------------------------------------- #
def role_shortlist(w, production_id: int, role_id: int, limit: int = 24):
    """Who can play this part.

    Two sections, which the dashboard separates with a bar:

    * ``inhouse`` - people already under contract to the studio who are free
      for the shoot, match the part's age/gender, and whom the casting office
      rates as good enough for it.
    * ``market``  - outside talent (not signed anywhere) you can audition in
      for a fee.

    Contract players who are on the payroll but wrong for this part (busy on
    another picture, wrong age or gender, or under-skilled) are counted in
    ``counts`` so the UI can say why someone you expected is missing.
    """
    p = w.db.q1("SELECT * FROM productions WHERE id=?", (production_id,))
    role = w.db.q1("SELECT * FROM roles WHERE id=? AND production_id=?", (role_id, production_id))
    if not p or not role:
        return dict(rows=[], error="no such role")
    role = dict(role)
    genre = p["genre"]
    skill_col = _skill_col(role["skill"])
    cols = f"""a.id,a.name,a.age,a.gender,a.status,a.studio,a.fame,a.star_power,a.fee,
               a.craft,a.films,a.awards,a.cult,a.hue,{skill_col} AS skill_val,
               a.t_charisma,a.t_versatility,a.t_ego,a.t_scandal,a.t_substance,a.t_likeability,
               a.s_action,a.s_dance,a.s_voice,a.s_stunts,a.s_drama,a.s_comedy,
               a.s_musicality,a.contract_films,a.contract_fee,a.busy_until,a.labels"""
    where = ["a.status IN ('available','working','star')",
             "(a.busy_until < ? OR a.busy_until IS NULL)",
             "a.age BETWEEN ? AND ?"]
    args = [w.abs_week, role["min_age"], role["max_age"]]
    if role["gender"] in ("m", "f"):
        where.append("a.gender=?")
        args.append(role["gender"])
    wsql = " AND ".join(where)
    # whoever already holds this part is not auditioning for it
    holder = role.get("actor_id") or -1
    own_rows = [dict(r) for r in w.db.q(
        f"""SELECT {cols} FROM actors a WHERE {wsql} AND a.studio='player'
            AND a.contract_films > 0 AND a.id<>?""", tuple(args) + (holder,))]
    market_rows = [dict(r) for r in w.db.q(
        f"""SELECT {cols} FROM actors a WHERE {wsql} AND a.studio IS NULL AND a.id<>?
            ORDER BY a.fame DESC, {skill_col} DESC LIMIT 90""", tuple(args) + (holder,))]
    away = 0
    def here(rows):
        nonlocal away
        keep = []
        for r in rows:
            if A.away_reason(w, r):
                away += 1
            else:
                keep.append(r)
        return keep
    own_rows, market_rows = here(own_rows), here(market_rows)
    on_payroll = w.db.scalar("SELECT COUNT(*) FROM actors WHERE studio='player' "
                             "AND contract_films > 0", (), 0)

    leads = [l for l in _existing_leads(w, production_id) if l["id"] != holder]

    # sequels: the faces from earlier installments (this continuity) come first
    returning = {}
    who = None
    if p["franchise_id"] and not _is_reboot(w, p):
        from . import franchise as F
        returning = F.returning_cast(w, p["franchise_id"])
        # a character part: whoever audiences know in it comes first, even
        # from another series (a team-up, a spin-off)
        from . import characters as CH
        who = CH.portrayer(w, role)
        if who and who["actor_id"] != holder:
            returning = dict(returning)
            prev = returning.get(who["actor_id"]) or {}
            returning[who["actor_id"]] = dict(name=prev.get("name", ""), lead=True,
                                              films=max(prev.get("films", 0), who["films"]))
        if returning:
            ids = [i for i in returning if i != holder]
            if ids:
                marks = ",".join("?" * len(ids))
                extra = [dict(r) for r in w.db.q(
                    f"""SELECT {cols} FROM actors a WHERE {wsql} AND a.studio IS NULL
                        AND a.id IN ({marks})""", tuple(args) + tuple(ids))]
                # free returning actors are always on the list, even if they
                # are not famous enough to make the top-90 cut
                extra = here(extra)
                got = {e["id"] for e in extra}
                market_rows = extra + [r for r in market_rows if r["id"] not in got]

    def score(r, section):
        row = dict(r)
        true_fit = A.role_fit(row, role, genre)
        est, pm = A.perceived(w, true_fit, r["id"], r["fame"], f"role{role_id}", spread=20)
        row["fit"] = est
        row["fit_pm"] = pm
        row["skill"] = round(r["skill_val"] or 0, 0)
        row["skill_req"] = round(role["min_skill"], 0)
        row["meets"] = est >= role["min_skill"] - pm * 0.5
        fee = A.effective_fee(w, row, kind=role["kind"], scale=p["scale"], budget=p["budget"])
        row["fee"] = round(fee, 0)
        row["own_contract"] = section == "inhouse"
        row["section"] = section
        if leads:
            chem = max(A.chemistry(row, l) for l in leads)
            c_est, c_pm = A.perceived(w, chem, r["id"] * 7 + role_id, r["fame"], "chem", spread=16)
            row["chemistry"] = c_est
            row["chemistry_pm"] = c_pm
        else:
            row["chemistry"] = None
        row["risk"] = round(clamp(r["t_scandal"] * 0.5 + r["t_substance"] * 0.4 + r["t_ego"] * 0.2,
                                  0, 99), 0)
        ret = returning.get(r["id"])
        row["returning"] = bool(ret)
        row["returning_films"] = ret["films"] if ret else 0
        row["returning_lead"] = bool(ret and ret["lead"])
        row["portrays"] = bool(who and r["id"] == who["actor_id"])
        return row

    # returning stars float to the top of their section: fans expect them back
    rank = lambda x: (x["fit"] + (x["chemistry"] or 0) * 0.35
                      + (40 if x["returning_lead"] else 20 if x["returning"] else 0)
                      + (30 if x.get("portrays") else 0))
    scored_own = [score(r, "inhouse") for r in own_rows]
    # "fits the part" for your own people means your office rates them at or
    # above what the part needs - no benefit of the doubt on the ± band
    # (a returning star of the series is always offered - the fans want them)
    own = sorted([r for r in scored_own if r["fit"] >= round(role["min_skill"]) or r["returning"]],
                 key=rank, reverse=True)
    market = sorted([score(r, "market") for r in market_rows], key=rank, reverse=True)
    keep_own = own[:max(6, limit // 2)]
    rows = keep_own + market[:max(0, limit - len(keep_own))]
    return dict(rows=rows, genre=genre, role=role,
                franchise=bool(p["franchise_id"]), sequel=bool(returning),
                returning_missing=_why_missing(w, role, returning, {r["id"] for r in rows}, holder),
                counts=dict(inhouse=len(own), market=len(market), payroll=on_payroll, away=away,
                            inhouse_unfit=len(scored_own) - len(own),
                            inhouse_elsewhere=max(0, on_payroll - len(scored_own))))


def _why_missing(w, role, returning, shown, holder):
    """Earlier stars of the series who are NOT on this list, and why not."""
    out = []
    for aid, v in returning.items():
        if aid in shown or aid == holder:
            continue
        a = A.get(w, aid)
        if not a:
            continue
        if w.db.scalar("SELECT COUNT(*) FROM roles WHERE production_id=? AND actor_id=?",
                       (role["production_id"], aid), 0):
            why = "already cast in another part of this picture"
        elif A.away_reason(w, a):
            why = A.away_reason(w, a)
        elif a["status"] in ("dead", "retired", "blacklisted"):
            why = a["status"]
        elif a["studio"] and a["studio"] != "player":
            why = f"under contract to {a['studio']} (poach them from their card)"
        elif (a["busy_until"] or -1) >= w.abs_week:
            why = "shooting another picture"
        elif not (role["min_age"] <= a["age"] <= role["max_age"]):
            why = f"aged {a['age']} - outside this part's {role['min_age']}-{role['max_age']}"
        elif role["gender"] in ("m", "f") and a["gender"] != role["gender"]:
            why = "wrong for this part"
        elif a["studio"] == "player":
            why = "yours, but rated below what this part needs"
        else:
            why = "not on the shortlist"
        out.append(dict(id=aid, name=v["name"], lead=v["lead"], why=why))
    return out


def _is_reboot(w, p) -> bool:
    origin = w.db.scalar("SELECT origin FROM scripts WHERE id=?", (p["script_id"],), "")
    return origin in ("reboot", "remake")


def _skill_col(skill: str) -> str:
    return "s_" + skill if ("s_" + skill) in ("s_drama", "s_comedy", "s_action",
                                              "s_musicality", "s_dance", "s_voice", "s_stunts") \
        else "s_drama"


def _existing_leads(w, production_id):
    rows = w.db.q("""SELECT a.* FROM roles r JOIN actors a ON a.id=r.actor_id
                     WHERE r.production_id=? AND r.kind='lead'""", (production_id,))
    return [dict(r) for r in rows]


def auto_cast(w, pid: int, ceiling: float = 0.45):
    """Fill every empty role with the best affordable fit, the way a casting
    director would: leads first, your own contract players and returning
    series stars preferred, fees kept inside a share of the budget, and
    nobody with a scandal waiting to happen if a safer choice fits."""
    from . import production as P
    p = w.db.q1("SELECT * FROM productions WHERE id=?", (pid,))
    if not p:
        return dict(ok=False, error="no such production")
    order = {"lead": 0, "voice": 1, "supporting": 2, "cameo": 3}
    roles = sorted([dict(r) for r in w.db.q("SELECT * FROM roles WHERE production_id=?", (pid,))],
                   key=lambda r: (order.get(r["kind"], 4), r["idx"]))
    pot = p["budget"] * ceiling - (p["cast_spend"] or 0)
    empty = [r for r in roles if not r["actor_id"]]
    if not empty:
        return dict(ok=True, cast=[], note="every role is already cast")
    share = {"lead": 0.45, "voice": 0.35, "supporting": 0.15, "cameo": 0.06}
    weight_left = sum(share.get(r["kind"], 0.1) for r in empty)
    cast, missed = [], []
    for role in empty:
        cap = max(0.0, pot) * share.get(role["kind"], 0.1) / max(0.01, weight_left)
        sl = role_shortlist(w, pid, role["id"], limit=40)

        def value(c):
            v = c["fit"] + (c.get("chemistry") or 0) * 0.25 + (c.get("star_power") or 0) * (
                0.35 if role["kind"] in ("lead", "voice") else 0.10)
            v += 40 if c.get("returning_lead") else 18 if c.get("returning") else 0
            v += 30 if c.get("portrays") else 0
            v += 8 if c.get("own_contract") else 0
            v -= max(0, (c.get("risk") or 0) - 45) * 0.4
            return v
        ok = [c for c in sl["rows"] if c.get("meets") and (c.get("fee") or 0) <= max(cap, 0)
              and (c.get("fee") or 0) <= w.cash]
        if not ok:   # nobody fits inside the share: take the best fit we can still pay for
            ok = [c for c in sl["rows"] if c.get("meets") and (c.get("fee") or 0) <= max(0.0, pot)
                  and (c.get("fee") or 0) <= w.cash]
        done = False
        for c in sorted(ok, key=value, reverse=True)[:5]:
            r = P.cast_role(w, pid, role["id"], c["id"])
            if r.get("ok"):
                pot -= c.get("fee") or 0
                cast.append(dict(role=role["name"], kind=role["kind"], name=c["name"], fee=c.get("fee") or 0))
                done = True
                break
        if not done:
            missed.append(role["name"])
        weight_left -= share.get(role["kind"], 0.1)
    if not cast:
        return dict(ok=False, error="nobody suitable inside the budget - audition by hand or raise the budget")
    return dict(ok=True, cast=cast, missed=missed, spent=sum(c["fee"] for c in cast))
