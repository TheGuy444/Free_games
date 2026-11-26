"""All tuning constants, content tables and era curves.

Money is in nominal dollars (floats).  Curves give *nominal* production cost and
nominal revenue-per-demand-unit for a year, so 1930s hits look small in dollars
(and are cheap to make) while modern blockbusters look enormous (and cost a
fortune) without any fudging in the sim itself.
"""
from __future__ import annotations

from math import sqrt

# --------------------------------------------------------------------------- #
#  Genres / skills
# --------------------------------------------------------------------------- #
GENRES = [
    "drama", "comedy", "action", "sci-fi", "horror",
    "western", "musical", "crime", "romance", "animation",
]
GENRE_LABEL = {g: g.replace("-", " ").title() for g in GENRES}
GENRE_LABEL["sci-fi"] = "Sci-Fi"

ACTOR_SKILLS = ["drama", "comedy", "action", "musicality", "dance", "voice", "stunts"]
ACTOR_TRAITS = ["charisma", "discipline", "versatility", "bankability",
                "ego", "scandal_prone", "substance_risk", "likeability", "press"]

# How much each acting skill matters for a genre (weights, auto-normalised)
GENRE_SKILL_WEIGHT = {
    "drama":     {"drama": 0.85, "comedy": 0.10, "action": 0.05},
    "comedy":    {"comedy": 0.80, "drama": 0.15, "voice": 0.05},
    "action":    {"action": 0.70, "drama": 0.18, "stunts": 0.35},
    "sci-fi":    {"action": 0.45, "drama": 0.35, "comedy": 0.10},
    "horror":    {"drama": 0.55, "action": 0.25, "comedy": 0.15},
    "western":   {"action": 0.50, "drama": 0.35, "stunts": 0.20},
    "musical":   {"musicality": 0.65, "dance": 0.55, "comedy": 0.25, "drama": 0.10},
    "crime":     {"drama": 0.65, "action": 0.35, "comedy": 0.10},
    "romance":   {"drama": 0.50, "comedy": 0.35, "musicality": 0.10},
    "animation": {"voice": 0.85, "comedy": 0.40, "musicality": 0.20},
}

# Subgenres: (genre, first year viable, heat modifier, franchise potential modifier)
SUBGENRES = {
    "silent spectacle":   dict(genre="drama",     from_year=1920, to_year=1931, fp=5),
    "screwball":          dict(genre="comedy",    from_year=1934, to_year=1955, fp=0),
    "pre-code glee":      dict(genre="comedy",    from_year=1929, to_year=1934, fp=0),
    "film noir":          dict(genre="crime",     from_year=1941, to_year=1962, fp=5),
    "heist":              dict(genre="crime",     from_year=1955, to_year=2030, fp=8),
    "detective":          dict(genre="crime",     from_year=1920, to_year=2030, fp=12),
    "epic":               dict(genre="drama",     from_year=1925, to_year=2030, fp=5),
    "war picture":        dict(genre="drama",     from_year=1925, to_year=2030, fp=0),
    "propaganda":         dict(genre="drama",     from_year=1939, to_year=1946, fp=0),
    "biopic":             dict(genre="drama",     from_year=1930, to_year=2030, fp=0),
    "stand-up picture":   dict(genre="comedy",    from_year=1960, to_year=2030, fp=5),
    "bro-movie":          dict(genre="comedy",    from_year=1985, to_year=2030, fp=8),
    "rom-com":            dict(genre="romance",   from_year=1990, to_year=2030, fp=0),
    "period romance":     dict(genre="romance",   from_year=1920, to_year=2030, fp=0),
    "sword & sandal":     dict(genre="action",    from_year=1925, to_year=1970, fp=5),
    "martial arts":       dict(genre="action",    from_year=1971, to_year=2030, fp=12),
    "spy thriller":       dict(genre="action",    from_year=1962, to_year=2030, fp=22),
    "disaster":           dict(genre="action",    from_year=1970, to_year=2005, fp=5),
    "superhero":          dict(genre="action",    from_year=1978, to_year=2030, fp=30),
    "buddy action":       dict(genre="action",    from_year=1975, to_year=2030, fp=12),
    "space opera":        dict(genre="sci-fi",    from_year=1936, to_year=2030, fp=28),
    "utopia/dystopia":    dict(genre="sci-fi",    from_year=1927, to_year=2030, fp=10),
    "monster movie":      dict(genre="horror",    from_year=1920, to_year=1975, fp=15),
    "gothic horror":      dict(genre="horror",    from_year=1920, to_year=1970, fp=10),
    "slasher":            dict(genre="horror",    from_year=1974, to_year=2030, fp=18),
    "supernatural":       dict(genre="horror",    from_year=1945, to_year=2030, fp=18),
    "found footage":      dict(genre="horror",    from_year=1999, to_year=2030, fp=8),
    "classical western":  dict(genre="western",   from_year=1920, to_year=1970, fp=8),
    "revisionist western": dict(genre="western",  from_year=1969, to_year=2010, fp=5),
    "backstage musical":  dict(genre="musical",   from_year=1929, to_year=1970, fp=5),
    "jukebox musical":    dict(genre="musical",   from_year=1998, to_year=2030, fp=8),
    "hand-drawn feature": dict(genre="animation", from_year=1937, to_year=2030, fp=20),
    "cgi feature":        dict(genre="animation", from_year=1995, to_year=2030, fp=32),
    "stop motion":        dict(genre="animation", from_year=1926, to_year=2030, fp=10),
}

