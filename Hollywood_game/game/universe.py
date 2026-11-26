"""Universe generation: the actor pool, writers, directors, rivals, scripts.

Runs once per new game.  Uses executemany bulk inserts so a 5,000 actor universe
materialises in well under a second.  New actors later enter *only* through the
casting pipeline (sim/casting.py) - never from thin air.
"""
from __future__ import annotations

import json
from math import sqrt

from . import config as C
from . import names as N
from .rng import derive, stream, clamp

SKILL_COLS = ["s_drama", "s_comedy", "s_action", "s_musicality", "s_dance", "s_voice", "s_stunts"]


def fee_for(fame: float, star_power: float, year: int) -> float:
    """Asking fee for a LEAD in a standard picture this year (nominal $).

    Star power gets a modest premium; fame is what the ticket actually buys.
    A 60-fame player costs ~5% of a standard budget, a 90-fame star ~17%, so a
    full cast of stars eats a picture alive - the classic mistake.
    """
    std = C.standard_cost(year)
    f = max(0.0, min(100.0, fame)) / 100.0
    sp = max(0.0, min(100.0, star_power)) / 100.0
    return std * (0.030 + 0.16 * (f ** 1.8)) * (0.85 + 0.30 * sp)


def make_actor(rnd, year: int, age: int | None = None, gender: str | None = None,
               known: bool = True, id_hint: int = 0) -> dict:
    gender = gender or ("m" if rnd.random() < 0.5 else "f")
    if age is None:
        u = rnd.random()
        if u < 0.24:
            age = rnd.randint(16, 25)
        elif u < 0.60:
            age = rnd.randint(26, 40)
        elif u < 0.88:
            age = rnd.randint(41, 60)
        else:
            age = rnd.randint(61, 84)
    talent = clamp(rnd.gauss(45, 17), 5, 92)
    if rnd.random() < C.GENERATIONAL_TALENT_P:
        talent = clamp(rnd.uniform(78, 96), 0, 99)
    exp = max(0.0, min(16.0, (age - 20) * 0.55))
    skills = {}
    for col in SKILL_COLS:
        base = talent + rnd.gauss(0, 13) + (exp if col != "voice" else exp * 0.6)
        if col == "stunts":
            base -= max(0, (age - 38)) * 0.5
        if col == "dance":
            base -= max(0, (age - 34)) * 0.45
        skills[col] = round(clamp(base, 3, 99), 1)
    craft = sorted(skills.values(), reverse=True)[:3]
    craft = sum(craft) / len(craft)

    # career tier
    fame = 0.0
    status = "available"
    films = leads = 0
    if known and age >= 24:
        u = rnd.random() * (0.55 + talent / 130.0)
        if u < 0.020:
            fame, status = rnd.uniform(68, 96), "star"
            films = rnd.randint(6, 40)
            leads = films
        elif u < 0.11:
            fame, status = rnd.uniform(30, 66), "working"
            films = rnd.randint(3, 26)
            leads = films // 2
        elif u < 0.33:
            fame, status = rnd.uniform(8, 32), "working"
            films = rnd.randint(1, 12)
            leads = rnd.randint(0, films)
        else:
            fame = rnd.uniform(0, 9)
    charisma = clamp(rnd.gauss(45, 20) + fame * 0.22, 2, 99)
    likeability = clamp(rnd.gauss(52, 20), 2, 99)
    discipline = clamp(rnd.gauss(55, 20), 2, 99)
    ego = clamp(rnd.gauss(38, 22) + fame * 0.18, 1, 99)
    bankability = clamp(fame * 0.6 + charisma * 0.25 + rnd.gauss(8, 12), 1, 99)
    star_power = clamp(C.STAR_POWER_W["fame"] * fame + C.STAR_POWER_W["bankability"] * bankability
                       + C.STAR_POWER_W["craft"] * craft, 0, 100)
    if status == "star":
        fame = max(fame, 60)
    return dict(
        name=N.person_name(rnd, gender), gender=gender,
        birth_year=year - age, age=age, hue=rnd.randrange(360),
        **skills,
        t_charisma=round(charisma, 1), t_discipline=round(discipline, 1),
        t_versatility=round(clamp(rnd.gauss(45, 22) + (talent - 45) * 0.3, 2, 99), 1),
        t_bankability=round(bankability, 1), t_ego=round(ego, 1),
        t_scandal=round(clamp(rnd.gauss(26, 18), 0, 99), 1),
        t_substance=round(clamp(rnd.gauss(20, 16), 0, 99), 1),
        t_likeability=round(likeability, 1), t_press=round(clamp(rnd.gauss(45, 22), 2, 99), 1),
        craft=round(craft, 1), fame=round(fame, 1), star_power=round(star_power, 1),
        fee=round(fee_for(fame, star_power, year), 0), status=status,
        films=films, leads=leads,
        debut_year=(year - min(age - 16, 4)) if films else None,
        last_work_year=(year - 1) if films else None,
        cult=round(clamp(rnd.gauss(4, 6), 0, 40), 1),
    )


