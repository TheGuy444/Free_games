"""Typecasting: what the town thinks an actor *is*.

Nobody starts with a label. Every credit puts experience into that picture's
genre; keep getting cast in Westerns and one morning the trades call you a
Cowboy. Actors can carry several labels at once, and the more they carry the
more "range" they have:

    0 labels  Unassigned   (a working actor, nothing sticks yet)
    1 label   Specialist
    2 labels  Versatile
    3+        Wide range

Labels matter on set: an actor plays their own label a little better
(``LABEL_FIT_BONUS``) and a wide-range actor is a little better at everything
else (``RANGE_FIT_BONUS``). See ``actors.fit_for_genre``.
"""
from __future__ import annotations

from .. import config as C
from ..rng import unit

XP_KIND = {"lead": 1.0, "voice": 1.0, "supporting": 0.6, "cameo": 0.3}
FIRST_XP, FIRST_SHARE = 2.5, 0.40         # the first label: "constantly in action"
MORE_XP, MORE_SHARE = 2.5, 0.22           # later labels: genuine range
KEEP_SHARE = 0.12                          # a label is dropped only below this
MAX_LABELS = 4
LABEL_FIT_BONUS = 3.0
RANGE_FIT_BONUS = 1.5

_LABEL = {
    "action": ("Action Star", "Action Star"),
    "comedy": ("Comedian", "Comedienne"),
    "drama": ("Dramatic Actor", "Dramatic Actress"),
    "horror": ("Scream King", "Scream Queen"),
    "western": ("Cowboy", "Cowgirl"),
    "musical": ("Song & Dance Man", "Song & Dance Star"),
    "crime": ("Tough Guy", "Femme Fatale"),
    "romance": ("Romantic Lead", "Romantic Lead"),
    "sci-fi": ("Sci-Fi Icon", "Sci-Fi Icon"),
    "animation": ("Voice Actor", "Voice Actress"),
}

# the skill each genre teaches by doing it
_TEACHES = {g: max(wts.items(), key=lambda kv: kv[1])[0] for g, wts in C.GENRE_SKILL_WEIGHT.items()}


def label_name(genre: str, gender: str = "m") -> str:
    pair = _LABEL.get(genre)
    if not pair:
        return genre
    return pair[1] if gender == "f" else pair[0]


def parse(labels) -> list:
    if not labels:
        return []
    if isinstance(labels, (list, tuple)):
        return list(labels)
    return [x for x in str(labels).split(",") if x]


def range_word(n: int) -> str:
    return {0: "Unassigned", 1: "Specialist", 2: "Versatile"}.get(n, "Wide range")


def describe(labels, gender="m") -> dict:
    ls = parse(labels)
    return dict(genres=ls, names=[label_name(g, gender) for g in ls],
                range=len(ls), range_word=range_word(len(ls)))


def fit_bonus(a, genre: str) -> float:
    ls = parse(a.get("labels") if hasattr(a, "get") else None)
    if not ls:
        return 0.0
    if genre in ls:
        return LABEL_FIT_BONUS
    return RANGE_FIT_BONUS if len(ls) >= 3 else 0.0


# --------------------------------------------------------------------------- #
#  Earning labels
# --------------------------------------------------------------------------- #
def _recompute(w, aid: int, versatility: float, old: list) -> list:
    rows = w.db.q("SELECT genre, xp FROM actor_genre WHERE actor_id=? ORDER BY xp DESC", (aid,))
    total = sum(r["xp"] for r in rows) or 0.0
    if total <= 0:
        return []
    more_share = MORE_SHARE - 0.08 * (versatility or 40) / 100.0
    out = []
    for r in rows:
        share = r["xp"] / total
        keep = r["genre"] in old and share >= KEEP_SHARE
        if not out:
            earn = r["xp"] >= FIRST_XP and share >= FIRST_SHARE
        else:
            earn = r["xp"] >= MORE_XP and share >= more_share
        if (keep or earn) and len(out) < MAX_LABELS:
            out.append(r["genre"])
    # an actor whose first label faded but still has others keeps the others
    return out


