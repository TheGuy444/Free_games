"""Autoplayer: plays the game the way a competent human would, so we can see
whether the economy, the talent market and the outcome spread actually hold up
over 60-90 years.  Also what `run.py --headless` runs.

    python -m tests.test_play [--years 60] [--seed 3] [--start 1928]
"""
from __future__ import annotations

import os
import sys

from . import config as C
from .db import DB
from .state import World
from .sim import (actors, boxoffice, casting, economy, engine, events,
                  franchise, production, rivals, scripts)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))



def fresh(slug, start_year, seed, actors_n=5200):
    path = os.path.join(ROOT, "saves", f"_auto_{slug}.sqlite")
    for suf in ("", "-wal", "-shm"):
        if os.path.exists(path + suf):
            os.remove(path + suf)
    db = DB(path)
    from game import universe
    universe.new_world(db, "Meridian Pictures", start_year, "studio", seed, actors=actors_n)
    return World(db)


def pick_cast(w, pid, budget, ceiling=0.42):
    """Fill every role with the best affordable fit, keeping the whole cast
    inside a share of the production budget."""
    out, spent = [], 0.0
    for role in w.db.q("SELECT id,kind FROM roles WHERE production_id=? ORDER BY idx", (pid,)):
        sl = casting.role_shortlist(w, pid, role["id"], limit=30)
        cap = budget * (0.20 if role["kind"] == "lead" else 0.08)
        for cand in sl["rows"]:
            fee = cand.get("fee") or 0
            if spent + fee > budget * ceiling:
                continue
            if fee <= cap and (cand.get("risk") or 0) < 55:
                r = production.cast_role(w, pid, role["id"], cand["id"])
                if r.get("ok"):
                    spent += fee
                    out.append((cand["name"], role["kind"], fee))
                    break
    return out


def buy_upgrades(w, pid, pot):
    std = C.standard_cost(w.year)
    p = production.get(w, pid)
    for _round in range(4):
        for k in ("sets", "costumes", "props", "sfx", "sound_stage", "score",
                  "cinematography", "stunt_team"):
            nxt = production.next_upgrade_cost(w, p, k)
            if nxt and nxt["cost"] <= pot * 0.18 and w.cash > nxt["cost"] + std * 2:
                production.set_upgrade(w, pid, k, nxt["tier"])
                pot -= nxt["cost"]
                p = production.get(w, pid)


def _staff(w, res):
    """Cast, dress and direct a picture the way the main loop does."""
    if not res or not res.get("ok"):
        return
    pid = res["id"]
    p = production.get(w, pid)
    pick_cast(w, pid, p["budget"])
    buy_upgrades(w, pid, p["budget"])
    dirs = w.db.q("""SELECT id FROM directors WHERE (busy_until < ? OR busy_until IS NULL)
                     AND (studio IS NULL OR studio='player') ORDER BY vision DESC LIMIT 1""", (w.abs_week,))
    if dirs:
        production.set_director(w, pid, dirs[0]["id"])


def _guess(s) -> float:
    """What the autoplayer thinks a script is worth: a reader's number if we
    bought coverage, otherwise the producer's gut feel."""
    c = s.get("coverage")
    return float(c if c is not None else (s.get("fp") or 0))


