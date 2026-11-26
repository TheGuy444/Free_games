"""Directors and writers: the behind-the-camera population.

The actor universe ages, retires and renews itself every year; until this
module the directors and writers did not - the same 110 directors worked from
1910 to 2010 at 1910 prices. Now, every New Year:

* fees and salaries follow the era's cost of making a picture,
* some people retire (never anyone mid-picture or on your payroll),
* new directors and writers arrive so the pool never runs dry.
"""
from __future__ import annotations

from .. import config as C
from .. import universe
from ..rng import stream

DIRECTOR_POOL = 110
WRITER_POOL = 220


def yearly(w):
    rnd = stream(w.seed, "crew", w.year)
    prev = C.standard_cost(w.year - 1)
    now = C.standard_cost(w.year)
    infl = now / max(1.0, prev)
    if abs(infl - 1.0) > 1e-9:
        w.db.execute("UPDATE directors SET fee=fee*?", (infl,))
        w.db.execute("UPDATE writers SET fee=fee*?, salary=salary*?", (infl, infl))

    # directors: a few retire each year (the famous ones linger longer)
    gone = 0
    for d in w.db.q("""SELECT id,name,films,prestige FROM directors
                       WHERE status<>'retired' AND (busy_until < ? OR busy_until IS NULL)
                       AND (studio IS NULL OR studio<>'player')""", (w.abs_week,)):
        p = 0.035 + 0.004 * min(30, d["films"]) - 0.0004 * d["prestige"]
        if rnd.random() < max(0.01, p):
            w.db.execute("UPDATE directors SET status='retired', busy_until=999999 WHERE id=?", (d["id"],))
            gone += 1
            if d["prestige"] > 45:
                universe.log(w.year, 0, "talent", f"{d['name']} retires",
                             f"{d['films']} pictures behind the camera. The town toasts them.")
    live = w.db.scalar("SELECT COUNT(*) FROM directors WHERE status<>'retired'", (), 0)
    new = max(0, DIRECTOR_POOL - live) + rnd.randint(0, 2)
    if new:
        w.db.executemany("""INSERT INTO directors(name,vision,discipline,temperament,prestige,fee,
                            status,studio,busy_until,hits,r)
                            VALUES(:name,:vision,:discipline,:temperament,:prestige,:fee,
                            'market',NULL,-1,0,:r)""",
                         [universe.make_director(rnd, w.year) for _ in range(new)])

    # writers on the open market churn the same way
    for wr in w.db.q("""SELECT id FROM writers WHERE status='market' AND studio IS NULL
                        AND busy_until < ?""", (w.abs_week,)):
        if rnd.random() < 0.04:
            w.db.execute("UPDATE writers SET status='retired', busy_until=999999 WHERE id=?", (wr["id"],))
    live = w.db.scalar("SELECT COUNT(*) FROM writers WHERE status<>'retired'", (), 0)
    new = max(0, WRITER_POOL - live) + rnd.randint(0, 3)
    if new:
        w.db.executemany("""INSERT INTO writers(name,skill,genre,genre2,fee,salary,weeks_per_script,
                            ego,drink,awards,status,studio,busy_until,scripts_written,best_picture,r)
                            VALUES(:name,:skill,:genre,:genre2,:fee,:salary,:weeks_per_script,
                            :ego,:drink,0,'market',NULL,-1,0,NULL,:r)""",
                         [universe.make_writer(rnd, w.year) for _ in range(new)])
    return dict(inflation=infl, directors_retired=gone)
