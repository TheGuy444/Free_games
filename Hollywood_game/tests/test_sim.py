"""Headless smoke test: build a universe, play a decade, print the shape of it.

    python -m tests.test_sim [--years 20] [--seed 7] [--bench]
"""
from __future__ import annotations

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from game import config as C                      # noqa: E402
from game.db import DB                            # noqa: E402
from game.state import World                      # noqa: E402
from game.sim import engine, economy, production, franchise, boxoffice, casting, scripts, actors, events, world  # noqa: E402

TMP = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "saves", "_test.sqlite")


def fresh(start_year=1928, seed=7, preset="studio", actors_n=4200):
    for suffix in ("", "-wal", "-shm"):
        p = TMP + suffix
        if os.path.exists(p):
            os.remove(p)
    db = DB(TMP)
    from game import universe
    universe.new_world(db, "Testament Pictures", start_year, preset, seed, actors=actors_n)
    return World(db)


def run(years=12, seed=7, start=1928, verbose=True, actors_n=4200):
    w = fresh(start, seed, actors_n=actors_n)
    t0 = time.time()
    # --- do something a player would do in year one
    wr = w.db.q("SELECT id FROM writers WHERE studio IS NULL ORDER BY skill DESC LIMIT 2")
    for r in wr:
        scripts.hire_writer(w, r["id"], staff_pos=True)
    engine.advance(w, 26)
    lib = scripts.library(w)
    if lib:
        s = lib[0]
        res = production.create(w, s["id"], scale="standard",
                                budget=C.standard_cost(w.year) * 0.9,
                                marketing=C.standard_cost(w.year) * 0.2)
        if res.get("ok"):
            pid = res["id"]
            roles = w.db.q("SELECT id FROM roles WHERE production_id=? ORDER BY idx", (pid,))
            for role in roles:
                sl = casting.role_shortlist(w, pid, role["id"], limit=8)
                for cand in sl["rows"]:
                    out = production.cast_role(w, pid, role["id"], cand["id"])
                    if out.get("ok"):
                        break
            dirs = w.db.q("SELECT id FROM directors ORDER BY vision DESC LIMIT 1")
            if dirs:
                production.set_director(w, pid, dirs[0]["id"])
    engine.advance(w, 52 * years - 26)
    t1 = time.time()

    stats = dict(
        years=years, seconds=round(t1 - t0, 2),
        releases=w.db.scalar("SELECT COUNT(*) FROM movies", (), 0),
        players_films=w.db.scalar("SELECT COUNT(*) FROM movies WHERE rights='player'", (), 0),
        rival_films=w.db.scalar("SELECT COUNT(*) FROM rival_releases", (), 0),
        actors=w.db.scalar("SELECT COUNT(*) FROM actors", (), 0),
        alive=w.db.scalar("SELECT COUNT(*) FROM actors WHERE status IN ('available','working','star')", (), 0),
        dead=w.db.scalar("SELECT COUNT(*) FROM actors WHERE status='dead'", (), 0),
        retired=w.db.scalar("SELECT COUNT(*) FROM actors WHERE status='retired'", (), 0),
        newcomers=w.db.scalar("SELECT COUNT(*) FROM actors WHERE discoverer='your casting office'", (), 0),
        cult=w.db.scalar("SELECT COUNT(*) FROM movies WHERE cult_classic=1", (), 0),
        stinkers=w.db.scalar("SELECT COUNT(*) FROM movies WHERE stinker=1", (), 0),
        franchises=w.db.scalar("SELECT COUNT(*) FROM franchises", (), 0),
        offers=w.db.scalar("SELECT COUNT(*) FROM offers WHERE status='open'", (), 0),
        events_fired=w.db.scalar("SELECT COUNT(*) FROM active_events", (), 0),
        cash=round(w.cash, 0), valuation=round(w.valuation, 0),
        prestige=round(w.prestige, 1), rep=round(w.reputation, 1),
        year=w.year, week=w.week,
        outcomes=dict(w.db.q("SELECT outcome, COUNT(*) FROM movies GROUP BY outcome")),
    )
    if verbose:
        for k, v in stats.items():
            print(f"  {k:>12}: {v}")
        print("  top gross :", [dict(r) for r in w.db.q(
            "SELECT title,year,gross,outcome,cult FROM movies ORDER BY gross DESC LIMIT 3")])
        print("  trends    :", [(r["genre"], round(r["heat"], 2)) for r in
                                w.db.q("SELECT genre,heat FROM trends ORDER BY heat DESC LIMIT 4")])
        print("  log tail  :")
        for r in w.db.q("SELECT year,title,text FROM event_log ORDER BY id DESC LIMIT 5"):
            print(f"     {r['year']} {r['title']} :: {(r['text'] or '')[:90]}")
    w.db.close()
    return stats


def bench(actors_n=6000, years=100):
    w = fresh(1920, 11, actors_n=actors_n)
    t0 = time.time()
    engine.advance(w, 52 * years)
    dt = time.time() - t0
    print(f"  {actors_n} actors x {years} years -> {dt:.2f}s "
          f"({(52 * years) / dt:,.0f} ticks/s), "
          f"{w.db.scalar('SELECT COUNT(*) FROM actors', (), 0)} lifetime actors, "
          f"{w.db.scalar('SELECT COUNT(*) FROM rival_releases', (), 0)} rival releases")
    # a typical UI query
    t1 = time.time()
    for _ in range(50):
        actors.list_actors(w, status="market", sort="fame", page=3, limit=40)
    print(f"  50x actor list query: {(time.time() - t1) * 1000:.0f}ms")
    w.db.close()


if __name__ == "__main__":
    years = 12
    seed = 7
    if "--years" in sys.argv:
        years = int(sys.argv[sys.argv.index("--years") + 1])
    if "--seed" in sys.argv:
        seed = int(sys.argv[sys.argv.index("--seed") + 1])
    if "--bench" in sys.argv:
        print("BENCH")
        bench()
    else:
        print(f"SMOKE (seed={seed}, {years} years)")
        run(years=years, seed=seed)