SCALES = {  # production scale: cost & reach multipliers
    "short":       dict(mult=0.06, reach=0.12, weeks=(2, 4),  label="Short Subject"),
    "indie":       dict(mult=0.30, reach=0.45, weeks=(5, 9),  label="Indie"),
    "standard":    dict(mult=1.00, reach=1.00, weeks=(9, 16), label="Standard Feature"),
    "epic":        dict(mult=2.60, reach=2.10, weeks=(16, 26), label="Epic"),
    "blockbuster": dict(mult=6.20, reach=4.20, weeks=(20, 36), label="Blockbuster"),
}

# --------------------------------------------------------------------------- #
#  Upgrade categories (props, sets, VFX ...)
# --------------------------------------------------------------------------- #
UPGRADES = {
    "sets":          dict(label="Sets & Backlot",       base=0.16),
    "costumes":      dict(label="Costumes",             base=0.09),
    "props":         dict(label="Props",                base=0.07),
    "sfx":           dict(label="Special Effects",      base=0.13),
    "sound_stage":   dict(label="Sound Stage",          base=0.07),
    "score":         dict(label="Score & Sound",        base=0.08),
    "cinematography": dict(label="Cinematography",      base=0.11),
    "stunt_team":    dict(label="Stunt Team",           base=0.06),
    "marketing":     dict(label="Marketing & Prints",   base=0.23),
}
# tier craft value (index = tier) and cost as fraction of production budget
TIER_VALUE = [0, 6, 12, 19, 27, 36, 46]
TIER_COST = [0.0, 0.05, 0.11, 0.19, 0.30, 0.44, 0.62]
TIER_TECH = {  # category -> tier : required tech unlock
    "cinematography": {4: "colour", 6: "imax"},
    "sfx": {5: "colour", 6: "cgi"},
    "sound_stage": {2: "sound"},
    "score": {2: "sound"},
    "sets": {5: "widescreen"},
    "marketing": {4: "tv", 6: "streaming"},
}
# genre -> category weight (normalised at use time)
GENRE_UPGRADE_WEIGHT = {
    "drama":     dict(sets=0.8, costumes=0.8, props=1.0, sfx=0.3, sound_stage=0.9, score=0.9, cinematography=1.2, stunt_team=0.2, marketing=0.8),
    "comedy":    dict(sets=0.7, costumes=0.7, props=1.0, sfx=0.4, sound_stage=1.0, score=0.7, cinematography=0.8, stunt_team=0.4, marketing=1.3),
    "action":    dict(sets=1.0, costumes=0.6, props=0.8, sfx=1.6, sound_stage=0.8, score=1.0, cinematography=1.1, stunt_team=1.8, marketing=1.5),
    "sci-fi":    dict(sets=1.7, costumes=1.3, props=1.2, sfx=2.0, sound_stage=0.9, score=1.1, cinematography=1.3, stunt_team=1.0, marketing=1.5),
    "horror":    dict(sets=1.2, costumes=0.9, props=1.1, sfx=1.5, sound_stage=1.0, score=1.4, cinematography=1.1, stunt_team=0.5, marketing=1.0),
    "western":   dict(sets=1.4, costumes=1.3, props=1.3, sfx=0.8, sound_stage=0.7, score=0.9, cinematography=1.4, stunt_team=1.1, marketing=0.9),
    "musical":   dict(sets=1.4, costumes=1.4, props=0.7, sfx=0.7, sound_stage=1.6, score=1.8, cinematography=1.2, stunt_team=0.3, marketing=1.2),
    "crime":     dict(sets=1.0, costumes=0.9, props=1.1, sfx=1.0, sound_stage=0.9, score=0.9, cinematography=1.1, stunt_team=0.9, marketing=1.0),
    "romance":   dict(sets=0.9, costumes=1.1, props=0.9, sfx=0.3, sound_stage=0.9, score=1.2, cinematography=1.1, stunt_team=0.2, marketing=1.0),
    "animation": dict(sets=1.6, costumes=1.0, props=1.2, sfx=1.3, sound_stage=1.2, score=1.4, cinematography=1.3, stunt_team=0.2, marketing=1.4),
}

