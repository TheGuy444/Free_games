"""Studio finances: overhead, payroll, loans, the lot, and valuation."""
from __future__ import annotations

from .. import config as C
from .. import universe
from ..rng import clamp, stream

BUILD_ORDER = list(C.BUILDINGS.keys())


def stages(w) -> int:
    return int(w.db.scalar("SELECT count FROM buildings WHERE kind='stage'", 0) or 0)


def max_productions(w) -> int:
    return 1 + stages(w)


def staff_payroll(w) -> float:
    """Weekly wages for retained writers (actors are paid per picture)."""
    return float(w.db.scalar("SELECT COALESCE(SUM(salary),0) FROM writers WHERE studio='player'", 0) or 0)


def lot_upkeep(w) -> float:
    """Weekly cost of the lot and its buildings, scaled to the era.

    A bare lot with one stage should cost a fifth of a picture a year; a
    full-blown studio park costs about a picture a year - but a full-blown
    studio park is also turning out four or five pictures a year.
    """
    std = C.standard_cost(w.year)
    total = std * 0.0026                      # gate, guards, property tax
    for r in w.db.q("SELECT kind,count FROM buildings"):
        spec = C.BUILDINGS.get(r["kind"])
        if spec:
            total += std * spec["per_year"] / 52.0 * (r["count"] or 0) * 1.6
    return total


def weekly(w):
    pay = staff_payroll(w)
    lot = lot_upkeep(w)
    if pay + lot > 0:
        w.spend(pay + lot, "overhead", "Lot upkeep and payroll")
    # debt service
    for r in w.db.q("SELECT id, balance, rate FROM loans"):
        interest = r["balance"] * r["rate"] / 52.0
        if interest <= 0:
            continue
        # pay the week's interest if there is cash; whatever cannot be paid
        # is added to the balance (never both)
        paid = min(interest, max(0.0, w.cash))
        if paid > 0:
            w.accrue(paid, "interest", "Loan interest")
        if interest - paid > 0:
            w.db.execute("UPDATE loans SET balance=balance+? WHERE id=?", (interest - paid, r["id"]))
    if w.cash < 0:
        # the bank forecloses on your nerve, not your studio (yet)
        w.db.execute("UPDATE game SET reputation=MAX(-100, reputation-0.25) WHERE id=1")


def loan_rate(w) -> float:
    from . import events as E
    base = 0.095 - clamp(w.prestige, 0, 100) * 0.0005 - clamp(w.reputation, -50, 100) * 0.00035
    return max(0.02, base * E.fx(w, "credit_mult"))


def debt(w) -> float:
    return float(w.db.scalar("SELECT COALESCE(SUM(balance),0) FROM loans", 0) or 0)


def loans_due(w):
    """Loans have a due year. On it the bank wants its money: paid from cash if
    there is any; otherwise rolled over for two years at a penalty rate, and
    the town hears about it."""
    for r in w.db.q("SELECT * FROM loans WHERE due_year <= ?", (w.year,)):
        pay = min(r["balance"], max(0.0, w.cash))
        if pay > 0:
            w.spend(pay, "loan", "Loan falls due")
        left = r["balance"] - pay
        if left <= 1:
            w.db.execute("DELETE FROM loans WHERE id=?", (r["id"],))
            universe.log(w.year, 0, "finance", "Loan repaid in full",
                         f"${r['principal']:,.0f} borrowed in {r['taken_year']} is off the books.")
        else:
            w.db.execute("UPDATE loans SET balance=?, rate=rate+0.03, due_year=? WHERE id=?",
                         (left, w.year + 2, r["id"]))
            w.add_reputation(-5)
            universe.log(w.year, 0, "finance", "The bank rolls over a loan - at a price",
                         f"${left:,.0f} still owed. Rate up three points, due {w.year + 2}. "
                         "The trades noticed.", weight=2)


def borrowing_capacity(w) -> float:
    std = C.standard_cost(w.year)
    assets = library_value(w)["total"]
    return max(0.0, std * 1.5 + assets * 0.35 - debt(w))


