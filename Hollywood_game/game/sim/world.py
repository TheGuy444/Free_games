"""Eras, genre trends and technology calendar."""
from __future__ import annotations

from .. import config as C
from .. import universe
from ..rng import clamp, unit


def heat_map(w) -> dict:
    return {r["genre"]: r["heat"] for r in w.db.q("SELECT genre, heat FROM trends")}


def weekly_tick(w):
    """Mean-reverting random walk with decade bias and oversaturation pressure."""
    trends = {r["genre"]: (r["heat"], r["drift"]) for r in w.db.q("SELECT genre, heat, drift FROM trends")}
    supply = w.db.kv_get(f"supply:{w.year}", {}) or {}
    ev_trend = w.__dict__.get("_fx", {}).get("_trendpull") if False else None
    rows = []
    for g, (h, drift) in trends.items():
        bias = C.bias_for(w.year, g)
        oversat = supply.get(g, 0)
        # oversupply of a genre cools it, drought warms it
        pressure = -0.030 * max(0, oversat - 6) / 6.0 + 0.010 * max(0, 4 - oversat) / 4.0
        noise = (unit(w.seed, "trend", g, w.year, w.week) - 0.5) * 0.035
        nh = clamp(h + 0.030 * ((1.0 + drift * 0.6 + bias) - h) + pressure + noise, 0.25, 2.3)
        nd = clamp(drift * 0.985 + bias * 0.004, -0.5, 0.7)
        if abs(nh - h) > 1e-9 or abs(nd - drift) > 1e-9:
            rows.append((nh, nd, g))
    if rows:
        w.db.executemany("UPDATE trends SET heat=?, drift=? WHERE genre=?", rows)


def count_supply(w, genre: str, n: int = 1):
    key = f"supply:{w.year}"
    s = w.db.kv_get(key, {}) or {}
    s[genre] = s.get(genre, 0) + n
    w.db.kv_set(key, s)


def yearly_open(w):
    """Called on the 1st week of a new year: tech unlocks, decade flavour."""
    for t in C.TECH:
        if w.year >= t["year"]:
            row = w.db.q1("SELECT unlocked FROM tech WHERE id=?", (t["id"],))
            if row and not row["unlocked"]:
                from .events import unlock_tech
                unlock_tech(w, t["id"], f"{w.year}")
    if w.year % 10 == 0:
        top = sorted(((C.bias_for(w.year, g), g) for g in C.GENRES), reverse=True)[:3]
        universe.log(w.year, 0, "world", f"The {w.year}s begin",
                     "What the town wants now: " + ", ".join(g for _, g in top) + ".", weight=3)


def trend_summary(w):
    rows = w.db.q("SELECT genre, heat, drift FROM trends ORDER BY heat DESC")
    return [dict(r) for r in rows]
