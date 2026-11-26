"""World & industry events: triggers, effects, resolutions, choice prompts.

Effects are data (see config.EVENTS) and are read through two accessors:
  fx(w, key)       -> product of all active multipliers for that key
  hazard_mult(w,h) -> how much a given production hazard is amplified
Aggregates are cached for the duration of a tick.
"""
from __future__ import annotations

import json

from .. import config as C
from .. import universe
from ..rng import clamp, stream

MULTIPLICATIVE = ["attendance_mult", "cost_mult", "revenue_mult", "credit_mult",
                  "script_supply_mult", "franchise_heat_mult", "marketing_mult",
                  "library_mult", "ip_demand_mult", "prestige_mult",
                  "reboot_penalty_mult", "foreign_mult", "posthumous_mult",
                  "production_speed_mult", "campaign_mult", "draft_mult"]

EVENT_BY_ID = {e["id"]: e for e in C.EVENTS}


def cache_clear(w):
    w.__dict__.pop("_fx", None)


def load_active(w):
    rows = w.db.q("SELECT * FROM active_events WHERE resolved=0")
    out = []
    for r in rows:
        d = dict(r)
        try:
            d["effects"] = json.loads(d["effects"] or "{}")
        except Exception:
            d["effects"] = {}
        out.append(d)
    return out


def fx(w, key: str, default=1.0) -> float:
    """Product of active event effects for `key` (cached per tick)."""
    cache = w.__dict__.get("_fx")
    if cache is None:
        cache = {}
        evs = load_active(w)
        for k in MULTIPLICATIVE:
            v = 1.0
            for e in evs:
                v *= float(e["effects"].get(k, 1.0))
            # the world can be bleak, but never impossible: stacked attendance
            # disasters are damped so a studio can still earn a living
            if k == "attendance_mult":
                v = clamp(v, 0.45, 1.35)
            cache[k] = v
        # additive ones
        cache["_sum:"] = {k: sum(float(e["effects"].get(k, 0.0)) for e in evs)
                          for k in ("salary_inflation", "draft", "actor_unavailable",
                                    "halt_chance", "poach_chance", "prestige_bonus_patriotic")}
        hz = {}
        for e in evs:
            for hk, hv in (e["effects"].get("hazard") or {}).items():
                hz[hk] = hz.get(hk, 1.0) * float(hv)
        cache["_hazard:"] = hz
        cache["_halt"] = any(bool(e["effects"].get("halt_production")) for e in evs)
        cache["_censor"] = any(bool(e["effects"].get("censor")) for e in evs)
        cache["_unlocks"] = [e["effects"].get("unlock") for e in evs if e["effects"].get("unlock")]
        w.__dict__["_fx"] = cache
    if key == "halt":
        return cache["_halt"]
    if key == "censor":
        return cache["_censor"]
    if key.startswith("sum:"):
        return cache["_sum:"].get(key[4:], 0.0)
    return cache.get(key, default)


def hazard_mult(w, hazard: str) -> float:
    cache = w.__dict__.get("_fx")
    if cache is None:
        fx(w, "_warm")
        cache = w.__dict__["_fx"]
    return cache["_hazard:"].get(hazard, 1.0)


def active(w):
    out = []
    for e in load_active(w):
        choice = None
        if e.get("choice"):
            try:
                opts = json.loads(e["choice"])
            except Exception:
                opts = []
            if opts:
                choice = dict(question=f"{e['name']}: how does the studio respond?",
                              options=[dict(id=o["id"], label=o["label"]) for o in opts])
        out.append(dict(id=e["def_id"], name=e["name"], kind=e["kind"],
                        severity=e["severity"], weeks_left=e["weeks_left"],
                        headline=e["headline"], effects=e["effects"],
                        choice=choice))
    return out


def start(w, def_id: str, weeks=None, force=False):
    d = EVENT_BY_ID.get(def_id)
    if not d:
        return None
    if not force:
        if w.year < d.get("first", 0) or w.year > d.get("last", 9999):
            return None
        if not d.get("repeatable") and w.db.scalar(
                "SELECT COUNT(*) FROM active_events WHERE def_id=?", (def_id,), 0):
            return None
        if w.db.scalar("SELECT COUNT(*) FROM active_events WHERE def_id=? AND resolved=0",
                       (def_id,), 0):
            return None
    dur = int(weeks or d["weeks"])
    eff = dict(d.get("effects") or {})
    if d.get("unlock"):
        unlock_tech(w, d["unlock"], d["name"])
    w.db.execute("""INSERT INTO active_events(def_id,name,kind,severity,started_year,started_week,
                    weeks_left,effects,headline,resolved) VALUES(?,?,?,?,?,?,?,?,?,0)""",
                 (def_id, d["name"], d["kind"], d.get("severity", 1), w.year, w.week,
                  dur, json.dumps(eff), d["headline"]))
    # immediate one-off trend shocks
    apply_trend_shock(w, eff)
    cache_clear(w)
    universe.log(w.year, w.week, "world" if d["kind"] == "world" else "industry",
                 d["name"], d["headline"], weight=d.get("severity", 1) + 1)
    if d.get("choices"):
        # park the decision on the event row; the dashboard prompts for it
        w.db.execute("""UPDATE active_events SET choice=? WHERE def_id=? AND resolved=0""",
                     (json.dumps(d["choices"]), def_id))
    return d