def take_loan(w, amount: float):
    amount = float(amount)
    cap = borrowing_capacity(w)
    if amount <= 0:
        return dict(ok=False, error="pick an amount")
    if amount > cap:
        return dict(ok=False, error=f"the bank will not lend more than ${cap:,.0f} right now")
    rate = loan_rate(w)
    w.earn(amount, "loan", "New loan")
    w.db.execute("""INSERT INTO loans(principal,balance,rate,taken_year,due_year)
                    VALUES(?,?,?,?,?)""", (amount, amount, rate, w.year, w.year + 6))
    universe.log(w.year, w.week, "finance", "Loan drawn",
                 f"${amount:,.0f} at {rate*100:.1f}% over six years.", weight=2)
    return dict(ok=True, amount=amount, rate=rate)


def repay(w, loan_id: int, amount: float = None):
    r = w.db.q1("SELECT * FROM loans WHERE id=?", (loan_id,))
    if not r:
        return dict(ok=False, error="no such loan")
    amt = min(float(amount) if amount else r["balance"], r["balance"], w.cash)
    if amt <= 0:
        return dict(ok=False, error="nothing to pay")
    w.spend(amt, "loan", "Loan repayment")
    newbal = r["balance"] - amt
    if newbal <= 1:
        w.db.execute("DELETE FROM loans WHERE id=?", (loan_id,))
    else:
        w.db.execute("UPDATE loans SET balance=? WHERE id=?", (newbal, loan_id))
    return dict(ok=True, paid=amt, balance=max(0.0, newbal))


def build(w, kind: str):
    spec = C.BUILDINGS.get(kind)
    if not spec:
        return dict(ok=False, error="unknown building")
    row = w.db.q1("SELECT count FROM buildings WHERE kind=?", (kind,))
    count = row["count"] if row else 0
    if count >= spec["max"]:
        return dict(ok=False, error=f"{spec['label']} is maxed out")
    if spec.get("tech") and not w.tech_on(spec["tech"]):
        return dict(ok=False, error=f"needs {C.TECH_YEAR.get(spec['tech'])}s technology")
    std = C.standard_cost(w.year)
    cost = std * spec["base"] * (1.0 + 0.45 * count)
    if not w.can_afford(cost):
        return dict(ok=False, error=f"needs ${cost:,.0f}")
    w.spend(cost, "build", f"Build: {spec['label']}")
    w.db.execute("""INSERT INTO buildings(kind,label,count) VALUES(?,?,1)
                    ON CONFLICT(kind) DO UPDATE SET count=count+1""", (kind, spec["label"]))
    universe.log(w.year, w.week, "finance", f"Built: {spec['label']}",
                 f"${cost:,.0f}. {spec['note']}", weight=2)
    return dict(ok=True, cost=cost, count=count + 1)


# --------------------------------------------------------------------------- #
#  Valuation
# --------------------------------------------------------------------------- #
def library_value(w):
    from . import franchise as F
    movies = [dict(r) for r in w.db.q("SELECT * FROM movies WHERE rights='player'")]
    lib = sum(F.movie_npv(w, m) for m in movies)
    frs = [dict(r) for r in w.db.q("SELECT * FROM franchises WHERE rights='player'")]
    # franchise_value already includes the movies in it: don't double count
    fr_lib_ids = {m["id"] for m in movies if m["franchise_id"]}
    lib -= sum(F.movie_npv(w, m) for m in movies if m["id"] in fr_lib_ids)
    fval = sum(F.franchise_value(w, f) for f in frs)
    return dict(movies=lib, franchises=fval, total=lib + fval, titles=len(movies),
                series=len(frs))


def lot_value(w):
    std = C.standard_cost(w.year)
    total = std * 0.25
    for r in w.db.q("SELECT kind,count FROM buildings"):
        spec = C.BUILDINGS.get(r["kind"])
        if spec:
            total += std * spec["base"] * (r["count"] or 0) * 0.8
    return total