# --------------------------------------------------------------------------- #
#  Tech unlocks
# --------------------------------------------------------------------------- #
TECH = [
    dict(id="sound", label="Talking Pictures", year=1927, note="Silent films die. Music & score genres boom."),
    dict(id="colour", label="Colour Film", year=1935, note="Unlocks high craft tiers."),
    dict(id="widescreen", label="Widescreen", year=1952, note="Epics fight back against TV."),
    dict(id="tv", label="Television", year=1948, note="Structural attendance decline; TV licensing revenue."),
    dict(id="vhs", label="Home Video", year=1977, note="Huge secondary revenue line for the library."),
    dict(id="imax", label="Large Format", year=1970, note="Event-scale premium releases."),
    dict(id="dolby", label="Dolby Stereo", year=1977, note="Multichannel sound: a format choice for every picture."),
    dict(id="cgi", label="Computer Graphics", year=1990, note="Spectacle ceiling rockets; animation reborn."),
    dict(id="dvd", label="DVD", year=1997, note="Special Editions: the library sells all over again."),
    dict(id="digital", label="Digital Cinema", year=2002, note="Shoot without film stock; cheaper, then standard."),
    dict(id="streaming", label="Streaming", year=2007, note="Theatres weaken, library value up."),
]
TECH_YEAR = {t["id"]: t["year"] for t in TECH}

# --------------------------------------------------------------------------- #
#  Era curves  (nominal $ millions)
# --------------------------------------------------------------------------- #
# Attendance index (tickets sold vs 1948 peak) and average ticket price ($)
ATTENDANCE = [(1920, .30), (1930, .45), (1940, .68), (1948, 1.00), (1955, .62),
              (1960, .48), (1965, .40), (1970, .40), (1975, .50), (1980, .55),
              (1985, .58), (1990, .64), (1995, .70), (2000, .76), (2005, .80),
              (2010, .83), (2015, .85), (2019, .84), (2020, .42), (2022, .55),
              (2025, .58), (2030, .60)]
PRICE = [(1920, .25), (1930, .30), (1940, .30), (1950, .40), (1960, .52),
         (1970, .75), (1980, 1.55), (1990, 4.00), (2000, 5.40), (2010, 7.55),
         (2020, 9.25), (2030, 11.5)]
# Cost of a "standard" feature (all-in, $M)
STD_COST = [(1920, .18), (1930, .32), (1940, .55), (1950, 1.10), (1960, 2.20),
            (1970, 3.40), (1980, 9.00), (1990, 25.0), (2000, 45.0), (2010, 68.0),
            (2020, 90.0), (2030, 105.0)]


def interp(table, year):
    """Piecewise-linear interpolation over a [(year, value)] table."""
    if year <= table[0][0]:
        return table[0][1]
    if year >= table[-1][0]:
        return table[-1][1]
    for (y0, v0), (y1, v1) in zip(table, table[1:]):
        if y0 <= year <= y1:
            t = (year - y0) / (y1 - y0)
            return v0 + (v1 - v0) * t
    return table[-1][1]


def attendance_index(year):
    return interp(ATTENDANCE, year)


def ticket_price(year):
    return interp(PRICE, year)


def standard_cost(year):
    """Nominal cost in $ of one average studio feature this year."""
    return interp(STD_COST, year) * 1_000_000.0


def unit_revenue(year):
    """Nominal $ revenue per demand-unit (drives the gross formula)."""
    return attendance_index(year) * ticket_price(year)


# --------------------------------------------------------------------------- #
#  Box office model constants
# --------------------------------------------------------------------------- #
# gross = standard_cost * scale_reach * q_mult * star_mult * trend * mkt * hype
#         * fanbase * legs / difficulty(year)
# Tuned so that a mediocre picture roughly breaks even after the exhibitor's cut.
BASE_K = 1.75           # gross multiple of a standard picture's cost
QUALITY_PIVOT = 62.0    # quality at which the film neither helps nor hurts
QUALITY_EXP = 2.3
LEGS_MIN, LEGS_MAX = 0.68, 1.55

