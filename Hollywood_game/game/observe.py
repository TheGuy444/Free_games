"""Observation mode: let the town run itself and watch who rises and falls.

    python3 run.py --observe --years 100 --start 1920 --seed 7
    python3 run.py --observe --years 100 --seed 7 --autoplay   # with a playing studio

Your own studio stays idle (its cash is topped up so it never goes bust and
it never makes a picture), unless --autoplay lets the autoplayer run it.
Every year the observer records each rival's cash, output, box-office share
and series, then prints a report by decade:

* studio stickiness: who was alive, who led, how long studios last, how
  concentrated the box office is (the top-3 share)
* franchise dynamics: how much of the slate is sequels, how long series run,
  how they end, the longest series in town (rivals' and yours)

The raw numbers are written next to the save as <slug>.observe.json.
"""
from __future__ import annotations

import json
import os
import statistics as st

from . import config as C


def _snapshot(w, track):
    yr = w.year - 1                     # the year that just ended
    std = C.standard_cost(yr)
    rows = [dict(r) for r in w.db.q("SELECT * FROM rivals")]
    gross = {r["studio"]: r["g"] for r in w.db.q(
        "SELECT studio, SUM(gross) g FROM rival_releases WHERE year=? GROUP BY studio", (yr,))}
    films = {r["studio"]: r["n"] for r in w.db.q(
        "SELECT studio, COUNT(*) n FROM rival_releases WHERE year=? GROUP BY studio", (yr,))}
    seq = w.db.scalar("SELECT COUNT(*) FROM rival_releases WHERE year=? AND franchise IS NOT NULL", (yr,), 0)
    tot = w.db.scalar("SELECT COUNT(*) FROM rival_releases WHERE year=?", (yr,), 0)
    pg = w.db.scalar("SELECT COALESCE(SUM(gross),0) FROM movies WHERE year=?", (yr,), 0) or 0.0
    year = dict(year=yr, std=std, films=tot, sequels=seq, player_gross=pg, studios={})
    for r in rows:
        if r["alive"]:
            year["studios"][r["name"]] = dict(cash_std=round(r["cash"] / std, 2), prestige=round(r["prestige"], 1),
                                              films=films.get(r["name"], 0), gross=gross.get(r["name"], 0.0))
        life = track["life"].setdefault(r["name"], dict(born=yr, died=None))
        if not r["alive"] and life["died"] is None:
            life["died"] = yr
    # series, by studio-qualified name (rival home-grown series are pruned from
    # the save when they die, so the observer keeps its own history)
    for r in rows:
        for s in (w.db.kv_get(f"rival_series:{r['id']}", None) or []):
            k = f"{r['name']} / {s['name']}"
            h = track["series"].setdefault(k, dict(owner=r["name"], start=yr, n=0, last=yr, peak_fan=0,
                                                   kind="rival"))
            h["n"] = max(h["n"], s["n"])
            h["last"] = max(h["last"], s["last_year"])
            h["peak_fan"] = max(h["peak_fan"], round(s["fan"]))
            h["fan"] = round(s["fan"])
            h["skind"] = s.get("kind") or "series"
            h["icon"] = bool(s.get("icon")) or h.get("icon", False)
            h["reboots"] = s.get("reboots", 0)
    for f in w.db.q("SELECT * FROM franchises"):
        k = f"franchise #{f['id']} {f['name']}"
        h = track["series"].setdefault(k, dict(owner=f["rights"], start=f["created_year"], n=0, last=0,
                                               peak_fan=0, kind="franchise"))
        h.update(owner=f["rights"], n=max(h["n"], f["installments"] or 0), last=f["last_year"],
                 peak_fan=max(h["peak_fan"], round(f["fan_base"])), fan=round(f["fan_base"]),
                 status=f["status"], reboots=(f["continuity"] or 1) - 1, skind=f["kind"] or "series")
    track["chars"] = [dict(name=c["name"], series=c["series"], fan=round(c["fan"]), peak=round(c["peak"]),
                           films=c["appearances"], faces=c["actors"], icon=bool(c["icon"]),
                           icon_year=c["icon_year"], role=c["role"], spun_off=bool(c["spun_off"]),
                           owner=c["rights"])
                      for c in w.db.q("""SELECT c.*, f.name AS series, f.rights FROM characters c
                                         LEFT JOIN franchises f ON f.id=c.franchise_id
                                         ORDER BY c.peak DESC LIMIT 60""")]
    track["years"].append(year)


def run(years=100, start=1920, seed=7, autoplay=False, slug=None, quiet=False):
    from .autoplay import autoplay as play, fresh
    from .sim import engine
    track = dict(years=[], life={}, series={})
    slug = slug or f"observe_{seed}_{start}"
    if autoplay:
        def hook(w):
            if w.week == 0 or not track["years"] or track["years"][-1]["year"] < w.year - 1:
                _snapshot(w, track)
        out = play(years=years, seed=seed, start=start, slug=slug, verbose=False, progress=hook)
        w = out["world"]
    else:
        w = fresh(slug, start, seed)
        last = w.year
        while w.year < start + years:
            w.cash = max(w.cash, C.standard_cost(w.year) * 30)      # an idle lot never folds
            engine.advance(w, 52)
            if w.year != last:
                _snapshot(w, track)
                last = w.year
    w.flush()
    w.db.commit()
    rep = report(track)
    path = os.path.splitext(w.db.path)[0] + ".observe.json"
    with open(path, "w") as fh:
        json.dump(dict(track=track, report=rep), fh, indent=1, default=str)
    if not quiet:
        print_report(rep)
        print(f"\n raw data: {path}")
    return rep


