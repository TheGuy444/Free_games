"""Era dynamics: what it costs to make and exploit a picture in a given year.

Three layers, all driven by the calendar (and the tech table):

1. **Formats** - per-picture choices at greenlight (changeable until cameras
   roll): Technicolor, CinemaScope, Dolby, IMAX, digital, 3-D. Each costs a
   share of the budget that falls as the technology matures, pulls audiences
   (by genre, fading as the novelty wears off), and eventually becomes the
   standard - at which point it is simply part of the price of a picture.
   Between "audiences expect it" and "standard", skipping it is a penalty
   (a black-and-white musical in 1962 looks cheap).

2. **Era overheads** - costs the industry imposes on every picture: the
   Production Code seal, guild pension & health contributions, digital
   grading. Plus an optional completion bond (1970+), and residuals that come
   off library income once the guilds win them.

3. **Home formats** - re-releasing library titles on each new format as it
   arrives: VHS, Special Edition DVD, Blu-ray/4K remasters - and the
   colourisation craze of the late 80s for old black-and-white pictures.
"""
from __future__ import annotations

from .. import config as C
from .. import universe
from ..rng import clamp

# --------------------------------------------------------------------------- #
#  1. Formats
# --------------------------------------------------------------------------- #
SPECTACLE = ("action", "sci-fi", "animation", "western", "musical")

FORMATS = {
    "colour": dict(
        label="Technicolor", tech="colour", windows=[(1935, 9999)],
        expect=1955, standard=1968,
        cost=((1935, 0.30), (1950, 0.16), (1967, 0.05)),
        appeal={"musical": 0.16, "animation": 0.16, "western": 0.10, "sci-fi": 0.10,
                "romance": 0.08, "action": 0.08}, appeal_default=0.04,
        miss_penalty={"drama": 0.06, "crime": 0.04, "horror": 0.05}, miss_default=0.16,
        vals=6, critics=0,
        blurb="Colour film. Expensive at first; audiences expect it by the late 1950s."),
    "widescreen": dict(
        label="CinemaScope widescreen", tech="widescreen", windows=[(1953, 9999)],
        expect=1960, standard=1972,
        cost=((1953, 0.12), (1971, 0.03)),
        appeal={"western": 0.12, "action": 0.10, "musical": 0.10, "sci-fi": 0.10},
        appeal_default=0.03, miss_penalty={}, miss_default=0.07,
        vals=3, critics=0,
        blurb="The answer to television: spectacle the living room cannot show."),
    "dolby": dict(
        label="Dolby Stereo sound", tech="dolby", windows=[(1977, 9999)],
        expect=1985, standard=1993,
        cost=((1977, 0.05), (1992, 0.015)),
        appeal={"musical": 0.08, "action": 0.06, "sci-fi": 0.07, "horror": 0.05},
        appeal_default=0.02, miss_penalty={}, miss_default=0.04,
        vals=2, critics=0,
        blurb="Multichannel sound: the roar the multiplex sells."),
    "imax": dict(
        label="IMAX cameras & screens", tech="imax", windows=[(1999, 9999)],
        expect=None, standard=None,
        cost=((1999, 0.16), (2015, 0.09)),
        appeal={"sci-fi": 0.16, "action": 0.14, "animation": 0.10},
        appeal_default=0.03, big_scale_only=True,
        vals=4, critics=0,
        blurb="Premium large-format release: worth it for event pictures, wasted on small ones."),
    "digital": dict(
        label="Shoot on digital", tech="digital", windows=[(2002, 9999)],
        expect=None, standard=2013,
        cost=((2002, -0.04), (2012, -0.07)),
        appeal={}, appeal_default=0.0,
        vals=0, critics=-3, critics_until=2010,
        blurb="Cheaper than film stock. Purists sneer, until nobody shoots on film any more."),
    "3d": dict(
        label="3-D release", tech=None, windows=[(1953, 1955), (2009, 9999)],
        expect=None, standard=None,
        cost=((1953, 0.10), (2009, 0.12), (2016, 0.06)),
        appeal={"horror": 0.14, "sci-fi": 0.12, "action": 0.10, "animation": 0.12},
        appeal_default=0.02, novelty_from=(1953, 2009), novelty_fade=6,
        vals=1, critics=-2,
        blurb="A fad, twice. Big novelty bump the first couple of years, then audiences tire of the glasses."),
}


def _interp(points, year):
    pts = sorted(points)
    if year <= pts[0][0]:
        return pts[0][1]
    for (y0, v0), (y1, v1) in zip(pts, pts[1:]):
        if y0 <= year <= y1:
            return v0 + (v1 - v0) * (year - y0) / max(1, y1 - y0)
    return pts[-1][1]


