"""Characters: the people on the poster, owned as IP apart from any one series.

A series is a run of pictures; a character is who audiences come back for.
Characters carry their own fan base, which survives reboots, recasts and a
move to another series:

* every series gets its characters from the picture that started it (the
  leads, and the best-liked supporting parts)
* a supporting part that keeps stealing the picture builds "breakout" and
  can be spun off into a series of its own - the character leaves home
* a team-up puts characters from different series in one picture: it pools
  their fans (and the risk), then feeds the result back to every series
* a character who survives into a second life - a reboot, a spin-off, a
  recast - and stays loved becomes an icon: icons barely fade, reboot well,
  shrug off recasting, and earn licensing money every year

Rights follow the character's home series: sell the series and its
characters go with it.
"""
from __future__ import annotations

import json

from .. import config as C
from .. import names as N
from .. import universe
from ..rng import clamp, stream

# icon: a second life (or a second face) and an audience that stayed
ICON_LIVES = 2
ICON_MIN_FILMS = 5
ICON_MIN_PEAK = 70.0
BREAKOUT_SPINOFF = 1.0        # one standout supporting turn is enough to try
SPINOFF_MIN_FAN = 30.0
TEAMUP_MIN_FAN = 15.0
TEAMUP_MAX = 6

CHAR_FIRST_M = ["Jack", "Nick", "Sam", "Frank", "Eli", "Max", "Leo", "Cole", "Rafe", "Dex",
                "Gideon", "Silas", "Abel", "Hank", "Reuben", "Otto", "Wes", "Jonah", "Ezra", "Milo"]
CHAR_FIRST_F = ["Kit", "Nora", "Tess", "Vera", "Ruby", "Lena", "Mara", "Ada", "Juno", "Iris",
                "Lou", "Della", "Wren", "Hattie", "Opal", "Sadie", "Cleo", "Margo", "Pearl", "Zia"]
CHAR_LAST = ["Kessler", "Drake", "Calder", "Mercer", "Stroud", "Vantage", "Hollis", "Larkin",
             "Crowe", "Ashby", "Blackwood", "Quill", "Rook", "Sorensen", "Tannery", "Valance",
             "Wilder", "Fairweather", "Gallow", "Harker", "Ingram", "Juniper", "Kincaid", "Lockhart"]
CODE_TITLE = ["Captain", "Doctor", "Agent", "Professor", "Major", "Madame", "Lady", "Mister",
              "Commander", "Sister"]
CODE_A = ["Night", "Iron", "Silver", "Crimson", "Storm", "Ember", "Frost", "Shadow", "Star",
          "Thunder", "Ivory", "Copper", "Neon", "Ash", "Hollow", "Golden"]
CODE_B = ["Warden", "Falcon", "Lantern", "Sentinel", "Comet", "Vixen", "Ranger", "Wraith",
          "Marshal", "Phantom", "Harrier", "Mantis", "Specter", "Kestrel", "Paladin", "Tempest"]
TEAM_WORD = ["Alliance", "League", "Legion", "Syndicate", "Guard", "Assembly", "Union", "Company"]

CODENAME_GENRES = {"action": 0.30, "sci-fi": 0.45, "animation": 0.35, "horror": 0.12,
                   "western": 0.08, "crime": 0.06}


def _gender_of(role_gender, rnd):
    return role_gender if role_gender in ("m", "f") else rnd.choice(["m", "f"])


def name_for(rnd, genre: str, gender: str, taken=()) -> str:
    for _ in range(12):
        if rnd.random() < CODENAME_GENRES.get(genre, 0.0):
            r = rnd.random()
            if r < 0.45:
                nm = f"{rnd.choice(CODE_TITLE)} {rnd.choice(CODE_A)}"
            elif r < 0.75:
                nm = f"The {rnd.choice(CODE_A)} {rnd.choice(CODE_B)}"
            else:
                nm = f"{rnd.choice(CODE_A)}{rnd.choice(CODE_B).lower()}"
        else:
            first = rnd.choice(CHAR_FIRST_F if gender == "f" else CHAR_FIRST_M)
            nm = f"{first} {rnd.choice(CHAR_LAST)}"
        if nm not in taken:
            return nm
    return f"{nm} {rnd.randint(2, 9)}"


def _taken(w):
    return {r["name"] for r in w.db.q("SELECT name FROM characters")}


