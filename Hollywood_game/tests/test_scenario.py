"""End-to-end scenario through the JSON API - the same calls the dashboard makes.

    python3 -m tests.test_scenario

Walks the whole studio loop: found a studio, buy and develop a script, sign
contract players, greenlight with a director, audition (checking the in-house /
outside-talent split), cast, swap, coach, shoot, release, turn a hit into a
series, take a loan, build, answer a world event, buy an estate sale. Every
step must answer ok:true (or the specific, expected refusal).
"""
from __future__ import annotations

import sys

from game import api, config as C
from game.sim import casting, events as E, production as P, rivals

FAILS = []


def call(method, path, expect_ok=True, **params):
    r = api.handle(method, path, params)
    ok = bool(r.get("ok"))
    if expect_ok is not None and ok != expect_ok:
        FAILS.append(f"{method} {path} {params} -> {r.get('error') or r}")
        print("  FAIL", method, path, r.get("error"))
    return r


def check(cond, msg):
    if not cond:
        FAILS.append(msg)
        print("  FAIL", msg)


def main():
    st = call("POST", "/api/new_game", name="Scenario Pictures", start_year=1939,
              preset="major", seed=11, slug="_scenario", actors=2400)["state"]
    w = api.WORLD
    std = C.standard_cost(w.year)
    w.cash += std * 40                       # bankroll the test, not the balance
    print("founded", st["game"]["name"], st["game"]["year"])

    # --- every GET a tab makes
    for path in ("/api/state", "/api/actors", "/api/casting/pool", "/api/scripts/market",
                 "/api/scripts/library", "/api/writers", "/api/productions", "/api/releases",
                 "/api/franchises", "/api/offers", "/api/world", "/api/log", "/api/finance",
                 "/api/awards", "/api/directors", "/api/config", "/api/saves"):
        call("GET", path)
    call("GET", "/api/actors", status="signed")
    call("GET", "/api/writers", sort="week_rate", dir="asc")

    # --- writers
    wr = call("GET", "/api/writers", limit=3)["rows"][0]
    call("POST", "/api/writer", action="hire", id=wr["id"])
    call("POST", "/api/writer", action="assign", id=wr["id"], genre="comedy")
    call("POST", "/api/writer", action="assign", id=wr["id"], genre="")

    # --- scripts: buy, coverage, every rewrite
    mk = call("GET", "/api/scripts/market", limit=10)["rows"]
    s1, s2 = mk[0], mk[1]
    call("POST", "/api/script", action="coverage", id=s1["id"])
    call("POST", "/api/script", action="buy", id=s1["id"])
    call("POST", "/api/script", action="buy", id=s2["id"])
    sd = call("GET", "/api/script", id=s1["id"])
    check("quality" not in sd, "script detail leaks true quality")
    check(sd.get("dev_options"), "script detail has no rewrite options")
    for opt in sd["dev_options"]:
        r = call("POST", "/api/script", action="develop", id=s2["id"], kind=opt["id"])
        if r.get("dead"):
            break

    # --- open calls (all four tiers) and signing contract players
    for t in range(4):
        call("POST", "/api/casting/open_call", tier=t)
    pool = call("GET", "/api/casting/pool", industry=1)["rows"]
    check(all(not r.get("studio") for r in pool), "discovery pool lists rival-signed actors")
    for a in pool[:2]:
        call("POST", "/api/actor", action="sign", id=a["id"], films=2)
    # sign established names of both genders across ages so some will fit
    stars = [a for a in call("GET", "/api/actors", status="available", limit=60)["rows"]
             if not a["studio"]][:14]
    for a in stars:
        call("POST", "/api/actor", action="sign", id=a["id"], films=3)
    signed = call("GET", "/api/actors", status="signed", limit=100)
    check(signed["total"] >= 10, f"signed filter shows {signed['total']}")
    a0 = signed["rows"][0]
    ad = call("GET", "/api/actor", id=a0["id"])
    check(ad.get("yours"), "actor detail does not know they are yours")
    for k in ("coach_drama", "drama", "rehab", "image"):
        call("POST", "/api/actor", action="develop", id=a0["id"], kind=k)
    call("POST", "/api/actor", action="publicity", id=a0["id"])

    # --- greenlight with a director: fee must be charged and the director booked
    d = call("GET", "/api/directors", limit=5)["rows"][0]
    cash0 = w.cash
    pr = call("POST", "/api/production", action="create", script_id=s1["id"], scale="standard",
              budget=std, marketing=std * 0.2, director_id=d["id"])
    pid = pr["id"]
    pd = call("GET", "/api/production", id=pid)
    check(pd["director_id"] == d["id"], "director not attached on greenlight")
    check(cash0 - w.cash > std * 0.38, "director fee not charged on greenlight")
    busy = w.db.scalar("SELECT busy_until FROM directors WHERE id=?", (d["id"],))
    check(busy > w.abs_week, "director not booked")
    call("POST", "/api/production", expect_ok=False, action="create", script_id=s2["id"],
         director_id=d["id"])          # same director can't do two pictures

    # --- auditions: in-house first, then outside, separated
    seen_inhouse = 0
    for role in pd["roles"]:
        sl = call("GET", "/api/auditions", production=pid, role=role["id"], limit=30)
        rows = sl["rows"]
        secs = [r["section"] for r in rows]
        check(secs == sorted(secs, key=lambda x: 0 if x == "inhouse" else 1),
              f"role {role['id']}: in-house rows not all above outside rows")
        for r in rows:
            if r["section"] == "inhouse":
                seen_inhouse += 1
                check(r["studio"] == "player" and r["contract_films"] > 0,
                      "in-house row is not a contract player")
                check(r["meets"], "in-house row does not fit the part")
                check(role["min_age"] <= r["age"] <= role["max_age"], "in-house row wrong age")
                check(role["gender"] in ("any", r["gender"]), "in-house row wrong gender")
            else:
                check(not r["studio"], "outside row is signed somewhere")
        check("payroll" in sl["counts"], "no payroll count for the empty-state message")
        pick = rows[0] if rows else None
        if pick:
            call("POST", "/api/production", action="cast", id=pid, role_id=role["id"],
                 actor_id=pick["id"])
    check(seen_inhouse > 0, "no contract player ever appeared in the in-house section")

    pd = call("GET", "/api/production", id=pid)
    filled = [r for r in pd["roles"] if r.get("actor_id")]
    check(filled and all(r.get("actor_name") for r in filled), "cast roles show no actor name")
    check(all(r["name"] != r.get("actor_name") for r in filled), "role name == actor name")
    # cast actor must vanish from other auditions on the same picture
    if len(pd["roles"]) > 1 and filled:
        other = pd["roles"][-1]
        ids = [r["id"] for r in call("GET", "/api/auditions", production=pid,
                                     role=other["id"])["rows"]]
        check(filled[0]["actor_id"] not in ids or filled[0]["id"] == other["id"],
              "already-cast actor still auditioning for another part")
    # swap (uncast) used to crash
    if filled:
        call("POST", "/api/production", action="uncast", id=pid, role_id=filled[0]["id"])
        call("POST", "/api/production", action="cast", id=pid, role_id=filled[0]["id"],
             actor_id=filled[0]["actor_id"])
    # director change, upgrades, test, marketing
    d2 = call("GET", "/api/directors", limit=5)["rows"][0]
    call("POST", "/api/production", action="director", id=pid, director_id=d2["id"])
    check(w.db.scalar("SELECT busy_until FROM directors WHERE id=?", (d["id"],)) == -1,
          "replaced director still booked")
    call("POST", "/api/production", action="upgrade", id=pid, cat=list(C.UPGRADES)[0], tier=2)
    call("POST", "/api/production", action="marketing", id=pid, amount=std * 0.3)
    call("POST", "/api/production", action="test", id=pid)

    # --- shoot it
    contract_before = {r["actor_id"]: w.db.scalar("SELECT contract_films FROM actors WHERE id=?",
                                                  (r["actor_id"],))
                       for r in call("GET", "/api/production", id=pid)["roles"] if r.get("actor_id")}
    for _ in range(60):
        if call("GET", "/api/production", id=pid)["status"] == "ready":
            break
        call("POST", "/api/tick", weeks=1)
    pd = call("GET", "/api/production", id=pid)
    check(pd["status"] == "ready", f"picture never finished ({pd['status']})")
    call("POST", "/api/production", action="reshoot", id=pid)
    for _ in range(10):
        if call("GET", "/api/production", id=pid)["status"] == "ready":
            break
        call("POST", "/api/tick", weeks=1)
    rel = call("POST", "/api/release", production=pid)
    for aid, before in contract_before.items():
        if before:
            after = w.db.scalar("SELECT contract_films FROM actors WHERE id=?", (aid,))
            check(after == before - 1, f"contract not used up for actor {aid}: {before}->{after}")
    mv = call("GET", "/api/movie", id=rel["movie_id"])
    check(mv["cast"] and all(c["name"] != c["role"] for c in mv["cast"]), "release cast list broken")
    check(mv["can_series"], "fresh picture should be eligible to become a series")

    # --- the press: a review pops, the paper prints it, the cast gets labels
    check(rel.get("review") and mv.get("has_review"), "release wrote no review")
    st2 = call("GET", "/api/state")
    check(rel["movie_id"] in st2["reviews_unseen"], "new review is not waiting to pop up")
    rv = call("GET", "/api/review", id=rel["movie_id"])
    check(len(rv["outlets"]) == 4 and all(1 <= o["score"] <= 10 for o in rv["outlets"]), "outlet scores broken")
    check(rv["headline"] and rv["consensus"] and rv["verdict"], "review text missing")
    check(rv["performances"] and all(p["grade"] for p in rv["performances"]), "performances not graded")
    call("POST", "/api/review/seen", id=rel["movie_id"])
    check(rel["movie_id"] not in call("GET", "/api/state")["reviews_unseen"], "review never marked read")
    call("POST", "/api/tick", weeks=1)
    paper = call("GET", "/api/paper", chart=100)
    check(any(r["movie_id"] == rel["movie_id"] for r in paper["chart"]), "our picture is not on the chart")
    check(paper["sections"]["review"], "paper has no reviews section")
    check(len(paper["chart"]) > 30, f"chart is thin: {len(paper['chart'])} pictures")
    call("GET", "/api/paper", abs=max(0, paper["abs"] - 5))
    call("GET", "/api/records")
    lead = rv["performances"][0]["actor_id"]
    check(w.db.scalar("SELECT COUNT(*) FROM actor_genre WHERE actor_id=?", (lead,)) > 0,
          "the lead's genre credit was not recorded")
    call("GET", "/api/actors", label="none")
    call("GET", "/api/actors", label="range")
    ad = call("GET", "/api/actor", id=lead)
    check("typecast" in ad and "award_list" in ad, "actor detail missing typecast/awards")

    # --- series, from the release history: any picture, no hit required
    first = rel["movie_id"]
    lead_ids = [c["id"] for c in mv["cast"] if c.get("kind") in ("lead", "voice")]
    sq = call("POST", "/api/franchise", action="sequel_from_movie", movie_id=first,
              name="Test Saga", scale="standard")
    fid = sq["franchise_id"]
    check(sq.get("series_created"), "sequel_from_movie did not start the series")
    call("GET", "/api/franchise", id=fid)
    spid = sq["id"]
    sp = call("GET", "/api/production", id=spid)
    check(sp["franchise_id"] == fid and sp["seq_index"] == 2, f"sequel index {sp.get('seq_index')}")
    check(call("GET", "/api/movie", id=first)["series"]["id"] == fid, "history does not show the series")
    # the original leads must be offered back, flagged as returning
    found_back = 0
    for role in sp["roles"]:
        sl = call("GET", "/api/auditions", production=spid, role=role["id"], limit=30)
        back = [r for r in sl["rows"] if r.get("returning")]
        found_back += len(back)
        pick = (back or sl["rows"] or [None])[0]
        if pick:
            call("POST", "/api/production", action="cast", id=spid, role_id=role["id"], actor_id=pick["id"])
    check(found_back > 0, "no returning cast offered for the sequel")
    for _ in range(80):
        if call("GET", "/api/production", id=spid)["status"] == "ready":
            break
        call("POST", "/api/tick", weeks=1)
    srel = call("POST", "/api/release", production=spid)
    check(srel.get("cast_back") is not None, "sequel release ignored returning cast")
    fd = call("GET", "/api/franchise", id=fid)
    check(fd["installments"] == 2, f"series has {fd['installments']} installments")
    check(len(fd["movies"]) == 2, "series does not list both pictures")
    # reboot an ACTIVE series: allowed, new continuity, old cast no longer "returning"
    rb = call("POST", "/api/franchise", action="launch", id=fid, kind="reboot")
    rp = call("GET", "/api/production", id=rb["id"])
    check(rp["franchise_id"] == fid, "reboot not attached to the series")
    sl = call("GET", "/api/auditions", production=rb["id"], role=rp["roles"][0]["id"])
    check(not any(r.get("returning") for r in sl["rows"]), "reboot still flags the old cast as returning")
    check(call("GET", "/api/franchise", id=fid)["continuity"] == 2, "continuity not bumped")
    # selling: blocked while an installment shoots, then shop it and take a bid
    call("POST", "/api/franchise", expect_ok=False, action="solicit", kind="franchise", id=fid)
    call("POST", "/api/production", action="cancel", id=rb["id"])
    bids = call("POST", "/api/franchise", action="solicit", kind="franchise", id=fid)["bids"]
    check(bids, "nobody bid on the series")
    again = call("POST", "/api/franchise", action="solicit", kind="franchise", id=fid)
    check(again.get("again"), "could re-shop the same series twice in a year")
    if bids:
        cash0 = w.cash
        call("POST", "/api/franchise", action="sell", offer_id=bids[0]["id"])
        fd = call("GET", "/api/franchise", id=fid)
        check(fd["rights"] == bids[0]["buyer"], "series rights did not move")
        check(abs(w.cash - cash0 - bids[0]["price"]) < 1, "sale money not paid")
        call("POST", "/api/franchise", expect_ok=False, action="launch", id=fid, kind="sequel")
        check(w.db.scalar("SELECT COUNT(*) FROM movies WHERE franchise_id=? AND rights='player'", (fid,)) == 0,
              "sold series' films still yours")
    # a standalone picture can be shopped too
    other = w.db.q1("SELECT id FROM movies WHERE rights='player' AND franchise_id IS NULL")
    if other:
        call("POST", "/api/franchise", action="solicit", kind="movie", id=other["id"])

    # --- money
    call("POST", "/api/finance", action="loan", amount=std * 0.5)
    lid = call("GET", "/api/finance")["loans"][0]["id"]
    bal0 = w.db.scalar("SELECT balance FROM loans WHERE id=?", (lid,))
    call("POST", "/api/tick", weeks=1)
    bal1 = w.db.scalar("SELECT balance FROM loans WHERE id=?", (lid,))
    check(abs(bal1 - bal0) < 1, f"interest capitalised while cash was available ({bal0}->{bal1})")
    call("POST", "/api/finance", action="repay", id=lid)
    call("POST", "/api/finance", action="build", kind="stage")
    call("POST", "/api/finance", action="campaign", amount=std * 0.05)

    # --- world event with a decision
    E.start(w, "actor_strike", force=True)
    ev = [e for e in call("GET", "/api/state")["events"] if e["choice"]]
    check(ev and ev[0]["choice"]["options"], "event decision has no options")
    if ev:
        call("POST", "/api/event", id=ev[0]["id"], choice=ev[0]["choice"]["options"][0]["id"])

    # --- a rival goes bust: offers must be created and buyable
    rv = w.db.q1("SELECT * FROM rivals WHERE alive=1 LIMIT 1")
    w.db.execute("""INSERT INTO franchises(name,genre,fan_base,heat,installments,last_year,
                    created_year,status,rights) VALUES('Rival Saga','action',80,1.0,2,?,?,'active',?)""",
                 (w.year, w.year, rv["name"]))
    w.db.execute("""INSERT INTO movies(title,genre,year,week,gross,rights) VALUES('Rival Pic','drama',?,0,1e6,?)""",
                 (w.year, rv["name"]))
    other = w.db.q1("SELECT name FROM rivals WHERE alive=1 AND id<>? LIMIT 1", (rv["id"],))["name"]
    w.db.execute("""INSERT INTO movies(title,genre,year,week,gross,rights) VALUES('Other Pic','drama',?,0,1e6,?)""",
                 (w.year, other))
    import random
    rivals.bankrupt(w, dict(rv), random.Random(1))
    offs = call("GET", "/api/offers")["rows"]
    buy = [o for o in offs if o["buyable"]]
    check(len(buy) == 2, f"estate sale offers: {len(buy)}")
    for o in buy:
        call("POST", "/api/franchise", action="acquire", offer_id=o["id"])
    check(w.db.scalar("SELECT rights FROM movies WHERE title='Other Pic'") == other,
          "library buyout took another rival's titles")
    check(w.db.scalar("SELECT rights FROM movies WHERE title='Rival Pic'") == "player",
          "library buyout missed the dead studio's titles")

    # --- loan a contract player out
    mine_free = w.db.q1("""SELECT id FROM actors WHERE studio='player' AND contract_films>0
                           AND busy_until < ?""", (w.abs_week,))
    if mine_free:
        c0 = w.cash
        lo = call("POST", "/api/actor", action="loan_out", id=mine_free["id"])
        check(w.cash > c0, "loan-out paid nothing")
        call("POST", "/api/actor", expect_ok=False, action="loan_out", id=mine_free["id"])

    # --- a series of our own for TV and merch
    m2 = w.db.q1("SELECT id FROM movies WHERE rights='player' AND franchise_id IS NULL")
    f2 = call("POST", "/api/franchise", action="create", movie_id=m2["id"], name="TV Saga")["id"]
    if not w.tech_on("tv"):
        call("POST", "/api/franchise", expect_ok=False, action="tv", id=f2)   # no TV in 1940s
        E.unlock_tech(w, "tv")
    call("POST", "/api/franchise", action="tv", id=f2)
    fan0 = w.db.scalar("SELECT fan_base FROM franchises WHERE id=?", (f2,))
    led0 = w.db.scalar("SELECT COUNT(*) FROM ledger WHERE label LIKE 'TV series licence%'")
    w.db.execute("INSERT INTO offers(kind,asset_id,asset_label,buyer,price,terms,year,expires_year,status,opportunity) "
                 "VALUES('merch',?,'TV Saga merchandise','a toy company',1000,'x',?,?,'open',2000)", (f2, w.year, w.year + 1))
    oid = w.db.scalar("SELECT MAX(id) FROM offers")
    call("POST", "/api/franchise", action="sell", offer_id=oid)
    check(w.db.kv_get(f"merch_sold:f{f2}", 0) == 1, "merch licence not recorded")

    # --- WWII: the draft takes young men off the audition list
    E.start(w, "wwii", force=True)
    E.cache_clear(w)
    s3 = call("GET", "/api/script", id=call("GET", "/api/scripts/market", limit=1)["rows"][0]["id"])
    call("POST", "/api/script", action="buy", id=s3["id"])
    for pp in w.db.q("SELECT id FROM productions WHERE status NOT IN ('released','cancelled')"):
        call("POST", "/api/production", action="cancel", id=pp["id"])
    wp = call("POST", "/api/production", action="create", script_id=s3["id"])
    away = 0
    for role in call("GET", "/api/production", id=wp["id"])["roles"]:
        away += call("GET", "/api/auditions", production=wp["id"], role=role["id"])["counts"].get("away", 0)
    check(away > 0, "WWII draft took nobody off the market")
    call("POST", "/api/production", action="cancel", id=wp["id"])

    # --- a loan that falls due, crew prices following the era, achievements
    call("POST", "/api/finance", action="loan", amount=std * 0.2)
    w.db.execute("UPDATE loans SET due_year=?", (w.year + 1,))
    dfee0 = w.db.scalar("SELECT AVG(fee) FROM directors WHERE status<>'retired'")
    nd0 = w.db.scalar("SELECT MAX(id) FROM directors")
    call("POST", "/api/tick", weeks=52 * 2)
    check(w.db.scalar("SELECT COUNT(*) FROM loans WHERE due_year<=?", (w.year - 1,)) == 0, "overdue loan left alone")
    check(w.db.scalar("SELECT AVG(fee) FROM directors WHERE id<=?", (nd0,)) > dfee0 * 1.05, "director fees never inflate")
    check(w.db.scalar("SELECT MAX(id) FROM directors") > nd0, "no new directors ever arrive")
    check(w.db.scalar("SELECT COUNT(*) FROM ledger WHERE label LIKE 'TV series licence%'") > led0, "TV show paid nothing")
    check(w.db.scalar("SELECT fan_base FROM franchises WHERE id=?", (f2,)) >= fan0, "TV did not hold the fan base")
    aw = call("GET", "/api/awards")
    check(any(m["year"] for m in aw["milestones"]), "no milestone ever recorded")

    # --- poaching war must not crash the calendar
    E.start(w, "talent_poach", force=True)
    call("POST", "/api/tick", weeks=52)
    call("POST", "/api/tick", weeks=260)

    print()
    if FAILS:
        print(f"{len(FAILS)} FAILURE(S)")
        for f in FAILS:
            print(" -", f)
        sys.exit(1)
    print("scenario OK")


