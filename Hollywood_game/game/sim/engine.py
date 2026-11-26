"""The tick engine.

One tick = one week.  Anything that must happen to thousands of entities runs
yearly with set-based SQL; anything that involves the player's decisions runs
weekly on a handful of rows.  `advance(w, n)` is what the dashboard's
fast-forward button calls.
"""
from __future__ import annotations

from .. import config as C
from .. import universe
from ..rng import clamp, stream
from . import actors as A
from . import boxoffice
from . import casting
from . import charts
from . import press
from . import typecast
from . import economy
from . import events as E
from . import franchise
from . import production as P
from . import rivals
from . import scripts as S
from . import world
from . import crew

AUTO_RELEASE_AFTER = 5         # weeks a finished picture sits before we open it
BANKRUPT_YEARS = 3


def set_speed(w, speed: int):
    w.speed = max(0, min(4, int(speed)))
    w.db.execute("UPDATE game SET speed=? WHERE id=1", (w.speed,))
    return w.speed


def tick(w):
    """Advance the world exactly one week."""
    w.week += 1
    new_year = False
    if w.week >= 52:
        w.week = 0
        w.year += 1
        new_year = True
    E.cache_clear(w)

    # --- weekly (small sets only)
    economy.weekly(w)
    E.weekly_tick(w)
    world.weekly_tick(w)
    P.weekly_tick(w)
    S.weekly_writers(w)
    auto_release(w)

    # --- four-weekly "industry" pass
    if w.week % 4 == 0:
        casting.industry_monthly(w)
        rivals.monthly(w)
        S.monthly_market(w)
        E.monthly_roll(w)
        rivals.poaching(w)
        press.gossip(w)
    # the week's box office chart, after everything that opened this week
    charts.weekly(w)
    if w.week % 8 == 0:
        franchise.generate_offers(w)

    if new_year:
        yearly(w)
    return dict(year=w.year, week=w.week, cash=w.cash, over=w.over)


def yearly(w):
    """New Year's Eve for the universe."""
    world.yearly_open(w)
    pandemic = 1.0
    for ev in E.load_active(w):
        if ev["def_id"] == "pandemic":
            pandemic = 2.6
        if ev["def_id"] == "wwii":
            pandemic = max(pandemic, 1.5)
    people = press.snapshot_people(w)
    A.yearly_pass(w, mortality_mult=pandemic, salary_inflation=E.fx(w, "sum:salary_inflation"))
    press.people_yearly(w, people)
    typecast.background(w)
    A.rivals_sign_talent(w, n=int(14 + 10 * C.attendance_index(w.year)))
    boxoffice.secondary_yearly(w)
    boxoffice.awards_year(w, campaign_spend=w.db.kv_get(f"campaign:{w.year - 1}", 0.0))
    from . import legacy
    legacy.season(w)
    legacy.rival_set_accident(w)
    franchise.yearly(w)
    from . import characters
    characters.yearly(w)
    rivals.yearly(w)
    crew.yearly(w)
    economy.loans_due(w)
    S.expire_options(w)
    # the town forgets a bad quarter as fast as a good one; prestige needs work
    w.add_reputation((45.0 - w.reputation) * 0.12)
    # standing slides: an idle lot loses it faster than a busy one, but nobody
    # keeps a reputation for free
    w.prestige = max(0.0, w.prestige * (0.94 if w.db.kv_get("releases_year", 0) else 0.86))
    w.db.kv_set("releases_year", 0)
    economy.record_year(w)
    check_end(w)
    universe.log(w.year, 0, "finance", f"{w.year}",
                 f"Cash ${w.cash:,.0f}. Valuation ${economy.valuation(w):,.0f}. "
                 f"Prestige {w.prestige:.0f}.", weight=1)


def ensure_press(w):
    """First open of a save (new or from before the newspaper existed): give
    the town a box office chart and give its working actors their labels."""
    if w.db.kv_get("press_v1"):
        return
    typecast.background(w, news=False)
    charts.seed(w)
    w.db.kv_set("press_v1", 1)
    w.db.commit()


def auto_release(w):
    """Pictures in the can open on their own unless you release them yourself."""
    ready = w.db.q("SELECT id FROM productions WHERE status='ready'")
    for r in ready:
        p = P.get(w, r["id"])
        delivered = w.db.kv_get(f"ready:{r['id']}", None)
        if delivered is None:
            w.db.kv_set(f"ready:{r['id']}", w.abs_week)
            continue
        if w.abs_week - delivered >= AUTO_RELEASE_AFTER:
            boxoffice.release(w, r["id"])


# --------------------------------------------------------------------------- #
#  Multi-week advance (fast forward)
# --------------------------------------------------------------------------- #
def advance(w, weeks: int = 1):
    """Fast-forward. Long jumps are chunked into years so a single request
    never holds the save in one enormous transaction."""
    remaining, out = max(0, int(weeks)), None
    while remaining > 0:
        step = min(52, remaining)
        out = _advance(w, step)
        remaining -= step
        if w.over:
            break
    return out


def _advance(w, weeks: int):
    for _ in range(max(0, min(520, int(weeks)))):
        if w.over:
            break
        tick(w)
    w.flush()
    w.db.commit()
    return dict(year=w.year, week=w.week, cash=w.cash, valuation=w.valuation, over=w.over)