def apply_trend_shock(w, eff):
    t = eff.get("trend") or {}
    for k, v in t.items():
        g = C.norm_genre(k)
        if g:
            w.db.execute("UPDATE trends SET heat=MAX(0.25, MIN(2.3, heat + ?)) WHERE genre=?",
                         (float(v) * 0.5, g))
            w.db.execute("UPDATE trends SET drift=drift+? WHERE genre=?", (float(v) * 0.06, g))


def unlock_tech(w, tid: str, why: str = ""):
    row = w.db.q1("SELECT * FROM tech WHERE id=?", (tid,))
    if not row:
        return
    if row["unlocked"]:
        return
    w.db.execute("UPDATE tech SET unlocked=1, unlocked_year=? WHERE id=?", (w.year, tid))
    note = next((t["note"] for t in C.TECH if t["id"] == tid), "")
    universe.log(w.year, w.week, "world", f"Technology: {row['label']}",
                 f"{note} {('(' + why + ')') if why else ''}".strip(), weight=3)


def resolve_choice(w, def_id: str, choice_id: str):
    row = w.db.q1("SELECT * FROM active_events WHERE def_id=? AND resolved=0", (def_id,))
    if not row:
        return dict(ok=False, error="no such active event")
    try:
        choices = json.loads(row["choice"] or "[]")
    except Exception:
        choices = []
    ch = next((c for c in choices if c["id"] == choice_id), None)
    if ch is None and str(choice_id).isdigit() and int(choice_id) < len(choices):
        ch = choices[int(choice_id)]          # older dashboards sent the button index
    if not ch:
        return dict(ok=False, error="choice unavailable")
    rnd = stream(w.seed, "choice", def_id, w.year, w.week)
    if ch.get("special") == "stream_dump":
        from . import boxoffice
        boxoffice.dump_slate_to_streaming(w, ch.get("discount", 0.35))
    if ch.get("risk"):
        if rnd.random() < ch["risk"]:
            w.spend(max(0.0, w.cash) * 0.05, "other", f"Failed gambit: {row['name']}")
            universe.log(w.year, w.week, "industry", "The gambit fails",
                         f"{row['name']} drags on. Costs balloon and the slate stalls.", weight=3)
            # the crisis is NOT over - it runs longer, you just stop being asked
            w.db.execute("""UPDATE active_events SET weeks_left=weeks_left+?, choice=NULL
                            WHERE id=?""", (int(row["weeks_left"] * 0.6), row["id"]))
        else:
            universe.log(w.year, w.week, "industry", "The gambit pays off",
                         "The other side blinks. The industry crawls back to work.", weight=3)
            w.db.execute("UPDATE active_events SET resolved=1, choice=NULL, weeks_left=0 WHERE id=?",
                         (row["id"],))
    else:
        mult = float(ch.get("cost_mult", 1.0))
        if mult != 1.0:
            cost = C.standard_cost(w.year) * 0.25 * mult * concurrent_shoots(w)
            w.spend(cost, "other", f"Settlement: {row['name']}")
        w.db.execute("UPDATE active_events SET resolved=1, choice=NULL, weeks_left=0 WHERE id=?",
                     (row["id"],))
    cache_clear(w)
    return dict(ok=True, label=ch["label"], text=f"{row['name']}: {ch['label']}.")


def concurrent_shoots(w) -> int:
    return int(w.db.scalar(
        "SELECT COUNT(*) FROM productions WHERE status IN ('shooting','pre_production','post_production')",
        0) or 1) or 1


def monthly_roll(w):
    """Decide whether something new happens."""
    rnd = stream(w.seed, "events", w.year, w.week)
    active_ids = {e["def_id"] for e in load_active(w)}
    if len(active_ids) >= 4:
        return
    pool, weights = [], []
    for d in C.EVENTS:
        if not d.get("first", 0) <= w.year <= d.get("last", 9999):
            continue
        if d["id"] in active_ids:
            continue
        if not d.get("repeatable") and w.db.scalar(
                "SELECT COUNT(*) FROM active_events WHERE def_id=?", (d["id"],), 0):
            continue
        pool.append(d["id"])
        weights.append(float(d.get("weight", 1)))
    if not pool:
        return
    # probability tuned so a decade yields a handful of big + small events
    p = 0.035 * (1.0 + 0.05 * len([x for x in weights if x > 50]))
    if rnd.random() > p:
        return
    total = sum(weights)
    r = rnd.random() * total
    acc = 0.0
    pick = pool[-1]
    for pid, wt in zip(pool, weights):
        acc += wt
        if r <= acc:
            pick = pid
            break
    start(w, pick)


def weekly_tick(w):
    rows = w.db.q("SELECT id, weeks_left, def_id, name FROM active_events WHERE resolved=0")
    for r in rows:
        left = r["weeks_left"] - 1
        if left <= 0:
            w.db.execute("UPDATE active_events SET weeks_left=0, resolved=1 WHERE id=?", (r["id"],))
            universe.log(w.year, w.week, "industry", f"Over: {r['name']}",
                         "Back to normal. Everyone pretends it never happened.")
        else:
            w.db.execute("UPDATE active_events SET weeks_left=? WHERE id=?", (left, r["id"]))
    cache_clear(w)