def report(track):
    years = track["years"]
    decades = {}
    for y in years:
        d = decades.setdefault(y["year"] // 10 * 10, [])
        d.append(y)
    by_dec = []
    leaders = []
    for dec, ys in sorted(decades.items()):
        tot = {}
        for y in ys:
            for n, s in y["studios"].items():
                tot[n] = tot.get(n, 0.0) + s["gross"]
        g = sum(tot.values()) or 1.0
        ranked = sorted(tot.items(), key=lambda kv: -kv[1])
        leaders.append(ranked[0][0] if ranked else None)
        alive_end = len(ys[-1]["studios"])
        films = sum(y["films"] for y in ys)
        seqs = sum(y["sequels"] for y in ys)
        born = [n for n, l in track["life"].items() if l["born"] // 10 * 10 == dec and l["born"] > years[0]["year"]]
        died = [n for n, l in track["life"].items() if l["died"] and l["died"] // 10 * 10 == dec]
        by_dec.append(dict(decade=dec, alive_end=alive_end, opened=len(born), folded=len(died),
                           leader=ranked[0][0] if ranked else None,
                           top3_share=round(100 * sum(v for _, v in ranked[:3]) / g),
                           films=films, sequel_share=round(100 * seqs / max(1, films)),
                           median_cash_std=round(st.median([s["cash_std"] for s in ys[-1]["studios"].values()]), 1)
                           if ys[-1]["studios"] else 0))
    last_year = years[-1]["year"] if years else 0
    spans = []
    for n, l in track["life"].items():
        end = l["died"] or last_year
        spans.append(dict(studio=n, born=l["born"], died=l["died"], years=end - l["born"]))
    spans.sort(key=lambda s: -s["years"])
    ser = [dict(name=k, **v) for k, v in track["series"].items() if v["n"] >= 1]
    multi = [s for s in ser if s["n"] >= 2]
    lengths = [s["n"] for s in multi]
    hist = {}
    for n in lengths:
        b = "2" if n == 2 else "3-4" if n <= 4 else "5-8" if n <= 8 else "9-15" if n <= 15 else "16+"
        hist[b] = hist.get(b, 0) + 1
    return dict(
        span=f"{years[0]['year']}-{last_year}" if years else "",
        decades=by_dec,
        leader_changes=sum(1 for a, b in zip(leaders, leaders[1:]) if a != b),
        studios_total=len(track["life"]),
        studios_folded=sum(1 for l in track["life"].values() if l["died"]),
        longest_lived=spans[:5],
        median_lifespan=st.median([s["years"] for s in spans if s["died"]]) if any(s["died"] for s in spans) else None,
        series_started=len(ser), series_with_sequels=len(multi),
        series_length_hist=hist,
        longest_series=sorted(ser, key=lambda s: -s["n"])[:8],
        player_franchises=[s for s in ser if s["kind"] == "franchise"],
        rival_kinds={k: sum(1 for s in ser if s["kind"] == "rival" and s.get("skind", "series") == k)
                     for k in ("series", "spinoff", "universe")},
        rival_icons=[s["name"] for s in ser if s["kind"] == "rival" and s.get("icon")],
        player_kinds={k: sum(1 for s in ser if s["kind"] == "franchise" and s.get("skind", "series") == k)
                      for k in ("series", "spinoff", "universe")},
        characters=track.get("chars", [])[:12],
        player_icons=[c for c in track.get("chars", []) if c["icon"]],
    )


def print_report(rep):
    print(f"=== Observation {rep['span']} ===")
    print(f"{'decade':>6} {'alive':>5} {'open':>4} {'fold':>4} {'top3%':>5} {'films':>5} {'seq%':>4} {'cash/std':>8}  leader")
    for d in rep["decades"]:
        print(f"{d['decade']:>6} {d['alive_end']:>5} {d['opened']:>4} {d['folded']:>4} {d['top3_share']:>5} "
              f"{d['films']:>5} {d['sequel_share']:>4} {d['median_cash_std']:>8}  {d['leader']}")
    print(f"\nStudios: {rep['studios_total']} existed, {rep['studios_folded']} folded, "
          f"median lifespan of the dead {rep['median_lifespan']} yrs, leader changed {rep['leader_changes']} times")
    print("Longest-lived:", ", ".join(f"{s['studio']} {s['years']}y" for s in rep["longest_lived"]))
    print(f"\nSeries: {rep['series_started']} started, {rep['series_with_sequels']} got a sequel; "
          f"lengths {rep['series_length_hist']}")
    for s in rep["longest_series"]:
        print(f"   {s['n']:>3} films  {s['name'][:48]:<48} {s['start']}-{s['last']} peak fans {s['peak_fan']}"
              + (f" reboots {s.get('reboots')}" if s.get("reboots") else ""))
    print(f"\nRival series by kind {rep['rival_kinds']}; rival icons: {', '.join(rep['rival_icons'][:6]) or 'none'}")
    if any(rep["player_kinds"].values()):
        print(f"Your series by kind {rep['player_kinds']}")
    if rep["characters"]:
        print("Top characters (yours and any sold):")
        for c in rep["characters"][:10]:
            print(f"   {c['name'][:22]:<22} {c['series'][:24]:<24} {c['role']:<10} films {c['films']:>2} "
                  f"faces {c['faces']:>2} peak {c['peak']:>3} now {c['fan']:>3}"
                  + (f"  ICON {c['icon_year']}" if c["icon"] else "") + ("  spun off" if c["spun_off"] else ""))