ACTOR_INSERT = """INSERT INTO actors(
 name,gender,birth_year,age,hue,
 s_drama,s_comedy,s_action,s_musicality,s_dance,s_voice,s_stunts,
 t_charisma,t_discipline,t_versatility,t_bankability,t_ego,t_scandal,t_substance,t_likeability,t_press,
 craft,fame,star_power,fee,status,films,leads,total_gross,best_gross,cult,
 debut_year,last_work_year,discoverer,notes,r,busy_until)
VALUES(:name,:gender,:birth_year,:age,:hue,
 :s_drama,:s_comedy,:s_action,:s_musicality,:s_dance,:s_voice,:s_stunts,
 :t_charisma,:t_discipline,:t_versatility,:t_bankability,:t_ego,:t_scandal,:t_substance,:t_likeability,:t_press,
 :craft,:fame,:star_power,:fee,:status,:films,:leads,0,0,:cult,
 :debut_year,:last_work_year,:discoverer,:notes,:r,-1)"""


def _actor_defaults(a: dict) -> dict:
    """ACTOR_INSERT binds every column by name; keep those keys present."""
    a.setdefault("discoverer", "studio records")
    a.setdefault("notes", "")
    return a


def make_writer(rnd, year: int) -> dict:
    skill = clamp(rnd.gauss(45, 20), 5, 97)
    g1 = rnd.choice(C.GENRES)
    g2 = rnd.choice(C.GENRES)
    weeks = max(6.0, rnd.gauss(20, 7) - skill / 12)
    std = C.standard_cost(year)
    fee = std * (0.03 + 0.09 * (skill / 100) ** 1.9)
    return dict(name=N.person_name(rnd, "m" if rnd.random() < 0.72 else "f"),
                skill=round(skill, 1), genre=g1, genre2=g2,
                fee=round(fee, 0), salary=round(fee / max(weeks, 6) * 0.72, 0),
                weeks_per_script=round(weeks, 1),
                ego=round(clamp(rnd.gauss(45, 22), 1, 99), 1),
                drink=round(clamp(rnd.gauss(28, 20), 0, 99), 1),
                awards=0, status="market", studio=None, best_picture=None,
                r=rnd.randrange(1, 2 ** 30))


def make_director(rnd, year: int) -> dict:
    vision = clamp(rnd.gauss(45, 20), 5, 98)
    prestige = clamp(rnd.gauss(10, 15) + (vision - 45) * 0.6, 0, 95)
    std = C.standard_cost(year)
    return dict(name=N.person_name(rnd, "m" if rnd.random() < 0.85 else "f"),
                vision=round(vision, 1), discipline=round(clamp(rnd.gauss(55, 20), 2, 99), 1),
                temperament=round(clamp(rnd.gauss(42, 24), 0, 99), 1),
                prestige=round(prestige, 1),
                fee=round(std * (0.03 + 0.13 * (vision / 100) ** 2.0), 0),
                status="market", studio=None, films=0, hits=0,
                r=rnd.randrange(1, 2 ** 30))


