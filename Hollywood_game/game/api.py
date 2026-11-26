"""JSON API. One dispatcher, no framework.

Every route returns a plain dict; the server turns it into JSON. Mutations go
through the same functions the simulation tests use, so the dashboard can never
drift from the engine.
"""
from __future__ import annotations

import json
import os
import threading

from . import config as C
from .db import DB
from .state import World, list_saves, save_path
from .sim import actors as A
from .sim import boxoffice, casting, charts, economy, engine, press, typecast
from .sim import events as E
from .sim import formats as FM
from .sim import franchise, production as P
from .sim import awards as AW
from .sim import legacy as LG
from .sim import rivals, scripts as S

LOCK = threading.RLock()
WORLD: World | None = None

START_YEARS = [1910, 1920, 1928, 1939, 1950, 1965, 1977, 1990]


# --------------------------------------------------------------------------- #
#  helpers
# --------------------------------------------------------------------------- #
def _i(v, default=None):
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def _f(v, default=None):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def w() -> World:
    if WORLD is None:
        raise NoGame()
    return WORLD


class NoGame(Exception):
    pass


def offer_rows(rows) -> list:
    """Shape offer rows for the rights desk."""
    out = []
    for r in rows:
        r = dict(r)
        r["from"] = r.get("buyer") or "a rival"
        r["amount"] = r.get("price") or 0.0
        r["asset_label"] = r.get("asset_label") or r.get("title") or "picture"
        r["buyable"] = r.get("kind") in ("acquire_franchise", "acquire_library")
        t = r.get("terms") or ""
        r["financing"] = t.split("; ", 1)[1] if "borrowed from" in t and "; " in t else None
        out.append(r)
    return out


def _page(p, page, limit):
    return dict(page=int(page or 1), limit=int(limit or 30), total=p.get("total", 0),
                pages=p.get("pages", 1))


def era_label(year: int) -> str:
    for lo, hi, label in C.ERAS:
        if lo <= year <= hi:
            return label
    return str(year)


def tech_table() -> list:
    """Every technology, whether the world has reached it or not."""
    live = {r["id"]: dict(r) for r in w().db.q("SELECT * FROM tech")}
    out = []
    for spec in C.TECH:
        row = live.get(spec["id"], {})
        year = row.get("year", spec["year"])
        unlocked = bool(row.get("unlocked", 0))
        when = row.get("unlocked_year") or year
        out.append(dict(id=spec["id"], label=spec["label"], note=spec["note"],
                        on_year=year, unlocked=unlocked,
                        unlocked_year=(when if unlocked else None),
                        enabled=unlocked and w().year >= when))
    return sorted(out, key=lambda r: r["on_year"])


def state_payload(p=None) -> dict:
    wld = w()
    fin = economy.finance_summary(wld)
    top = [dict(r) for r in wld.db.q("""SELECT id,title,year,genre,outcome,gross,net,quality,cult_classic
                                        FROM movies WHERE rights='player'
                                        ORDER BY gross DESC LIMIT 5""")]
    charts = boxoffice.chart_data(wld)
    return dict(
        game=dict(name=wld.name, year=wld.year, week=wld.week, speed=wld.speed,
                  year_label=f"{wld.year} · week {wld.week + 1}", era=era_label(wld.year),
                  cash=wld.cash, prestige=wld.prestige, reputation=wld.reputation,
                  valuation=wld.valuation, over=wld.over, seed=wld.seed,
                  start_year=wld.start_year, stats=wld.stats),
        presets=dict(start_cash=C.START_CASH, scales={k: dict(label=v["label"], mult=v["mult"],
                                                              weeks=v["weeks"])
                                                      for k, v in C.SCALES.items()}),
        trends=[dict(genre=g, label=C.GENRE_LABEL[g], heat=round(h, 3))
                for g, h in sorted(wld.trends().items(), key=lambda kv: -kv[1])],
        events=E.active(wld),
        productions=[_decorate_production(dict(r)) for r in P.list_active(wld)],
        ready=[dict(r) for r in wld.db.q("""SELECT id,title,genre,scale,budget,marketing,quality,
                        hype,franchise_id,seq_index FROM productions WHERE status='ready'""")],
        top=top,
        charts=charts,
        offers=offer_rows(franchise.offers(wld)[:8]),
        offers_open=wld.db.scalar("SELECT COUNT(*) FROM offers WHERE status='open'", 0),
        buildings=fin["buildings"],
        log=[dict(r) for r in wld.db.q("""SELECT year,week,kind,title,text,weight FROM event_log
                                          ORDER BY id DESC LIMIT 22""")],
        counts=dict(market=wld.db.scalar("SELECT COUNT(*) FROM actors WHERE studio IS NULL "
                                         "AND status IN ('available','working','star')", 0),
                    under_contract=wld.db.scalar("SELECT COUNT(*) FROM actors "
                                                 "WHERE studio='player'", 0),
                    discovery=wld.db.scalar(
                        "SELECT COUNT(*) FROM discoveries d JOIN actors a ON a.id=d.actor_id "
                        "WHERE d.claimed=0 AND d.expires_year>=? AND a.studio IS NULL",
                        (wld.year,), 0),
                    library=len(S.library(wld)),
                    writers=wld.db.scalar("SELECT COUNT(*) FROM writers WHERE studio='player'", 0),
                    franchises=wld.db.scalar("SELECT COUNT(*) FROM franchises "
                                             "WHERE rights='player'", 0),
                    titles=wld.db.scalar("SELECT COUNT(*) FROM movies WHERE rights='player'", 0)),
        finance=fin,
        ceremony=AW.pending(wld),
        reviews_unseen=[r["movie_id"] for r in wld.db.q(
            "SELECT movie_id FROM reviews WHERE seen=0 ORDER BY movie_id DESC LIMIT 12")],
        reviews_unseen_count=wld.db.scalar("SELECT COUNT(*) FROM reviews WHERE seen=0", 0),
        paper=_paper_teaser(wld),
        ok=True,
    )