def available(w, fid: str) -> bool:
    f = FORMATS[fid]
    if f["tech"] and not w.tech_on(f["tech"]):
        return False
    return any(a <= w.year <= b for a, b in f["windows"])


def is_standard(w, fid: str) -> bool:
    s = FORMATS[fid]["standard"]
    return bool(s) and w.year >= s and available(w, fid)


def cost_frac(w, fid: str) -> float:
    return _interp(FORMATS[fid]["cost"], w.year)


def appeal(w, fid: str, genre: str, scale: str) -> float:
    """Box-office multiplier minus one for using the format on this picture."""
    f = FORMATS[fid]
    a = f["appeal"].get(genre, f["appeal_default"])
    if f.get("big_scale_only") and scale not in ("epic", "blockbuster"):
        a *= 0.25
    if f.get("novelty_from"):
        start = max(y for y in f["novelty_from"] if y <= w.year) if any(
            y <= w.year for y in f["novelty_from"]) else w.year
        a *= max(0.15, 1.0 - (w.year - start) / float(f["novelty_fade"]))
    if f["standard"]:
        # once everyone has it, it pulls nobody in by itself
        a *= clamp((f["standard"] - w.year) / 6.0, 0.0, 1.0)
    return a


def miss_penalty(w, fid: str, genre: str) -> float:
    """Fraction of gross lost by NOT using a format audiences now expect."""
    f = FORMATS[fid]
    if not f.get("expect") or w.year < f["expect"] or is_standard(w, fid) or not available(w, fid):
        return 0.0
    full = f["miss_penalty"].get(genre, f["miss_default"])
    ramp = (w.year - f["expect"]) / max(1.0, (f["standard"] or w.year + 1) - f["expect"])
    return full * clamp(ramp, 0.15, 1.0)


def options(w, budget: float, genre: str, scale: str, chosen=None):
    """What the greenlight / production screens show."""
    chosen = chosen or {}
    out = []
    for fid, f in FORMATS.items():
        if not available(w, fid):
            continue
        std = is_standard(w, fid)
        out.append(dict(
            id=fid, label=f["label"], blurb=f["blurb"], standard=std,
            on=std or fid in chosen,
            cost=0.0 if std else round(budget * cost_frac(w, fid), 0),
            appeal=round(appeal(w, fid, genre, scale) * 100, 1),
            miss=round(miss_penalty(w, fid, genre) * 100, 1),
            critics=f["critics"] if (f["critics"] and w.year < f.get("critics_until", 9999)) else 0))
    return out


def get_chosen(w, pid: int) -> dict:
    return w.db.kv_get(f"fmt:{pid}", {}) or {}


def set_formats(w, pid: int, wanted):
    """Turn formats on/off for a picture that has not started shooting.
    Paid when switched on; 80% back if switched off before the cameras roll."""
    p = w.db.q1("SELECT * FROM productions WHERE id=?", (pid,))
    if not p:
        return dict(ok=False, error="no such production")
    if p["status"] not in ("development", "pre_production"):
        return dict(ok=False, error="the cameras are rolling - formats are locked")
    wanted = set(x for x in (wanted or []) if x in FORMATS)
    chosen = get_chosen(w, pid)
    for fid in list(chosen):
        if fid not in wanted:
            back = chosen.pop(fid) * 0.8
            if back > 0:
                w.earn(back, "production", f"Format dropped: {FORMATS[fid]['label']}")
            elif back < 0:
                w.spend(-back, "production", f"Format dropped: {FORMATS[fid]['label']}")
    add_cost = 0.0
    for fid in wanted:
        if fid in chosen or is_standard(w, fid) or not available(w, fid):
            continue
        c = p["budget"] * cost_frac(w, fid)
        if c > 0 and not w.can_afford(c):
            return dict(ok=False, error=f"{FORMATS[fid]['label']} needs ${c:,.0f}")
        if c > 0:
            w.spend(c, "production", f"{FORMATS[fid]['label']}: {p['title']}")
        elif c < 0:
            w.earn(-c, "production", f"{FORMATS[fid]['label']} saves: {p['title']}")
        chosen[fid] = c
        add_cost += c
    w.db.kv_set(f"fmt:{pid}", chosen)
    return dict(ok=True, formats=sorted(chosen), spent=round(add_cost, 0))


def effective(w, pid: int):
    """Formats actually on the picture (chosen + whatever is standard)."""
    chosen = set(get_chosen(w, pid))
    return chosen | {fid for fid in FORMATS if is_standard(w, fid)}