def make_script(rnd, year: int, writer: dict | None = None, genre: str | None = None,
                trends: dict | None = None, quality_bias: float = 0.0,
                scale: str | None = None, origin: str = "new",
                franchise=None) -> dict:
    w_skill = writer["skill"] if writer else clamp(rnd.gauss(42, 20), 5, 95)
    if writer:
        genre = genre or rnd.choice([writer["genre"], writer["genre"], writer["genre2"]])
    else:
        genre = genre or rnd.choice(C.GENRES)
    subs = [s for s, v in C.SUBGENRES.items()
            if v["genre"] == genre and v["from_year"] <= year <= v["to_year"]]
    sub = rnd.choice(subs) if subs else None
    heat = (trends or {}).get(genre, 1.0)
    q = clamp(rnd.gauss(w_skill * 0.72 + 6, 11) + quality_bias
              + (4 if sub else 0), 2, 99)
    fp = clamp(rnd.gauss(18, 16) + q * 0.28 + (C.SUBGENRES[sub]["fp"] if sub else 0)
               + (25 if origin in ("remake", "reboot") else 0), 0, 100)
    if scale is None:
        u = rnd.random()
        scale = ("short" if u < 0.08 else "indie" if u < 0.30 else
                 "standard" if u < 0.82 else "epic" if u < 0.95 else "blockbuster")
    std = C.standard_cost(year)
    price = std * (0.03 + 0.10 * (q / 100) ** 2.0) * C.SCALES[scale]["mult"] * (0.75 + 0.5 * heat)
    return dict(title=(franchise["name"] if (franchise and origin == "remake") else N.movie_title(rnd, genre)),
                genre=genre, subgenre=sub, scale=scale, quality=round(q, 1),
                fp=int(fp), writer_id=(writer["id"] if writer else None),
                price=round(price, 0), option_price=round(price * 0.22, 0),
                created_year=year, origin=origin,
                source_franchise=(franchise["id"] if franchise and origin in ("remake", "reboot") else None),
                tags=",".join([t for t in [sub, scale] if t]))