def _paper_teaser(wld):
    top = wld.db.q1("""SELECT headline FROM news WHERE abs_week>=? ORDER BY weight DESC, id DESC
                       LIMIT 1""", (wld.abs_week - 1,))
    no1 = wld.db.q1("SELECT title, studio, kind FROM box_runs WHERE active=1 AND rank=1 AND wk>0")
    return dict(headline=top["headline"] if top else None,
                number_one=dict(no1) if no1 else None)


# --------------------------------------------------------------------------- #
#  route table
# --------------------------------------------------------------------------- #
def r_new_game(p):
    name = (p.get("name") or "Meridian Pictures").strip()[:48] or "Meridian Pictures"
    start = _i(p.get("start_year"), 1928)
    if start not in START_YEARS:
        start = min(START_YEARS, key=lambda y: abs(y - start))
    preset = p.get("preset") if p.get("preset") in C.START_CASH else "studio"
    seed = _i(p.get("seed"), None) or 0
    actors_n = max(1200, min(20000, _i(p.get("actors"), 5200)))
    slug = (p.get("slug") or "").strip()
    with LOCK:
        global WORLD
        path = save_path(slug) if slug else save_path(f"{start}_{abs(hash(name)) % 10**6}")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        for suf in ("", "-wal", "-shm"):
            if os.path.exists(path + suf):
                os.remove(path + suf)
        db = DB(path)
        from . import universe
        universe.new_world(db, name, start, preset, seed, actors=actors_n)
        WORLD = World(db)
        return dict(ok=True, slug=os.path.basename(path), state=state_payload())


def r_load(p):
    path = save_path((p.get("slug") or "").strip())
    if not os.path.exists(path):
        return dict(ok=False, error="no such save")
    with LOCK:
        global WORLD
        WORLD = World(DB(path))
        return dict(ok=True, state=state_payload())


def r_saves(p):
    return dict(ok=True, saves=list_saves(), current=current_slug())


def r_tick(p):
    weeks = max(1, min(520, _i(p.get("weeks"), 1)))
    with LOCK:
        res = engine.advance(w(), weeks) or {}
        if res.get("over"):
            res["over"] = "bankrupt"
        return dict(ok=True, tick=res, state=state_payload())


def r_speed(p):
    with LOCK:
        return dict(ok=True, speed=engine.set_speed(w(), _i(p.get("speed"), 0)))


# ---- talent --------------------------------------------------------------- #
def r_actors(p):
    status, signed = p.get("status", "any"), None
    if status in ("signed", "player"):          # "under contract to you"
        status, signed = "any", "player"
    elif status == "rival":
        status, signed = "any", "rival"
    res = A.list_actors(w(), q=p.get("q"), status=status, signed=signed,
                        gender=p.get("gender", "any"), min_age=_i(p.get("min_age")),
                        max_age=_i(p.get("max_age")), min_fame=_f(p.get("min_fame")),
                        sort=p.get("sort", "fame"), dirn=p.get("dir", "desc"),
                        page=_i(p.get("page"), 1), limit=_i(p.get("limit"), 25),
                        label=p.get("label") or None)
    for r in res.get("rows", []):
        r["busy"] = (r.get("busy_until") or -1) >= w().abs_week
        r["typecast"] = typecast.describe(r.get("labels"), r.get("gender"))
    res.update(ok=True, **_page(res, p.get("page"), p.get("limit")))
    return res