# How hard it is to get money out of theatres that year (1.0 = 1948 peak).
# TV collapse and the '70s are brutal; event pictures and home video compensate.
DIFFICULTY = [(1920, .85), (1930, .95), (1940, .90), (1948, 1.00), (1955, 1.30),
              (1960, 1.50), (1970, 1.55), (1975, 1.40), (1980, 1.30), (1985, 1.25),
              (1990, 1.15), (1995, 1.10), (2000, 1.05), (2010, 1.00), (2020, 1.30),
              (2030, 1.25)]


def difficulty(year):
    return interp(DIFFICULTY, year)


def quality_mult(q):
    return max(0.02, (q / QUALITY_PIVOT) ** QUALITY_EXP)


def star_mult(sp):
    return 0.52 + 0.86 * (max(0.0, min(100.0, sp)) / 100.0) ** 1.4


def marketing_mult(mkt, budget):
    base = max(1.0, 0.35 * budget)
    return min(1.80, 0.58 + 0.80 * (max(0.0, mkt) / base) ** 0.6)


def hype_mult(hype):
    return 0.85 + max(0.0, min(100.0, hype)) / 160.0


def fan_mult(fan_base):
    """A series opens with an audience already in the street - worth up to +35%."""
    return 1.0 + min(0.35, max(0.0, fan_base) / 420.0)

# --------------------------------------------------------------------------- #
#  Era decade biases (added into genre heat drift)
# --------------------------------------------------------------------------- #
DECADE_BIAS = {
    1920: dict(western=.35, comedy=.30, drama=.10, action=.05, horror=.05, animation=.15, musical=-.35, sci_fi=-.15),
    1930: dict(musical=.45, comedy=.35, drama=.20, horror=.30, western=.05, animation=.15),
    1940: dict(drama=.35, action=.10, musical=.30, horror=.10, comedy=.20, western=.05),
    1950: dict(sci_fi=.45, western=.35, musical=.30, drama=.10, horror=.10, comedy=.10),
    1960: dict(musical=.15, drama=.25, crime=.15, comedy=.10, western=.05, sci_fi=.10),
    1970: dict(action=.40, crime=.35, drama=.15, horror=.20, comedy=.15, sci_fi=.20, musical=-.25),
    1980: dict(action=.50, comedy=.35, sci_fi=.35, horror=.25, musical=-.15, animation=.05),
    1990: dict(action=.40, animation=.55, drama=.20, sci_fi=.30, comedy=.25, horror=.05),
    2000: dict(action=.50, sci_fi=.40, animation=.30, crime=.15, horror=.10, comedy=.10),
    2010: dict(action=.65, sci_fi=.45, animation=.25, horror=.15, drama=.05, musical=.05),
    2020: dict(action=.45, sci_fi=.35, horror=.25, animation=.25, drama=.05, comedy=.05),
}
# alias keys that appear in content tables but are not genres themselves
TREND_ALIAS = {"sci_fi": "sci-fi", "war_picture": "drama", "adventure": "action",
               "sci fi": "sci-fi"}


def norm_genre(k):
    """Map any content-table key to a real genre, or None if unknown."""
    g = TREND_ALIAS.get(k, k)
    return g if g in GENRES else None