def era_scenario():
    """Formats, era overheads, bonds, home releases and script sales."""
    from game.sim import formats as FM
    print("era scenario")
    # --- golden age: Technicolor costs money, the Code seal is charged, B&W is fine
    call("POST", "/api/new_game", name="Era Pictures", start_year=1939, preset="major",
         seed=5, slug="_scenario_era", actors=1600)
    w = api.WORLD
    std = C.standard_cost(w.year)
    w.cash += std * 40
    fm = call("GET", "/api/formats", budget=std, genre="musical", scale="standard")
    ids = [f["id"] for f in fm["formats"]]
    check("colour" in ids and "dolby" not in ids, f"1939 formats wrong: {ids}")
    check(any(c["id"] == "code" for c in fm["era_costs"]), "no Production Code seal in 1939")
    check(not fm["bond"]["available"], "completion bonds before 1970")
    mk = call("GET", "/api/scripts/market", limit=6)["rows"]
    for sc in mk[:3]:
        call("POST", "/api/script", action="buy", id=sc["id"])
    # sell one: price follows the true quality, rival owns it afterwards
    q = call("GET", "/api/script", id=mk[2]["id"])["sale"]
    check(q and q["price"] > 0, "no sale quote for an owned script")
    c0 = w.cash
    sold = call("POST", "/api/script", action="sell", id=mk[2]["id"])
    check(abs(w.cash - c0 - sold["price"]) < 1, "script sale not paid")
    check(w.db.scalar("SELECT owner FROM scripts WHERE id=?", (mk[2]["id"],)) == sold["buyer"],
          "sold script still ours")
    call("POST", "/api/script", expect_ok=False, action="sell", id=mk[2]["id"])
    # greenlight in Technicolor
    c0 = w.cash
    pr = call("POST", "/api/production", action="create", script_id=mk[0]["id"], budget=std,
              marketing=std * 0.2, formats=["colour"])
    pid = pr["id"]
    tech_cost = std * FM.cost_frac(w, "colour")
    check(c0 - w.cash >= std * 0.18 + std * 0.2 + tech_cost - 1, "Technicolor not charged at greenlight")
    check(FM.get_chosen(w, pid).get("colour"), "format not recorded")
    call("POST", "/api/production", action="formats", id=pid, formats=[])
    check(not FM.get_chosen(w, pid), "format not dropped")
    call("POST", "/api/production", action="formats", id=pid, formats=["colour"])
    pd = call("GET", "/api/production", id=pid)
    check(any(f["id"] == "colour" and f["on"] for f in pd["formats"]), "production screen lost the format")
    for role in pd["roles"]:
        rows = call("GET", "/api/auditions", production=pid, role=role["id"])["rows"]
        if rows:
            call("POST", "/api/production", action="cast", id=pid, role_id=role["id"], actor_id=rows[0]["id"])
    for _ in range(60):
        if call("GET", "/api/production", id=pid)["status"] == "ready":
            break
        call("POST", "/api/tick", weeks=1)
    call("POST", "/api/production", expect_ok=False, action="formats", id=pid, formats=[])
    rel = call("POST", "/api/release", production=pid)
    mv = call("GET", "/api/movie", id=rel["movie_id"])
    check(mv["formats"] == ["colour"], f"movie formats {mv['formats']}")
    m = w.db.q1("SELECT * FROM movies WHERE id=?", (rel["movie_id"],))
    check(m["net"] < (m["gross"] * C.STUDIO_SHARE - m["gross"] * C.DISTRIBUTION_FEE - m["budget"] - m["marketing"]),
          "format and era costs missing from the picture's net")

    # --- the eighties: Dolby, guild costs, bonds, residuals, VHS
    call("POST", "/api/new_game", name="Eighties Pictures", start_year=1980, preset="major",
         seed=6, slug="_scenario_era2", actors=1600)
    w = api.WORLD
    std = C.standard_cost(w.year)
    w.cash += std * 40
    fm = call("GET", "/api/formats", budget=std, genre="action", scale="epic")
    st = {f["id"]: f for f in fm["formats"]}
    check(st.get("colour", {}).get("standard") and st.get("widescreen", {}).get("standard"),
          "colour/widescreen not standard by the 80s")
    check("dolby" in st and not st["dolby"]["standard"], "Dolby should be an option in the 80s")
    check(any(c["id"] == "guilds" for c in fm["era_costs"]), "no guild costs in the 80s")
    check(fm["bond"]["available"] and fm["residual_rate"] > 0, "no bond / residuals in the 80s")
    mk = call("GET", "/api/scripts/market", limit=3)["rows"]
    call("POST", "/api/script", action="buy", id=mk[0]["id"])
    pr = call("POST", "/api/production", action="create", script_id=mk[0]["id"], budget=std,
              formats=["dolby"], bond=True)
    check(FM.bonded(w, pr["id"]), "bond not taken at greenlight")
    pd = call("GET", "/api/production", id=pr["id"])
    for role in pd["roles"]:
        rows = call("GET", "/api/auditions", production=pr["id"], role=role["id"])["rows"]
        if rows:
            call("POST", "/api/production", action="cast", id=pr["id"], role_id=role["id"], actor_id=rows[0]["id"])
    for _ in range(70):
        if call("GET", "/api/production", id=pr["id"])["status"] == "ready":
            break
        call("POST", "/api/tick", weeks=1)
    rel = call("POST", "/api/release", production=pr["id"])
    call("POST", "/api/tick", weeks=52)
    check((w.db.scalar("SELECT COUNT(*) FROM ledger WHERE kind='residuals'") or 0) > 0, "no residuals paid")
    mv = call("GET", "/api/movie", id=rel["movie_id"])
    vhs = [h for h in mv["home"] if h["id"] == "vhs"]
    check(vhs, "no VHS release offered in the 80s")
    if vhs:
        before = w.db.scalar("SELECT secondary FROM movies WHERE id=?", (rel["movie_id"],))
        call("POST", "/api/home", id=rel["movie_id"], kind="vhs")
        call("POST", "/api/home", expect_ok=False, id=rel["movie_id"], kind="vhs")
        check(FM.home_mult(w, rel["movie_id"]) > 1.0, "VHS release had no effect")
    call("GET", "/api/catalogue")
    call("GET", "/api/world")


