#!/usr/bin/env python3
"""Hollywood Tycoon - launcher.

    python run.py                      # dashboard at http://localhost:8000
    python run.py --new                # start a fresh studio, then serve
    python run.py --load 1928_123456   # resume a save (see --list)
    python run.py --list               # list saves
    python run.py --host 0.0.0.0       # expose on your LAN
    python run.py --headless --years 30 [--seed 7]   # no browser: play and report
    python run.py --observe --years 100 --start 1920 [--seed 7] [--autoplay]   # watch the town

Nothing to install: standard library and SQLite only.
"""
from __future__ import annotations

import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from game import api                      # noqa: E402
from game.server import serve             # noqa: E402


def headless(years: float, seed: int, start: int, preset: str, name: str):
    """Play the game without a browser, using the same autoplayer the balance
    tests use, then load the result into the API so the save is inspectable."""
    from game import autoplay

    def progress(w):
        print(f"  {w.year} wk{w.week:>2}  cash ${w.cash:>14,.0f}  val ${w.valuation:>15,.0f}"
              f"  prestige {w.prestige:3.0f}  rep {w.reputation:3.0f}"
              f"  films {w.stats.get('releases', 0):3d}"
              f"  hits {w.stats.get('hits', 0):3d}"
              f"  stink {w.stats.get('stinker', 0):3d}")

    out = autoplay.autoplay(years=int(years), seed=seed, start=start,
                            slug=f"headless_{seed}", progress=progress)
    print()
    for k, v in out.items():
        if k in ("best", "world", "path"):
            continue
        print(f"  {k:>12}: {v}")
    print("\n  the money pictures:")
    for m in out.get("best", []):
        print(f"   {m['year']} {m['title'][:34]:<34} {m['genre']:<9} {m['outcome']:<11} ${m['g']:,.0f}")
    print(f"\n save: {out.get('path')}")
    print(f" open it in the dashboard with:  python3 run.py --load {out.get('slug')}")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="Hollywood Tycoon")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--new", action="store_true", help="start a new studio")
    ap.add_argument("--load", metavar="SLUG", help="load a save by file name")
    ap.add_argument("--list", action="store_true", help="list saves and exit")
    ap.add_argument("--headless", action="store_true", help="play without the dashboard")
    ap.add_argument("--observe", action="store_true",
                    help="observation mode: let the town run (your studio idle) and report on "
                         "studio rise and fall and franchise life cycles")
    ap.add_argument("--autoplay", action="store_true", help="with --observe: let the autoplayer run your studio")
    ap.add_argument("--years", type=float, default=20.0)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--start", type=int, default=1928)
    ap.add_argument("--preset", default="studio", choices=list(api.C.START_CASH))
    ap.add_argument("--name", default="Meridian Pictures")
    ap.add_argument("--quiet", action="store_true", help="hide request logging")
    a = ap.parse_args(argv)

    if a.list:
        saves = api.handle("GET", "/api/saves", {})
        rows = saves.get("saves") or []
        if not rows:
            print("no saves yet")
        for s in rows:
            print(f"  {s.get('slug'):<28} {s.get('name','?'):<26} {s.get('year','?')}  "
                  f"${s.get('cash', 0):,.0f}")
        return 0

    if a.observe:
        from game import observe
        observe.run(years=int(a.years), start=a.start, seed=a.seed or 7, autoplay=a.autoplay)
        return 0
    if a.headless:
        return headless(a.years, a.seed, a.start, a.preset, a.name)

    serve(host=a.host, port=a.port, open_game=a.load, new_game=a.new, quiet=a.quiet)
    return 0


if __name__ == "__main__":
    sys.exit(main())