def autoplay(years=60, seed=3, start=1928, slug="main", verbose=True, progress=None):
    w = fresh(slug, start, seed)
    history = []
    # sign a writer so we always have scripts
    for wr in w.db.q("SELECT id FROM writers WHERE studio IS NULL ORDER BY skill DESC LIMIT 1"):
        scripts.hire_writer(w, wr["id"], staff_pos=True)
    guard = 0
    while w.year < start + years and not w.over:
        guard += 1
        if guard > 4000:
            break
        std = C.standard_cost(w.year)
        active = w.db.scalar("SELECT COUNT(*) FROM productions WHERE status NOT IN "
                             "('released','cancelled')", (), 0)

        # 1. money in the bank
        if w.cash < -std * 0.4 and not w.db.q1("SELECT id FROM loans WHERE balance>0"):
            economy.take_loan(w, std * 3)

        # 5b. spin a breakout character off, or put the stars of several
        # series in one picture once there is a universe worth pooling
        from .sim import characters as CH
        busy_now = w.db.scalar("SELECT COUNT(*) FROM productions WHERE status NOT IN "
                               "('released','cancelled')", (), 0)
        if busy_now < economy.max_productions(w) and w.cash > std * 10 \
                and w.year - (w.db.kv_get("ap_spinoff", 0) or 0) >= 6:
            for c in w.db.q("""SELECT c.* FROM characters c JOIN franchises f ON f.id=c.franchise_id
                               WHERE f.rights='player' AND c.spun_off=0 AND c.role<>'lead'
                               AND c.breakout >= 1 AND c.fan >= 40 ORDER BY c.fan DESC LIMIT 3"""):
                res = CH.spinoff(w, c["id"])
                if res.get("ok"):
                    _staff(w, res)
                    w.db.kv_set("ap_spinoff", w.year)
                    break
        if busy_now < economy.max_productions(w) and w.year >= 1975 and w.cash > std * 25 \
                and w.year - (w.db.kv_get("ap_teamup", 0) or 0) >= 6 \
                and not w.db.scalar("""SELECT COUNT(*) FROM franchises WHERE kind='universe'
                                       AND rights='player' AND status='active'""", (), 0):
            best = {}
            for c in CH.teamup_options(w):
                if c["series_kind"] != "universe" and c["fan"] >= 60 and c["franchise_id"] not in best:
                    best[c["franchise_id"]] = c
            team = sorted(best.values(), key=lambda c: -c["fan"])[:4]
            if len(team) >= 2:
                res = CH.teamup(w, [c["id"] for c in team])
                if res.get("ok"):
                    _staff(w, res)
                    w.db.kv_set("ap_teamup", w.year)

        # 2. greenlight
        scale = "standard"
        if w.cash > std * 14:
            scale = "epic"
        if w.cash > std * 40:
            scale = "blockbuster"
        want = 1 if w.cash < std * 8 else (2 if w.cash < std * 20 else 3)
        # lean times: nothing shooting and not enough for a standard feature -
        # borrow against the library if we must and shoot something cheap,
        # the way a real studio kept the lights on, instead of idling to death
        if active == 0 and w.cash <= std * 2.2:
            if w.cash < std * 0.9 and not w.db.q1("SELECT id FROM loans WHERE balance>0"):
                economy.take_loan(w, min(economy.borrowing_capacity(w), std * 1.2))
            if w.cash > std * 0.6:
                scale = "indie"
        if active < want and (w.cash > std * (2.2 if scale == "standard" else 4.5)
                              or (scale == "indie" and active == 0)):
            busy_fr = {r["franchise_id"] for r in w.db.q(
                """SELECT franchise_id FROM productions WHERE franchise_id IS NOT NULL
                   AND status NOT IN ('released','cancelled')""")}
            lib = [s for s in scripts.library(w) if s.get("source_franchise") not in busy_fr]
            hot = max(w.trends().items(), key=lambda kv: kv[1])[0] if w.trends() else None
            lib.sort(key=lambda s: -_guess(s) * (1 + 0.4 * (s["genre"] == hot)))
            if lib:
                s = lib[0]
                if w.cash < std * 3 and s.get("option_price"):
                    scripts.option(w, s["id"])
                bud = std * {"indie": 0.45, "standard": 0.95, "epic": 1.8}.get(scale, 3.0)
                # formats: anything audiences now expect, plus anything whose
                # pull for this genre clearly beats what it costs
                from .sim import formats as FM
                fm = [f["id"] for f in FM.options(w, bud, s["genre"], scale)
                      if not f["standard"] and (f["miss"] > 0 or f["cost"] < 0
                                                or f["appeal"] > 100 * f["cost"] / max(1.0, bud) * 1.6)]
                r = production.create(w, s["id"], scale=scale, budget=bud, marketing=std * 0.25,
                                      formats=fm, bond=FM.bond_available(w) and scale != "indie")
                if not r.get("ok"):
                    if verbose and w.year < start + 4:
                        print(f"   greenlight failed ({w.year}): {r.get('error')} "
                              f"cash={w.cash:,.0f} std={std:,.0f}")
                else:
                    pid = r["id"]
                    casted = pick_cast(w, pid, bud)
                    buy_upgrades(w, pid, bud)
                    dirs = w.db.q("""SELECT id FROM directors
                                      WHERE (busy_until < ? OR busy_until IS NULL)
                                        AND (studio IS NULL OR studio='player')
                                      ORDER BY vision DESC LIMIT 1""", (w.abs_week,))
                    ds = production.set_director(w, pid, dirs[0]["id"]) if dirs else {"ok": False,
                                                                                      "error": "none"}
                    production.test_screening(w, pid)
                    if verbose and w.year < start + 4:
                        pp = production.get(w, pid)
                        comp = production.components(w, pp)
                        print(f"   {w.year} film {pp['title'][:22]}: "
                              + " ".join(f"{k}={v:.0f}" for k, v in comp.items()
                                          if isinstance(v, (int, float)))
                              + f" | cast={len(casted)} ${pp['cast_spend']:,.0f}"
                              + f" dir={ds.get('ok')} ups={sum(pp['upgrades'].values())}")

        # 3. fill the pipeline
        if len(scripts.library(w)) < 2 and w.cash > std * 3:
            m = scripts.market(w, limit=12)
            if m["rows"]:
                best = max(m["rows"], key=lambda s: _guess(s) / max(1.0, s["price"]))
                if w.cash > best["price"] * 2.5:
                    scripts.buy(w, best["id"])
                elif best.get("option_price"):
                    scripts.option(w, best["id"])

        # 4. talent pipeline
        mine = casting.discovery_pool(w)
        if len(mine) < 8 and w.cash > std * 4:
            casting.open_call(w, tier=1 if w.cash < std * 12 else 2)
            # sign the best unclaimed face so the pipeline actually feeds the lot
            pool = casting.discovery_pool(w)
            if pool and w.cash > std * 10:
                top = max(pool, key=lambda a: a.get("promise") or 0)
                actors.sign(w, top["id"], films=2)

        # 5. franchises off your hits
        for m in w.db.q("""SELECT id FROM movies WHERE rights='player' AND franchise_id IS NULL
                           AND (outcome IN ('HIT','BLOCKBUSTER','PHENOMENON') OR cult>58)"""):
            franchise.create_from_movie(w, m["id"])
        frs = franchise.list_all(w)
        # a human player makes the next one while the fans still care, and
        # brings a famous series back once it has rested
        for f in sorted(frs, key=lambda f: -(f["fan_base"] or 0)):
            if f["rights"] != "player" or f["in_production"]:
                continue
            gap = w.year - (f["last_year"] or f["created_year"])
            if f["status"] in ("active", "dormant") and f["fan_base"] >= 50 and gap >= 2 \
                    and f["fatigue"]["recent"] < 2 and w.cash > std * 8:
                _staff(w, franchise.launch(w, f["id"], kind="sequel"))
                break
            if f["can_reboot"] and gap >= 12 and (f["total_gross"] or 0) > std * 15 and w.cash > std * 12:
                _staff(w, franchise.launch(w, f["id"], kind="reboot"))
                break

        # 6. sell distribution rights on anything old, keep the IP
        for o in w.db.q("""SELECT id FROM offers WHERE status='open' AND kind='distribution'
                           AND year < ?""", (w.year - 1,)):
            franchise.sell(w, o["id"])

        # 7. awards campaign when we have a contender
        if w.db.scalar("SELECT COUNT(*) FROM movies WHERE rights='player' AND year=? AND quality>76",
                       (w.year,), 0) and w.cash > std * 6:
            engine.campaign(w, std * 0.05)

        engine.advance(w, 13)
        if progress:
            progress(w)
        history.append(dict(year=w.year, cash=round(w.cash), val=round(w.valuation),
                            prestige=round(w.prestige), rep=round(w.reputation),
                            films=w.stats.get("releases", 0), hits=w.stats.get("hits", 0)))

    out = report(w, years, verbose)
    out["path"] = w.db.path
    out["slug"] = os.path.basename(w.db.path)[:-len(".sqlite")]
    out["world"] = w
    return out