def character_scenario():
    """Characters: born with a series, cast by name, spun off, teamed up,
    carried through a reboot, made icons."""
    from game.sim import characters as CH
    print("character scenario")
    call("POST", "/api/new_game", name="Character Pictures", start_year=1985, preset="major",
         seed=9, slug="_scenario_chars", actors=1800)
    w = api.WORLD
    std = C.standard_cost(w.year)
    w.cash += std * 200

    def shoot(pid):
        call("POST", "/api/production", action="auto_cast", id=pid)
        d = call("GET", "/api/directors", limit=8)["rows"]
        for dd in d:
            if call("POST", "/api/production", expect_ok=None, action="director", id=pid,
                    director_id=dd["id"]).get("ok"):
                break
        for _ in range(90):
            if call("GET", "/api/production", id=pid)["status"] == "ready":
                break
            call("POST", "/api/tick", weeks=1)
        return call("POST", "/api/release", production=pid)

    films = []
    for sc in call("GET", "/api/scripts/market", limit=20)["rows"]:
        if len(films) >= 2:
            break
        if not call("POST", "/api/script", expect_ok=None, action="buy", id=sc["id"]).get("ok"):
            continue
        pr = call("POST", "/api/production", action="create", script_id=sc["id"], budget=std,
                  marketing=std * 0.25)
        films.append(shoot(pr["id"])["movie_id"])
    fids = [call("POST", "/api/franchise", action="create", movie_id=m, name=f"Saga {i}")["id"]
            for i, m in enumerate(films)]
    for fid in fids:
        chars = call("GET", "/api/franchise", id=fid)["characters"]
        check(len(chars) >= 2, f"series {fid} got {len(chars)} characters")
        check(all(c["actor_name"] for c in chars), "a character with nobody playing them")
    # a sequel's parts carry the characters' names, and the portrayer is offered back
    sq = call("POST", "/api/franchise", action="launch", id=fids[0], kind="sequel", scale="standard")
    sp = call("GET", "/api/production", id=sq["id"])
    named = [r for r in sp["roles"] if r.get("character_id")]
    check(len(named) >= 2, "sequel parts are not bound to the characters")
    r0 = named[0]
    who = CH.get(w, r0["character_id"])["actor_id"]
    sl = call("GET", "/api/auditions", production=sq["id"], role=r0["id"], limit=30)
    check(any(r["id"] == who and r.get("portrays") for r in sl["rows"])
          or w.db.scalar("SELECT status FROM actors WHERE id=?", (who,)) in ("dead", "retired")
          or w.db.scalar("SELECT studio FROM actors WHERE id=?", (who,)),
          "the character's actor is not offered back")
    shoot(sq["id"])
    c0 = CH.get(w, r0["character_id"])
    check(c0["appearances"] >= 2, f"appearances not counted ({c0['appearances']})")
    # spin-off: force a breakout on a supporting character
    sup = w.db.q1("SELECT * FROM characters WHERE franchise_id=? AND role='supporting'", (fids[0],))
    if not sup:
        cid = w.db.execute("""INSERT INTO characters(name,franchise_id,origin_franchise,genre,gender,role,fan,
                              peak,appearances,actor_id,actors,breakout,created_year,last_year)
                              VALUES('Test Sidekick',?,?,'action','m','supporting',40,40,1,NULL,1,1,?,?)""",
                           (fids[0], fids[0], w.year, w.year)).lastrowid
    else:
        cid = sup["id"]
        w.db.execute("UPDATE characters SET breakout=1, fan=40 WHERE id=?", (cid,))
    so = call("POST", "/api/franchise", action="spinoff", character_id=cid, scale="standard")
    nf = w.db.q1("SELECT * FROM franchises WHERE id=?", (so["franchise_id"],))
    check(nf["kind"] == "spinoff" and nf["parent_id"] == fids[0], "spin-off series not linked to its parent")
    check(CH.get(w, cid)["franchise_id"] == nf["id"] and CH.get(w, cid)["role"] == "lead",
          "spun-off character did not move to the new series")
    spp = call("GET", "/api/production", id=so["id"])
    check(any(r.get("character_id") == cid and r["kind"] in ("lead", "voice") for r in spp["roles"]),
          "spin-off picture does not star the character")
    call("POST", "/api/franchise", expect_ok=False, action="spinoff", character_id=cid)
    shoot(so["id"])
    # team-up: leads from two series in one picture
    leads = [CH.of_series(w, f)[0]["id"] for f in fids]
    for i in leads:
        w.db.execute("UPDATE characters SET fan=MAX(fan, 40) WHERE id=?", (i,))
    call("POST", "/api/franchise", expect_ok=False, action="teamup", character_ids=leads[:1])
    fan_before = [w.db.scalar("SELECT fan_base FROM franchises WHERE id=?", (f,)) for f in fids]
    tu = call("POST", "/api/franchise", action="teamup", character_ids=leads, name="The Test League")
    uf = w.db.q1("SELECT * FROM franchises WHERE id=?", (tu["franchise_id"],))
    check(uf["kind"] == "universe", "team-up is not a universe series")
    tp = call("GET", "/api/production", id=tu["id"])
    check(sorted(r["character_id"] for r in tp["roles"] if r.get("character_id")) == sorted(leads),
          "team-up parts are not the chosen characters")
    trel = shoot(tu["id"])
    check(w.db.scalar("SELECT COUNT(*) FROM char_appearances WHERE movie_id=? AND universe=1",
                      (trel["movie_id"],)) >= 1, "team-up appearances not recorded")
    fan_after = [w.db.scalar("SELECT fan_base FROM franchises WHERE id=?", (f,)) for f in fids]
    check(fan_after != fan_before, "team-up did not feed back into its series")
    ch = call("GET", "/api/characters")
    check(ch["rows"] and ch["teamup"], "characters listing empty")
    check(call("GET", "/api/franchise", id=uf["id"])["characters"], "team-up shows no team")
    # reboot: a second life; a loved character with five films becomes an icon
    rb = call("POST", "/api/franchise", action="launch", id=fids[1], kind="reboot")
    shoot(rb["id"])
    star = CH.of_series(w, fids[1])[0]
    check(CH._lives(w, star["id"]) >= 2, "reboot did not count as a second life")
    w.db.execute("UPDATE characters SET appearances=6, peak=120, fan=90 WHERE id=?", (star["id"],))
    CH._check_icon(w, star["id"])
    check(CH.get(w, star["id"])["icon"] == 1, "a beloved character with two lives is not an icon")
    lic0 = w.db.scalar("SELECT COUNT(*) FROM ledger WHERE kind='licensing'", (), 0)
    call("POST", "/api/tick", weeks=52)
    check(w.db.scalar("SELECT COUNT(*) FROM ledger WHERE kind='licensing'", (), 0) > lic0,
          "icon earned no licensing money")
    # selling the series takes its characters with it
    o = w.db.execute("""INSERT INTO offers(kind,asset_id,asset_label,buyer,price,year,expires_year)
                        VALUES('franchise',?,?,?,?,?,?)""",
                     (fids[1], "Saga 1", w.db.scalar("SELECT name FROM rivals WHERE alive=1 LIMIT 1"),
                      std, w.year, w.year + 1)).lastrowid
    call("POST", "/api/franchise", action="sell", offer_id=o)
    check(CH.rights_of(w, CH.get(w, star["id"])) != "player", "sold series kept its characters")
    call("POST", "/api/franchise", expect_ok=False, action="spinoff", character_id=star["id"])
    call("POST", "/api/tick", weeks=52 * 3)
    print("character scenario OK" if not FAILS else "character scenario had failures")


if __name__ == "__main__":
    main()
    era_scenario()
    character_scenario()
    if FAILS:
        print(f"{len(FAILS)} FAILURE(S)")
        for f in FAILS:
            print(" -", f)
        sys.exit(1)
    print("era scenario OK")
