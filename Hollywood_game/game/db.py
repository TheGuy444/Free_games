"""SQLite schema, connection management and query helpers.

Design notes for scale
----------------------
* One save = one sqlite file (WAL).  Saving is free, load = reopen.
* Population churn (thousands of actors aging, decaying, retiring, dying) runs as
  *set-based* UPDATE statements using a per-row LCG column `r`, so a year of
  history for a 5,000 actor universe costs one statement, not 5,000 Python calls.
* Everything the UI lists is paginated server-side with indexes.
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading

SCHEMA_VERSION = 1

SCHEMA = """
CREATE TABLE IF NOT EXISTS game (
  id INTEGER PRIMARY KEY CHECK (id=1),
  name TEXT NOT NULL,
  seed INTEGER NOT NULL,
  start_year INTEGER NOT NULL,
  year INTEGER NOT NULL,
  week INTEGER NOT NULL,
  cash REAL NOT NULL,
  prestige REAL NOT NULL DEFAULT 0,
  reputation REAL NOT NULL DEFAULT 0,
  valuation REAL NOT NULL DEFAULT 0,
  speed INTEGER NOT NULL DEFAULT 0,
  over INTEGER NOT NULL DEFAULT 0,
  stats TEXT NOT NULL DEFAULT '{}',
  created INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS trends (
  genre TEXT PRIMARY KEY,
  heat REAL NOT NULL DEFAULT 1.0,
  drift REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tech (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  year INTEGER NOT NULL,
  unlocked INTEGER NOT NULL DEFAULT 0,
  unlocked_year INTEGER
);

CREATE TABLE IF NOT EXISTS actors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  gender TEXT NOT NULL,
  birth_year INTEGER NOT NULL,
  age INTEGER NOT NULL,
  hue INTEGER NOT NULL DEFAULT 0,
  s_drama REAL NOT NULL DEFAULT 10,
  s_comedy REAL NOT NULL DEFAULT 10,
  s_action REAL NOT NULL DEFAULT 10,
  s_musicality REAL NOT NULL DEFAULT 10,
  s_dance REAL NOT NULL DEFAULT 10,
  s_voice REAL NOT NULL DEFAULT 10,
  s_stunts REAL NOT NULL DEFAULT 10,
  t_charisma REAL NOT NULL DEFAULT 20,
  t_discipline REAL NOT NULL DEFAULT 50,
  t_versatility REAL NOT NULL DEFAULT 40,
  t_bankability REAL NOT NULL DEFAULT 30,
  t_ego REAL NOT NULL DEFAULT 30,
  t_scandal REAL NOT NULL DEFAULT 25,
  t_substance REAL NOT NULL DEFAULT 20,
  t_likeability REAL NOT NULL DEFAULT 50,
  t_press REAL NOT NULL DEFAULT 40,
  craft REAL NOT NULL DEFAULT 20,
  fame REAL NOT NULL DEFAULT 0,
  star_power REAL NOT NULL DEFAULT 0,
  fee REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'available',   -- new|available|working|star|retired|dead|blacklisted
  studio TEXT,                                -- 'player' or rival name when signed
  contract_films INTEGER NOT NULL DEFAULT 0,
  contract_fee REAL NOT NULL DEFAULT 0,
  contract_until INTEGER NOT NULL DEFAULT 0,
  films INTEGER NOT NULL DEFAULT 0,
  leads INTEGER NOT NULL DEFAULT 0,
  awards INTEGER NOT NULL DEFAULT 0,
  noms INTEGER NOT NULL DEFAULT 0,
  total_gross REAL NOT NULL DEFAULT 0,
  best_gross REAL NOT NULL DEFAULT 0,
  cult REAL NOT NULL DEFAULT 0,
  debut_year INTEGER,
  last_work_year INTEGER,
  discoverer TEXT,
  notes TEXT NOT NULL DEFAULT '',
  r INTEGER NOT NULL DEFAULT 1,
  busy_until INTEGER NOT NULL DEFAULT -1
);
CREATE INDEX IF NOT EXISTS ix_actors_fame ON actors(fame DESC);
CREATE INDEX IF NOT EXISTS ix_actors_status ON actors(status);
CREATE INDEX IF NOT EXISTS ix_actors_name ON actors(name);
CREATE INDEX IF NOT EXISTS ix_actors_age ON actors(age);
CREATE INDEX IF NOT EXISTS ix_actors_studio ON actors(studio);

CREATE TABLE IF NOT EXISTS writers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  skill REAL NOT NULL DEFAULT 30,
  genre TEXT NOT NULL DEFAULT 'drama',
  genre2 TEXT NOT NULL DEFAULT 'drama',
  fee REAL NOT NULL DEFAULT 0,
  salary REAL NOT NULL DEFAULT 0,
  weeks_per_script REAL NOT NULL DEFAULT 16,
  ego REAL NOT NULL DEFAULT 40,
  drink REAL NOT NULL DEFAULT 20,
  awards INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'market',   -- market|staff|busy
  studio TEXT,
  busy_until INTEGER NOT NULL DEFAULT -1,
  scripts_written INTEGER NOT NULL DEFAULT 0,
  best_picture INTEGER,
  r INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ix_writers_status ON writers(status);

CREATE TABLE IF NOT EXISTS scripts (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  genre TEXT NOT NULL,
  subgenre TEXT,
  scale TEXT NOT NULL DEFAULT 'standard',
  quality REAL NOT NULL DEFAULT 30,
  fp INTEGER NOT NULL DEFAULT 0,           -- franchise potential
  writer_id INTEGER,
  owner TEXT NOT NULL DEFAULT 'market',    -- market|player|rival
  status TEXT NOT NULL DEFAULT 'market',   -- market|optioned|owned|in_production|produced|dead
  price REAL NOT NULL DEFAULT 0,
  option_price REAL NOT NULL DEFAULT 0,
  created_year INTEGER NOT NULL DEFAULT 1920,
  coverage REAL,                           -- revealed estimate (null = unread)
  coverage_pm REAL,                        -- +/- band
  developed INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL DEFAULT 'new',      -- new|remake|reboot
  source_franchise INTEGER,
  tags TEXT NOT NULL DEFAULT '',
  busy INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_scripts_owner ON scripts(owner, status);
CREATE INDEX IF NOT EXISTS ix_scripts_genre ON scripts(genre);

CREATE TABLE IF NOT EXISTS directors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  vision REAL NOT NULL DEFAULT 30,
  discipline REAL NOT NULL DEFAULT 50,
  temperament REAL NOT NULL DEFAULT 40,
  prestige REAL NOT NULL DEFAULT 0,
  fee REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'market',
  studio TEXT,
  busy_until INTEGER NOT NULL DEFAULT -1,
  films INTEGER NOT NULL DEFAULT 0,
  hits INTEGER NOT NULL DEFAULT 0,
  r INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS productions (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  script_id INTEGER,
  genre TEXT NOT NULL,
  subgenre TEXT,
  scale TEXT NOT NULL DEFAULT 'standard',
  budget REAL NOT NULL DEFAULT 0,
  spent REAL NOT NULL DEFAULT 0,
  marketing REAL NOT NULL DEFAULT 0,
  cast_spend REAL NOT NULL DEFAULT 0,
  upgrades TEXT NOT NULL DEFAULT '{}',
  director_id INTEGER,
  status TEXT NOT NULL DEFAULT 'development',  -- development|pre_production|shooting|post_production|ready|released|cancelled
  phase_weeks INTEGER NOT NULL DEFAULT 0,
  weeks_total INTEGER NOT NULL DEFAULT 0,
  weeks_left INTEGER NOT NULL DEFAULT 0,
  weeks_all INTEGER NOT NULL DEFAULT 1,
  test_score REAL NOT NULL DEFAULT 0,
  progress REAL NOT NULL DEFAULT 0,
  quality REAL NOT NULL DEFAULT 0,     -- live craft estimate
  q_low REAL NOT NULL DEFAULT 0,
  q_high REAL NOT NULL DEFAULT 100,
  hype REAL NOT NULL DEFAULT 0,
  chemistry REAL NOT NULL DEFAULT 0,
  craft REAL NOT NULL DEFAULT 0,
  cast_power REAL NOT NULL DEFAULT 0,
  trend_lock REAL NOT NULL DEFAULT 1.0,
  franchise_id INTEGER,
  seq_index INTEGER NOT NULL DEFAULT 1,
  halted INTEGER NOT NULL DEFAULT 0,
  log TEXT NOT NULL DEFAULT '[]',
  created_year INTEGER NOT NULL DEFAULT 1920,
  start_week INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(script_id) REFERENCES scripts(id)
);
CREATE INDEX IF NOT EXISTS ix_prod_status ON productions(status);

CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY,
  production_id INTEGER NOT NULL,
  idx INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'supporting',   -- lead|supporting|cameo|voice
  skill TEXT NOT NULL DEFAULT 'drama',
  weight REAL NOT NULL DEFAULT 0.2,
  min_skill REAL NOT NULL DEFAULT 10,
  min_age INTEGER NOT NULL DEFAULT 16,
  max_age INTEGER NOT NULL DEFAULT 80,
  gender TEXT NOT NULL DEFAULT 'any',
  want_stunts INTEGER NOT NULL DEFAULT 0,
  want_dance INTEGER NOT NULL DEFAULT 0,
  want_voice INTEGER NOT NULL DEFAULT 0,
  actor_id INTEGER,
  fee REAL NOT NULL DEFAULT 0,
  FOREIGN KEY(production_id) REFERENCES productions(id)
);
CREATE INDEX IF NOT EXISTS ix_roles_prod ON roles(production_id);

CREATE TABLE IF NOT EXISTS movies (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  genre TEXT NOT NULL,
  subgenre TEXT,
  scale TEXT NOT NULL DEFAULT 'standard',
  year INTEGER NOT NULL,
  week INTEGER NOT NULL,
  budget REAL NOT NULL DEFAULT 0,
  marketing REAL NOT NULL DEFAULT 0,
  gross REAL NOT NULL DEFAULT 0,
  gross_domestic REAL NOT NULL DEFAULT 0,
  net REAL NOT NULL DEFAULT 0,
  secondary REAL NOT NULL DEFAULT 0,
  critics REAL NOT NULL DEFAULT 0,
  audience REAL NOT NULL DEFAULT 0,
  wom REAL NOT NULL DEFAULT 1,
  quality REAL NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL DEFAULT 'TROUGH',
  cult REAL NOT NULL DEFAULT 0,
  cult_classic INTEGER NOT NULL DEFAULT 0,
  stinker INTEGER NOT NULL DEFAULT 0,
  franchise_id INTEGER,
  seq_index INTEGER NOT NULL DEFAULT 1,
  writer_id INTEGER,
  director_name TEXT,
  cast TEXT NOT NULL DEFAULT '[]',
  rights TEXT NOT NULL DEFAULT 'player',     -- 'player' or rival name
  sold_year INTEGER,
  sold_price REAL NOT NULL DEFAULT 0,
  noms INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  razzies INTEGER NOT NULL DEFAULT 0,
  foreign_share REAL NOT NULL DEFAULT 0.35
);
CREATE INDEX IF NOT EXISTS ix_movies_year ON movies(year);
CREATE INDEX IF NOT EXISTS ix_movies_franchise ON movies(franchise_id);
CREATE INDEX IF NOT EXISTS ix_movies_rights ON movies(rights);

CREATE TABLE IF NOT EXISTS franchises (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  root_movie_id INTEGER,
  genre TEXT NOT NULL DEFAULT 'action',
  fan_base REAL NOT NULL DEFAULT 0,
  heat REAL NOT NULL DEFAULT 1,
  continuity INTEGER NOT NULL DEFAULT 1,
  installments INTEGER NOT NULL DEFAULT 0,
  last_year INTEGER NOT NULL DEFAULT 0,
  created_year INTEGER NOT NULL DEFAULT 1920,
  status TEXT NOT NULL DEFAULT 'active',    -- active|dormant|dead|sold
  rights TEXT NOT NULL DEFAULT 'player',
  sold_year INTEGER,
  sold_price REAL NOT NULL DEFAULT 0,
  total_gross REAL NOT NULL DEFAULT 0,
  total_net REAL NOT NULL DEFAULT 0,
  recasts INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_fr_status ON franchises(status);

CREATE TABLE IF NOT EXISTS offers (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,          -- movie|franchise|distribution|merch|option_buy|library
  asset_id INTEGER,
  asset_label TEXT NOT NULL,
  buyer TEXT NOT NULL,
  price REAL NOT NULL,
  terms TEXT NOT NULL DEFAULT '',
  year INTEGER NOT NULL,
  expires_year INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',   -- open|accepted|declined|expired
  opportunity REAL NOT NULL DEFAULT 0,   -- projected value to us (regret column)
  hidden_buyer_interest REAL NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ix_offers_status ON offers(status, kind);

CREATE TABLE IF NOT EXISTS active_events (
  id INTEGER PRIMARY KEY,
  def_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  severity INTEGER NOT NULL DEFAULT 1,
  started_year INTEGER NOT NULL,
  started_week INTEGER NOT NULL,
  weeks_left INTEGER NOT NULL,
  effects TEXT NOT NULL DEFAULT '{}',
  headline TEXT NOT NULL DEFAULT '',
  choice TEXT,
  resolved INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS event_log (
  id INTEGER PRIMARY KEY,
  year INTEGER NOT NULL,
  week INTEGER NOT NULL,
  kind TEXT NOT NULL,          -- world|industry|local|release|finance|award|offer|talent
  title TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  weight INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ix_log_year ON event_log(year DESC, week DESC);

CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY,
  year INTEGER NOT NULL,
  week INTEGER NOT NULL,
  kind TEXT NOT NULL,          -- gross|secondary|salary|cast|production|marketing|overhead|loan|interest|ip_sale|build|other
  label TEXT NOT NULL,
  amount REAL NOT NULL         -- signed
);
CREATE INDEX IF NOT EXISTS ix_ledger_year ON ledger(year);

CREATE TABLE IF NOT EXISTS loans (
  id INTEGER PRIMARY KEY,
  principal REAL NOT NULL,
  balance REAL NOT NULL,
  rate REAL NOT NULL,
  taken_year INTEGER NOT NULL,
  due_year INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS buildings (
  kind TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rivals (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  cash REAL NOT NULL DEFAULT 0,
  prestige REAL NOT NULL DEFAULT 0,
  aggression REAL NOT NULL DEFAULT 0.5,
  appetite REAL NOT NULL DEFAULT 0.5,
  alive INTEGER NOT NULL DEFAULT 1,
  films INTEGER NOT NULL DEFAULT 0,
  gross REAL NOT NULL DEFAULT 0,
  ip INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS awards (
  id INTEGER PRIMARY KEY,
  year INTEGER NOT NULL,
  category TEXT NOT NULL,
  label TEXT NOT NULL,
  movie_id INTEGER,
  movie_title TEXT,
  actor_id INTEGER,
  actor_name TEXT,
  studio TEXT NOT NULL,
  won INTEGER NOT NULL DEFAULT 0,
  franchise_id INTEGER
);
CREATE INDEX IF NOT EXISTS ix_award_year ON awards(year);

CREATE TABLE IF NOT EXISTS year_stats (
  year INTEGER PRIMARY KEY,
  releases INTEGER NOT NULL DEFAULT 0,
  gross REAL NOT NULL DEFAULT 0,
  net REAL NOT NULL DEFAULT 0,
  profit REAL NOT NULL DEFAULT 0,
  cash REAL NOT NULL DEFAULT 0,
  valuation REAL NOT NULL DEFAULT 0,
  prestige REAL NOT NULL DEFAULT 0,
  reputation REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS discoveries (
  id INTEGER PRIMARY KEY,
  actor_id INTEGER NOT NULL,
  year INTEGER NOT NULL,
  week INTEGER NOT NULL,
  tier INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'open_call',
  claimed INTEGER NOT NULL DEFAULT 0,
  expires_year INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_disc_claim ON discoveries(claimed, expires_year);

CREATE TABLE IF NOT EXISTS cast_members (
  id INTEGER PRIMARY KEY,
  movie_id INTEGER NOT NULL,
  actor_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'supporting',
  fee REAL NOT NULL DEFAULT 0,
  fit REAL NOT NULL DEFAULT 0,
  franchise_id INTEGER
);
CREATE INDEX IF NOT EXISTS ix_cm_actor ON cast_members(actor_id);
CREATE INDEX IF NOT EXISTS ix_cm_movie ON cast_members(movie_id);

CREATE TABLE IF NOT EXISTS legacy (
  actor_id INTEGER PRIMARY KEY,
  rating REAL NOT NULL DEFAULT 1000,       -- hidden Elo-style career rating
  peak REAL NOT NULL DEFAULT 1000,
  matches INTEGER NOT NULL DEFAULT 0,
  died_year INTEGER,
  died_age INTEGER,
  cause TEXT,
  hof_year INTEGER,
  hof_note TEXT
);
CREATE INDEX IF NOT EXISTS ix_legacy_hof ON legacy(hof_year);

CREATE TABLE IF NOT EXISTS rival_releases (
  id INTEGER PRIMARY KEY,
  studio TEXT NOT NULL,
  title TEXT NOT NULL,
  genre TEXT NOT NULL,
  subgenre TEXT,
  year INTEGER NOT NULL,
  week INTEGER NOT NULL,
  quality REAL NOT NULL DEFAULT 40,
  gross REAL NOT NULL DEFAULT 0,
  star_power REAL NOT NULL DEFAULT 20,
  franchise TEXT,
  award INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_rr_year ON rival_releases(year);
CREATE INDEX IF NOT EXISTS ix_rr_genre ON rival_releases(genre, year);

CREATE TABLE IF NOT EXISTS characters (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  franchise_id INTEGER,                    -- home series: rights follow it
  origin_franchise INTEGER,                -- the series they first appeared in
  genre TEXT NOT NULL DEFAULT 'action',
  gender TEXT NOT NULL DEFAULT 'm',
  role TEXT NOT NULL DEFAULT 'lead',       -- lead|supporting (in their home series)
  fan REAL NOT NULL DEFAULT 0,
  peak REAL NOT NULL DEFAULT 0,
  appearances INTEGER NOT NULL DEFAULT 0,
  actor_id INTEGER,                        -- who plays them now
  actors INTEGER NOT NULL DEFAULT 1,       -- how many faces they have had
  breakout REAL NOT NULL DEFAULT 0,
  icon INTEGER NOT NULL DEFAULT 0,
  icon_year INTEGER,
  spun_off INTEGER NOT NULL DEFAULT 0,
  created_year INTEGER NOT NULL DEFAULT 1920,
  last_year INTEGER NOT NULL DEFAULT 1920
);
CREATE INDEX IF NOT EXISTS ix_char_fr ON characters(franchise_id);

CREATE TABLE IF NOT EXISTS char_appearances (
  character_id INTEGER NOT NULL,
  movie_id INTEGER NOT NULL,
  actor_id INTEGER,
  year INTEGER NOT NULL,
  franchise_id INTEGER,
  continuity INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL DEFAULT 'lead',
  universe INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (character_id, movie_id)
);

CREATE TABLE IF NOT EXISTS title_bag (
  title TEXT PRIMARY KEY            -- every title the world has used: never drawn again
);

CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- ---------------------------------------------------------------- the press
-- Every story the newspaper prints. `section` is one of
-- front|release|review|boxoffice|stars|world|awards|records|business.
CREATE TABLE IF NOT EXISTS news (
  id INTEGER PRIMARY KEY,
  year INTEGER NOT NULL,
  week INTEGER NOT NULL,
  abs_week INTEGER NOT NULL,
  section TEXT NOT NULL,
  headline TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  movie_id INTEGER,
  actor_id INTEGER,
  run_id INTEGER,
  weight INTEGER NOT NULL DEFAULT 1,
  mine INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_news_abs ON news(abs_week DESC, weight DESC);
CREATE INDEX IF NOT EXISTS ix_news_section ON news(section, abs_week DESC);

-- The critics' verdict on one of our pictures (the release pop-up).
CREATE TABLE IF NOT EXISTS reviews (
  movie_id INTEGER PRIMARY KEY,
  year INTEGER NOT NULL,
  week INTEGER NOT NULL,
  title TEXT NOT NULL,
  outcome TEXT NOT NULL,
  critics REAL NOT NULL,
  audience REAL NOT NULL,
  score10 REAL NOT NULL,
  verdict TEXT NOT NULL,
  headline TEXT NOT NULL,
  subhead TEXT NOT NULL DEFAULT '',
  consensus TEXT NOT NULL DEFAULT '',
  audience_line TEXT NOT NULL DEFAULT '',
  outlets TEXT NOT NULL DEFAULT '[]',
  performances TEXT NOT NULL DEFAULT '[]',
  opening REAL NOT NULL DEFAULT 0,
  open_rank INTEGER,
  seen INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_reviews_seen ON reviews(seen);

-- One theatrical run per picture in town (ours, rivals', independents').
-- The money for our pictures is still booked on release; the run only spreads
-- that gross across weeks so there is a chart to read.
CREATE TABLE IF NOT EXISTS box_runs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                -- player|rival|indie
  movie_id INTEGER,
  title TEXT NOT NULL,
  studio TEXT NOT NULL,
  genre TEXT NOT NULL,
  lead_name TEXT,
  year INTEGER NOT NULL,
  week INTEGER NOT NULL,
  open_abs INTEGER NOT NULL,
  total REAL NOT NULL,
  decay REAL NOT NULL,
  weeks_max INTEGER NOT NULL,
  opening REAL NOT NULL,
  critics INTEGER,
  wk INTEGER NOT NULL DEFAULT 0,
  week_gross REAL NOT NULL DEFAULT 0,
  cume REAL NOT NULL DEFAULT 0,
  rank INTEGER,
  prev_rank INTEGER,
  best_rank INTEGER,
  w1 INTEGER NOT NULL DEFAULT 0,
  w10 INTEGER NOT NULL DEFAULT 0,
  w50 INTEGER NOT NULL DEFAULT 0,
  w100 INTEGER NOT NULL DEFAULT 0,
  streak1 INTEGER NOT NULL DEFAULT 0,
  best_streak1 INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ix_runs_active ON box_runs(active, rank);
CREATE INDEX IF NOT EXISTS ix_runs_movie ON box_runs(movie_id);

-- Top ten of every week, kept forever (back issues of the paper).
CREATE TABLE IF NOT EXISTS chart_hist (
  abs_week INTEGER NOT NULL,
  rank INTEGER NOT NULL,
  run_id INTEGER NOT NULL,
  gross REAL NOT NULL,
  cume REAL NOT NULL,
  weeks INTEGER NOT NULL,
  PRIMARY KEY (abs_week, rank)
);

-- What kind of pictures an actor keeps getting cast in: the road to a label.
CREATE TABLE IF NOT EXISTS actor_genre (
  actor_id INTEGER NOT NULL,
  genre TEXT NOT NULL,
  xp REAL NOT NULL DEFAULT 0,
  films INTEGER NOT NULL DEFAULT 0,
  leads INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (actor_id, genre)
);
"""

# Columns added after the first release. Old saves get them on open; fresh
# saves get them here too, so the CREATE TABLEs above stay untouched.
MIGRATIONS = [
    ("actors", "labels", "TEXT NOT NULL DEFAULT ''"),
    ("actors", "g_films", "INTEGER NOT NULL DEFAULT 0"),
    ("actors", "standouts", "INTEGER NOT NULL DEFAULT 0"),
    ("cast_members", "perf", "REAL"),
    ("cast_members", "grade", "TEXT"),
    ("rival_releases", "lead_id", "INTEGER"),
    ("rival_releases", "lead_name", "TEXT"),
    ("rivals", "debt", "REAL NOT NULL DEFAULT 0"),
    ("franchises", "kind", "TEXT NOT NULL DEFAULT 'series'"),   # series|spinoff|universe
    ("franchises", "parent_id", "INTEGER"),
    ("roles", "character_id", "INTEGER"),
    ("cast_members", "character_id", "INTEGER"),
]
MIGRATION_INDEXES = [
    "CREATE INDEX IF NOT EXISTS ix_rr_lead ON rival_releases(lead_id)",
    "CREATE INDEX IF NOT EXISTS ix_award_actor ON awards(actor_id)",
]


class DB:
    def __init__(self, path: str):
        self.path = path
        new = not os.path.exists(path) or os.path.getsize(path) == 0
        self.conn = sqlite3.connect(path, check_same_thread=False, timeout=30)
        self.conn.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        with self.lock:
            self.conn.execute("PRAGMA journal_mode=WAL")
            self.conn.execute("PRAGMA synchronous=NORMAL")
            self.conn.execute("PRAGMA temp_store=MEMORY")
            self.conn.execute("PRAGMA cache_size=-40000")
            self.conn.execute("PRAGMA foreign_keys=OFF")
            self.conn.executescript(SCHEMA)
            self._migrate()
            self.conn.commit()
        if new:
            pass

    def _migrate(self):
        cols = {}
        for table, col, decl in MIGRATIONS:
            if table not in cols:
                cols[table] = {r[1] for r in self.conn.execute(f"PRAGMA table_info({table})")}
            if col not in cols[table]:
                self.conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")
                cols[table].add(col)
        for sql in MIGRATION_INDEXES:
            self.conn.execute(sql)

    # ---- helpers ---------------------------------------------------------
    def q(self, sql, args=()):
        cur = self.conn.execute(sql, args)
        return cur.fetchall()

    def q1(self, sql, args=()):
        cur = self.conn.execute(sql, args)
        return cur.fetchone()

    def scalar(self, sql, args=(), default=None):
        # tolerate scalar(sql, default) shorthand
        if not isinstance(args, (tuple, list)):
            args, default = (), args
        row = self.q1(sql, args)
        if row is None:
            return default
        v = row[0]
        return default if v is None else v

    def execute(self, sql, args=()):
        if not isinstance(args, (tuple, list, dict)):
            args = (args,)
        with self.lock:
            cur = self.conn.execute(sql, args)
            return cur

    def executemany(self, sql, seq):
        with self.lock:
            return self.conn.executemany(sql, seq)

    def commit(self):
        with self.lock:
            self.conn.commit()

    def close(self):
        with self.lock:
            try:
                self.conn.commit()
            except Exception:
                pass
            self.conn.close()

    # ---- convenience ------------------------------------------------------
    def game(self):
        return self.q1("SELECT * FROM game WHERE id=1")

    def kv_get(self, k, default=None):
        row = self.q1("SELECT v FROM kv WHERE k=?", (k,))
        if not row:
            return default
        try:
            return json.loads(row[0])
        except Exception:
            return row[0]

    def kv_set(self, k, v):
        self.execute("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
                     (k, json.dumps(v)))