def new_world(db, name: str, start_year: int, preset: str, seed: int,
              actors: int = 4200):
    """Create a whole playable universe.  Returns nothing; everything is in db."""
    bind_log_db(db)
    rnd = stream(seed, "bootstrap", name, start_year)
    # START_CASH is tuned for a 1928 start; every other start gets the same
    # number of pictures' worth of money in that era's dollars (a flat $6M
    # could not pay for one 1977 picture, and was a fortune in 1910)
    era = C.standard_cost(start_year) / C.standard_cost(1928)
    cash = round(C.START_CASH.get(preset, C.START_CASH["studio"]) * 1_000_000.0 * era, -3)
    db.execute("""INSERT OR REPLACE INTO game(id,name,seed,start_year,year,week,cash,prestige,
                  reputation,valuation,speed,over,stats,created)
                  VALUES(1,?,?,?,?,?,?,0,0,0,0,0,?,0)""",
               (name, seed, start_year, start_year, 0, cash, json.dumps({
                   "preset": preset, "releases": 0, "hits": 0, "flops": 0,
                   "cult": 0, "awards": 0, "ip_sold": 0, "ip_value_sold": 0.0})))

    # trends
    for g in C.GENRES:
        bias = C.bias_for(start_year, g)
        db.execute("INSERT OR REPLACE INTO trends(genre,heat,drift) VALUES(?,?,?)",
                   (g, clamp(1.0 + bias, 0.3, 2.0), bias * 0.2))
    # tech
    for t in C.TECH:
        unlocked = 1 if start_year >= t["year"] else 0
        db.execute("INSERT OR REPLACE INTO tech(id,label,year,unlocked,unlocked_year) VALUES(?,?,?,?,?)",
                   (t["id"], t["label"], t["year"], unlocked, start_year if unlocked else None))

    # ---- actors
    rows = []
    for i in range(actors):
        a = make_actor(rnd, start_year)
        a["r"] = (derive(seed, "actorlcg", i) % (1 << 31)) or 1
        rows.append(a)
    db.executemany(ACTOR_INSERT, [_actor_defaults(r) for r in rows])
    std = C.standard_cost(start_year)

    # A firmament for the era. Every decade of film history has about fifty
    # names on every marquee; we guarantee them instead of hoping the dice
    # hand them out, then price them like the gold they are.
    db.execute("""UPDATE actors SET fame = MAX(fame, 62 + (r % 30)), status='star'
                  WHERE id IN (SELECT id FROM actors
                               WHERE status IN ('available','working','star')
                                 AND age BETWEEN 24 AND 58
                               ORDER BY star_power DESC, fame DESC LIMIT 70)""")
    db.execute("""UPDATE actors SET fame = MAX(fame, 24 + (r % 24)), status='working'
                  WHERE id IN (SELECT id FROM actors WHERE status='available'
                                 AND age BETWEEN 19 AND 55
                               ORDER BY craft DESC, fame DESC LIMIT 360)""")
    db.execute("""UPDATE actors SET fee = ? * (0.030 + 0.16 * POW(fame / 100.0, 1.8))
                  WHERE status IN ('available','working','star')""", (std,))
    db.commit()

    # ---- writers / directors
    db.executemany("""INSERT INTO writers(name,skill,genre,genre2,fee,salary,weeks_per_script,
                       ego,drink,awards,status,studio,busy_until,scripts_written,best_picture,r)
                       VALUES(:name,:skill,:genre,:genre2,:fee,:salary,:weeks_per_script,
                       :ego,:drink,0,'market',NULL,-1,0,NULL,:r)""",
                   [make_writer(rnd, start_year) for _ in range(220)])
    db.executemany("""INSERT INTO directors(name,vision,discipline,temperament,prestige,fee,
                       status,studio,busy_until,hits,r)
                       VALUES(:name,:vision,:discipline,:temperament,:prestige,:fee,
                       'market',NULL,-1,0,:r)""",
                   [make_director(rnd, start_year) for _ in range(110)])

    # ---- rivals
    rn = list(C.RIVAL_NAMES)
    rnd.shuffle(rn)
    db.executemany("""INSERT INTO rivals(name,cash,prestige,aggression,appetite,alive,films,gross,ip)
                      VALUES(?,?,?,0.5,0.5,1,0,0,0)""",
                   [(rn[i], (2.0 + rnd.random() * 8.0) * C.standard_cost(start_year) * 3,
                     rnd.uniform(2, 25)) for i in range(C.RIVAL_COUNT)])

    # ---- starting script market
    trends = {g: h for g, h in db.q("SELECT genre,heat FROM trends")}
    srows = []
    for _ in range(46):
        s = make_script(rnd, start_year, trends=trends)
        srows.append((s["title"], s["genre"], s["subgenre"], s["scale"], s["quality"], s["fp"],
                      s["writer_id"], "market", "market", s["price"], s["option_price"],
                      start_year, s["origin"], s["source_franchise"], s["tags"]))
    db.executemany("""INSERT INTO scripts(title,genre,subgenre,scale,quality,fp,writer_id,owner,status,
                       price,option_price,created_year,coverage,coverage_pm,developed,origin,
                       source_franchise,tags) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,0,?,?,?)""", srows)

    # ---- starter buildings & loan line
    db.execute("INSERT OR REPLACE INTO buildings(kind,label,count) VALUES('stage','Sound Stage',1)")
    db.execute("INSERT OR REPLACE INTO buildings(kind,label,count) VALUES('casting_office','Casting Office',1)")

    db.execute("""INSERT INTO year_stats(year,releases,gross,net,profit,cash,valuation,prestige,reputation)
                  VALUES(?,0,0,0,0,?,0,0,0)""", (start_year, cash))
    log(start_year, 0, "world", f"{name} opens its gates",
        f"The lot has one stage, a casting office and {cash/1e6:.1f}M in the bank. "
        f"Hire writers, buy scripts, cast pictures, and build an empire.")
    db.commit()


# The app runs one save at a time, so the history log binds to a single DB.
_LOG_DB = None


def bind_log_db(db):
    global _LOG_DB
    _LOG_DB = db
    N.bind_titles(db)          # and the title bag belongs to the same world


def log(year, week, kind, title, text="", weight=1):
    if _LOG_DB is None:
        return
    _LOG_DB.execute("INSERT INTO event_log(year,week,kind,title,text,weight) VALUES(?,?,?,?,?,?)",
                    (year, week, kind, title, text, weight))
    # world and industry news also goes in the paper
    section = {"world": "world", "industry": "world", "offer": "business"}.get(kind)
    if section and not str(title).startswith("Milestone") and not (kind == "world" and str(title).isdigit()):
        start = _LOG_DB.scalar("SELECT start_year FROM game WHERE id=1", (), None)
        if start is not None:
            _LOG_DB.execute("""INSERT INTO news(year,week,abs_week,section,headline,body,weight,mine)
                               VALUES(?,?,?,?,?,?,?,0)""",
                            (year, week, (year - start) * 52 + week, section, title, text or "",
                             int(weight)))