# --------------------------------------------------------------------------- #
#  Lookups
# --------------------------------------------------------------------------- #
def get(w, cid):
    r = w.db.q1("SELECT * FROM characters WHERE id=?", (cid,))
    return dict(r) if r else None


def rights_of(w, ch) -> str:
    return w.db.scalar("SELECT rights FROM franchises WHERE id=?", (ch["franchise_id"],), "player")


def of_series(w, fid):
    """Characters whose home is this series, stars first."""
    return [dict(r) for r in w.db.q("""SELECT * FROM characters WHERE franchise_id=?
                                       ORDER BY role='lead' DESC, fan DESC""", (fid,))]


def universe_of(w, fid):
    return w.db.kv_get(f"universe:{fid}", None)


def _pool(values):
    """Fans of several characters together: the biggest counts in full, the
    rest less and less - a team-up's audience overlaps."""
    vals = sorted((max(0.0, v) for v in values), reverse=True)
    wts = [1.0, 0.6, 0.4, 0.3, 0.25, 0.2]
    return sum(v * wts[min(i, len(wts) - 1)] for i, v in enumerate(vals))


def _lives(w, cid) -> int:
    """Distinct lives on screen: each (series, continuity) a character has
    appeared in, not counting team-ups."""
    return int(w.db.scalar("""SELECT COUNT(*) FROM (SELECT DISTINCT franchise_id, continuity
                              FROM char_appearances WHERE character_id=? AND universe=0)""",
                           (cid,), 0) or 0)


def _continuity(w, fid) -> int:
    return int(w.db.scalar("SELECT continuity FROM franchises WHERE id=?", (fid,), 1) or 1)


# --------------------------------------------------------------------------- #
#  Birth: a series gets its characters from the picture that started it
# --------------------------------------------------------------------------- #
def ensure_for_franchise(w, fid):
    """Give a series its characters if it has none (new series, old saves)."""
    f = w.db.q1("SELECT * FROM franchises WHERE id=?", (fid,))
    if not f or (f["kind"] or "series") == "universe":
        return []
    if w.db.scalar("SELECT COUNT(*) FROM characters WHERE origin_franchise=? OR franchise_id=?",
                   (fid, fid), 0):
        return of_series(w, fid)
    root = f["root_movie_id"]
    if not root:
        return []
    cast = [dict(r) for r in w.db.q("""SELECT cm.*, a.gender, a.name AS actor_name FROM cast_members cm
                                       JOIN actors a ON a.id=cm.actor_id WHERE cm.movie_id=?
                                       ORDER BY cm.kind IN ('lead','voice') DESC, cm.perf DESC,
                                       cm.fee DESC""", (root,))]
    if not cast:
        return []
    leads = [c for c in cast if c["kind"] in ("lead", "voice")][:2]
    sups = [c for c in cast if c["kind"] == "supporting"][:2]
    rnd = stream(w.seed, "chars", fid)
    taken = _taken(w)
    fan = f["fan_base"] or 0.0
    m = w.db.q1("SELECT year FROM movies WHERE id=?", (root,))
    yr = m["year"] if m else w.year
    made = []
    for c in leads + sups:
        lead = c["kind"] in ("lead", "voice")
        g = c.get("gender") or "m"
        nm = name_for(rnd, f["genre"], g, taken)
        taken.add(nm)
        standout = c.get("grade") == "Standout"
        cfan = fan * (0.70 if lead else 0.22) + (6.0 if standout else 0.0)
        cur = w.db.execute("""INSERT INTO characters(name,franchise_id,origin_franchise,genre,gender,role,
                         fan,peak,appearances,actor_id,actors,breakout,created_year,last_year)
                         VALUES(?,?,?,?,?,?,?,?,0,?,1,?,?,?)""",
                           (nm, fid, fid, f["genre"], g, "lead" if lead else "supporting",
                            round(cfan, 1), round(cfan, 1), c["actor_id"],
                            (1.0 if standout and not lead else 0.0), yr, yr))
        cid = cur.lastrowid
        _rename_credit(w, root, c["actor_id"], c["role"], nm, cid)
        made.append(cid)
        # backfill: later pictures of the series where the same actor came back
        for mo in w.db.q("""SELECT mo.id FROM movies mo JOIN cast_members cm ON cm.movie_id=mo.id
                            WHERE mo.franchise_id=? AND cm.actor_id=? AND mo.id<>?""",
                         (fid, c["actor_id"], root)):
            _rename_credit(w, mo["id"], c["actor_id"], None, nm, cid)
    for cid in made:
        n = w.db.scalar("SELECT COUNT(*) FROM char_appearances WHERE character_id=?", (cid,), 0)
        last = w.db.scalar("SELECT MAX(year) FROM char_appearances WHERE character_id=?", (cid,), yr)
        w.db.execute("UPDATE characters SET appearances=?, last_year=? WHERE id=?", (n, last, cid))
    return of_series(w, fid)