def spent(w, pid: int) -> float:
    return sum(get_chosen(w, pid).values())


def production_values_bonus(w, pid: int) -> float:
    return sum(FORMATS[f]["vals"] for f in effective(w, pid))


def release_effects(w, p) -> dict:
    """At release: box-office multiplier, critics shift and a line for the press."""
    on = effective(w, p["id"])
    mult, crit, notes = 1.0, 0.0, []
    for fid, f in FORMATS.items():
        if not available(w, fid):
            continue
        if fid in on:
            a = appeal(w, fid, p["genre"], p["scale"])
            mult *= 1.0 + a
            if f["critics"] and w.year < f.get("critics_until", 9999):
                crit += f["critics"]
            if a >= 0.06:
                notes.append(f"{f['label']} pulled them in")
        else:
            pen = miss_penalty(w, fid, p["genre"])
            if pen > 0:
                mult *= 1.0 - pen
                if pen >= 0.04:
                    notes.append(f"no {f['label']}: it looked dated")
    return dict(mult=mult, critics=crit, notes=notes, formats=sorted(on))


# --------------------------------------------------------------------------- #
#  2. Era overheads, the completion bond, residuals
# --------------------------------------------------------------------------- #
def era_costs(w, budget: float):
    """Costs every picture pays in this year, whether you like it or not."""
    std = C.standard_cost(w.year)
    out = []
    if 1934 <= w.year <= 1967:
        out.append(dict(id="code", label="Production Code seal & review", amount=round(std * 0.006, 0),
                        why="The Hays Office reads every script and screens every cut."))
    if w.year >= 1960:
        rate = 0.010 + 0.015 * clamp((w.year - 1960) / 40.0, 0, 1)
        out.append(dict(id="guilds", label="Guild pension & health", amount=round(budget * rate, 0),
                        why=f"SAG, WGA and DGA contributions: {rate * 100:.1f}% of the budget."))
    if w.year >= 2001:
        out.append(dict(id="di", label="Digital intermediate & grading", amount=round(budget * 0.012, 0),
                        why="Every frame goes through a computer before it reaches a screen."))
    if w.year >= 2004:
        out.append(dict(id="security", label="Anti-piracy & screener security", amount=round(budget * 0.004, 0),
                        why="Watermarked screeners and locked-down edit bays."))
    return out


def charge_era_costs(w, pid: int, budget: float, title: str) -> float:
    total = 0.0
    for c in era_costs(w, budget):
        if c["amount"] > 0:
            w.spend(c["amount"], "production", f"{c['label']}: {title}")
            total += c["amount"]
    w.db.kv_set(f"eracost:{pid}", total)
    return total


def bond_available(w) -> bool:
    return w.year >= 1970


def bond_cost(budget: float) -> float:
    return round(budget * 0.03, 0)


def take_bond(w, pid: int):
    p = w.db.q1("SELECT * FROM productions WHERE id=?", (pid,))
    if not p:
        return dict(ok=False, error="no such production")
    if not bond_available(w):
        return dict(ok=False, error="completion bonds are not a thing yet")
    if w.db.kv_get(f"bond:{pid}", 0):
        return dict(ok=False, error="already bonded")
    if p["status"] not in ("development", "pre_production"):
        return dict(ok=False, error="no insurer will write a bond once the cameras roll")
    c = bond_cost(p["budget"])
    if not w.can_afford(c):
        return dict(ok=False, error=f"needs ${c:,.0f}")
    w.spend(c, "production", f"Completion bond: {p['title']}")
    w.db.kv_set(f"bond:{pid}", c)
    return dict(ok=True, cost=c)


def bonded(w, pid: int) -> bool:
    return bool(w.db.kv_get(f"bond:{pid}", 0))


def bond_cover(w, pid: int, amount: float) -> float:
    """How much of an on-set disaster you actually pay when bonded."""
    return amount * 0.35 if bonded(w, pid) else amount


def residual_rate(year: int) -> float:
    """Share of library income that goes back to talent once the guilds win
    residuals (the 1960 strike), creeping up with every contract."""
    if year < 1960:
        return 0.0
    return 0.05 + 0.05 * clamp((year - 1960) / 40.0, 0, 1)


def picture_costs(w, pid: int) -> float:
    """Everything the era made this picture cost on top of budget/cast/P&A."""
    return spent(w, pid) + (w.db.kv_get(f"eracost:{pid}", 0) or 0) + (w.db.kv_get(f"bond:{pid}", 0) or 0)