def r_actor(p):
    wld = w()
    d = A.actor_detail(wld, _i(p.get("id")))
    if not d:
        return dict(ok=False, error="no such actor")
    d["coach_options"] = A.coach_options(wld)
    d["legacy"] = LG.actor_info(wld, d["id"])
    d["yours"] = d.get("studio") == "player" and (d.get("contract_films") or 0) > 0
    d["rival"] = bool(d.get("studio")) and d.get("studio") != "player"
    d["busy"] = (d.get("busy_until") or -1) >= wld.abs_week
    d["busy_until_year"] = (wld.start_year + d["busy_until"] // 52) if d["busy"] else None
    d["contract_until_year"] = (wld.start_year + (d.get("contract_until") or 0) // 52
                                if d.get("contract_films") else None)
    d["loan_out"] = A.loan_out_quote(wld, d) if d["yours"] else None
    d["sign_bonus"] = {n: round(d["fee"] * (0.12 + 0.23 * n), 0) for n in C.CONTRACT_FILMS}
    d["sign_rate"] = {n: round(d["fee"] * C.CONTRACT_DISCOUNT[n], 0) for n in C.CONTRACT_FILMS}
    d["typecast"] = typecast.describe(d.get("labels"), d.get("gender"))
    d["genre_profile"] = typecast.profile(wld, d["id"])
    d["award_list"] = [dict(r) for r in wld.db.q(
        """SELECT year, label, movie_title, movie_id, studio, won, category FROM awards
           WHERE actor_id=? ORDER BY year DESC, won DESC""", (d["id"],))]
    return d


def r_actor_action(p):
    wld, act, aid = w(), p.get("action"), _i(p.get("id"))
    with LOCK:
        if act == "sign":
            return A.sign(wld, aid, max(1, min(8, _i(p.get("films"), 1))))
        if act == "release":
            return A.release_actor(wld, aid)
        if act == "develop":
            return A.develop(wld, aid, p.get("kind", "coach"))
        if act == "publicity":
            return A.publicity(wld, aid)
        if act == "blacklist":
            return A.blacklist(wld, aid)
        if act == "hire_rival":
            return A.hire_from_rival(wld, aid)
        if act == "loan_out":
            return A.loan_out(wld, aid)
    return dict(ok=False, error="unknown actor action")


# ---- casting -------------------------------------------------------------- #
def r_casting_pool(p):
    rows = casting.discovery_pool(w(), include_industry=bool(p.get("industry")))
    wld = w()
    for r in rows:
        r.setdefault("source", "open call")
    return dict(ok=True, rows=rows, cost=casting.open_call_cost(wld, 1),
                costs=[round(casting.open_call_cost(wld, t), 0) for t in range(4)])


def r_open_call(p):
    with LOCK:
        return casting.open_call(w(), tier=max(0, min(3, _i(p.get("tier"), 1))))


def r_waive(p):
    with LOCK:
        return casting.waive(w(), _i(p.get("id")))


def r_auditions(p):
    return casting.role_shortlist(w(), _i(p.get("production")), _i(p.get("role")),
                                  limit=_i(p.get("limit"), 24))


# ---- production ----------------------------------------------------------- #
def _label_roles(rows):
    """Give each role a human label: Lead 1, Supporting 3, Cameo 7..."""
    seen = {}
    for r in rows:
        kind = r.get("kind") or "supporting"
        seen[kind] = seen.get(kind, 0) + 1
        r["label"] = f"{kind.replace(chr(95), ' ').title()} {seen[kind]}"
        if not r.get("name"):
            r["name"] = r["label"]
    return rows


def _decorate_production(row):
    if not row:
        return row
    row["phase"] = row.get("status")
    row["roles_total"] = row.get("roles_total") or row.get("role_count") or 0
    row["franchise_name"] = row.get("franchise_name") or row.get("franchise")
    if row.get("id") and not row.get("director_name"):
        row["director_name"] = w().db.scalar(
            "SELECT d.name FROM directors d JOIN productions p ON p.director_id=d.id "
            "WHERE p.id=?", (row["id"],))
    row["phase_label"] = {"development": "Development", "pre_production": "Pre-production",
                          "shooting": "Shooting", "post_production": "Post-production",
                          "ready": "Awaiting release", "released": "Released",
                          "cancelled": "Shut down"}.get(row.get("status"), row.get("status"))
    if row.get("roles"):
        _label_roles(row["roles"])
    return row


def r_productions(p):
    rows = [dict(r) for r in P.list_active(w())]
    for r in rows:
        _decorate_production(r)
    return dict(ok=True, rows=rows, library=S.library(w()))


def r_production(p):
    pid = _i(p.get("id"))
    d = P.production_detail(w(), pid)
    if not d:
        return dict(ok=False, error="no such production")
    return _decorate_production(dict(d))


def r_production_action(p):
    wld, act = w(), p.get("action")
    pid = _i(p.get("id"))
    with LOCK:
        if act == "create":
            return P.create(wld, _i(p["script_id"]), title=p.get("title"),
                            scale=p.get("scale", "standard"), budget=_f(p.get("budget")),
                            marketing=_f(p.get("marketing")), director_id=_i(p.get("director_id")),
                            formats=p.get("formats") or [], bond=bool(p.get("bond")))
        if act == "formats":
            return FM.set_formats(wld, pid, p.get("formats") or [])
        if act == "bond":
            return FM.take_bond(wld, pid)
        if act == "upgrade":
            return P.set_upgrade(wld, pid, p.get("cat"), _i(p.get("tier"), 0))
        if act == "max_upgrades":
            return P.max_upgrades(wld, pid)
        if act == "auto_cast":
            return casting.auto_cast(wld, pid)
        if act == "budget":
            return P.set_budget(wld, pid, _f(p.get("budget"), 0))
        if act == "marketing":
            return P.set_marketing(wld, pid, _f(p.get("amount"), 0))
        if act == "director":
            return P.set_director(wld, pid, _i(p.get("director_id")))
        if act == "cast":
            return P.cast_role(wld, pid, _i(p.get("role_id")), _i(p.get("actor_id")))
        if act == "uncast":
            return P.uncast_role(wld, pid, _i(p.get("role_id")))
        if act == "test":
            return P.test_screening(wld, pid)
        if act == "reshoot":
            return P.reshoot(wld, pid, _f(p.get("amount")))
        if act == "cancel":
            return P.cancel(wld, pid)
    return dict(ok=False, error="unknown production action")


def r_directors(p):
    res = P.directors_market(w(), sort=p.get("sort", "vision"), dirn=p.get("dir", "desc"),
                             page=_i(p.get("page"), 1), limit=_i(p.get("limit"), 25))
    res.update(ok=True, **_page(res, p.get("page"), p.get("limit")))
    return res


# ---- scripts & writers ---------------------------------------------------- #
def r_script_market(p):
    res = S.market(w(), genre=p.get("genre"), scale=p.get("scale"),
                   max_price=_f(p.get("max_price")), q=p.get("q"),
                   sort=p.get("sort", "price"), dirn=p.get("dir", "asc"),
                   page=_i(p.get("page"), 1), limit=_i(p.get("limit"), 25))
    res.update(ok=True, **_page(res, p.get("page"), p.get("limit")))
    return res


def _enrich_library(wld, rows) -> list:
    out = []
    std = C.standard_cost(wld.year)
    for r in rows:
        r = dict(r)
        r["known"] = r.get("coverage") is not None
        r["shoot_cost"] = round(std * C.SCALES.get(r.get("scale", "standard"),
                                                   C.SCALES["standard"])["mult"], -3)
        r["in_use"] = bool(wld.db.scalar(
            "SELECT COUNT(*) FROM productions WHERE script_id=? AND status NOT IN "
            "('released','cancelled')", (r["id"],), 0))
        r["option_expires"] = (wld.db.kv_get(f"option_due:{r['id']}", None)
                               if r.get("status") == "optioned" else None)
        out.append(r)
    return out


def r_script_library(p):
    return dict(ok=True, rows=_enrich_library(w(), S.library(w())))


def r_script(p):
    wld = w()
    d = S.script_detail(wld, _i(p.get("id")))
    if not d:
        return dict(ok=False, error="no such script")
    # true quality stays hidden: the studio only ever knows its readers' coverage
    d.pop("quality", None)
    d["owned"] = d.get("owner") == "player"
    d["std_cost"] = C.standard_cost(wld.year)
    d["writer_name"] = (d.get("writer") or {}).get("name") if isinstance(d.get("writer"), dict) else None
    d["dev_options"] = S.development_options(wld)
    d["sale"] = S.sale_quote(wld, d["id"]) if d["owned"] else None
    d["coverage_cost"] = round(S.coverage_cost(wld), 0)
    d["slots"] = economy.max_productions(wld)
    d["in_work"] = wld.db.scalar("""SELECT COUNT(*) FROM productions WHERE status IN
        ('development','pre_production','shooting','post_production')""", (), 0)
    return d


def r_script_action(p):
    wld, act = w(), p.get("action")
    sid = _i(p.get("id"))
    with LOCK:
        if act == "buy":
            return S.buy(wld, sid)
        if act == "sell":
            return S.sell(wld, sid)
        if act == "option":
            return S.option(wld, sid)
        if act == "coverage":
            return S.coverage(wld, sid)
        if act == "develop":
            return S.develop(wld, sid, p.get("kind", "polish"))
    return dict(ok=False, error="unknown script action")


def _writer_row(r) -> dict:
    r = dict(r)
    r["week_rate"] = r.get("week_rate") or r.get("salary") or 0.0
    r["best"] = r.get("best") or r.get("genre") or "—"
    r["speed"] = r.get("speed") or round(52.0 / max(1.0, r.get("weeks_per_script") or 8.0), 1)
    quirks = []
    if (r.get("drink") or 0) > 55:
        quirks.append("drinks")
    if (r.get("ego") or 0) > 65:
        quirks.append("difficult")
    r["quirk"] = ", ".join(quirks)
    return r


def r_writers(p):
    wld = w()
    if p.get("staff"):
        rows = [dict(r) for r in wld.db.q(
            "SELECT * FROM writers WHERE studio='player' ORDER BY skill DESC")]
        for r in rows:
            r["assigned"] = wld.db.kv_get(f"wassign:{r['id']}", None)
        return dict(ok=True, rows=[_writer_row(r) for r in rows], total=len(rows),
                    page=1, pages=1)
    res = S.writers_market(wld, sort=p.get("sort", "skill"), dirn=p.get("dir", "desc"),
                           page=_i(p.get("page"), 1), limit=_i(p.get("limit"), 25))
    res["rows"] = [_writer_row(r) for r in res.get("rows", [])]
    res.update(ok=True, **_page(res, p.get("page"), p.get("limit")))
    return res


def r_writer_action(p):
    wld, act, wid = w(), p.get("action"), _i(p.get("id"))
    with LOCK:
        if act == "hire":
            return S.hire_writer(wld, wid, staff_pos=bool(p.get("staff", True)))
        if act == "fire":
            return S.fire_writer(wld, wid)
        if act == "assign":
            return S.assign_genre(wld, wid, p.get("genre"))
    return dict(ok=False, error="unknown writer action")


# ---- releases, franchises, world ------------------------------------------ #
def _jarr(v):
    """Rows store JSON blobs as text; the frontend wants real arrays."""
    if isinstance(v, list):
        return v
    if isinstance(v, str) and v.strip().startswith("["):
        try:
            out = json.loads(v)
            return out if isinstance(out, list) else []
        except Exception:
            return []
    return []


def r_releases(p):
    res = boxoffice.catalogue(w(), q=p.get("q"), genre=p.get("genre"), outcome=p.get("outcome"),
                              rights=p.get("rights", "player"), sort=p.get("sort", "year"),
                              dirn=p.get("dir", "desc"), page=_i(p.get("page"), 1),
                              limit=_i(p.get("limit"), 30),
                              cult_only=bool(p.get("cult_only")))
    for r in res.get("rows", []):
        r["cast"] = _jarr(r.get("cast"))
        r["domestic"] = r.get("gross_domestic") or 0.0
        r["foreign"] = round((r.get("gross") or 0.0) - (r.get("gross_domestic") or 0.0))
    res.update(ok=True)
    return res


def r_movie(p):
    wld = w()
    m = wld.db.q1("""SELECT m.*, f.name AS franchise_name FROM movies m
                     LEFT JOIN franchises f ON f.id=m.franchise_id WHERE m.id=?""", (_i(p.get("id")),))
    if not m:
        return dict(ok=False, error="no such picture")
    r = dict(m)
    r["cast"] = _jarr(r.get("cast"))
    r["domestic"] = r.get("gross_domestic") or 0.0
    r["foreign"] = round((r.get("gross") or 0.0) - (r.get("gross_domestic") or 0.0))
    r["total"] = (r.get("gross") or 0) * C.STUDIO_SHARE + (r.get("secondary") or 0)
    r["can_series"] = r["rights"] == "player" and not r.get("franchise_id")
    r["home"] = FM.home_options(wld, m) if r["rights"] == "player" else []
    r["formats"] = wld.db.kv_get(f"mfmt:{r['id']}", None)
    r["series_fan"] = round(franchise.series_fan_estimate(m), 0)
    r["series_fee"] = round(franchise.series_setup_fee(wld, m), 0)
    r["sequel_cost"] = round(C.standard_cost(wld.year) * 0.045, 0)
    r["can_sell"] = r["rights"] == "player" and not r.get("franchise_id")
    r["has_review"] = bool(wld.db.scalar("SELECT COUNT(*) FROM reviews WHERE movie_id=?", (r["id"],), 0))
    run = charts.movie_run(wld, r["id"])
    r["chart"] = dict(best_rank=run["best_rank"], w1=run["w1"], w10=run["w10"], wk=run["wk"],
                      active=run["active"], rank=run["rank"]) if run else None
    if r.get("franchise_id"):
        f = wld.db.q1("SELECT * FROM franchises WHERE id=?", (r["franchise_id"],))
        if f:
            r["series"] = dict(id=f["id"], name=f["name"], status=f["status"], rights=f["rights"],
                               installments=f["installments"], fan_base=round(f["fan_base"], 0),
                               mine=f["rights"] == "player")
    return dict(ok=True, **r)


def r_formats(p):
    """Greenlight preview: format choices, era overheads and the bond for a
    picture of this budget / genre / scale in the current year."""
    wld = w()
    budget = _f(p.get("budget")) or C.standard_cost(wld.year)
    genre, scale = p.get("genre", "drama"), p.get("scale", "standard")
    return dict(ok=True, year=wld.year, formats=FM.options(wld, budget, genre, scale),
                era_costs=FM.era_costs(wld, budget),
                bond=dict(available=FM.bond_available(wld), cost=FM.bond_cost(budget)),
                residual_rate=FM.residual_rate(wld.year))


def r_home(p):
    with LOCK:
        return FM.home_release(w(), _i(p.get("id")), p.get("kind"))


def r_catalogue(p):
    return dict(ok=True, rows=FM.catalogue_candidates(w(), limit=_i(p.get("limit"), 12)))


def r_release(p):
    with LOCK:
        res = boxoffice.release(w(), _i(p.get("production")))
        if res.get("ok"):
            engine.milestones(w())
        return res


def r_review(p):
    rv = press.get_review(w(), _i(p.get("id")))
    if not rv:
        return dict(ok=False, error="no review for that picture")
    rv["unseen"] = w().db.scalar("SELECT COUNT(*) FROM reviews WHERE seen=0", 0)
    return dict(ok=True, **rv)


def r_review_seen(p):
    with LOCK:
        if p.get("all"):
            w().db.execute("UPDATE reviews SET seen=1 WHERE seen=0")
        else:
            w().db.execute("UPDATE reviews SET seen=1 WHERE movie_id=?", (_i(p.get("id")),))
        return dict(ok=True, unseen=w().db.scalar("SELECT COUNT(*) FROM reviews WHERE seen=0", 0))


def _issue_date(wld, absw):
    year = wld.start_year + absw // 52
    week = absw % 52
    return year, week


def r_paper(p):
    """One issue of the trade paper. `abs` picks a back issue (absolute week)."""
    wld = w()
    now = wld.abs_week
    absw = _i(p.get("abs"), now)
    absw = max(0, min(now, absw))
    size = max(10, min(100, _i(p.get("chart"), 10)))
    year, week = _issue_date(wld, absw)
    chart = charts.current(wld, size) if absw == now else charts.past(wld, absw)
    fresh_since = absw - 3
    sections = {}
    for sec in ("review", "release", "boxoffice", "stars", "world", "awards", "records", "business"):
        sections[sec] = press.stories(wld, sec, upto=absw, limit=8)
    front = press.stories(wld, None, upto=absw, since=absw - 1, limit=40)
    front.sort(key=lambda r: (-(r["weight"] + (2 if r["mine"] else 0)), -r["abs_week"], -r["id"]))
    if len(front) < 4:
        more = press.stories(wld, None, upto=absw, since=absw - 8, limit=40)
        seen = {r["id"] for r in front}
        more.sort(key=lambda r: (-(r["weight"] + (2 if r["mine"] else 0)), -r["abs_week"], -r["id"]))
        front += [r for r in more if r["id"] not in seen]
    in_release = wld.db.scalar("SELECT COUNT(*) FROM box_runs WHERE active=1 AND wk>0", 0) \
        if absw == now else None
    total = (wld.db.scalar("SELECT SUM(week_gross) FROM box_runs WHERE active=1 AND wk>0", 0)
             if absw == now else
             wld.db.scalar("SELECT SUM(gross) FROM chart_hist WHERE abs_week=?", (absw,), 0))
    ticket = C.ticket_price(year)
    return dict(ok=True, abs=absw, now=now, first=0, year=year, week=week,
                date=f"Week {week + 1}, {year}", era=era_label(year),
                price=round(max(0.02, ticket * 0.12), 2), issue=absw + 1,
                front=front[:5], chart=chart, chart_size=size, sections=sections,
                in_release=in_release, total_week=total or 0.0, top10_only=absw != now,
                fresh_since=fresh_since)


def r_records(p):
    return dict(ok=True, records=charts.records(w(), limit=_i(p.get("limit"), 5)))


def r_franchises(p):
    rows = []
    for f in franchise.list_all(w()):
        f = dict(f)
        f["gross"] = f.get("total_gross") or 0.0
        fat = f.get("fatigue")
        f["fatigue"] = (fat or {}).get("penalty", 0.0) if isinstance(fat, dict) else (fat or 0.0)
        f["fatigue_note"] = (fat or {}).get("note", "") if isinstance(fat, dict) else ""
        rows.append(f)
    return dict(ok=True, rows=rows)


def r_franchise(p):
    d = franchise.detail(w(), _i(p.get("id")))
    if not d:
        return dict(ok=False, error="no such series")
    d = dict(d)
    d["ok"] = True
    d["gross"] = d.get("total_gross") or 0.0
    if not d.get("movies"):
        d["movies"] = [dict(x) for x in w().db.q(
            "SELECT id,title,year,gross,net,outcome,cult_classic FROM movies "
            "WHERE franchise_id=? ORDER BY year", (d.get("id"),))]
    fat = d.get("fatigue")
    d["fatigue_note"] = (fat or {}).get("note", "") if isinstance(fat, dict) else ""
    d["fatigue"] = (fat or {}).get("penalty", 0.0) if isinstance(fat, dict) else (fat or 0.0)
    d["std_cost"] = C.standard_cost(w().year)
    return d


def r_characters(p):
    from .sim import characters as CH
    wld = w()
    return dict(ok=True, rows=CH.all_rows(wld), teamup=CH.teamup_options(wld),
                icons=CH.icons_in_town(wld), max_team=CH.TEAMUP_MAX, min_fan=CH.TEAMUP_MIN_FAN)


def r_franchise_action(p):
    wld, act = w(), p.get("action")
    with LOCK:
        if act == "create":
            return franchise.create_from_movie(wld, _i(p.get("movie_id")), p.get("name"))
        if act == "launch":
            return franchise.launch(wld, _i(p.get("id")), kind=p.get("kind", "sequel"),
                                    script_id=_i(p.get("script_id")), scale=p.get("scale"),
                                    budget=_f(p.get("budget")), marketing=_f(p.get("marketing")),
                                    title=(p.get("title") or None))
        if act == "sequel_from_movie":
            return franchise.sequel_from_movie(wld, _i(p.get("movie_id")), kind=p.get("kind", "sequel"),
                                               name=p.get("name"), scale=p.get("scale"),
                                               budget=_f(p.get("budget")),
                                               marketing=_f(p.get("marketing")),
                                               title=(p.get("title") or None))
        if act == "tv":
            return franchise.launch_tv(wld, _i(p.get("id")))
        if act == "tv_cancel":
            return franchise.cancel_tv(wld, _i(p.get("id")))
        if act == "solicit":
            return franchise.solicit(wld, p.get("kind", "franchise"), _i(p.get("id")))
        if act == "sell":
            return franchise.sell(wld, _i(p.get("offer_id")))
        if act == "decline":
            return franchise.decline(wld, _i(p.get("offer_id")))
        if act == "buyback":
            return franchise.buyback(wld, p.get("kind", "franchise"), _i(p.get("asset_id")))
        if act == "option_out":
            return franchise.option_out(wld, _i(p.get("id")), max(2, min(20, _i(p.get("years"), 7))))
        if act == "acquire":
            return rivals.acquire(wld, _i(p.get("offer_id")))
        if act in ("spinoff", "teamup"):
            from .sim import characters as CH
            kw = dict(scale=p.get("scale") or None, budget=_f(p.get("budget")),
                      marketing=_f(p.get("marketing")), title=(p.get("title") or None))
            if act == "spinoff":
                return CH.spinoff(wld, _i(p.get("character_id")), name=p.get("name") or None, **kw)
            ids = p.get("character_ids") or []
            if isinstance(ids, str):
                ids = [x for x in ids.split(",") if x.strip()]
            return CH.teamup(wld, [_i(x) for x in ids], name=p.get("name") or None, **kw)
    return dict(ok=False, error="unknown franchise action")


def r_offers(p):
    rows = offer_rows(franchise.offers(w(), include_expired=bool(p.get("all"))))
    return dict(ok=True, rows=rows, open=len([r for r in rows if r.get("status") == "open"]))


def r_world(p):
    wld = w()
    return dict(ok=True,
                trends=state_payload()["trends"],
                events=E.active(wld),
                tech=tech_table(),
                era=dict(year=wld.year, label=era_label(wld.year),
                         standard_cost=C.standard_cost(wld.year),
                         ticket=C.ticket_price(wld.year),
                         attendance=C.attendance_index(wld.year),
                         difficulty=C.difficulty(wld.year)),
                rivals=[dict(r, status=("bankrupt" if not r.get("alive", 1) else "active"))
                        for r in rivals.table(wld)],
                supply=wld.db.kv_get("supply", {}))


def r_log(p):
    kind = p.get("kind")
    limit = max(1, min(300, _i(p.get("limit"), 80)))
    if kind and kind != "any":
        rows = w().db.q("SELECT * FROM event_log WHERE kind=? ORDER BY id DESC LIMIT ?",
                        (kind, limit))
    else:
        rows = w().db.q("SELECT * FROM event_log ORDER BY id DESC LIMIT ?", (limit,))
    return dict(ok=True, rows=[dict(r) for r in rows])


def r_event_action(p):
    with LOCK:
        return E.resolve_choice(w(), p.get("id") or "", str(p.get("choice", "0")))


def r_finance(p):
    return dict(ok=True, **economy.finance_summary(w()))


def r_finance_action(p):
    wld, act = w(), p.get("action")
    with LOCK:
        if act == "loan":
            return economy.take_loan(wld, _f(p.get("amount"), 0))
        if act == "repay":
            return economy.repay(wld, _i(p.get("id")), _f(p.get("amount")))
        if act == "build":
            return economy.build(wld, p.get("kind"))
        if act == "campaign":
            return engine.campaign(wld, _f(p.get("amount"), 0))
    return dict(ok=False, error="unknown finance action")


def r_awards(p):
    year = _i(p.get("year"))
    if year:
        rows = w().db.q("SELECT * FROM awards WHERE year=? ORDER BY id", (year,))
    else:
        rows = w().db.q("SELECT * FROM awards ORDER BY year DESC, id LIMIT 120")
    out = []
    for r in rows:
        r = dict(r)
        r["title"] = r.get("movie_title") or r.get("actor_name") or "—"
        r["award"] = r.get("label") or r.get("category") or ""
        cat = str(r.get("category") or "")
        r["kind"] = "razzie" if ("worst" in cat.lower() or "razzie" in cat.lower()) else "oscar"
        out.append(r)
    decorated = [dict(r) for r in w().db.q(
        """SELECT a.id, a.name, a.gender, a.status, a.labels,
                  SUM(CASE WHEN aw.won=1 AND aw.category='actor' THEN 1 ELSE 0 END) AS wins,
                  SUM(CASE WHEN aw.category='actor' THEN 1 ELSE 0 END) AS noms,
                  SUM(CASE WHEN aw.category='razzie_actor' THEN 1 ELSE 0 END) AS razzies,
                  GROUP_CONCAT(CASE WHEN aw.won=1 AND aw.category='actor'
                               THEN aw.movie_title || ' (' || aw.year || ')' END, ' · ') AS won_for
           FROM awards aw JOIN actors a ON a.id=aw.actor_id
           GROUP BY a.id HAVING noms > 0 ORDER BY wins DESC, noms DESC, a.name LIMIT 20""")]
    for r in decorated:
        r["typecast"] = typecast.describe(r.get("labels"), r.get("gender"))
    return dict(ok=True, rows=out, milestones=engine.milestone_table(w()), decorated=decorated,
                ceremony_year=w().year, campaign=w().db.kv_get(f"campaign:{w().year}", 0.0),
                ceremonies=AW.years(w()),
                hall=LG.hall(w()),
                bodies=[dict(id=b["id"], name=b["name"], short=b["short"], blurb=b["blurb"])
                        for b in C.AWARD_BODIES])


def r_ceremony(p):
    return AW.get(w(), _i(p.get("year")))


def r_ceremony_action(p):
    if p.get("action") == "seen":
        return AW.seen(w())
    return dict(ok=False, error="unknown ceremony action")


def current_slug():
    """Which studio the server already has open, if any."""
    if not WORLD:
        return None
    base = os.path.basename(WORLD.db.path)
    return base[:-len(".sqlite")] if base.endswith(".sqlite") else base


def r_config(p):
    return dict(ok=True,
                start_years=START_YEARS,
                current=current_slug(),
                presets=C.START_CASH,
                genres=[dict(id=g, label=C.GENRE_LABEL[g]) for g in C.GENRES],
                scales=[dict(id=k, **{kk: vv for kk, vv in v.items()}) for k, v in C.SCALES.items()],
                upgrades=[dict(id=k, label=v["label"]) for k, v in C.UPGRADES.items()],
                skills=getattr(C, "ACTOR_SKILLS", []),
                saves=list_saves(),
                version="0.1.0")


ROUTES = {
    ("GET", "/api/config"): r_config,
    ("POST", "/api/new_game"): r_new_game,
    ("POST", "/api/load"): r_load,
    ("GET", "/api/saves"): r_saves,
    ("GET", "/api/state"): state_payload,
    ("POST", "/api/tick"): r_tick,
    ("POST", "/api/speed"): r_speed,
    ("GET", "/api/actors"): r_actors,
    ("GET", "/api/actor"): r_actor,
    ("POST", "/api/actor"): r_actor_action,
    ("GET", "/api/casting/pool"): r_casting_pool,
    ("POST", "/api/casting/open_call"): r_open_call,
    ("POST", "/api/casting/waive"): r_waive,
    ("GET", "/api/auditions"): r_auditions,
    ("GET", "/api/productions"): r_productions,
    ("GET", "/api/production"): r_production,
    ("POST", "/api/production"): r_production_action,
    ("GET", "/api/directors"): r_directors,
    ("GET", "/api/scripts/market"): r_script_market,
    ("GET", "/api/scripts/library"): r_script_library,
    ("GET", "/api/script"): r_script,
    ("POST", "/api/script"): r_script_action,
    ("GET", "/api/writers"): r_writers,
    ("POST", "/api/writer"): r_writer_action,
    ("GET", "/api/releases"): r_releases,
    ("POST", "/api/release"): r_release,
    ("GET", "/api/movie"): r_movie,
    ("GET", "/api/formats"): r_formats,
    ("POST", "/api/home"): r_home,
    ("GET", "/api/catalogue"): r_catalogue,
    ("GET", "/api/review"): r_review,
    ("POST", "/api/review/seen"): r_review_seen,
    ("GET", "/api/paper"): r_paper,
    ("GET", "/api/records"): r_records,
    ("GET", "/api/franchises"): r_franchises,
    ("GET", "/api/franchise"): r_franchise,
    ("GET", "/api/characters"): r_characters,
    ("POST", "/api/franchise"): r_franchise_action,
    ("GET", "/api/offers"): r_offers,
    ("GET", "/api/world"): r_world,
    ("GET", "/api/log"): r_log,
    ("POST", "/api/event"): r_event_action,
    ("GET", "/api/finance"): r_finance,
    ("POST", "/api/finance"): r_finance_action,
    ("GET", "/api/awards"): r_awards,
    ("GET", "/api/ceremony"): r_ceremony,
    ("POST", "/api/ceremony"): r_ceremony_action,
}


def handle(method: str, path: str, params: dict) -> dict:
    fn = ROUTES.get((method.upper(), path))
    if not fn:
        return dict(ok=False, error=f"no route {method} {path}", routes=sorted(ROUTES.keys()))
    try:
        with LOCK:
            out = fn(params or {})
            # every decision is written straight to the save, not just on the
            # next calendar tick - closing the browser never loses a move
            if method.upper() == "POST" and WORLD is not None:
                WORLD.flush()
                WORLD.db.commit()
        if isinstance(out, dict):
            # every success answers ok:true; the frontend tests it everywhere
            out.setdefault("ok", True)
        return out
    except NoGame:
        return dict(ok=False, need_game=True,
                    error="no studio yet - start a new game or load a save")
    except Exception as exc:                              # never kill the server
        import traceback
        traceback.print_exc()
        return dict(ok=False, error=f"{type(exc).__name__}: {exc}")