def _rename_credit(w, mid, actor_id, old_role, new_name, cid):
    """Put the character's name on the credit (and log the appearance)."""
    mo = w.db.q1("SELECT * FROM movies WHERE id=?", (mid,))
    if not mo:
        return
    cm = w.db.q1("SELECT * FROM cast_members WHERE movie_id=? AND actor_id=?", (mid, actor_id))
    if not cm:
        return
    w.db.execute("UPDATE cast_members SET role=?, character_id=? WHERE movie_id=? AND actor_id=?",
                 (new_name, cid, mid, actor_id))
    try:
        cast = json.loads(mo["cast"] or "[]")
        for c in cast:
            if c.get("id") == actor_id:
                c["role"] = new_name
        w.db.execute("UPDATE movies SET cast=? WHERE id=?", (json.dumps(cast), mid))
    except Exception:
        pass
    cont = _continuity_at(w, mo["franchise_id"], mo["year"]) if mo["franchise_id"] else 1
    w.db.execute("""INSERT OR IGNORE INTO char_appearances(character_id,movie_id,actor_id,year,
                    franchise_id,continuity,kind,universe) VALUES(?,?,?,?,?,?,?,0)""",
                 (cid, mid, actor_id, mo["year"], mo["franchise_id"], cont, cm["kind"]))


def _continuity_at(w, fid, year):
    """Which continuity a picture of this series in `year` belonged to."""
    if not fid:
        return 1
    hist = w.db.kv_get(f"continuities:{fid}", None) or []
    c = 1
    for y in hist:
        if year >= y:
            c += 1
    return c


def note_reboot(w, fid):
    """franchise.launch calls this when a reboot is greenlit."""
    hist = list(w.db.kv_get(f"continuities:{fid}", None) or [])
    hist.append(w.year)
    w.db.kv_set(f"continuities:{fid}", hist)


# --------------------------------------------------------------------------- #
#  Putting characters into a production's parts
# --------------------------------------------------------------------------- #
def bind_roles(w, pid, fid):
    """Name the parts of a series picture after its characters. A team-up
    gets one starring part per character."""
    f = w.db.q1("SELECT * FROM franchises WHERE id=?", (fid,))
    if not f:
        return
    if (f["kind"] or "series") == "universe":
        return _bind_universe(w, pid, f)
    chars = ensure_for_franchise(w, fid)
    if not chars:
        return
    roles = [dict(r) for r in w.db.q("SELECT * FROM roles WHERE production_id=? ORDER BY idx", (pid,))]
    lead_roles = [r for r in roles if r["kind"] in ("lead", "voice")]
    sup_roles = [r for r in roles if r["kind"] == "supporting"]
    leads = [c for c in chars if c["role"] == "lead"]
    sups = [c for c in chars if c["role"] != "lead"]
    # stars take the starring parts; anyone left over (a third lead, the
    # supporting regulars) takes a supporting part, keeping one part open for
    # a newcomer who might break out
    pairs = list(zip(lead_roles, leads))
    rest = leads[len(lead_roles):] + sups
    pairs += list(zip(sup_roles[:max(0, len(sup_roles) - 1)], rest))
    for r, c in pairs:
        w.db.execute("""UPDATE roles SET name=?, character_id=?, gender=?, min_age=MIN(min_age,18),
                        max_age=MAX(max_age,75) WHERE id=?""",
                     (c["name"], c["id"], c["gender"] if c["gender"] in ("m", "f") else r["gender"], r["id"]))