# --------------------------------------------------------------------------- #
#  3. Home formats for the library
# --------------------------------------------------------------------------- #
HOME = {
    "vhs": dict(label="Home video release (VHS)", tech="vhs", years=(1977, 2006), cost=0.025,
                mult=1.6, runs=10, min_age=0,
                blurb="Duplicate, box and ship it to every video store in the country."),
    "dvd": dict(label="Special Edition DVD", tech="dvd", years=(1997, 2016), cost=0.03,
                mult=1.5, runs=8, min_age=0,
                blurb="Commentary track, deleted scenes, a making-of. Collectors buy it twice."),
    "remaster": dict(label="Blu-ray / 4K remaster", tech="streaming", years=(2008, 9999), cost=0.04,
                     mult=1.4, runs=8, min_age=12,
                     blurb="Scan the negative, clean every frame, sell it to a new generation."),
    "colourise": dict(label="Colourise it", tech=None, years=(1985, 1995), cost=0.05,
                      mult=1.3, runs=10, min_age=0, bw_only=True, prestige=-1.5,
                      blurb="Crayola the classics for TV. Profitable. Critics will call it vandalism."),
}


def _was_bw(w, m) -> bool:
    fm = w.db.kv_get(f"mfmt:{m['id']}", None)
    if fm is not None:
        return "colour" not in fm
    return (m["year"] or 0) < 1950          # older pictures from before we tracked formats


def home_state(w, mid: int) -> dict:
    return w.db.kv_get(f"home:{mid}", {}) or {}


def home_options(w, m):
    from . import franchise as F
    done = home_state(w, m["id"])
    std = C.standard_cost(w.year)
    now = F.movie_annual(w, m)
    out = []
    if m["rights"] != "player":
        return out
    for k, h in HOME.items():
        if h["tech"] and not w.tech_on(h["tech"]):
            continue
        if not (h["years"][0] <= w.year <= h["years"][1]):
            continue
        if w.year - (m["year"] or w.year) < h["min_age"]:
            continue
        if h.get("bw_only") and not _was_bw(w, m):
            continue
        # priced off what it should earn: the extra library income over the
        # run, minus a margin for the duplicator, the distributor and the risk
        extra = max(0.0, F.movie_annual(w, m, extra_home=h["mult"]) - now)
        expected = extra * h["runs"] * 0.75            # it fades over the run
        cost = max(std * 0.002, expected * 0.45)
        out.append(dict(id=k, label=h["label"], blurb=h["blurb"], cost=round(cost, 0),
                        extra=round(extra, 0), expected=round(expected, 0),
                        mult=h["mult"], years=h["runs"], done=k in done,
                        until=done.get(k), active=done.get(k, 0) >= w.year))
    return out


def home_release(w, mid: int, kind: str):
    m = w.db.q1("SELECT * FROM movies WHERE id=?", (mid,))
    if not m or m["rights"] != "player":
        return dict(ok=False, error="you do not hold that picture")
    opt = next((o for o in home_options(w, dict(m)) if o["id"] == kind), None)
    if not opt:
        return dict(ok=False, error="not available for this picture right now")
    if opt["done"]:
        return dict(ok=False, error="already done")
    if not w.can_afford(opt["cost"]):
        return dict(ok=False, error=f"needs ${opt['cost']:,.0f}")
    w.spend(opt["cost"], "secondary", f"{opt['label']}: {m['title']}")
    st = home_state(w, mid)
    st[kind] = w.year + HOME[kind]["runs"]
    w.db.kv_set(f"home:{mid}", st)
    if HOME[kind].get("prestige"):
        w.add_prestige(HOME[kind]["prestige"])
        universe.log(w.year, w.week, "world", f"{m['title']} colourised",
                     "Film critics call it vandalism. Television stations call it a ratings win.")
    return dict(ok=True, cost=opt["cost"], until=st[kind])


def home_mult(w, mid: int) -> float:
    st = home_state(w, mid)
    mult = 1.0
    for k, until in st.items():
        if until >= w.year and k in HOME:
            mult *= HOME[k]["mult"]
    return mult


def catalogue_candidates(w, limit=12):
    """Library titles where a re-release on the format of the day would pay."""
    rows = [dict(r) for r in w.db.q("""SELECT * FROM movies WHERE rights='player' AND gross>0
                                       ORDER BY gross DESC LIMIT 200""")]
    out = []
    for m in rows:
        opts = [o for o in home_options(w, m) if not o["done"] and o["expected"] > o["cost"]]
        if opts:
            out.append(dict(id=m["id"], title=m["title"], year=m["year"], gross=m["gross"],
                            outcome=m["outcome"], options=opts))
        if len(out) >= limit:
            break
    return out
