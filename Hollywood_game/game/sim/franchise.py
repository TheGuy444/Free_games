"""Franchises, series, sequels, reboots and the rights market.

This is the "Marvel in real life" module: you can turn any picture in your
catalogue into a franchise, milk it, let it die, reboot it - or sell the rights
for cash today and watch somebody else farm it in 1998.
"""
from __future__ import annotations

import json

from .. import config as C
from .. import names as N
from .. import universe
from ..rng import clamp, stream, unit
from . import events as E
from . import production as P
from . import scripts as S

DISCOUNT = 0.08
HORIZON = 22          # years of future exploitation considered in a price


# --------------------------------------------------------------------------- #
#  Valuation
# --------------------------------------------------------------------------- #
def annuity_years():
    return sum((1 - DISCOUNT) ** k for k in range(HORIZON))


def _age_curve(age: int, cult: float = 0.0) -> float:
    """Television pays for a title while it is young and current. The curve
    falls away to almost nothing inside two decades - a library is a pension
    that runs out, not an annuity for the ages. Cult titles keep a floor."""
    pts = [(0, 1.00), (2, 0.92), (4, 0.72), (6, 0.50), (9, 0.30),
           (12, 0.16), (15, 0.09), (18, 0.05), (24, 0.02), (40, 0.01)]
    v = C.interp(pts, age)
    return v * (1.0 + (0.5 if cult else 0.0))


def lifetime_left(w, m, cap=0.55) -> float:
    """How much more exploitation income this title may still generate."""
    gross = max(0.0, m["gross"] or 0.0)
    booked = m["secondary"] or 0.0
    return max(0.0, gross * cap - booked)


def movie_annual(w, m, extra_home: float = 1.0) -> float:
    """Annual exploitation income for one title we hold.

    Every line is a slice of what the picture earned in cinemas; each one ages,
    and the whole is capped at 8% of the original gross. A library is a pension,
    not a money printer - you still have to make pictures.
    """
    year, y = w.year, m["year"]
    gross = max(0.0, m["gross"] or 0.0)
    if gross <= 0:
        return 0.0
    age = max(0, year - y)
    ac = _age_curve(age, bool(m["cult_classic"]))
    base = 0.0
    if year >= C.SECONDARY["tv_license"]["min_year"] and m["rights"] == "player":
        base += gross * C.SECONDARY["tv_license"]["share"] * 0.45 * ac
    if year >= C.SECONDARY["home_video"]["min_year"]:
        ramp = min(1.0, age / C.SECONDARY["home_video"]["ramp"])
        base += gross * C.SECONDARY["home_video"]["share"] * ramp * 0.28 * ac
    if year >= C.SECONDARY["streaming"]["min_year"]:
        base += gross * C.SECONDARY["streaming"]["share"] * 0.24 * ac
    # merchandising: franchise titles, and only once licensing becomes an industry
    if m["franchise_id"] and year >= 1948:
        f = w.db.q1("SELECT heat,fan_base FROM franchises WHERE id=?", (m["franchise_id"],))
        if f:
            base += gross * 0.030 * (clamp(f["fan_base"], 0, 260) / 130.0) \
                * clamp(f["heat"], 0.3, 1.6) * ac
    # cult titles grow instead of fading
    if m["cult_classic"] or (m["cult"] or 0) > 35:
        base += C.standard_cost(year) * 0.012 * (m["cult"] / 40.0) * (1.0 + min(1.2, age / 30.0))
    # anniversary re-releases
    if age > 0 and age % C.SECONDARY["reissue"]["every"] == 0:
        base += gross * C.SECONDARY["reissue"]["share"] * (1.4 if m["cult_classic"] else 0.7)
    if w.db.kv_get(f"dist_sold:{m['id']}", 0):
        base *= 0.62
    if w.db.kv_get(f"merch_sold:{m['id']}", 0) or (
            m["franchise_id"] and w.db.kv_get(f"merch_sold:f{m['franchise_id']}", 0)):
        base *= 0.85
    base *= 1.0 + 0.10 * (w.db.scalar("SELECT count FROM buildings WHERE kind='archive'", 0) or 0)
    # home-video and streaming booms make every library worth more while they last
    base *= E.fx(w, "library_mult")
    # a star dies, and their pictures are suddenly on every channel
    pm = E.fx(w, "posthumous_mult")
    if pm != 1.0 and w.db.scalar("""SELECT COUNT(*) FROM cast_members cm JOIN actors a ON a.id=cm.actor_id
                                    WHERE cm.movie_id=? AND a.status='dead' AND cm.kind IN ('lead','voice')""",
                                 (m["id"],), 0):
        base *= pm
    # re-released on the format of the day (VHS, DVD, remaster, colourised)
    from . import formats as FM
    hm = FM.home_mult(w, m["id"]) * extra_home
    base *= hm
    # a title never pays out more than a share of what it did in cinemas -
    # a fresh home release raises that ceiling while it is on the shelves
    return max(0.0, min(base, gross * 0.06 * hm, lifetime_left(w, m,
                                                          C.SECONDARY.get("lifetime_cap", 0.55) * hm ** 0.5)))