def bias_for(year, genre):
    """Decade bias contribution for a genre in a given year."""
    d = DECADE_BIAS.get((year // 10) * 10, {})
    total = 0.0
    for k, v in d.items():
        if norm_genre(k) == genre:
            total += v
    return total


# --------------------------------------------------------------------------- #
#  Reception / outcome tiers
# --------------------------------------------------------------------------- #
# (min return-on-budget multiple, label, badge colour, reputation delta)
OUTCOMES = [
    (10.0, "PHENOMENON", "phenom", 22),
    (4.0,  "BLOCKBUSTER", "block", 14),
    (2.0,  "HIT", "hit", 7),
    (1.15, "SOLID", "solid", 2),
    (0.75, "TROUGH", "trough", -2),
    (0.40, "FLOP", "flop", -7),
    (0.0,  "STINKER", "stink", -14),
]

CULT = dict(
    min_run=0.04,          # gross/budget must be poor-ish...
    max_run=1.6,
    quality_hi=88,         # ...with either high craft (misunderstood)...
    quality_lo=14,         # ...or glorious garbage
    camp_floor=55,
)

EXHIBITOR_CUT = 0.50       # cinemas keep half
DISTRIBUTION_FEE = 0.06    # our distribution cost on gross
STUDIO_SHARE = 1 - EXHIBITOR_CUT - DISTRIBUTION_FEE  # ~0.44 of gross is ours

# Secondary revenue lines (share of gross or flat, gated by tech/era)
SECONDARY = dict(
    tv_license=dict(share=0.10, min_year=1952),
    home_video=dict(share=0.55, min_year=1978, ramp=6),   # grows over 6 yrs
    streaming=dict(share=0.30, min_year=2008),
    merch=dict(share=0.30, franchise_only=True),
    reissue=dict(share=0.12, every=10),                   # anniversary re-release
)

# --------------------------------------------------------------------------- #
#  Awards
# --------------------------------------------------------------------------- #
AWARD_CATEGORIES = [
    ("picture", "Best Picture"),
    ("director", "Best Director"),
    ("actor", "Best Actor"),
    ("actress", "Best Actress"),
    ("screenplay", "Best Screenplay"),
    ("craft", "Best Technical Achievement"),
]
# Award bodies. Every picture of the year - yours and the rivals' - is judged
# by the same rules; each body simply cares about different things.
#   weights: quality, critics, audience, tech (production values), spend
#   (budget + P&A), flash (box office), star (lead's star power)
#   campaign: how much "For Your Consideration" money moves it (0 = immune)
#   genre: points added or taken away by genre
AWARD_BODIES = [
    dict(id="academy", name="Silver Screen Academy", short="Academy", prestige=1.0,
         blurb="The big one. Serious pictures, strong reviews - and a campaign never hurts.",
         weights=dict(quality=0.40, critics=0.35, audience=0.10, tech=0.05, spend=0.10),
         campaign=1.0, genre=dict(drama=6, western=2, musical=2, crime=2, horror=-9,
                                  comedy=-6, animation=-7, **{"sci-fi": -3}),
         categories=[("picture", "Best Picture"), ("director", "Best Director"),
                     ("actor", "Best Actor"), ("actress", "Best Actress"),
                     ("screenplay", "Best Screenplay"), ("craft", "Best Technical Achievement")]),
    dict(id="critics", name="Circle of Film Critics", short="Critics' Circle", prestige=0.6,
         blurb="The reviewers vote. Money and marketing buy nothing here; bloat costs you.",
         weights=dict(quality=0.30, critics=0.62, audience=0.08, spend=-0.10),
         campaign=0.0, genre=dict(drama=3, crime=2, horror=-3),
         categories=[("critics:picture", "Best Film"), ("critics:director", "Best Director")]),
    dict(id="guild", name="Craft Guilds Gala", short="Craft Guilds", prestige=0.4,
         blurb="Cinematographers, designers and effects crews honour the work you can see on screen.",
         weights=dict(tech=0.55, quality=0.25, spend=0.20),
         campaign=0.2, genre=dict(musical=4, action=3, animation=4, western=2, **{"sci-fi": 5}),
         categories=[("guild:visuals", "Best Visual Achievement"),
                     ("guild:design", "Best Production Design")]),
    dict(id="people", name="People's Choice Marquee", short="People's Choice", prestige=0.3,
         blurb="Ticket buyers vote. Big, loud, starry and loved beats clever.",
         weights=dict(audience=0.45, flash=0.30, star=0.15, quality=0.10),
         campaign=0.4, genre=dict(action=4, comedy=4, animation=3, romance=2, **{"sci-fi": 3}),
         categories=[("people:picture", "Favourite Picture"), ("people:star", "Favourite Star")]),
]
AWARD_PRESTIGE = {"picture": 7, "director": 4, "screenplay": 3, "craft": 3, "actor": 4, "actress": 4,
                  "critics:picture": 4, "critics:director": 2, "guild:visuals": 2, "guild:design": 2,
                  "people:picture": 2, "people:star": 2}

RAZZIE_CATEGORIES = [("razzie_picture", "Golden Raspberry Worst Picture"),
                     ("razzie_actor", "Golden Raspberry Worst Performance")]

# --------------------------------------------------------------------------- #
#  Lot buildings
# --------------------------------------------------------------------------- #
BUILDINGS = {
    "stage":     dict(label="Sound Stage",       base=0.55, per_year=0.02, bonus=("production_values", 3), max=6,
                      note="+3 production values on your films, +1 concurrent shoot"),
    "backlot":   dict(label="Backlot Sets",      base=0.80, per_year=0.03, bonus=("sets", 6), max=5,
                      note="Sets built in-house: set upgrades 8% cheaper each, +4 production values"),
    "vfx_lab":   dict(label="Effects Lab",       base=1.20, per_year=0.04, bonus=("sfx", 8), max=5, tech="sound",
                      note="Effects upgrades 8% cheaper each, +5 production values"),
    "casting_office": dict(label="Casting Office", base=0.45, per_year=0.02, bonus=("casting", 12), max=3,
                      note="+12% open-call pool size & scout accuracy"),
    "writers_room": dict(label="Writers' Room",  base=0.50, per_year=0.02, bonus=("script", 6), max=4,
                      note="Staff writers 8% faster and better; sharper coverage; safer rewrites"),
    "marketing_dept": dict(label="Marketing Dept", base=0.60, per_year=0.02, bonus=("marketing", 10), max=4,
                      note="Every ad dollar works 10% harder"),
    "archive":   dict(label="Archive & IP Vault", base=0.70, per_year=0.01, bonus=("library", 10), max=4,
                      note="+10% library & franchise exploitation income"),
    "gym":       dict(label="Star Factory (Coach/Rehab)", base=0.40, per_year=0.02, bonus=("talent", 8), max=3,
                      note="Coaching 12% cheaper and better; on-set scandals and relapses 12% rarer"),
}

# --------------------------------------------------------------------------- #
#  World events
# --------------------------------------------------------------------------- #
# effects vocabulary is documented in DESIGN.md §12
EVENTS = [
    dict(id="great_depression", name="The Great Depression", kind="world",
         first=1929, last=1939, weight=6, weeks=210, severity=3,
         headline="Markets crash. Audiences seek cheap escape.",
         effects=dict(attendance_mult=0.72, cost_mult=0.85, credit_mult=2.2,
                      trend={"musical": 0.35, "comedy": 0.40, "horror": 0.20, "drama": -0.15})),
    dict(id="wwii", name="World War II", kind="world",
         first=1941, last=1946, weight=100, weeks=200, severity=5,
         headline="America at war: rations, the draft, and propaganda orders.",
         effects=dict(halt_chance=0.10, attendance_mult=0.90, cost_mult=1.20,
                      draft=0.12, salary_inflation=0.25,
                      trend={"war_picture": 0.5, "drama": 0.25, "horror": -0.25, "western": -0.15},
                      prestige_bonus_patriotic=0.25)),
    dict(id="actor_strike", name="Actors' Strike", kind="industry",
         first=1925, last=2030, weight=3.0, weeks=14, severity=4, repeatable=True,
         headline="The actors walk off every set in town. Filming stalls.",
         effects=dict(halt_production=True, salary_inflation=0.30, cost_mult=1.15),
         choices=[dict(id="settle", label="Settle at 22% raise", cost_mult=1.22, ends=True),
                  dict(id="defy", label="Defy the unions (risk 60% shutdown)", risk=0.60, ends=True)]),
    dict(id="writers_strike", name="Screenwriters' Strike", kind="industry",
         first=1960, last=2030, weight=3.0, weeks=16, severity=3, repeatable=True,
         headline="Writers downed their pens. The script market is empty.",
         effects=dict(script_supply_mult=0.15, salary_inflation=0.18),
         choices=[dict(id="settle", label="Sign the new residuals deal", cost_mult=1.15, ends=True),
                  dict(id="wait", label="Wait them out", risk=0.35, ends=True)]),
    dict(id="blacklist", name="Blacklist Hearings", kind="industry",
         first=1947, last=1960, weight=8, weeks=120, severity=4,
         headline="Hearings in Washington. Names are being read aloud.",
         effects=dict(actor_unavailable=0.05, script_supply_mult=0.75, prestige_mult=0.9,
                      trend={"drama": -0.10})),
    dict(id="antitrust", name="Antitrust Decree", kind="industry",
         first=1948, last=1950, weight=100, weeks=52, severity=5,
         headline="The Supreme Court breaks the studio-theatre pipeline.",
         effects=dict(revenue_mult=0.85, credit_mult=0.8)),
    dict(id="tv_arrival", name="The Television Boom", kind="world",
         first=1949, last=1962, weight=100, weeks=300, severity=4,
         headline="Sets are in every living room. Nobody is coming out.",
         effects=dict(attendance_mult=0.72, trend={"sci-fi": 0.30, "western": 0.25, "musical": 0.15},
                      unlock="tv")),
    dict(id="hays_code", name="Production Code Enforcement", kind="industry",
         first=1934, last=1966, weight=40, weeks=400, severity=2,
         headline="The Code office is cutting scenes and fining studios.",
         effects=dict(censor=1, trend={"romance": 0.10, "horror": -0.10}, hazard={"censor_cut": 2.2})),
    dict(id="new_hollywood", name="New Hollywood Wave", kind="industry",
         first=1967, last=1976, weight=70, weeks=260, severity=3,
         headline="Young auteur cinema eats the old system.",
         effects=dict(trend={"drama": 0.30, "crime": 0.30, "musical": -0.35, "western": -0.30},
                      prestige_mult=1.15)),
    dict(id="blockbuster_era", name="Dawn of the Blockbuster", kind="industry",
         first=1975, last=1985, weight=70, weeks=300, severity=3,
         headline="Wide releases and toy aisles: the blockbuster economy begins.",
         effects=dict(trend={"action": 0.45, "sci-fi": 0.35, "adventure": 0.30},
                      franchise_heat_mult=1.4, marketing_mult=1.2)),
    dict(id="recession80", name="Early-'80s Recession", kind="world",
         first=1980, last=1983, weight=45, weeks=110, severity=2,
         headline="Double-digit interest. Studios scramble for sure things.",
         effects=dict(attendance_mult=0.86, credit_mult=1.9, trend={"comedy": 0.20})),
    dict(id="vhs_boom", name="Home Video Boom", kind="industry",
         first=1978, last=1992, weight=100, weeks=300, severity=3,
         headline="The library is suddenly worth more than the release slate.",
         effects=dict(unlock="vhs", library_mult=1.6, trend={"horror": 0.25, "comedy": 0.15})),
    dict(id="cgi_rev", name="The CGI Revolution", kind="industry",
         first=1991, last=2000, weight=100, weeks=300, severity=3,
         headline="Computers on set. Spectacle is the new currency.",
         effects=dict(unlock="cgi", trend={"sci-fi": 0.35, "action": 0.30, "animation": 0.40},
                      cost_mult=1.15)),
    dict(id="streaming", name="The Streaming Wars", kind="industry",
         first=2008, last=2030, weight=100, weeks=500, severity=4,
         headline="Windows collapse. Libraries are bidding wars.",
         effects=dict(unlock="streaming", attendance_mult=0.85, library_mult=1.8,
                      trend={"drama": 0.15}, ip_demand_mult=1.5)),
    dict(id="pandemic", name="Pandemic Closures", kind="world",
         first=1918, last=2030, weight=2.2, weeks=40, severity=5, repeatable=True,
         headline="Cinemas shuttered by order of public health authorities.",
         effects=dict(halt_production=True, attendance_mult=0.50, cost_mult=1.10),
         choices=[dict(id="stream", label="Dump the slate to streaming (-35% gross, cash now)", special="stream_dump", ends=True),
                  dict(id="wait", label="Hold the slate for reopening", risk=0.45, ends=True)]),
    dict(id="backlot_fire", name="Backlot Fire", kind="local",
         first=1920, last=2030, weight=2.6, weeks=6, severity=2, repeatable=True,
         headline="Fire takes the backlot: sets and props destroyed.",
         effects=dict(hazard={"prop_fire": 4.0}, cost_mult=1.10)),
    dict(id="talent_poach", name="Talent Poaching War", kind="industry",
         first=1920, last=2030, weight=3.4, weeks=26, severity=2, repeatable=True,
         headline="Rivals are buying out contracts left and right.",
         effects=dict(salary_inflation=0.25, poach_chance=0.12)),
    dict(id="franchise_fatigue", name="Franchise Fatigue", kind="industry",
         first=1980, last=2030, weight=3.0, weeks=52, severity=2, repeatable=True,
         headline="Audiences shrug at the number 4.",
         effects=dict(franchise_heat_mult=0.65, trend={"action": -0.15})),
    dict(id="reboot_fatigue", name="Reboot Fatigue", kind="industry",
         first=1995, last=2030, weight=2.6, weeks=52, severity=2, repeatable=True,
         headline="Nothing but sequels, they say. Critics are sharpening knives.",
         effects=dict(reboot_penalty_mult=1.6, ip_demand_mult=0.8)),
    dict(id="star_death", name="Death of a Star", kind="local",
         first=1920, last=2030, weight=3.0, weeks=4, severity=3, repeatable=True,
         headline="A beloved star has died. The industry mourns, estates get rich.",
         effects=dict(posthumous_mult=1.5, hazard={"star_death": 3.0})),
    dict(id="merger", name="Conglomerate Merger Wave", kind="industry",
         first=1965, last=2030, weight=2.4, weeks=80, severity=2, repeatable=True,
         headline="Majors merge. IP is the only thing anyone wants to buy.",
         effects=dict(ip_demand_mult=1.7, credit_mult=1.3)),
    dict(id="foreign_boom", name="Global Market Explosion", kind="world",
         first=1990, last=2030, weight=3.0, weeks=200, severity=2, repeatable=True,
         headline="Overseas cinemas multiply. Spectacle travels best.",
         effects=dict(foreign_mult=1.45, trend={"action": 0.20, "sci-fi": 0.20, "comedy": -0.10})),
    dict(id="awards_scandal", name="Award-Season Scandal", kind="industry",
         first=1940, last=2030, weight=1.8, weeks=20, severity=2, repeatable=True,
         headline="Vote-buying allegations rock the Academy.",
         effects=dict(prestige_mult=0.85, campaign_mult=1.4)),
    dict(id="scandal_era", name="Studio Scandal Era", kind="industry",
         first=1920, last=1965, weight=2.6, weeks=60, severity=3, repeatable=True,
         headline="Morality panics. Stars are front-page scandals.",
         effects=dict(hazard={"scandal": 3.2}, prestige_mult=0.9, trend={"romance": -0.15})),
    dict(id="union_wages", name="Union Wage Demands", kind="industry",
         first=1933, last=2030, weight=3.0, weeks=30, severity=2, repeatable=True,
         headline="Craft unions win a stepped wage increase.",
         effects=dict(cost_mult=1.18, salary_inflation=0.15)),
]

# Production hazards: base weekly probability (before event modifiers & traits)
HAZARDS = {
    "injury":        dict(p=0.010, label="Injury on set", severity=8),
    "scandal":       dict(p=0.009, label="Star scandal in the press", severity=10),
    "overrun":       dict(p=0.020, label="Budget overrun", severity=6),
    "weather":       dict(p=0.012, label="Weather washout", severity=5),
    "director_feud": dict(p=0.007, label="Director/lead feud", severity=9),
    "censor_cut":    dict(p=0.003, label="Censor demands cuts", severity=7),
    "prop_fire":     dict(p=0.002, label="Props/set destroyed", severity=12),
    "lawsuit":       dict(p=0.004, label="Lawsuit filed", severity=8),
    "substance":     dict(p=0.006, label="Substance abuse relapse", severity=9),
    "poached":       dict(p=0.005, label="Star poached mid-shoot", severity=11),
    "star_death":    dict(p=0.0006, label="Fatal accident on set", severity=18),
    "slowdown":      dict(p=0.006, label="Union slowdown", severity=5),
}

# --------------------------------------------------------------------------- #
#  Talent / career constants
# --------------------------------------------------------------------------- #
FAME_DECAY = 0.935           # yearly fame decay toward 0
STAR_POWER_W = dict(fame=0.55, bankability=0.25, craft=0.20)
SALARY_F = 1.0               # fee = SALARY_F * star_power^1.55 * standard_cost * scale
SALARY_EXP = 1.55
FEE_MIN_FRAC = 0.006         # floor fee as fraction of a standard picture
CONTRACT_FILMS = [1, 2, 3, 5]
CONTRACT_DISCOUNT = {1: 0.95, 2: 0.86, 3: 0.78, 5: 0.66}

# discovery / open call
OPEN_CALL_COST_FRAC = 0.06   # fraction of a standard picture
OPEN_CALL_POOL = [12, 26, 44, 70]        # pool size by tier
OPEN_CALL_TIER_COST = [1.0, 2.4, 5.0, 9.0]
NEWCOMER_AGE = (16, 30)
GENERATIONAL_TALENT_P = 0.02

# Rival studios
# How keen the town is on series pictures, by era: the B-picture series of the
# 30s and 40s, the epics-and-originals 60s, the blockbuster sequel boom, and the
# franchise century. Chance a studio with a live series makes the next one.
SERIES_APPETITE = [(1920, 0.30), (1935, 0.45), (1948, 0.35), (1958, 0.22), (1968, 0.18),
                   (1978, 0.30), (1990, 0.38), (2003, 0.50), (2015, 0.60), (2030, 0.60)]

RIVAL_COUNT = 7
RIVAL_NAMES = ["Monarch Pictures", "Continental Studios", "Crimson Reel Co.",
               "Pacific-Paramount", "Babylon Films", "Vanguard Talking Pictures",
               "Coronet Productions", "Liberty Feature Corp.", "Nebula Media Group",
               "Sable & Sons"]

START_CASH = {
    "indie": 1.6,       # $M at 1920 scale (scaled by era)
    "studio": 6.0,
    "major": 22.0,
}


# --------------------------------------------------------------------------- #
#  Era labels (dashboard chrome)
# --------------------------------------------------------------------------- #
ERAS = [
    (1880, 1912, "Silent Dawn"),
    (1913, 1926, "Silent Empire"),
    (1927, 1938, "Coming of Sound"),
    (1939, 1949, "Golden Age"),
    (1950, 1959, "Widescreen Revolt"),
    (1960, 1974, "New Hollywood"),
    (1975, 1989, "Blockbuster Age"),
    (1990, 2006, "Franchise Century"),
    (2007, 2039, "Streaming Wars"),
]
