"""World: the live game object wrapping the DB with cached scalar state."""
from __future__ import annotations

import json
import os
import time

from . import config as C
from .db import DB


class World:
    def __init__(self, db: DB):
        self.db = db
        from . import universe
        universe.bind_log_db(db)
        row = db.game()
        if row is None:
            raise RuntimeError("no game in this save")
        self._load(row)
        from .sim import engine
        engine.ensure_press(self)
        self._ensure_tech()

    def _ensure_tech(self):
        """Saves made before a technology existed in the game still get it."""
        for t in C.TECH:
            self.db.execute("""INSERT OR IGNORE INTO tech(id,label,year,unlocked,unlocked_year)
                               VALUES(?,?,?,?,?)""",
                            (t["id"], t["label"], t["year"], 1 if self.year >= t["year"] else 0,
                             t["year"] if self.year >= t["year"] else None))

    def log(self, kind, title, text="", weight=1):
        from . import universe
        universe.log(self.year, self.week, kind, title, text, weight)

    def _load(self, row):
        self.gid = row["id"]
        self.name = row["name"]
        self.seed = row["seed"]
        self.start_year = row["start_year"]
        self.year = row["year"]
        self.week = row["week"]
        self.cash = row["cash"]
        self.prestige = row["prestige"]
        self.reputation = row["reputation"]
        self.valuation = row["valuation"]
        self.speed = row["speed"]
        self.over = row["over"]
        try:
            self.stats = json.loads(row["stats"])
        except Exception:
            self.stats = {}

    # ---------------- time ----------------
    @property
    def abs_week(self) -> int:
        return (self.year - self.start_year) * 52 + self.week

    def tech_on(self, tid: str) -> bool:
        return self.db.scalar(
            "SELECT unlocked FROM tech WHERE id=?", (tid,), 0) == 1

    def tech_year(self, tid: str) -> int:
        return C.TECH_YEAR.get(tid, 0)

    def trend(self, genre: str) -> float:
        v = self.db.scalar("SELECT heat FROM trends WHERE genre=?", (genre,), 1.0)
        return v if v else 1.0

    def trends(self) -> dict:
        return {r["genre"]: r["heat"] for r in self.db.q("SELECT genre,heat FROM trends")}

    # ---------------- money ----------------
    def spend(self, amount: float, kind: str, label: str):
        if amount <= 0:
            return True
        self.cash -= amount
        self.db.execute("INSERT INTO ledger(year,week,kind,label,amount) VALUES(?,?,?,?,?)",
                        (self.year, self.week, kind, label, -amount))
        return True

    def earn(self, amount: float, kind: str, label: str):
        if amount == 0:
            return
        self.cash += amount
        self.db.execute("INSERT INTO ledger(year,week,kind,label,amount) VALUES(?,?,?,?,?)",
                        (self.year, self.week, kind, label, amount))

    def can_afford(self, amount: float) -> bool:
        return self.cash >= amount

    def accrue(self, amount: float, kind: str, label: str):
        """Recurring cost: moves the cash now, but writes ONE ledger line per
        week per kind, so 70 years of payroll stays readable and cheap."""
        if amount <= 0:
            return
        self.cash -= amount
        buf = self.__dict__.setdefault("_accrued", {})
        buf.setdefault(kind, [0.0, label])
        buf[kind][0] += amount

    def flush_accrued(self):
        buf = self.__dict__.get("_accrued")
        if not buf:
            return
        for kind, (amount, label) in buf.items():
            self.db.execute("INSERT INTO ledger(year,week,kind,label,amount) VALUES(?,?,?,?,?)",
                            (self.year, self.week, kind, label, -amount))
        self.__dict__["_accrued"] = {}

    # ---------------- persistence ----------------
    def flush(self):
        self.flush_accrued()
        self.db.execute(
            "UPDATE game SET cash=?, prestige=?, reputation=?, valuation=?, year=?, week=?, "
            "speed=?, over=?, stats=? WHERE id=1",
            (self.cash, self.prestige, self.reputation, self.valuation, self.year, self.week,
             self.speed, self.over, json.dumps(self.stats)))

    def bump(self, key: str, n=1):
        self.stats[key] = self.stats.get(key, 0) + n

    def add_prestige(self, n: float):
        """Prestige is hard-won and slides back: one year can only move it so far."""
        if n > 0:
            from .sim import events as E
            n *= E.fx(self, "prestige_mult")     # blacklist years, New Hollywood...
            key = f"prestige_gain:{self.year}"
            spent = self.db.kv_get(key, 0.0) or 0.0
            room = max(0.0, 8.0 * (1.0 - self.prestige / 115.0) - spent)
            n = min(n, room)
            if n <= 0:
                return
            self.db.kv_set(key, spent + n)
        self.prestige = max(0.0, min(100.0, self.prestige + n))

    def add_reputation(self, n: float):
        self.reputation = max(-100.0, min(100.0, self.reputation + n))


# --- save management --------------------------------------------------------
SAVE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "saves")


def save_path(slug: str) -> str:
    """A save is one SQLite file in SAVE_DIR. Slug may or may not carry the
    extension - typing either form from the command line should work."""
    slug = (slug or "").strip()
    if slug.lower().endswith(".sqlite"):
        slug = slug[:-len(".sqlite")]
    slug = "".join(ch for ch in slug if ch.isalnum() or ch in "-_")[:48] or "slot"
    return os.path.join(SAVE_DIR, f"{slug}.sqlite")


def list_saves():
    out = []
    if not os.path.isdir(SAVE_DIR):
        return out
    for fn in sorted(os.listdir(SAVE_DIR)):
        if fn.endswith(".sqlite") and not fn.endswith("-wal"):
            p = os.path.join(SAVE_DIR, fn)
            try:
                c = sqlite3_connect_ro(p)
                row = c.execute("SELECT name,year,week,cash,valuation FROM game WHERE id=1").fetchone()
                c.close()
            except Exception:
                row = None
            out.append(dict(slug=fn[:-7], path=p, bytes=os.path.getsize(p),
                            name=(row[0] if row else fn), year=(row[1] if row else 0),
                            week=(row[2] if row else 0), cash=(row[3] if row else 0),
                            valuation=(row[4] if row else 0)))
    return out


def sqlite3_connect_ro(path):
    import sqlite3
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)