def _bind_universe(w, pid, f):
    u = universe_of(w, f["id"]) or {}
    chars = [c for c in (get(w, i) for i in u.get("chars", [])) if c and rights_of(w, c) == "player"]
    if not chars:
        return
    roles = [dict(r) for r in w.db.q("SELECT * FROM roles WHERE production_id=? ORDER BY idx", (pid,))]
    base = next((r for r in roles if r["kind"] in ("lead", "voice")), roles[0] if roles else None)
    if not base:
        return
    sups = [r for r in roles if r["kind"] == "supporting"][:2]
    cameos = [r for r in roles if r["kind"] == "cameo"]
    w.db.execute("DELETE FROM roles WHERE production_id=?", (pid,))
    n = len(chars)
    rows = []
    for i, c in enumerate(chars):
        rows.append((pid, i, c["name"], base["kind"], base["skill"], round(0.80 / n, 4), base["min_skill"],
                     18, 75, c["gender"] if c["gender"] in ("m", "f") else "any",
                     base["want_stunts"], base["want_dance"], base["want_voice"], c["id"]))
    for j, r in enumerate(sups + cameos):
        rows.append((pid, n + j, r["name"], r["kind"], r["skill"], round(0.20 / max(1, len(sups) + len(cameos)), 4),
                     r["min_skill"], r["min_age"], r["max_age"], r["gender"], r["want_stunts"],
                     r["want_dance"], r["want_voice"], None))
    w.db.executemany("""INSERT INTO roles(production_id,idx,name,kind,skill,weight,min_skill,min_age,
                        max_age,gender,want_stunts,want_dance,want_voice,character_id)
                        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", rows)


def portrayer(w, role) -> dict | None:
    """The actor audiences know in this part, if the part is a character."""
    cid = role.get("character_id") if isinstance(role, dict) else role["character_id"]
    if not cid:
        return None
    c = get(w, cid)
    if not c or not c["actor_id"]:
        return None
    return dict(actor_id=c["actor_id"], films=c["appearances"], icon=bool(c["icon"]))


# --------------------------------------------------------------------------- #
#  The box office: what the characters on the poster are worth
# --------------------------------------------------------------------------- #
def fan_effect(w, p, comp, franchise, is_reboot: bool) -> dict:
    """Multiplier on top of the series fan effect, from the characters in the
    picture. Sequels gain a little; reboots keep the characters' fans even
    though the series' own audience has gone; team-ups pool everybody."""
    out = dict(mult=1.0, icons=0, chars=0, pool=0.0, note="")
    if not franchise:
        return out
    cids = [r.get("character_id") for r in comp["roles"] if r.get("character_id") and r.get("actor_id")]
    chars = [c for c in (get(w, i) for i in cids) if c]
    if not chars:
        return out
    out["chars"] = len(chars)
    out["icons"] = sum(1 for c in chars if c["icon"])
    pool = _pool([c["fan"] for c in chars])
    out["pool"] = pool
    heat = clamp(franchise["heat"], 0.3, 1.7)
    F = franchise["fan_base"] or 0.0
    kind = franchise["kind"] or "series"
    if kind == "universe":
        u = universe_of(w, franchise["id"]) or {}
        series_fans = [w.db.scalar("SELECT fan_base FROM franchises WHERE id=?", (c["franchise_id"],), 0) or 0
                       for c in chars]
        member = _pool([max(a, b) for a, b in zip(series_fans, [c["fan"] for c in chars])])
        # the novelty of seeing them together wears off: each team-up in the
        # run draws less on the members' own audiences
        member *= max(0.45, 1.0 - 0.06 * (franchise["installments"] or 0))
        eff = max(F, member)
        n_series = len({c["franchise_id"] for c in chars})
        event = 1.0 + min(0.25, 0.07 * max(0, n_series - 1))
        out["mult"] = C.fan_mult(eff * heat) / C.fan_mult(F * heat) * event
        out["note"] = f"team-up of {len(chars)} characters from {n_series} series"
        u["last_pool"] = round(member, 1)
        w.db.kv_set(f"universe:{franchise['id']}", u)
    elif is_reboot:
        eff = max(F, 0.8 * pool)
        out["mult"] = C.fan_mult(eff * heat) / C.fan_mult(F * heat)
        if out["icons"]:
            out["mult"] *= 1.10
            out["note"] = "an icon returns"
    else:
        eff = F + 0.15 * max(0.0, pool - F)
        out["mult"] = C.fan_mult(eff * heat) / C.fan_mult(F * heat)
    return out


# --------------------------------------------------------------------------- #
#  After the release: fans, breakouts, icons
# --------------------------------------------------------------------------- #
GRADE_FAN = {"Standout": 6.0, "Strong": 2.0, "Fine": 0.0, "Weak": -3.0, "Miscast": -6.0}


def on_release(w, p, mid, comp, q, run, grades: dict, franchise, cult_classic=False):
    if not franchise:
        return
    kind = franchise["kind"] or "series"
    is_universe = kind == "universe"
    cont = _continuity(w, franchise["id"])
    rnd = stream(w.seed, "charrel", mid)
    taken = None
    for r in comp["roles"]:
        aid = r.get("actor_id")
        if not aid:
            continue
        cid = r.get("character_id")
        grade = grades.get(aid, "Fine")
        if not cid:
            # a supporting part in a series picture that steals the show
            # becomes a character of the series
            if is_universe or r["kind"] != "supporting" or grade != "Standout":
                continue
            taken = taken or _taken(w)
            nm = name_for(rnd, franchise["genre"], r.get("gender") if r.get("gender") in ("m", "f")
                          else _gender_of(r.get("gender"), rnd), taken)
            taken.add(nm)
            fan0 = 10.0 + q * 0.2 + (franchise["fan_base"] or 0) * 0.08
            cur = w.db.execute("""INSERT INTO characters(name,franchise_id,origin_franchise,genre,gender,role,
                             fan,peak,appearances,actor_id,actors,breakout,created_year,last_year)
                             VALUES(?,?,?,?,?,'supporting',?,?,0,?,1,1.0,?,?)""",
                               (nm, franchise["id"], franchise["id"], franchise["genre"],
                                r.get("gender") if r.get("gender") in ("m", "f") else "m",
                                round(fan0, 1), round(fan0, 1), aid, w.year, w.year))
            cid = cur.lastrowid
            _rename_credit(w, mid, aid, r["name"], nm, cid)
            _bump(w, cid, 0.0, grade)
            universe.log(w.year, w.week, "world", f"Breakout: {nm}",
                         f"A supporting part in {p['title']} stole the picture. Audiences want more of "
                         f"{nm} - a spin-off is on the table.", weight=2)
            continue
        c = get(w, cid)
        if not c:
            continue
        w.db.execute("UPDATE cast_members SET character_id=? WHERE movie_id=? AND actor_id=?", (cid, mid, aid))
        w.db.execute("""INSERT OR IGNORE INTO char_appearances(character_id,movie_id,actor_id,year,
                        franchise_id,continuity,kind,universe) VALUES(?,?,?,?,?,?,?,?)""",
                     (cid, mid, aid, w.year, franchise["id"], cont, r["kind"], 1 if is_universe else 0))
        fan = c["fan"]
        # like a series, a character wears out with overuse: every picture in
        # this continuity asks a little more of the audience, and two in a
        # row inside a couple of years asks a lot
        n_cont = int(w.db.scalar("""SELECT COUNT(*) FROM char_appearances WHERE character_id=?
                                    AND franchise_id=? AND continuity=? AND universe=0""",
                                 (cid, franchise["id"], cont), 0) or 0)
        gap = w.year - (c["last_year"] or w.year)
        # and anyone in three pictures inside four years is overexposed
        recent = int(w.db.scalar("""SELECT COUNT(*) FROM char_appearances WHERE character_id=?
                                    AND year > ?""", (cid, w.year - 4), 0) or 0)
        n_cont += 3 * max(0, recent - 2)
        grow = 0.84 + 0.18 * min(2.5, run)
        if grow > 1.0:
            grow = 1.0 + (grow - 1.0) * max(0.0, 1.0 - fan / 380.0)
        fan = (fan * grow + (q - 58) * 0.30 + (10.0 if cult_classic else 0.0)
               - 1.4 * n_cont - (5.0 if 0 < gap < 2 and c["appearances"] else 0.0))
        if is_universe:
            fan += 4.0 if run >= 1.5 else -4.0 if run < 0.8 else 0.0
        if aid != c["actor_id"]:
            # a new face: the audience takes a moment (icons barely notice)
            fan *= 0.97 if c["icon"] else 0.90
            w.db.execute("UPDATE characters SET actor_id=?, actors=actors+1 WHERE id=?", (aid, cid))
        breakout = 0.0
        if r["kind"] == "supporting" and c["role"] != "lead":
            breakout = 1.0 if grade == "Standout" else 0.4 if grade == "Strong" else 0.0
        _bump(w, cid, fan - c["fan"], grade, breakout)
    if is_universe:
        _feed_members(w, franchise, q, run)


def _bump(w, cid, delta, grade, breakout=0.0):
    c = get(w, cid)
    fan = clamp(c["fan"] + delta + GRADE_FAN.get(grade, 0.0), 0, 400)
    n = int(w.db.scalar("SELECT COUNT(*) FROM char_appearances WHERE character_id=?", (cid,), 0) or 0)
    w.db.execute("""UPDATE characters SET fan=?, peak=MAX(peak, ?), appearances=?, last_year=?,
                    breakout=breakout+? WHERE id=?""",
                 (round(fan, 1), round(fan, 1), n, w.year, breakout, cid))
    _check_icon(w, cid)


def _check_icon(w, cid):
    c = get(w, cid)
    if not c or c["icon"]:
        return
    lives = _lives(w, cid)
    # a second life on screen (a reboot or a series of their own), or a long
    # run that has survived several faces - the James Bond road
    span = w.year - (c["created_year"] or w.year)
    second_life = lives >= ICON_LIVES or ((c["actors"] or 1) >= 3 and c["appearances"] >= 10 and span >= 20)
    if second_life and c["appearances"] >= ICON_MIN_FILMS and c["peak"] >= ICON_MIN_PEAK and c["fan"] >= 45:
        w.db.execute("UPDATE characters SET icon=1, icon_year=? WHERE id=?", (w.year, cid))
        owner = rights_of(w, c)
        mine = owner == "player"
        universe.log(w.year, w.week, "world", f"{c['name']} is an icon",
                     f"{c['appearances']} pictures, {lives} {'life' if lives == 1 else 'lives'} on screen and "
                     f"{c['actors']} {'face' if c['actors'] == 1 else 'faces'}. Bigger than any one series now"
                     + (" - and yours." if mine else f", and {owner} owns them."), weight=3 if mine else 2)
        from . import press
        press.add(w, "world", f"{c['name']} joins the pantheon",
                  f"Audiences no longer care who plays {c['name']} - only that someone does.",
                  weight=2, mine=1 if mine else 0)


def _feed_members(w, uf, q, run):
    """A team-up hands its audience back to every series that fed it."""
    u = universe_of(w, uf["id"]) or {}
    boost = clamp((run - 1.0) * 6.0 + (q - 60) * 0.25, -20.0, 15.0)
    for fid in set(u.get("series", [])):
        f = w.db.q1("SELECT * FROM franchises WHERE id=? AND rights='player'", (fid,))
        if not f:
            continue
        gain = boost * max(0.0, 1.0 - f["fan_base"] / 420.0) if boost > 0 else boost
        fan = f["fan_base"] * (0.90 if run < 0.8 else 1.0) + gain
        w.db.execute("UPDATE franchises SET fan_base=? WHERE id=?", (clamp(fan, 5, 420), fid))


# --------------------------------------------------------------------------- #
#  Every year: fading, and licensing for icons
# --------------------------------------------------------------------------- #
def yearly(w):
    std = C.standard_cost(w.year)
    lic = 0.0
    names = []
    for c in w.db.q("SELECT c.*, f.rights FROM characters c LEFT JOIN franchises f ON f.id=c.franchise_id"):
        idle = w.year - (c["last_year"] or w.year)
        if c["icon"]:
            k = 0.99
        else:
            k = 0.96 if idle <= 4 else 0.93
        w.db.execute("UPDATE characters SET fan=? WHERE id=?", (round(max(0.0, c["fan"] * k), 1), c["id"]))
        if c["icon"] and c["rights"] == "player":
            # comics, toys, lunchboxes, the Saturday serial, the theme-park ride
            amt = std * 0.04 * c["fan"] / 100.0
            if amt > 0:
                lic += amt
                names.append(c["name"])
    if lic > 0:
        w.earn(lic, "licensing", "Character licensing: " + ", ".join(names[:4])
               + (f" +{len(names) - 4}" if len(names) > 4 else ""))
    return lic


# --------------------------------------------------------------------------- #
#  Spin-offs and team-ups (player actions)
# --------------------------------------------------------------------------- #
def can_spinoff(w, c) -> str | None:
    if not c:
        return "no such character"
    if rights_of(w, c) != "player":
        return "you do not own this character"
    if c["spun_off"]:
        return "already has a series of their own"
    home = w.db.q1("SELECT * FROM franchises WHERE id=?", (c["franchise_id"],))
    if c["role"] == "lead" and home and (home["kind"] or "series") != "universe":
        return "already leads their own series"
    if c["breakout"] < BREAKOUT_SPINOFF and c["fan"] < SPINOFF_MIN_FAN:
        return f"not enough of a following yet (fans {c['fan']:.0f}; a standout turn or {SPINOFF_MIN_FAN:.0f}+ fans)"
    return None


def spinoff(w, cid, name=None, **kw):
    from . import franchise as F
    c = get(w, cid)
    why = can_spinoff(w, c)
    if why:
        return dict(ok=False, error=why)
    home = w.db.q1("SELECT * FROM franchises WHERE id=?", (c["franchise_id"],))
    std = C.standard_cost(w.year)
    fee = std * 0.03
    if not w.can_afford(fee + std * 0.3):
        return dict(ok=False, error="not enough cash for the spin-off")
    w.spend(fee, "franchise", f"Spin-off rights work: {c['name']}")
    fan = c["fan"] * 0.9 + (home["fan_base"] or 0) * 0.15
    nm = (name or c["name"]).strip()[:60] or c["name"]
    cur = w.db.execute("""INSERT INTO franchises(name,root_movie_id,genre,fan_base,heat,continuity,installments,
                    last_year,created_year,status,rights,total_gross,total_net,note,kind,parent_id)
                    VALUES(?,NULL,?,?,?,1,0,?,?,'active','player',0,0,?,'spinoff',?)""",
                       (nm, home["genre"], round(fan, 1), home["heat"], w.year, w.year,
                        f"spun off from {home['name']}", home["id"]))
    nfid = cur.lastrowid
    w.db.execute("UPDATE characters SET franchise_id=?, role='lead', spun_off=1 WHERE id=?", (nfid, cid))
    res = F.launch(w, nfid, kind="sequel", **kw)
    if not res.get("ok"):
        # undo: the character goes home
        w.db.execute("UPDATE characters SET franchise_id=?, role=?, spun_off=0 WHERE id=?",
                     (home["id"], c["role"], cid))
        w.db.execute("DELETE FROM franchises WHERE id=?", (nfid,))
        w.earn(fee, "franchise", f"Spin-off called off: {c['name']}")
        return res
    universe.log(w.year, w.week, "finance", f"Spin-off: {nm}",
                 f"{c['name']} leaves {home['name']} for a series of their own. "
                 f"They bring about {fan:.0f} fans with them.", weight=3)
    res.update(franchise_id=nfid, series=nm)
    return res


def _team_name(w, chars, rnd):
    if len(chars) == 2:
        return f"{chars[0]['name']} & {chars[1]['name']}"
    return f"The {rnd.choice(CODE_A)} {rnd.choice(TEAM_WORD)}"


def teamup_options(w):
    rows = [dict(r) for r in w.db.q("""SELECT c.*, f.name AS series, f.rights, f.kind AS series_kind,
                                       a.name AS actor_name FROM characters c
                                       JOIN franchises f ON f.id=c.franchise_id
                                       LEFT JOIN actors a ON a.id=c.actor_id
                                       WHERE f.rights='player' AND c.fan >= ? ORDER BY c.fan DESC""",
                                    (TEAMUP_MIN_FAN,))]
    return rows


def teamup(w, char_ids, name=None, **kw):
    from . import franchise as F
    ids = []
    for i in char_ids or []:
        if i and int(i) not in ids:
            ids.append(int(i))
    chars = [get(w, i) for i in ids]
    if len(chars) < 2:
        return dict(ok=False, error="a team-up needs at least two characters")
    if len(chars) > TEAMUP_MAX:
        return dict(ok=False, error=f"at most {TEAMUP_MAX} characters - any more and nobody gets a scene")
    for c in chars:
        if not c or rights_of(w, c) != "player":
            return dict(ok=False, error="you must own every character in it")
        if c["fan"] < TEAMUP_MIN_FAN:
            return dict(ok=False, error=f"{c['name']} has too small a following to carry a team-up")
    series = sorted({c["franchise_id"] for c in chars})
    if len(series) < 2:
        return dict(ok=False, error="a team-up brings together characters from different series")
    rnd = stream(w.seed, "teamup", w.year, w.week, *ids)
    genres = [c["genre"] for c in chars]
    genre = max(set(genres), key=genres.count)
    member_fans = [max(c["fan"], w.db.scalar("SELECT fan_base FROM franchises WHERE id=?",
                                             (c["franchise_id"],), 0) or 0) for c in chars]
    fan = min(420.0, _pool(member_fans))
    heat = sum(w.db.scalar("SELECT heat FROM franchises WHERE id=?", (s,), 1.0) or 1.0 for s in series) / len(series)
    nm = (name or _team_name(w, chars, rnd)).strip()[:60]
    cur = w.db.execute("""INSERT INTO franchises(name,root_movie_id,genre,fan_base,heat,continuity,installments,
                    last_year,created_year,status,rights,total_gross,total_net,note,kind)
                    VALUES(?,NULL,?,?,?,1,0,?,?,'active','player',0,0,?,'universe')""",
                       (nm, genre, round(fan, 1), heat, w.year, w.year,
                        "team-up of " + ", ".join(c["name"] for c in chars)))
    ufid = cur.lastrowid
    w.db.kv_set(f"universe:{ufid}", dict(chars=ids, series=series))
    if not kw.get("scale"):
        kw["scale"] = "blockbuster" if (w.year >= 1975 and fan > 140) else "epic"
    res = F.launch(w, ufid, kind="sequel", **kw)
    if not res.get("ok"):
        w.db.execute("DELETE FROM franchises WHERE id=?", (ufid,))
        w.db.kv_set(f"universe:{ufid}", None)
        return res
    # a crowded picture is a hard picture to write
    crowd = max(0, len(chars) - 3) * 2.5
    if crowd:
        w.db.execute("""UPDATE scripts SET quality=MAX(10, quality-?) WHERE id=
                        (SELECT script_id FROM productions WHERE id=?)""", (crowd, res["id"]))
    universe.log(w.year, w.week, "finance", f"Team-up: {nm}",
                 f"{len(chars)} characters from {len(series)} series in one picture. "
                 f"A combined following of about {fan:.0f}. If it works, every series gains; "
                 "if it flops, they all pay.", weight=3)
    res.update(franchise_id=ufid, series=nm)
    return res


# --------------------------------------------------------------------------- #
#  Listings for the dashboard
# --------------------------------------------------------------------------- #
def _row(w, c):
    c = dict(c)
    c["lives"] = _lives(w, c["id"])
    c["can_spinoff"] = can_spinoff(w, c) is None
    c["spinoff_why"] = can_spinoff(w, c)
    a = w.db.q1("SELECT name, status FROM actors WHERE id=?", (c["actor_id"],)) if c["actor_id"] else None
    c["actor_name"] = a["name"] if a else None
    c["actor_dead"] = bool(a and a["status"] == "dead")
    c["series_name"] = w.db.scalar("SELECT name FROM franchises WHERE id=?", (c["franchise_id"],), "")
    c["origin_name"] = w.db.scalar("SELECT name FROM franchises WHERE id=?", (c["origin_franchise"],), "")
    c["teams"] = [r["name"] for r in w.db.q("""SELECT DISTINCT f.name FROM char_appearances ca
                     JOIN franchises f ON f.id=ca.franchise_id WHERE ca.character_id=? AND ca.universe=1""",
                                             (c["id"],))]
    return c


def for_series(w, fid):
    f = w.db.q1("SELECT * FROM franchises WHERE id=?", (fid,))
    if not f:
        return []
    if (f["kind"] or "series") == "universe":
        u = universe_of(w, fid) or {}
        return [_row(w, c) for c in (get(w, i) for i in u.get("chars", [])) if c]
    ensure_for_franchise(w, fid)
    return [_row(w, c) for c in of_series(w, fid)]


def all_rows(w, mine_only=True):
    sql = """SELECT c.* FROM characters c JOIN franchises f ON f.id=c.franchise_id"""
    if mine_only:
        sql += " WHERE f.rights='player'"
    sql += " ORDER BY c.icon DESC, c.fan DESC LIMIT 200"
    return [_row(w, c) for c in w.db.q(sql)]


def icons_in_town(w):
    return [_row(w, c) | dict(owner=rights_of(w, c)) for c in w.db.q(
        "SELECT * FROM characters WHERE icon=1 ORDER BY peak DESC LIMIT 40")]