def play(w, years: float):
    """Headless long-run driver, for tests and balance sweeps."""
    return advance(w, int(round(52 * years)))


# --------------------------------------------------------------------------- #
#  Failure / success states
# --------------------------------------------------------------------------- #
def check_end(w):
    std = C.standard_cost(w.year)
    bad = w.cash < -0.6 * std
    streak = w.db.kv_get("bad_years", 0)
    streak = streak + 1 if bad else 0
    w.db.kv_set("bad_years", streak)
    if streak >= BANKRUPT_YEARS and not w.over:
        w.over = 1
        universe.log(w.year, 0, "finance", "The studio is finished",
                     "Three years under water. The bank takes the lot, the contracts and "
                     "the name. Your run ends here - start a new studio.", weight=5)
    milestones(w)


# key, title, how to earn it, test(w) -> bool
MILESTONES = [
    ("first_release", "Opening night", "Release your first picture.",
     lambda w: w.stats.get("releases", 0) >= 1),
    ("first_hit", "A hit", "Release a picture that makes twice what it cost.",
     lambda w: w.stats.get("hits", 0) >= 1),
    ("blockbuster", "Lines round the block", "Release a BLOCKBUSTER or a PHENOMENON.",
     lambda w: _n(w, "SELECT COUNT(*) FROM movies WHERE rights='player' AND outcome IN ('BLOCKBUSTER','PHENOMENON')") >= 1),
    ("trilogy", "A trilogy", "Release three pictures in one series.",
     lambda w: _n(w, "SELECT COUNT(*) FROM franchises WHERE rights='player' AND installments>=3") >= 1),
    ("franchise8", "An eight-film universe", "Eight installments in a series you own.",
     lambda w: _n(w, "SELECT COUNT(*) FROM franchises WHERE rights='player' AND installments>=8") >= 1),
    ("franchise4b", "Theme-park money", "A series you own grosses $4 billion in total.",
     lambda w: _n(w, "SELECT COUNT(*) FROM franchises WHERE rights='player' AND total_gross>=4e9") >= 1),
    ("best_picture", "Best Picture", "Win Best Picture.",
     lambda w: _n(w, "SELECT COUNT(*) FROM awards WHERE category='picture' AND won=1 AND studio=?", (w.name,)) >= 1),
    ("best_picture10", "Ten Best Pictures", "Win Best Picture ten times.",
     lambda w: _n(w, "SELECT COUNT(*) FROM awards WHERE category='picture' AND won=1 AND studio=?", (w.name,)) >= 10),
    ("award10", "Ten statuettes", "Win ten Silver Screen Academy awards.",
     lambda w: _n(w, """SELECT COUNT(*) FROM awards WHERE won=1 AND studio=?
                        AND category NOT LIKE '%:%' AND category NOT LIKE 'razzie%'""", (w.name,)) >= 10),
    ("star_maker", "Star maker", "An unknown from one of your open calls becomes a star (fame 70+).",
     lambda w: _n(w, "SELECT COUNT(*) FROM actors WHERE discoverer='your casting office' AND fame>=70") >= 1),
    ("cheap_cult", "Glorious garbage", "A cult classic made for under a third of a typical picture.",
     lambda w: _n(w, """SELECT COUNT(*) FROM movies WHERE rights='player' AND cult_classic=1
                        AND budget < ?""", (C.standard_cost(w.year) * 0.34,)) >= 1),
    ("razzie", "So bad it's famous", "Take home a Golden Raspberry.",
     lambda w: _n(w, "SELECT COUNT(*) FROM awards WHERE category LIKE 'razzie%' AND studio=?", (w.name,)) >= 1),
    ("billion", "A billion-dollar studio", "Studio valuation passes $1 billion.",
     lambda w: (w.valuation or 0) >= 1e9),
    ("debt_free", "Nobody's mortgage", "Pay off every loan after having borrowed.",
     lambda w: _n(w, "SELECT COUNT(*) FROM ledger WHERE kind='loan' AND amount>0") >= 1
     and _n(w, "SELECT COUNT(*) FROM loans") == 0),
    ("year_2020", "Still standing in 2020", "Keep the studio open until 2020.",
     lambda w: w.year >= 2020),
    ("survivor", "A century of pictures", "Run the studio for a hundred years.",
     lambda w: w.year - w.start_year >= 100),
]


def _n(w, sql, args=()):
    return w.db.scalar(sql, args, 0) or 0


def milestones(w):
    st = w.stats
    ms = st.get("milestones", {})
    for key, title, how, test in MILESTONES:
        if ms.get(key):
            continue
        try:
            done = test(w)
        except Exception:
            done = False
        if done:
            ms[key] = w.year
            universe.log(w.year, w.week, "world", f"Milestone: {title}", how, weight=4)
    st["milestones"] = ms


def milestone_table(w):
    ms = w.stats.get("milestones", {})
    return [dict(key=k, title=t, how=h, year=ms.get(k)) for k, t, h, _ in MILESTONES]


def campaign(w, amount: float):
    """Award-season spending for the coming ceremony."""
    amount = max(0.0, float(amount))
    if not w.can_afford(amount):
        return dict(ok=False, error="not enough cash")
    w.spend(amount, "campaign", "Awards campaign")
    key = f"campaign:{w.year}"
    w.db.kv_set(key, w.db.kv_get(key, 0.0) + amount)
    return dict(ok=True, total=w.db.kv_get(key, 0.0))