def report(w, years, verbose=True):
    g = w.db.scalar("SELECT COALESCE(SUM(gross),0) FROM movies WHERE rights='player'", (), 0)
    n = w.db.scalar("SELECT COUNT(*) FROM movies WHERE rights='player'", (), 0)
    out = dict(
        end_year=w.year, weeks_played=(w.year - w.start_year) * 52 + w.week,
        films=n, avg_gross=round(g / n) if n else 0,
        outcomes=dict(w.db.q("SELECT outcome, COUNT(*) FROM movies WHERE rights='player' GROUP BY outcome")),
        cult=w.db.scalar("SELECT COUNT(*) FROM movies WHERE cult_classic=1", (), 0),
        stinkers=w.db.scalar("SELECT COUNT(*) FROM movies WHERE stinker=1", (), 0),
        awards=w.stats.get("awards", 0),
        franchises=w.db.scalar("SELECT COUNT(*) FROM franchises WHERE rights='player'", (), 0),
        sold_ip=w.db.scalar("SELECT COUNT(*) FROM franchises WHERE rights<>'player'", (), 0),
        ip_income=round(w.db.scalar("SELECT COALESCE(SUM(amount),0) FROM ledger WHERE kind='ip_sale'", (), 0)),
        actors_total=w.db.scalar("SELECT COUNT(*) FROM actors", (), 0),
        discovered=w.db.scalar("SELECT COUNT(*) FROM actors WHERE discoverer='your casting office'", (), 0),
        events=w.db.scalar("SELECT COUNT(*) FROM active_events", (), 0),
        cash=round(w.cash), valuation=round(w.valuation), prestige=round(w.prestige),
        rep=round(w.reputation), over=w.over,
        best=[dict(r) for r in w.db.q("SELECT title,year,genre,outcome,ROUND(gross) g FROM movies"
                                      " WHERE rights='player' ORDER BY gross DESC LIMIT 3")],
    )
    if verbose:
        print(f"--- {w['name'] if isinstance(w, dict) else w.name}: {years} years played ---")
        for k, v in out.items():
            print(f"  {k:>12}: {v}")
    return out


