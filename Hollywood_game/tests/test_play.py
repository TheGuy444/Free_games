"""Balance harness: plays decades of studio history and prints what happened.

    python -m tests.test_play --years 60 --seed 3 --start 1928

The autoplayer itself lives in game/autoplay.py (run.py --headless uses it too);
this file is the command-line wrapper.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from game.autoplay import autoplay, fresh, report  # noqa: E402,F401

if __name__ == "__main__":
    a = sys.argv
    kw = {}
    for flag, key, cast in (("--years", "years", int), ("--seed", "seed", int),
                            ("--start", "start", int), ("--slug", "slug", str)):
        if flag in a:
            kw[key] = cast(a[a.index(flag) + 1])
    autoplay(**kw)