def slate_value(w):
    rows = w.db.q("""SELECT budget,spent,cast_spend,marketing,status FROM productions
                     WHERE status NOT IN ('released','cancelled')""")
    return sum((r["spent"] or 0) + (r["cast_spend"] or 0) for r in rows) * 1.05


def valuation(w) -> float:
    lib = library_value(w)
    v = (max(0.0, w.cash) + lib["total"] + lot_value(w) + slate_value(w)
         + w.prestige * C.standard_cost(w.year) * 0.05 - debt(w))
    v = max(0.0, v)
    w.valuation = v
    return v


def finance_summary(w):
    yr = w.year
    rows = w.db.q("""SELECT kind, SUM(amount) a FROM ledger WHERE year=? GROUP BY kind""", (yr,))
    by_kind = {r["kind"]: r["a"] for r in rows}
    income = sum(v for v in by_kind.values() if v > 0)
    out = sum(-v for v in by_kind.values() if v < 0)
    lib = library_value(w)
    prod_value = sum(r["net"] or 0 for r in w.db.q("SELECT net FROM movies WHERE year=?", (yr,)))
    return dict(
        year=yr, cash=w.cash, debt=debt(w), income=income, expenditure=out,
        by_kind=[dict(kind=k, amount=v) for k, v in sorted(by_kind.items(), key=lambda kv: kv[1])],
        valuation=valuation(w), library=lib, lot=lot_value(w), slate=slate_value(w),
        prestige=w.prestige, reputation=w.reputation,
        payroll_weekly=staff_payroll(w), upkeep_weekly=lot_upkeep(w),
        loan_rate=loan_rate(w), capacity=borrowing_capacity(w),
        loans=[dict(r) for r in w.db.q("SELECT * FROM loans ORDER BY id")],
        buildings=[dict(kind=r["kind"], label=r["label"], count=r["count"],
                        spec=C.BUILDINGS.get(r["kind"], {}))
                   for r in w.db.q("SELECT * FROM buildings ORDER BY kind")],
        build_options=[dict(kind=k, label=v["label"], note=v["note"], tech=v.get("tech"),
                            cost=round(C.standard_cost(w.year) * v["base"]
                                       * (1.0 + 0.45 * (w.db.scalar(
                                           "SELECT count FROM buildings WHERE kind=?", (k,), 0) or 0)), 0),
                            count=(w.db.scalar("SELECT count FROM buildings WHERE kind=?", (k,), 0) or 0),
                            max=v["max"], tech_ok=(not v.get("tech")) or w.tech_on(v["tech"]))
                       for k, v in C.BUILDINGS.items()],
        year_profit=sum(v for k, v in by_kind.items() if k != "loan"),
        slots=max_productions(w),
        in_work=int(w.db.scalar("""SELECT COUNT(*) FROM productions WHERE status IN
                    ('development','pre_production','shooting','post_production')""", (), 0)),
    )


def record_year(w):
    """Snapshot the year for the charts."""
    gross = float(w.db.scalar("SELECT COALESCE(SUM(gross),0) FROM movies WHERE year=?", (w.year,), 0))
    net = float(w.db.scalar("SELECT COALESCE(SUM(net),0) FROM movies WHERE year=?", (w.year,), 0))
    rel = int(w.db.scalar("SELECT COUNT(*) FROM movies WHERE year=?", (w.year,), 0))
    ledger_net = float(w.db.scalar("""SELECT COALESCE(SUM(amount),0) FROM ledger
                                      WHERE year=? AND kind<>'loan'""", (w.year,), 0))
    v = valuation(w)
    w.db.execute("""INSERT INTO year_stats(year,releases,gross,net,profit,cash,valuation,prestige,reputation)
                    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(year) DO UPDATE SET
                    releases=excluded.releases, gross=excluded.gross, net=excluded.net,
                    profit=excluded.profit, cash=excluded.cash, valuation=excluded.valuation,
                    prestige=excluded.prestige, reputation=excluded.reputation""",
                 (w.year, rel, gross, net, ledger_net, w.cash, v, w.prestige, w.reputation))