def movie_npv(w, m) -> float:
    """What the remaining exploitation of one title is worth today."""
    age = w.year - m["year"]
    left = max(0, HORIZON - max(0, age) // 2)
    annual = movie_annual(w, m)
    return annual * sum((1 - DISCOUNT) ** k for k in range(left))


def series_track_record(w, f) -> tuple:
    """(typical gross, typical cost) of the series' recent pictures, in today's
    money. The latest installment counts most: buyers pay for where a series
    is now, not where it was in 1962."""
    rows = w.db.q("""SELECT year, gross, budget, marketing FROM movies
                     WHERE franchise_id=? AND gross>0 ORDER BY year DESC, id DESC LIMIT 3""", (f["id"],))
    std_now = C.standard_cost(w.year)
    g = c = wsum = 0.0
    for wt, r in zip((1.0, 0.7, 0.5), rows):
        infl = std_now / max(1.0, C.standard_cost(r["year"]))
        g += (r["gross"] or 0) * infl * wt
        c += ((r["budget"] or 0) + (r["marketing"] or 0)) * infl * wt
        wsum += wt
    if not wsum:
        return 0.0, 0.0
    return g / wsum, c / wsum


def sequel_pipeline(w, f) -> float:
    """What the next few pictures are worth to whoever holds the rights.

    This is the number a buyer actually pays for: a series that grosses
    hundreds of millions a picture is worth a large share of that, every time
    it goes before the cameras again. Cold, dormant or money-losing series are
    priced accordingly."""
    gross, cost = series_track_record(w, f)
    if gross <= 0:
        return 0.0
    gap = w.year - (f["last_year"] or f["created_year"])
    momentum = (clamp(f["heat"], 0.3, 2.0) ** 0.5
                * {"active": 1.0, "dormant": 0.6, "dead": 0.3}.get(f["status"], 0.8)
                * 0.96 ** max(0, gap - 4)
                * C.fan_mult(f["fan_base"]) ** 0.5)
    nxt = gross * momentum
    # the holder's take per picture: studio share plus TV, video and toys,
    # less what it costs to make - never less than a sliver of the gross
    margin = max(0.12, C.STUDIO_SHARE * 1.35 - cost / max(1.0, nxt))
    # four more pictures, one every three years, each a little smaller
    films = sum((1 - DISCOUNT) ** (3 * k) * 0.88 ** (k - 1) for k in range(1, 5))
    return nxt * margin * films


def franchise_value(w, f) -> float:
    """Library + future-sequel value of a franchise.

    Three parts: the library you hold today, the earning power of the next
    pictures (from the series' real box office), and the brand - the fan base
    and the merchandising it carries even before anyone shoots a frame."""
    movies = [dict(r) for r in w.db.q("SELECT * FROM movies WHERE franchise_id=? AND rights='player'",
                                      (f["id"],))]
    v = sum(movie_npv(w, m) for m in movies)
    std = C.standard_cost(w.year)
    heat = clamp(f["heat"], 0.2, 2.0)
    brand = (f["fan_base"] / 100.0) * std * 2.4 * heat * (1.0 + 0.12 * min(f["installments"], 6))
    pipeline = sequel_pipeline(w, f)
    # fans are worth something, but a series is priced on what it sells
    brand = min(brand, pipeline + std * 0.5)
    v += (pipeline + 0.5 * brand) * E.fx(w, "ip_demand_mult")
    return v


LENDERS = [(1920, "the Bank of the Pacific Coast"), (1946, "a syndicate of New York banks"),
           (1968, "an insurance company's film fund"), (1985, "a junk-bond house"),
           (2000, "a private-equity fund"), (2015, "a sovereign wealth fund")]
LOAN_RATE = 0.06          # interest a year on acquisition debt
LOAN_AMORTISE = 0.10      # share of the principal repaid each year


def lender(w) -> str:
    out = LENDERS[0][1]
    for yr, nm in LENDERS:
        if w.year >= yr:
            out = nm
    return out


def buyer_purse(w, rv) -> float:
    """What a rival can put down from its own resources: some of the cash in
    the bank plus what its bankers will lend against its recent box office,
    less what it already owes."""
    std = C.standard_cost(w.year)
    recent = w.db.scalar("SELECT COALESCE(SUM(gross),0) FROM rival_releases WHERE studio=? AND year>=?",
                         (rv["name"], w.year - 5), 0) or 0.0
    debt = rv.get("debt") or 0.0
    return max(std * 0.5, max(0.0, rv["cash"]) * 0.6 + recent * 0.5 + std * 3.0 - debt * 0.3)


def buyer_reach(w, rv, value, earnings=0.0) -> float:
    """The biggest cheque a rival can write for one series. Past its own purse
    it can take a bank loan secured on the series itself, the way studios
    really bought libraries. How much it borrows depends on how bold it is;
    the bank wants a down payment, and lends only what the series (and the
    studio's own pictures) can plausibly pay back."""
    own = buyer_purse(w, rv)
    ltv = 0.70 + 0.20 * clamp(rv.get("aggression", 0.5), 0.0, 1.0)     # loan-to-value it will take on
    recent = w.db.scalar("SELECT COALESCE(SUM(gross),0) FROM rival_releases WHERE studio=? AND year>=?",
                         (rv["name"], w.year - 5), 0) or 0.0
    service = LOAN_RATE + LOAN_AMORTISE
    payable = (max(0.0, earnings) + recent / 5.0 * C.STUDIO_SHARE * 0.3) / service
    loan = min(max(0.0, value) * ltv, payable)
    return max(own, min(own + loan, own / max(0.10, 1.0 - ltv)))


def movie_value(w, m) -> float:
    return movie_npv(w, m) * E.fx(w, "ip_demand_mult")


# --------------------------------------------------------------------------- #
#  Franchise creation / conversion
# --------------------------------------------------------------------------- #
def create_from_movie(w, movie_id: int, name: str = None):
    m = w.db.q1("SELECT * FROM movies WHERE id=?", (movie_id,))
    if not m:
        return dict(ok=False, error="no such title")
    if m["rights"] != "player":
        return dict(ok=False, error=f"you sold the rights to {m['rights']}")
    if m["franchise_id"]:
        return dict(ok=False, error="already part of a series")
    std = C.standard_cost(w.year)
    # Any picture you own can become a series. A flop just starts with a tiny,
    # cold fan base - the market, not a rule, tells you it was a bad idea.
    # rights consolidation: lawyers, licensing offices, a theme park brochure
    fee = max(std * 0.05, (m["gross"] or 0) * 0.05)
    if w.cash < fee:
        return dict(ok=False, error=f"setting up the series costs {fee:,.0f} - not enough cash")
    w.earn(-fee, "franchise", f"Franchise setup: {name or m['title']}")
    fr_name = (name or m["title"]).strip()[:60] or m["title"]
    fan = series_fan_estimate(m)
    cur = w.db.execute("""INSERT INTO franchises(name,root_movie_id,genre,fan_base,heat,continuity,
                    installments,last_year,created_year,status,rights,total_gross,total_net,note)
                    VALUES(?,?,?,?,?,?,1,?,?, 'active','player',?,?,?)""",
                       (fr_name, movie_id, m["genre"], fan, clamp(w.trend(m["genre"]), 0.5, 1.8),
                        1.0, w.year, w.year, m["gross"], m["net"],
                        "converted from back catalogue" if w.year - m["year"] > 2 else "launched"))
    fid = cur.lastrowid
    w.db.execute("UPDATE movies SET franchise_id=? WHERE id=?", (fid, movie_id))
    w.db.execute("UPDATE cast_members SET franchise_id=? WHERE movie_id=?", (fid, movie_id))
    from . import characters
    chars = characters.ensure_for_franchise(w, fid)
    universe.log(w.year, w.week, "finance", f"Franchise created: {fr_name}",
                 f"Fan base {fan:.0f}. Rights consolidated for ${fee:,.0f}. "
                 "The merchandising department is already dialling.", weight=3)
    return dict(ok=True, id=fid, fan_base=round(fan, 1), fee=fee, name=fr_name,
                characters=[c["name"] for c in chars])


def series_fan_estimate(m) -> float:
    """Fan base a picture would hand a new series: what it earned against what
    it cost, how much audiences liked it, and any cult following."""
    # the studio's share against what it cost: 1.0 is break-even, 2 a hit, 4 a blockbuster
    run = (m["gross"] or 0) * C.STUDIO_SHARE / max(1.0, (m["budget"] or 0) + (m["marketing"] or 0))
    return clamp(6.0 + 55.0 * max(0.0, min(4.5, run) - 0.5)
                 + (m["cult"] or 0) * 0.4 + ((m["audience"] or 50) - 50) * 0.3, 5, 260)


def series_setup_fee(w, m) -> float:
    return max(C.standard_cost(w.year) * 0.05, (m["gross"] or 0) * 0.05)


def _in_production(w, fid) -> int:
    return int(w.db.scalar("""SELECT COUNT(*) FROM productions WHERE franchise_id=?
                              AND status NOT IN ('released','cancelled')""", (fid,), 0))


def next_index(w, f) -> int:
    """Installment number of the next picture, counting ones still shooting."""
    return (f["installments"] or 0) + _in_production(w, f["id"]) + 1


def era_start(w, fid) -> int:
    """First year of the current continuity (after the latest reboot)."""
    return int(w.db.kv_get(f"reboot_year:{fid}", 0) or 0)


def returning_cast(w, fid) -> dict:
    """actor_id -> dict(name, lead, films) for everyone who has appeared in this
    continuity of the series. A reboot starts the count over."""
    since = era_start(w, fid)
    out = {}
    for r in w.db.q("""SELECT cm.actor_id, a.name, cm.kind, mo.year FROM cast_members cm
                       JOIN movies mo ON mo.id=cm.movie_id JOIN actors a ON a.id=cm.actor_id
                       WHERE mo.franchise_id=? AND mo.year>=?""", (fid, since)):
        d = out.setdefault(r["actor_id"], dict(name=r["name"], lead=False, films=0))
        d["films"] += 1
        d["lead"] = d["lead"] or r["kind"] in ("lead", "voice")
    return out


def sequel_from_movie(w, movie_id: int, kind: str = "sequel", name: str = None, **kw):
    """From the release history: make the next one. Starts the series first if
    this picture is not part of one yet."""
    m = w.db.q1("SELECT * FROM movies WHERE id=?", (movie_id,))
    if not m:
        return dict(ok=False, error="no such picture")
    fid = m["franchise_id"]
    created = None
    if not fid:
        created = create_from_movie(w, movie_id, name)
        if not created.get("ok"):
            return created
        fid = created["id"]
    res = launch(w, fid, kind=kind, **kw)
    if res.get("ok"):
        res["franchise_id"] = fid
        res["series_created"] = bool(created)
    return res


def solicit(w, kind: str, ident: int):
    """Shop a series (or a single title) around town. Up to three rivals bid;
    the bids sit on the rights desk until they expire. Once a year per asset -
    you cannot keep re-rolling the town until someone overpays."""
    if kind == "franchise":
        a = w.db.q1("SELECT * FROM franchises WHERE id=? AND rights='player'", (ident,))
        if not a:
            return dict(ok=False, error="not your series")
        if _in_production(w, ident):
            return dict(ok=False, error="an installment is still in production - finish it first")
        label = a["name"]
        terms = "series name, all installments, sequels and merchandising, in perpetuity"
    elif kind == "movie":
        a = w.db.q1("SELECT * FROM movies WHERE id=? AND rights='player'", (ident,))
        if not a:
            return dict(ok=False, error="you do not own that picture")
        if a["franchise_id"]:
            return dict(ok=False, error="part of a series - sell the whole series instead")
        label = a["title"]
        terms = "all rights, in perpetuity"
    else:
        return dict(ok=False, error="unknown asset")
    key = f"solicit:{kind}:{ident}"
    if w.db.kv_get(key, None) == w.year:
        bids = [dict(r) for r in w.db.q("""SELECT * FROM offers WHERE kind=? AND asset_id=?
                                           AND status='open' ORDER BY price DESC""", (kind, ident))]
        return dict(ok=True, bids=_bid_rows(bids), again=True,
                    note="You already shopped it this year; these are the bids still open.")
    w.db.kv_set(key, w.year)
    # clear stale unsolicited offers on the same asset so the desk shows one auction
    w.db.execute("UPDATE offers SET status='expired' WHERE kind=? AND asset_id=? AND status='open'",
                 (kind, ident))
    rivals_alive = [dict(r) for r in w.db.q("SELECT * FROM rivals WHERE alive=1 ORDER BY cash DESC")]
    bids = []
    for i, rv in enumerate(rivals_alive[:5]):
        rnd = stream(w.seed, "solicit", kind, ident, w.year, rv["id"])
        if rnd.random() < 0.35 and i > 0:
            continue                       # not everyone is interested
        pr = price_asset(w, kind, ident, rnd, buyer=rv)
        if not pr:
            continue
        ask = pr["ask"]
        t = terms
        if kind == "franchise" and pr.get("financed", 0) > ask * 0.2:
            t += f"; ${pr['financed']:,.0f} of it borrowed from {lender(w)}"
        cur = w.db.execute("""INSERT INTO offers(kind,asset_id,asset_label,buyer,price,terms,year,
                              expires_year,status,opportunity,hidden_buyer_interest)
                              VALUES(?,?,?,?,?,?,?,?,'open',?,?)""",
                           (kind, ident, label, rv["name"], ask, t, w.year, w.year + 1,
                            pr["opportunity"], pr["interest"]))
        bids.append(dict(w.db.q1("SELECT * FROM offers WHERE id=?", (cur.lastrowid,))))
        if len(bids) >= 3:
            break
    universe.log(w.year, w.week, "offer", f"Shopping {label}",
                 f"{len(bids)} studio(s) put a number on the table.", weight=2)
    bids.sort(key=lambda r: -r["price"])
    return dict(ok=True, bids=_bid_rows(bids), again=False)


def _bid_rows(rows):
    out = []
    for r in rows:
        r = dict(r)
        r["regret"] = max(0.0, r["opportunity"] - r["price"])
        ratio = r["price"] / max(1.0, r["opportunity"])
        r["verdict"] = ("very underpaid" if ratio < 0.6 else "thin" if ratio < 1.0
                        else "fair" if ratio < 1.6 else "generous")
        t = r.get("terms") or ""
        r["financing"] = t.split("; ", 1)[1] if "borrowed from" in t and "; " in t else None
        out.append(r)
    return out


# --------------------------------------------------------------------------- #
#  Television spin-offs (from the TV era on)
# --------------------------------------------------------------------------- #
def tv_quote(w, f) -> dict:
    std = C.standard_cost(w.year)
    annual = (f["fan_base"] or 0) / 100.0 * std * 0.09 * clamp(f["heat"], 0.4, 1.6) \
        * E.fx(w, "library_mult") ** 0.5
    return dict(cost=round(std * 0.35, 0), annual=round(annual, 0), seasons=5)


def tv_status(w, fid):
    return w.db.kv_get(f"tv:{fid}", None)


def launch_tv(w, fid: int):
    """Spin the series off into a TV show: a pilot fee now, a licence cheque
    every year it runs, and fans who never get the chance to drift away."""
    f = w.db.q1("SELECT * FROM franchises WHERE id=? AND rights='player'", (fid,))
    if not f:
        return dict(ok=False, error="not your series")
    if not w.tech_on("tv"):
        return dict(ok=False, error="there is no television yet")
    if tv_status(w, fid):
        return dict(ok=False, error="it is already on the air")
    q = tv_quote(w, f)
    if not w.can_afford(q["cost"]):
        return dict(ok=False, error=f"the pilot needs ${q['cost']:,.0f}")
    w.spend(q["cost"], "franchise", f"TV pilot: {f['name']}")
    w.db.kv_set(f"tv:{fid}", dict(start=w.year, until=w.year + q["seasons"], annual=q["annual"]))
    universe.log(w.year, w.week, "finance", f"{f['name']}: the TV series",
                 f"A weekly show keeps the fans warm. About ${q['annual']:,.0f} a year for "
                 f"{q['seasons']} seasons.", weight=2)
    return dict(ok=True, cost=q["cost"], annual=q["annual"], seasons=q["seasons"])


def cancel_tv(w, fid: int):
    if not tv_status(w, fid):
        return dict(ok=False, error="not on the air")
    w.db.kv_set(f"tv:{fid}", None)
    return dict(ok=True)


def _tv_year(w, f):
    """Yearly: licence income, fans kept warm, and the show ends on schedule."""
    tv = tv_status(w, f["id"])
    if not tv:
        return None
    if f["rights"] != "player":                     # sold: the show goes with it
        w.db.kv_set(f"tv:{f['id']}", None)
        return None
    q = tv_quote(w, f)
    w.earn(q["annual"], "secondary", f"TV series licence: {f['name']}")
    if w.year >= tv["until"]:
        w.db.kv_set(f"tv:{f['id']}", None)
        universe.log(w.year, 0, "finance", f"{f['name']} TV series ends",
                     "The last episode airs. Renew it from the series card if the fans still care.")
    return q["annual"]


def mark_in_production(w, fid: int, pid: int):
    f = w.db.q1("SELECT * FROM franchises WHERE id=?", (fid,))
    if not f:
        return
    if f["status"] in ("dormant", "dead"):
        w.db.execute("UPDATE franchises SET status='active' WHERE id=?", (fid,))


# --------------------------------------------------------------------------- #
#  Sequels and reboots
# --------------------------------------------------------------------------- #
def sequel_script(w, fid: int, kind: str = "sequel"):
    """Commission a script for the series straight from the studio's writers."""
    f = w.db.q1("SELECT * FROM franchises WHERE id=?", (fid,))
    if not f:
        return None, dict(ok=False, error="no such franchise")
    std = C.standard_cost(w.year)
    cost = std * (0.045 if kind == "sequel" else 0.085)
    if not w.can_afford(cost):
        return None, dict(ok=False, error=f"needs ${cost:,.0f} for the script")
    rnd = stream(w.seed, "sequel", fid, w.year, w.week, kind)
    root = w.db.q1("SELECT title FROM movies WHERE id=?", (f["root_movie_id"],))
    base = root["title"] if root else f["name"]
    idx = next_index(w, f)
    title = N.reboot_title(base, rnd) if kind in ("reboot", "remake") else N.unique_sequel(base, idx, rnd)
    if kind not in ("reboot", "remake") and w.db.scalar(
            "SELECT COUNT(*) FROM scripts WHERE title=?", (title,), 0):
        title = f"{base} {idx}"            # never two pictures with the same name
    N.take(title)
    fp = clamp(30 + f["fan_base"] * 0.35 + (f["heat"] - 1) * 18 + 22 * (kind == "reboot"), 15, 100)
    q = clamp(rnd.gauss(52 + (f["heat"] - 1) * 8, 12) - (6 if kind == "reboot" else 0), 15, 92)
    w.spend(cost, "script", f"{kind} script: {title}")
    cur = w.db.execute("""INSERT INTO scripts(title,genre,subgenre,scale,quality,fp,writer_id,owner,
                    status,price,option_price,created_year,developed,origin,source_franchise,tags)
                    VALUES(?,?,?,?,?,?,NULL,'player','owned',?,?,?,0,?,?,?)""",
                       (title, f["genre"], w.db.scalar(
                           "SELECT subgenre FROM movies WHERE id=?", (f["root_movie_id"],), None),
                        "standard", round(q, 1), int(fp), round(std * 0.08, 0),
                        round(std * 0.02, 0), w.year, kind, fid, f"{kind},{f['name']}"))
    return cur.lastrowid, dict(ok=True, cost=cost, title=title, quality=round(q, 1), fp=int(fp))


def fatigue(w, f) -> dict:
    """Sequels too close together, or too many, cool the well."""
    recent = w.db.scalar("""SELECT COUNT(*) FROM movies WHERE franchise_id=? AND year > ?""",
                         (f["id"], w.year - 4), 0)
    gap = w.year - (f["last_year"] or f["created_year"])
    penalty = max(0.0, (recent - 1)) * 0.22
    note = []
    if recent >= 2:
        note.append(f"{recent} installments in four years - the town is squinting")
    if gap > 6:
        note.append(f"{gap} years since the last one: the fan base has drifted")
    return dict(penalty=penalty, gap=gap, recent=recent, note="; ".join(note))


def launch(w, fid: int, kind: str = "sequel", script_id: int = None, scale: str = None,
           budget: float = None, marketing: float = None, title: str = None):
    f = w.db.q1("SELECT * FROM franchises WHERE id=?", (fid,))
    if not f:
        return dict(ok=False, error="no such franchise")
    if f["rights"] != "player":
        return dict(ok=False, error=f"you no longer own {f['name']} ({f['rights']})")
    kind = kind if kind in ("sequel", "reboot", "remake") else "sequel"
    if kind == "sequel" and f["status"] == "dead" and not script_id:
        return dict(ok=False, error="the property is dead - reboot it instead")
    reboot_mult = E.fx(w, "reboot_penalty_mult")
    gap = w.year - (f["last_year"] or f["created_year"])
    if kind in ("reboot", "remake") and not f["installments"]:
        return dict(ok=False, error="nothing to reboot yet")
    if script_id:
        s = w.db.q1("SELECT * FROM scripts WHERE id=?", (script_id,))
        if not s or s["owner"] != "player" or s["status"] not in ("owned", "optioned"):
            return dict(ok=False, error="you need to own that script")
        if s["source_franchise"] != fid:
            return dict(ok=False, error="that script does not belong to this series")
    else:
        script_id, info = sequel_script(w, fid, "reboot" if kind in ("reboot", "remake") else "sequel")
        if not script_id:
            return info
    if not scale:
        scale = "epic" if (f["fan_base"] > 120 and w.year > 1975) else "standard"
    res = P.create(w, script_id, title=title, scale=scale, budget=budget, marketing=marketing,
                   franchise_id=fid, kind=kind)
    if res.get("ok") and kind in ("reboot", "remake"):
        # a new continuity: the old cast is no longer "returning", and the
        # series is live again whatever state it was in
        w.db.kv_set(f"reboot_year:{fid}", w.year)
        from . import characters
        characters.note_reboot(w, fid)
        w.db.execute("UPDATE franchises SET continuity=continuity+1, status='active' WHERE id=?", (fid,))
        if gap < 5:
            P.add_log(w, res["id"], f"rebooting only {gap} year(s) after the last one - audiences may balk")
    if res.get("ok"):
        w.db.execute("""UPDATE productions SET hype=MIN(100, hype + ?) WHERE id=?""",
                     (min(35.0, f["fan_base"] * 0.30 * clamp(f["heat"], 0.4, 1.6) * (1.1 if kind == "sequel" else 0.9)),
                      res["id"]))
        if kind in ("reboot", "remake"):
            P.add_log(w, res["id"], f"rebooting a {f['status']} series "
                                    f"(backlash risk x{reboot_mult:.1f})")
    return res


# --------------------------------------------------------------------------- #
#  Rights market: offers, sales, buy-backs
# --------------------------------------------------------------------------- #
def _buyer(w, rnd):
    rows = [dict(r) for r in w.db.q("SELECT * FROM rivals WHERE alive=1")]
    if not rows:
        return None
    rows.sort(key=lambda r: r["cash"], reverse=True)
    return rows[rnd.randrange(min(4, len(rows)))]


def price_asset(w, kind: str, ident: int, rnd=None, buyer=None):
    """(ask, opportunity_cost, buyer) for a sale.  Includes hidden buyer interest."""
    rnd = rnd or stream(w.seed, "price", kind, ident, w.year)
    interest = clamp(rnd.uniform(0.55, 1.75) * E.fx(w, "ip_demand_mult"), 0.4, 2.6)
    if kind == "movie":
        m = w.db.q1("SELECT * FROM movies WHERE id=? AND rights='player'", (ident,))
        if not m:
            return None
        base = movie_npv(w, m)
        ask = base * interest * (1.0 + w.reputation / 400.0)
        opp = base
    elif kind == "franchise":
        f = w.db.q1("SELECT * FROM franchises WHERE id=? AND rights='player'", (ident,))
        if not f:
            return None
        base = franchise_value(w, f)
        # franchise_value already carries the IP-demand climate; do not count it twice
        ask = base * interest / max(0.25, E.fx(w, "ip_demand_mult"))
        opp = base * (1.0 + 0.35 * clamp(f["heat"], 0.3, 1.6))
        loan_value = base
        # what the series earns a year for its owner: four pictures over a dozen years
        earnings = sequel_pipeline(w, f) / 9.0
    else:
        return None
    buyer = buyer or _buyer(w, rnd)
    if not buyer:
        return None
    ask = max(C.standard_cost(w.year) * 0.02, ask)
    # nobody can write a cheque bigger than their war chest - but a war chest
    # is cash plus what the bank will lend against a studio's recent hits
    # a series can be bought on borrowed money, secured on the series itself;
    # a single picture cannot
    reach = buyer_reach(w, buyer, loan_value, earnings) if kind == "franchise" else buyer_purse(w, buyer)
    ask = min(ask, reach)
    financed = max(0.0, ask - max(0.0, buyer["cash"]) * 0.6)
    return dict(ask=ask, opportunity=opp, buyer=buyer["name"], interest=interest, financed=financed)


def generate_offers(w, force=False):
    """Rivals put money on the table for things you own."""
    rnd = stream(w.seed, "offers", w.year, w.week)
    made = 0
    owned_movies = [dict(r) for r in w.db.q("""SELECT m.* FROM movies m WHERE m.rights='player'
                        AND m.year < ? ORDER BY m.gross DESC LIMIT 60""", (w.year - 1,))]
    owned_fr = [dict(r) for r in w.db.q("SELECT * FROM franchises WHERE rights='player'")]
    ipdemand = E.fx(w, "ip_demand_mult")
    picks = []
    for f in owned_fr:
        if rnd.random() < 0.30 * ipdemand or force:
            picks.append(("franchise", f["id"]))
    for m in owned_movies[:14]:
        if rnd.random() < 0.12 * ipdemand or force:
            picks.append(("movie", m["id"]))
    if not picks and force:
        if owned_fr:
            picks.append(("franchise", owned_fr[0]["id"]))
        elif owned_movies:
            picks.append(("movie", owned_movies[0]["id"]))
    for kind, ident in picks:
        if w.db.scalar("""SELECT COUNT(*) FROM offers WHERE kind=? AND asset_id=? AND status='open'""",
                       (kind, ident), 0):
            continue
        pr = price_asset(w, kind, ident, rnd)
        if not pr:
            continue
        label = (w.db.scalar("SELECT name FROM franchises WHERE id=?", (ident,), "?")
                 if kind == "franchise" else w.db.scalar("SELECT title FROM movies WHERE id=?", (ident,), "?"))
        terms = "all rights, in perpetuity"
        if kind == "franchise":
            terms = "series name, all installments, sequels and merchandising, in perpetuity"
            if pr.get("financed", 0) > pr["ask"] * 0.2:
                terms += f"; ${pr['financed']:,.0f} of it borrowed from {lender(w)}"
        w.db.execute("""INSERT INTO offers(kind,asset_id,asset_label,buyer,price,terms,year,
                        expires_year,status,opportunity,hidden_buyer_interest)
                        VALUES(?,?,?,?,?,?,?,?, 'open',?,?)""",
                     (kind, ident, label, pr["buyer"], pr["ask"], terms, w.year, w.year + 2,
                      pr["opportunity"], pr["interest"]))
        made += 1
    # merchandising: a toy company wants the licence for a whole series
    if w.year >= 1948:
        for f in owned_fr:
            if w.db.kv_get(f"merch_sold:f{f['id']}", 0) or rnd.random() >= 0.10 * ipdemand:
                continue
            if w.db.scalar("SELECT COUNT(*) FROM offers WHERE kind='merch' AND asset_id=? AND status='open'",
                           (f["id"],), 0):
                continue
            movies = [dict(r) for r in w.db.q("SELECT * FROM movies WHERE franchise_id=? AND rights='player'",
                                               (f["id"],))]
            toys = sum(m["gross"] or 0 for m in movies) * 0.030 * (clamp(f["fan_base"], 0, 260) / 130.0) \
                * clamp(f["heat"], 0.3, 1.6) * 0.15
            if toys <= 0:
                continue
            w.db.execute("""INSERT INTO offers(kind,asset_id,asset_label,buyer,price,terms,year,
                            expires_year,status,opportunity,hidden_buyer_interest)
                            VALUES('merch',?,?,?,?,?,?,?,'open',?,1.0)""",
                         (f["id"], f"{f['name']} merchandise", "a toy company",
                          toys * rnd.uniform(3.0, 6.0),
                          "merchandise licence for the series: cash now, merch income cut for good",
                          w.year, w.year + 1, toys * 8.0))
            made += 1
    # side deals: distribution-only advances on individual titles (keep the IP)
    for m in owned_movies[:10]:
        if rnd.random() < 0.10 * ipdemand:
            base = movie_npv(w, m)
            if base <= 0:
                continue
            buyer = (_buyer(w, rnd) or {}).get("name", "a distributor")
            w.db.execute("""INSERT INTO offers(kind,asset_id,asset_label,buyer,price,terms,year,
                            expires_year,status,opportunity,hidden_buyer_interest)
                            VALUES('distribution',?,?,?,?,?,?,?, 'open',?,?)""",
                         (m["id"], m["title"], buyer, base * 0.34 * rnd.uniform(0.8, 1.6),
                          "distribution only: cash advance now, you keep the copyright but "
                          "exploitation income is reduced", w.year, w.year + 2, base, 1.0))
            made += 1
    return made


def offers(w, include_expired=False):
    sql = "SELECT * FROM offers WHERE " + ("status IN ('open','expired')" if include_expired else "status='open'")
    rows = [dict(r) for r in w.db.q(sql + " ORDER BY price DESC LIMIT 60")]
    for r in rows:
        r["regret"] = max(0.0, r["opportunity"] - r["price"])
        if r["kind"] == "franchise":
            f = w.db.q1("SELECT installments,fan_base,heat,status FROM franchises WHERE id=?",
                        (r["asset_id"],))
            r["detail"] = dict(f) if f else {}
        return_ = r["price"] / max(1.0, r["opportunity"])
        r["verdict"] = ("very underpaid" if return_ < 0.6 else "thin" if return_ < 1.0
                        else "fair" if return_ < 1.6 else "generous")
    return rows


def sell(w, offer_id: int):
    o = w.db.q1("SELECT * FROM offers WHERE id=? AND status='open'", (offer_id,))
    if not o:
        return dict(ok=False, error="offer is gone")
    if o["kind"] in ("movie", "franchise"):
        return _sell_ip(w, o)
    if o["kind"] == "merch":
        w.earn(o["price"], "ip_sale", f"Merchandise licence: {o['asset_label']}")
        w.db.kv_set(f"merch_sold:f{o['asset_id']}", 1)
        for m in w.db.q("SELECT id FROM movies WHERE franchise_id=?", (o["asset_id"],)):
            w.db.kv_set(f"merch_sold:{m['id']}", 1)
        w.db.execute("UPDATE offers SET status='accepted' WHERE id=?", (offer_id,))
        universe.log(w.year, w.week, "finance", f"Merch licence sold: {o['asset_label']}",
                     f"${o['price']:,.0f} today. The lunchboxes are someone else's now.", weight=2)
        return dict(ok=True, price=o["price"])
    if o["kind"] == "distribution":
        w.earn(o["price"], "ip_sale", f"Distribution rights: {o['asset_label']}")
        w.db.kv_set(f"dist_sold:{o['asset_id']}", 1)
        w.db.execute("UPDATE offers SET status='accepted' WHERE id=?", (offer_id,))
        universe.log(w.year, w.week, "finance", f"Distribution rights sold: {o['asset_label']}",
                     f"${o['price']:,.0f} cash up front; exploitation income reduced forever.", weight=2)
        return dict(ok=True, price=o["price"])
    return dict(ok=False, error="unknown deal")


def _sell_ip(w, o):
    buyer = o["buyer"]
    if o["kind"] == "movie":
        m = w.db.q1("SELECT * FROM movies WHERE id=? AND rights='player'", (o["asset_id"],))
        if not m:
            return dict(ok=False, error="title no longer yours")
        w.earn(o["price"], "ip_sale", f"Sold {m['title']} to {buyer}")
        _buyer_pays(w, buyer, o["price"])
        w.db.execute("UPDATE movies SET rights=?, sold_year=?, sold_price=? WHERE id=?",
                     (buyer, w.year, o["price"], o["asset_id"]))
        note = f"{m['title']} is {buyer}'s now. ${o['price']:,.0f} in the bank."
    else:
        f = w.db.q1("SELECT * FROM franchises WHERE id=? AND rights='player'", (o["asset_id"],))
        if not f:
            return dict(ok=False, error="series no longer yours")
        w.earn(o["price"], "ip_sale", f"Sold {f['name']} to {buyer}")
        loan = _buyer_pays(w, buyer, o["price"])
        w.db.execute("""UPDATE franchises SET rights=?, status='sold', sold_year=?, sold_price=?
                        WHERE id=?""", (buyer, w.year, o["price"], f["id"]))
        w.db.execute("UPDATE movies SET rights=?, sold_year=?, sold_price=? WHERE franchise_id=?",
                     (buyer, w.year, o["price"], f["id"]))
        note = (f"{f['name']} ({f['installments']} films, fan base {f['fan_base']:.0f}) sold to {buyer} "
                f"for ${o['price']:,.0f}. The board calls it prudent."
                + (f" {buyer} borrowed ${loan:,.0f} of it from {lender(w)}." if loan > o["price"] * 0.2 else ""))
        w.stats["ip_sold"] = w.stats.get("ip_sold", 0) + 1
        w.stats["ip_value_sold"] = w.stats.get("ip_value_sold", 0.0) + o["price"]
    w.db.execute("UPDATE offers SET status='accepted' WHERE id=?", (o["id"],))
    universe.log(w.year, w.week, "offer", f"Rights sold: {o['asset_label']} → {buyer}", note, weight=3)
    return dict(ok=True, price=o["price"], buyer=buyer)


def _buyer_pays(w, buyer, price):
    """The buyer's cash pays for part of the deal; the rest is a bank loan the
    buyer services every year (rivals.yearly) - borrow too much and the
    series can end up at the receivers."""
    rv = w.db.q1("SELECT * FROM rivals WHERE name=?", (buyer,))
    if not rv:
        return 0.0
    cash_part = min(price, max(0.0, rv["cash"]) * 0.6)
    loan = max(0.0, price - cash_part)
    w.db.execute("UPDATE rivals SET cash=cash-?, debt=debt+? WHERE id=?", (cash_part, loan, rv["id"]))
    return loan


def decline(w, offer_id: int):
    w.db.execute("UPDATE offers SET status='declined' WHERE id=? AND status='open'", (offer_id,))
    return dict(ok=True)


def buyback(w, kind: str, ident: int):
    """Try to buy back something you sold.  Expensive, and often impossible."""
    if kind == "franchise":
        f = w.db.q1("SELECT * FROM franchises WHERE id=?", (ident,))
        if not f:
            return dict(ok=False, error="no such series")
        if f["rights"] == "player":
            return dict(ok=False, error="you already own it")
        holder = w.db.q1("SELECT * FROM rivals WHERE name=?", (f["rights"],))
        value = franchise_value(w, f)
        if not holder:
            return dict(ok=False, error="the current holder is a shell company abroad")
        premium = 1.55 + unit(w.seed, "buyback", ident, w.year) * 0.9
        ask = max(value * premium, holder["cash"] * 0.25)
        if not w.can_afford(ask):
            return dict(ok=False, error=f"{f['rights']} wants ${ask:,.0f}")
        want = 0.35 + 0.4 * (1 - min(1.0, holder["cash"] / max(1.0, ask * 2)))
        if unit(w.seed, "buyback_ok", ident, w.year) > want:
            w.spend(ask * 0.12, "ip_buy", f"Broker fees: {f['name']}")
            return dict(ok=False, error=f"{f['rights']} refuses to talk at any price "
                                        f"(they are having far too much fun)")
        w.spend(ask, "ip_buy", f"Buy back {f['name']} from {f['rights']}")
        w.db.execute("""UPDATE franchises SET rights='player', status='active', heat=heat*0.8
                        WHERE id=?""", (ident,))
        w.db.execute("UPDATE movies SET rights='player' WHERE franchise_id=?", (ident,))
        universe.log(w.year, w.week, "offer", f"{f['name']} is yours again",
                     f"${ask:,.0f} paid to {f['rights']}. Somebody in accounting is weeping.", weight=3)
        return dict(ok=True, price=ask)
    if kind == "movie":
        m = w.db.q1("SELECT * FROM movies WHERE id=?", (ident,))
        if not m or m["rights"] == "player":
            return dict(ok=False, error="nothing to buy back")
        value = movie_npv(w, dict(m, rights="player")) * 1.8
        if not w.can_afford(value):
            return dict(ok=False, error=f"they want ${value:,.0f}")
        w.spend(value, "ip_buy", f"Buy back {m['title']}")
        w.db.execute("UPDATE movies SET rights='player', sold_year=NULL, sold_price=0 WHERE id=?", (ident,))
        return dict(ok=True, price=value)
    return dict(ok=False, error="unknown asset")


def option_out(w, fid: int, years: int = 7):
    """The classic mistake: license a series to a rival with a reversion clause."""
    f = w.db.q1("SELECT * FROM franchises WHERE id=? AND rights='player'", (fid,))
    if not f:
        return dict(ok=False, error="not your series")
    rnd = stream(w.seed, "option", fid, w.year)
    buyer = _buyer(w, rnd)
    if not buyer:
        return dict(ok=False, error="nobody to sell to")
    value = franchise_value(w, f)
    fee = value * 0.18 * rnd.uniform(0.7, 1.3)
    w.earn(fee, "ip_sale", f"Option on {f['name']} → {buyer['name']}")
    w.db.execute("""UPDATE franchises SET rights=?, status='active', note=? WHERE id=?""",
                 (buyer["name"], f"optioned {w.year}, reverts if unfilmed by {w.year + years}", fid))
    w.db.execute("UPDATE movies SET rights=? WHERE franchise_id=?", (buyer["name"], fid))
    w.db.kv_set(f"option:{fid}", dict(buyer=buyer["name"], expires=w.year + years, fee=fee))
    universe.log(w.year, w.week, "offer", f"{f['name']} optioned to {buyer['name']}",
                 f"${fee:,.0f} today. If they do not make one in {years} years it comes back. "
                 f"They always make one.", weight=3)
    return dict(ok=True, fee=fee, buyer=buyer["name"], expires=w.year + years)


# --------------------------------------------------------------------------- #
#  Yearly upkeep
# --------------------------------------------------------------------------- #
def yearly(w):
    rows = [dict(r) for r in w.db.q("SELECT * FROM franchises")]
    for f in rows:
        gap = w.year - (f["last_year"] or f["created_year"])
        status = f["status"]
        if f["rights"] == "player":
            if status == "active" and gap >= 12:
                status = "dormant"
                universe.log(w.year, 0, "finance", f"{f['name']} has gone quiet",
                             "Twelve years without a new installment. The fans write letters.", weight=2)
            elif status == "dormant" and gap >= 25:
                status = "dead"
                universe.log(w.year, 0, "finance", f"{f['name']} is dead",
                             "Nobody is making another one. Unless you reboot it.", weight=2)
        on_tv = bool(_tv_year(w, f))
        decayed = max(2.0, f["fan_base"] * (1.01 if on_tv else 0.965 if status == "active" else 0.94))
        heat = clamp(f["heat"] * 0.97 + 0.03 * w.trend(f["genre"]), 0.2, 2.2)
        w.db.execute("UPDATE franchises SET status=?, fan_base=?, heat=? WHERE id=?",
                     (status, decayed, heat, f["id"]))
    # option reversions (or the rival films it in time and you lose it forever)
    for f in [x for x in rows if x["rights"] != "player"]:
        opt = w.db.kv_get(f"option:{f['id']}", None)
        if not opt:
            continue
        if w.year >= opt["expires"]:
            made = w.db.scalar("""SELECT COUNT(*) FROM rival_releases
                                   WHERE franchise=? AND year >= ?""",
                               (f["name"], opt["expires"] - 7), 0)
            if made:
                # they made one in time: the reversion clause is dead
                w.db.kv_set(f"option:{f['id']}", None)
                w.db.execute("UPDATE franchises SET note=?, status='sold' WHERE id=?",
                             (f"sold to {f['rights']} after their picture", f["id"]))
                universe.log(w.year, 0, "offer", f"{f['name']} is gone",
                             f"{f['rights']} filmed one inside the option window. "
                             f"The reversion clause is worthless now.", weight=4)
            else:
                w.db.execute("""UPDATE franchises SET rights='player', status='dormant',
                                note='reverted to you' WHERE id=?""", (f["id"],))
                w.db.execute("UPDATE movies SET rights='player' WHERE franchise_id=?", (f["id"],))
                w.db.kv_set(f"option:{f['id']}", None)
                universe.log(w.year, 0, "offer", f"{f['name']} reverts to you",
                             "The option expired unfilmed. It is yours again - and worth more.",
                             weight=3)
    # expire stale offers
    w.db.execute("UPDATE offers SET status='expired' WHERE status='open' AND expires_year < ?",
                 (w.year,))


def list_all(w):
    rows = [dict(r) for r in w.db.q("""SELECT f.* FROM franchises f ORDER BY
                     CASE f.status WHEN 'active' THEN 0 WHEN 'dormant' THEN 1
                     WHEN 'dead' THEN 2 ELSE 3 END, f.total_gross DESC""")]
    out = []
    for f in rows:
        f["movies"] = [dict(x) for x in w.db.q("""SELECT id,title,year,gross,net,outcome,cult_classic,
                                 rights,seq_index FROM movies WHERE franchise_id=? ORDER BY year""",
                                                (f["id"],))]
        f["value"] = franchise_value(w, f) if f["rights"] == "player" else 0.0
        f["annual"] = sum(movie_annual(w, m) for m in
                          [dict(x) for x in w.db.q("SELECT * FROM movies WHERE franchise_id=? AND rights='player'",
                                                   (f["id"],))])
        f["fatigue"] = fatigue(w, f)
        mine = f["rights"] == "player"
        f["in_production"] = _in_production(w, f["id"])
        f["can_sequel"] = mine and f["status"] in ("active", "dormant")
        f["can_reboot"] = mine and (f["installments"] or 0) > 0
        f["can_sell"] = mine and not f["in_production"]
        f["next_index"] = next_index(w, f) if mine else None
        f["reboot_soon"] = mine and (w.year - (f["last_year"] or f["created_year"])) < 5
        f["continuity"] = f.get("continuity") or 1
        f["sequel_cost"] = round(C.standard_cost(w.year) * 0.045, 0)
        f["tv"] = tv_status(w, f["id"]) if mine else None
        f["tv_quote"] = tv_quote(w, f) if (mine and w.tech_on("tv")) else None
        f["merch_sold"] = bool(w.db.kv_get(f"merch_sold:f{f['id']}", 0))
        f["reboot_cost"] = round(C.standard_cost(w.year) * 0.085, 0)
        f["kind"] = f.get("kind") or "series"
        f["parent_name"] = (w.db.scalar("SELECT name FROM franchises WHERE id=?", (f["parent_id"],), None)
                            if f.get("parent_id") else None)
        f["n_characters"] = w.db.scalar("SELECT COUNT(*) FROM characters WHERE franchise_id=?", (f["id"],), 0)
        f["icons"] = [r["name"] for r in w.db.q(
            "SELECT name FROM characters WHERE franchise_id=? AND icon=1 ORDER BY fan DESC", (f["id"],))]
        f["open_offers"] = w.db.q1("""SELECT COUNT(*) c FROM offers WHERE kind='franchise'
                                      AND asset_id=? AND status='open'""", (f["id"],))["c"]
        out.append(f)
    return out


def detail(w, fid: int):
    for f in list_all(w):
        if f["id"] == fid:
            f["offers"] = _bid_rows([dict(o) for o in w.db.q(
                "SELECT * FROM offers WHERE asset_id=? AND kind='franchise' AND status='open' "
                "ORDER BY price DESC LIMIT 8", (fid,))])
            from . import characters
            f["characters"] = characters.for_series(w, fid)
            f["cast"] = sorted(([dict(id=k, **v) for k, v in returning_cast(w, fid).items()]),
                               key=lambda r: (-r["lead"], -r["films"]))
            return f
    return None