def credit(w, aid: int, genre: str, kind: str = "lead", standout: bool = False,
           news: bool = True, xp: float | None = None):
    """One more picture in `genre` on this actor's record. Returns the labels
    gained (genre ids) so callers can tell the story."""
    if not aid or genre not in C.GENRES:
        return []
    gain = XP_KIND.get(kind, 0.5) if xp is None else xp
    if standout:
        gain += 0.35
    lead = 1 if kind in ("lead", "voice") else 0
    w.db.execute("""INSERT INTO actor_genre(actor_id, genre, xp, films, leads) VALUES(?,?,?,1,?)
                    ON CONFLICT(actor_id, genre) DO UPDATE SET xp=xp+excluded.xp,
                    films=films+1, leads=leads+excluded.leads""", (aid, genre, gain, lead))
    # learning by doing: the genre's core skill creeps up
    skill = _TEACHES.get(genre)
    if skill:
        w.db.execute(f"UPDATE actors SET s_{skill}=MIN(99, s_{skill}+?), g_films=g_films+1 WHERE id=?",
                     (0.2 * gain, aid))
    return refresh(w, aid, news=news)


def refresh(w, aid: int, news: bool = True):
    a = w.db.q1("SELECT id,name,gender,fame,labels,t_versatility FROM actors WHERE id=?", (aid,))
    if not a:
        return []
    old = parse(a["labels"])
    new = _recompute(w, aid, a["t_versatility"], old)
    if new == old:
        return []
    w.db.execute("UPDATE actors SET labels=? WHERE id=?", (",".join(new), aid))
    gained = [g for g in new if g not in old]
    if gained and news and (a["fame"] or 0) >= 20:
        _announce(w, dict(a), old, new, gained)
    return gained


def _announce(w, a, old, new, gained):
    from . import press
    g = gained[0]
    name = a["name"]
    lab = label_name(g, a["gender"])
    if not old:
        head = f"{name} is becoming the town's go-to {lab}"
        body = (f"Picture after picture in {C.GENRE_LABEL[g].lower()}, and the casting offices "
                f"have noticed. {name} now reads as a {lab} - and plays one better than most.")
    else:
        names = ", ".join(label_name(x, a["gender"]) for x in new)
        head = f"{name} shows range"
        body = (f"Not just a {label_name(old[0], a['gender'])} any more: {name} is now billed as "
                f"{names}. Directors call it range; agents call it a raise.")
    press.add(w, "stars", head, body, actor_id=a["id"], weight=2 if (a["fame"] or 0) >= 50 else 1)


# --------------------------------------------------------------------------- #
#  Off-screen careers (rival pictures, loan-outs, the years before the game)
# --------------------------------------------------------------------------- #
def background(w, news: bool = False, limit: int | None = None):
    """Credits we did not watch happen: any film on an actor's record that is
    not in actor_genre yet is booked to the genres they are best suited for,
    split by how versatile they are. Runs yearly and once on a fresh save."""
    from . import actors as A
    rows = w.db.q(f"""SELECT * FROM actors WHERE films > g_films
                      AND status IN ('available','working','star','blacklisted','retired')
                      {'LIMIT %d' % int(limit) if limit else ''}""")
    if not rows:
        return 0
    ups = []
    for r in rows:
        a = dict(r)
        n = (a["films"] or 0) - (a["g_films"] or 0)
        if n <= 0:
            continue
        fits = sorted(((A.fit_for_genre(a, g, labels=False), g) for g in C.GENRES), reverse=True)
        vers = a.get("t_versatility") or 40
        cur = parse(a.get("labels"))
        main = cur[0] if cur and unit(w.seed, "bgmain", a["id"], w.year) < 0.7 else fits[0][1]
        second = next(g for _, g in fits if g != main)
        third = next(g for _, g in fits if g not in (main, second))
        s1 = max(0.40, 0.88 - 0.45 * vers / 100.0)
        s3 = 0.15 if vers > 68 else 0.0
        s2 = 1.0 - s1 - s3
        xp = n * 0.7
        for g, s in ((main, s1), (second, s2), (third, s3)):
            if s > 0:
                ups.append((a["id"], g, xp * s, max(0, round(n * s))))
    w.db.executemany("""INSERT INTO actor_genre(actor_id, genre, xp, films, leads) VALUES(?,?,?,?,0)
                        ON CONFLICT(actor_id, genre) DO UPDATE SET xp=xp+excluded.xp,
                        films=films+excluded.films""", ups)
    w.db.execute("UPDATE actors SET g_films=films WHERE films > g_films")
    for r in rows:
        refresh(w, r["id"], news=news)
    return len(rows)


def profile(w, aid: int) -> list:
    rows = w.db.q("SELECT genre, xp, films, leads FROM actor_genre WHERE actor_id=? ORDER BY xp DESC",
                  (aid,))
    total = sum(r["xp"] for r in rows) or 1.0
    return [dict(genre=r["genre"], label=C.GENRE_LABEL.get(r["genre"], r["genre"]),
                 xp=round(r["xp"], 1), films=r["films"], leads=r["leads"],
                 share=round(100 * r["xp"] / total)) for r in rows]
