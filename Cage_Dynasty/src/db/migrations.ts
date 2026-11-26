/**
 * Versioned schema migrations. The save file's PRAGMA user_version records
 * which have run, so old saves upgrade when the game updates.
 *
 * Conventions:
 *  - Time is an integer game `week` (0 = first week of the world's history).
 *  - Event tables (bout, contract history, ledger) are append-only and indexed
 *    by (entity, week) so they can be archived per decade later.
 *  - SQL stays portable to Postgres: no SQLite-only types beyond INTEGER/REAL/TEXT/BLOB.
 */
export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: "init",
    sql: `
CREATE TABLE world (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  seed          INTEGER NOT NULL,
  start_year    INTEGER NOT NULL,
  current_week  INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);

CREATE TABLE region (
  id      INTEGER PRIMARY KEY,
  code    TEXT NOT NULL UNIQUE,
  name    TEXT NOT NULL,
  flavor  TEXT NOT NULL
);

CREATE TABLE weight_class (
  id        INTEGER PRIMARY KEY,
  code      TEXT NOT NULL UNIQUE,
  name      TEXT NOT NULL,
  sex       TEXT NOT NULL CHECK (sex IN ('M','F')),
  limit_kg  REAL NOT NULL
);

CREATE TABLE discipline (
  id    INTEGER PRIMARY KEY,
  code  TEXT NOT NULL UNIQUE,
  name  TEXT NOT NULL
);

-- A person can be a fighter, later a coach, commentator, etc.
CREATE TABLE person (
  id          INTEGER PRIMARY KEY,
  first_name  TEXT NOT NULL,
  last_name   TEXT NOT NULL,
  nickname    TEXT,
  sex         TEXT NOT NULL CHECK (sex IN ('M','F')),
  birth_week  INTEGER NOT NULL,
  region_id   INTEGER NOT NULL REFERENCES region(id)
);
CREATE INDEX person_region ON person(region_id);

CREATE TABLE fighter (
  person_id        INTEGER PRIMARY KEY REFERENCES person(id),
  weight_class_id  INTEGER NOT NULL REFERENCES weight_class(id),
  walk_weight_kg   REAL NOT NULL,
  archetype        TEXT NOT NULL,
  base_discipline  INTEGER REFERENCES discipline(id),
  status           TEXT NOT NULL CHECK (status IN ('amateur','active','injured','retired','deceased')),
  fidelity         TEXT NOT NULL DEFAULT 'light' CHECK (fidelity IN ('full','standard','light')),
  pro_debut_week   INTEGER,
  retired_week     INTEGER,
  wins             INTEGER NOT NULL DEFAULT 0,
  losses           INTEGER NOT NULL DEFAULT 0,
  draws            INTEGER NOT NULL DEFAULT 0,
  ko_wins          INTEGER NOT NULL DEFAULT 0,
  sub_wins         INTEGER NOT NULL DEFAULT 0,
  rating           REAL NOT NULL DEFAULT 1500,  -- composite strength rating (Elo-like)
  damage_total     REAL NOT NULL DEFAULT 0,
  last_fight_week  INTEGER
);
CREATE INDEX fighter_status_wc ON fighter(status, weight_class_id, rating);

-- Current attributes, 0-100. History of changes goes in fighter_attr_history (yearly snapshots).
CREATE TABLE fighter_attributes (
  person_id      INTEGER PRIMARY KEY REFERENCES fighter(person_id),
  boxing INTEGER NOT NULL, kicks INTEGER NOT NULL, clinch_strike INTEGER NOT NULL,
  takedowns INTEGER NOT NULL, td_defense INTEGER NOT NULL, top_control INTEGER NOT NULL,
  sub_offense INTEGER NOT NULL, sub_defense INTEGER NOT NULL, scrambles INTEGER NOT NULL,
  strength INTEGER NOT NULL, speed INTEGER NOT NULL, cardio INTEGER NOT NULL,
  chin INTEGER NOT NULL, recovery INTEGER NOT NULL, durability INTEGER NOT NULL,
  fight_iq INTEGER NOT NULL, composure INTEGER NOT NULL, aggression INTEGER NOT NULL, heart INTEGER NOT NULL,
  charisma INTEGER NOT NULL, mic_skill INTEGER NOT NULL, professionalism INTEGER NOT NULL,
  potential INTEGER NOT NULL
);

CREATE TABLE fighter_attr_history (
  person_id  INTEGER NOT NULL REFERENCES fighter(person_id),
  year       INTEGER NOT NULL,
  overall    INTEGER NOT NULL,
  striking   INTEGER NOT NULL,
  grappling  INTEGER NOT NULL,
  physical   INTEGER NOT NULL,
  PRIMARY KEY (person_id, year)
);

CREATE TABLE fighter_discipline (
  person_id      INTEGER NOT NULL REFERENCES fighter(person_id),
  discipline_id  INTEGER NOT NULL REFERENCES discipline(id),
  level          INTEGER NOT NULL,   -- 0-100
  PRIMARY KEY (person_id, discipline_id)
);

CREATE TABLE promotion (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  region_id     INTEGER REFERENCES region(id),   -- NULL = global
  tier          TEXT NOT NULL CHECK (tier IN ('global','major','regional','local')),
  founded_week  INTEGER NOT NULL,
  folded_week   INTEGER,
  is_player     INTEGER NOT NULL DEFAULT 0,
  cash          REAL NOT NULL DEFAULT 0,
  prestige      REAL NOT NULL DEFAULT 0
);

CREATE TABLE promotion_tier_history (
  promotion_id  INTEGER NOT NULL REFERENCES promotion(id),
  week          INTEGER NOT NULL,
  tier          TEXT NOT NULL,
  PRIMARY KEY (promotion_id, week)
);

CREATE TABLE contract (
  id               INTEGER PRIMARY KEY,
  fighter_id       INTEGER NOT NULL REFERENCES fighter(person_id),
  promotion_id     INTEGER NOT NULL REFERENCES promotion(id),
  kind             TEXT NOT NULL CHECK (kind IN ('exclusive','non_exclusive','co_promotion','reality_show')),
  start_week       INTEGER NOT NULL,
  end_week         INTEGER,            -- set when the contract ends
  bouts_total      INTEGER NOT NULL,
  bouts_remaining  INTEGER NOT NULL,
  purse            REAL NOT NULL,
  win_bonus        REAL NOT NULL
);
CREATE INDEX contract_fighter ON contract(fighter_id, end_week);
CREATE INDEX contract_promo ON contract(promotion_id, end_week);

CREATE TABLE venue (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  region_id  INTEGER NOT NULL REFERENCES region(id),
  capacity   INTEGER NOT NULL
);

CREATE TABLE event (
  id            INTEGER PRIMARY KEY,
  promotion_id  INTEGER NOT NULL REFERENCES promotion(id),
  week          INTEGER NOT NULL,
  name          TEXT NOT NULL,
  venue_id      INTEGER REFERENCES venue(id),
  attendance    INTEGER,
  gate          REAL
);
CREATE INDEX event_promo_week ON event(promotion_id, week);
CREATE INDEX event_week ON event(week);

CREATE TABLE bout (
  id               INTEGER PRIMARY KEY,
  event_id         INTEGER NOT NULL REFERENCES event(id),
  week             INTEGER NOT NULL,
  card_order       INTEGER NOT NULL,       -- 1 = main event
  weight_class_id  INTEGER NOT NULL REFERENCES weight_class(id),
  red_id           INTEGER NOT NULL REFERENCES fighter(person_id),
  blue_id          INTEGER NOT NULL REFERENCES fighter(person_id),
  scheduled_rounds INTEGER NOT NULL,
  winner_id        INTEGER,                -- NULL = draw / no contest
  method           TEXT NOT NULL CHECK (method IN ('KO','TKO','SUB','DEC_U','DEC_S','DEC_M','DRAW','NC')),
  end_round        INTEGER NOT NULL,
  end_time_s       INTEGER NOT NULL,
  rng_seed         INTEGER NOT NULL,       -- deterministic replay
  fidelity         TEXT NOT NULL
);
CREATE INDEX bout_red_week  ON bout(red_id, week);
CREATE INDEX bout_blue_week ON bout(blue_id, week);
CREATE INDEX bout_event     ON bout(event_id);

-- Play-by-play for full-fidelity bouts only: compact event codes, narrated at view time.
CREATE TABLE bout_log (
  bout_id  INTEGER PRIMARY KEY REFERENCES bout(id),
  events   BLOB NOT NULL
);
`,
  },
  {
    version: 2,
    name: "round_stats",
    sql: `
-- Per-round stats for bouts run through the full fight engine (standard and full fidelity).
CREATE TABLE bout_round_stats (
  bout_id   INTEGER NOT NULL REFERENCES bout(id),
  round     INTEGER NOT NULL,
  corner    INTEGER NOT NULL CHECK (corner IN (0, 1)),
  sig_att   INTEGER NOT NULL,
  sig_land  INTEGER NOT NULL,
  kd        INTEGER NOT NULL,
  td_att    INTEGER NOT NULL,
  td_land   INTEGER NOT NULL,
  sub_att   INTEGER NOT NULL,
  ctrl_s    INTEGER NOT NULL,
  PRIMARY KEY (bout_id, round, corner)
);
`,
  },
  {
    version: 3,
    name: "booking_weighins_titles_moments",
    sql: `
ALTER TABLE world ADD COLUMN player_promotion_id INTEGER REFERENCES promotion(id);
ALTER TABLE promotion ADD COLUMN event_weeks TEXT NOT NULL DEFAULT '';   -- AI schedule: weeks of the year
ALTER TABLE fighter ADD COLUMN popularity REAL NOT NULL DEFAULT 10;      -- 0-100 drawing power
ALTER TABLE fighter ADD COLUMN loss_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE fighter ADD COLUMN injured_until INTEGER;
ALTER TABLE fighter ADD COLUMN missed_weight INTEGER NOT NULL DEFAULT 0; -- recent weight misses, decays yearly
ALTER TABLE event ADD COLUMN status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('scheduled','completed','cancelled'));
ALTER TABLE bout ADD COLUMN title_id INTEGER;
ALTER TABLE bout ADD COLUMN catchweight INTEGER NOT NULL DEFAULT 0;

CREATE TABLE title (
  id               INTEGER PRIMARY KEY,
  promotion_id     INTEGER NOT NULL REFERENCES promotion(id),
  weight_class_id  INTEGER NOT NULL REFERENCES weight_class(id),
  UNIQUE (promotion_id, weight_class_id)
);

CREATE TABLE title_reign (
  id          INTEGER PRIMARY KEY,
  title_id    INTEGER NOT NULL REFERENCES title(id),
  fighter_id  INTEGER NOT NULL REFERENCES fighter(person_id),
  start_week  INTEGER NOT NULL,
  end_week    INTEGER,
  defenses    INTEGER NOT NULL DEFAULT 0,
  end_reason  TEXT
);
CREATE INDEX title_reign_title ON title_reign(title_id, end_week);
CREATE INDEX title_reign_fighter ON title_reign(fighter_id);

-- Bouts the player (or AI ahead of time) has booked on a scheduled event.
CREATE TABLE booking (
  id               INTEGER PRIMARY KEY,
  event_id         INTEGER NOT NULL REFERENCES event(id),
  card_order       INTEGER NOT NULL,
  red_id           INTEGER NOT NULL REFERENCES fighter(person_id),
  blue_id          INTEGER NOT NULL REFERENCES fighter(person_id),
  weight_class_id  INTEGER NOT NULL REFERENCES weight_class(id),
  rounds           INTEGER NOT NULL,
  title_id         INTEGER REFERENCES title(id),
  booked_week      INTEGER NOT NULL,
  status           TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','cancelled','completed')),
  cancel_reason    TEXT,
  bout_id          INTEGER REFERENCES bout(id)
);
CREATE INDEX booking_event ON booking(event_id);
CREATE INDEX booking_red ON booking(red_id, status);
CREATE INDEX booking_blue ON booking(blue_id, status);

CREATE TABLE weigh_in (
  id          INTEGER PRIMARY KEY,
  event_id    INTEGER NOT NULL REFERENCES event(id),
  fighter_id  INTEGER NOT NULL REFERENCES fighter(person_id),
  week        INTEGER NOT NULL,
  limit_kg    REAL NOT NULL,
  weight_kg   REAL NOT NULL,
  outcome     TEXT NOT NULL CHECK (outcome IN ('made','drained','missed','hospitalised')),
  fine        REAL NOT NULL DEFAULT 0
);
CREATE INDEX weigh_in_fighter ON weigh_in(fighter_id, week);
CREATE INDEX weigh_in_event ON weigh_in(event_id);

CREATE TABLE post_fight_moment (
  id          INTEGER PRIMARY KEY,
  bout_id     INTEGER NOT NULL REFERENCES bout(id),
  week        INTEGER NOT NULL,
  fighter_id  INTEGER NOT NULL REFERENCES fighter(person_id),
  kind        TEXT NOT NULL CHECK (kind IN ('callout','retirement','statement')),
  target_id   INTEGER REFERENCES fighter(person_id),
  text        TEXT NOT NULL
);
CREATE INDEX moment_fighter ON post_fight_moment(fighter_id, week);
CREATE INDEX moment_target ON post_fight_moment(target_id, week);
CREATE INDEX moment_bout ON post_fight_moment(bout_id);

CREATE TABLE news_item (
  id            INTEGER PRIMARY KEY,
  week          INTEGER NOT NULL,
  promotion_id  INTEGER REFERENCES promotion(id),
  kind          TEXT NOT NULL,
  text          TEXT NOT NULL
);
CREATE INDEX news_promo_week ON news_item(promotion_id, week);
`,
  },
  {
    version: 4,
    name: "news_and_rankings",
    sql: `
ALTER TABLE fighter ADD COLUMN win_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE news_item ADD COLUMN fighter_id INTEGER;
ALTER TABLE news_item ADD COLUMN importance INTEGER NOT NULL DEFAULT 1;  -- 1 minor, 2 notable, 3 headline
CREATE INDEX news_week ON news_item(week);

-- Rankings snapshots every 4 weeks: worldwide lists and the player's company lists.
--   scope = 0 for worldwide, otherwise a promotion id; list = 0 for pound-for-pound, otherwise a weight class id
CREATE TABLE ranking_snapshot (
  week        INTEGER NOT NULL,
  scope       INTEGER NOT NULL,
  list        INTEGER NOT NULL,
  rank        INTEGER NOT NULL,
  fighter_id  INTEGER NOT NULL REFERENCES fighter(person_id),
  score       REAL NOT NULL,
  PRIMARY KEY (week, scope, list, rank)
);
CREATE INDEX ranking_fighter ON ranking_snapshot(fighter_id, week);
`,
  },
  {
    version: 5,
    name: "news_stories",
    sql: `
-- Newspaper copy for notable items: a headline and a short story (paragraphs split by blank lines).
ALTER TABLE news_item ADD COLUMN headline TEXT;
ALTER TABLE news_item ADD COLUMN story TEXT;
`,
  },
  {
    version: 6,
    name: "fighter_wear",
    sql: `
-- Wear by body part (0-100). Head wear is damage_total.
ALTER TABLE fighter ADD COLUMN wear_body REAL NOT NULL DEFAULT 0;
ALTER TABLE fighter ADD COLUMN wear_arms REAL NOT NULL DEFAULT 0;
ALTER TABLE fighter ADD COLUMN wear_legs REAL NOT NULL DEFAULT 0;
`,
  },
  {
    version: 7,
    name: "detailed_stats",
    sql: `
-- Detailed standup, clinch, top and bottom stats read by the fight engine.
ALTER TABLE fighter_attributes ADD COLUMN punch_speed INTEGER NOT NULL DEFAULT 50;
ALTER TABLE fighter_attributes ADD COLUMN punch_power INTEGER NOT NULL DEFAULT 50;
ALTER TABLE fighter_attributes ADD COLUMN punch_tech INTEGER NOT NULL DEFAULT 50;
ALTER TABLE fighter_attributes ADD COLUMN kick_speed INTEGER NOT NULL DEFAULT 50;
ALTER TABLE fighter_attributes ADD COLUMN kick_power INTEGER NOT NULL DEFAULT 50;
ALTER TABLE fighter_attributes ADD COLUMN kick_tech INTEGER NOT NULL DEFAULT 50;
ALTER TABLE fighter_attributes ADD COLUMN head_movement INTEGER NOT NULL DEFAULT 50;
ALTER TABLE fighter_attributes ADD COLUMN shot_takedown INTEGER NOT NULL DEFAULT 50;
ALTER TABLE fighter_attributes ADD COLUMN shot_defense INTEGER NOT NULL DEFAULT 50;
ALTER TABLE fighter_attributes ADD COLUMN clinch_control INTEGER NOT NULL DEFAULT 50;
ALTER TABLE fighter_attributes ADD COLUMN clinch_takedown INTEGER NOT NULL DEFAULT 50;
ALTER TABLE fighter_attributes ADD COLUMN clinch_defense INTEGER NOT NULL DEFAULT 50;
ALTER TABLE fighter_attributes ADD COLUMN passing INTEGER NOT NULL DEFAULT 50;
ALTER TABLE fighter_attributes ADD COLUMN gnp INTEGER NOT NULL DEFAULT 50;
ALTER TABLE fighter_attributes ADD COLUMN top_sub INTEGER NOT NULL DEFAULT 50;
ALTER TABLE fighter_attributes ADD COLUMN guard_defense INTEGER NOT NULL DEFAULT 50;
ALTER TABLE fighter_attributes ADD COLUMN sweeps INTEGER NOT NULL DEFAULT 50;
ALTER TABLE fighter_attributes ADD COLUMN guard_sub INTEGER NOT NULL DEFAULT 50;
ALTER TABLE fighter_attributes ADD COLUMN get_up INTEGER NOT NULL DEFAULT 50;
-- Older saves: estimate the detailed stats from the coarse ones.
UPDATE fighter_attributes SET
  punch_speed = (boxing + speed) / 2, punch_power = (boxing + strength) / 2, punch_tech = boxing,
  kick_speed = (kicks + speed) / 2, kick_power = (kicks + strength) / 2, kick_tech = kicks,
  head_movement = (speed + fight_iq + boxing) / 3,
  shot_takedown = takedowns, shot_defense = td_defense,
  clinch_control = (clinch_strike + strength + top_control) / 3, clinch_takedown = (takedowns + strength) / 2, clinch_defense = td_defense,
  passing = (top_control + sub_offense) / 2, gnp = (top_control + strength) / 2, top_sub = sub_offense,
  guard_defense = (scrambles + sub_defense) / 2, sweeps = (scrambles + sub_offense) / 2, guard_sub = sub_offense,
  get_up = (scrambles + td_defense) / 2;
`,
  },
  {
    version: 8,
    name: "hall_of_fame",
    sql: `
-- scope 0 = the global hall, otherwise a promotion id.
CREATE TABLE hall_of_fame (
  fighter_id  INTEGER NOT NULL REFERENCES person(id),
  scope       INTEGER NOT NULL,
  week        INTEGER NOT NULL,
  score       INTEGER NOT NULL,
  citation    TEXT NOT NULL,
  PRIMARY KEY (fighter_id, scope)
);
CREATE INDEX hall_scope ON hall_of_fame(scope, week);
CREATE INDEX bout_winner ON bout(winner_id);
`,
  },
  {
    version: 9,
    name: "traits_regional_popularity_card_ratings",
    sql: `
ALTER TABLE fighter ADD COLUMN traits TEXT;           -- comma-separated trait keys
ALTER TABLE fighter ADD COLUMN pop_regions TEXT;      -- JSON {regionId: popularity}
ALTER TABLE fighter ADD COLUMN fotn INTEGER NOT NULL DEFAULT 0;  -- Fight of the Night bonuses
ALTER TABLE event ADD COLUMN region_id INTEGER REFERENCES region(id);
ALTER TABLE event ADD COLUMN rating REAL;             -- card rating 0-100
ALTER TABLE bout ADD COLUMN rating REAL;              -- fight rating 0-100
ALTER TABLE bout ADD COLUMN segment TEXT;             -- 'main' or 'prelim'
ALTER TABLE bout ADD COLUMN fotn INTEGER NOT NULL DEFAULT 0;
CREATE INDEX bout_rating ON bout(rating);
CREATE INDEX event_rating ON event(rating);
`,
  },
  {
    version: 10,
    name: "money_and_broadcasting",
    sql: `
ALTER TABLE promotion ADD COLUMN own_network INTEGER NOT NULL DEFAULT 0;
ALTER TABLE promotion ADD COLUMN own_network_name TEXT;
ALTER TABLE promotion ADD COLUMN subscribers INTEGER NOT NULL DEFAULT 0;
ALTER TABLE promotion ADD COLUMN own_ppv INTEGER NOT NULL DEFAULT 0;
ALTER TABLE event ADD COLUMN broadcast TEXT;        -- 'tv', 'ppv' or 'none'
ALTER TABLE event ADD COLUMN venue TEXT;            -- club, arena, big_arena, stadium
ALTER TABLE event ADD COLUMN ppv_buys INTEGER;
ALTER TABLE event ADD COLUMN ppv_revenue REAL;
ALTER TABLE event ADD COLUMN tv_viewers INTEGER;
ALTER TABLE event ADD COLUMN tv_revenue REAL;
ALTER TABLE event ADD COLUMN sponsors REAL;
ALTER TABLE event ADD COLUMN costs REAL;
ALTER TABLE event ADD COLUMN profit REAL;
CREATE INDEX event_gate ON event(gate);
CREATE INDEX event_ppv ON event(ppv_buys);

-- TV and PPV deals. network_id NULL is never used: owning your own outlet is a flag on promotion.
CREATE TABLE broadcast_deal (
  id                INTEGER PRIMARY KEY,
  promotion_id      INTEGER NOT NULL REFERENCES promotion(id),
  network_id        INTEGER,
  kind              TEXT NOT NULL CHECK (kind IN ('tv','ppv')),
  start_week        INTEGER NOT NULL,
  end_week          INTEGER NOT NULL,
  events_per_year   INTEGER NOT NULL,
  fee_per_event     REAL NOT NULL,
  share             REAL NOT NULL,
  events_this_year  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE ledger (
  id            INTEGER PRIMARY KEY,
  promotion_id  INTEGER NOT NULL REFERENCES promotion(id),
  week          INTEGER NOT NULL,
  amount        REAL NOT NULL,
  what          TEXT NOT NULL
);
CREATE INDEX ledger_promo ON ledger(promotion_id, week);

-- The in-house reality series.
CREATE TABLE reality_season (
  id            INTEGER PRIMARY KEY,
  promotion_id  INTEGER NOT NULL REFERENCES promotion(id),
  number        INTEGER NOT NULL,
  name          TEXT NOT NULL,
  start_week    INTEGER NOT NULL,
  divisions     TEXT NOT NULL,     -- comma-separated weight class ids
  outlet        TEXT NOT NULL,     -- 'own' or a network id
  status        TEXT NOT NULL CHECK (status IN ('airing','finished')),
  episodes      INTEGER NOT NULL DEFAULT 0,
  viewers       INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE reality_cast (
  season_id   INTEGER NOT NULL REFERENCES reality_season(id),
  fighter_id  INTEGER NOT NULL REFERENCES fighter(person_id),
  weight_class_id INTEGER NOT NULL,
  status      TEXT NOT NULL,       -- 'in', 'out', 'finalist', 'winner'
  PRIMARY KEY (season_id, fighter_id)
);
CREATE TABLE reality_bout (
  id          INTEGER PRIMARY KEY,
  season_id   INTEGER NOT NULL REFERENCES reality_season(id),
  episode     INTEGER NOT NULL,
  week        INTEGER NOT NULL,
  stage       TEXT NOT NULL,       -- quarterfinal, semifinal, final
  red_id      INTEGER NOT NULL,
  blue_id     INTEGER NOT NULL,
  winner_id   INTEGER,
  method      TEXT NOT NULL,
  end_round   INTEGER NOT NULL,
  rating      REAL
);
`,
  },
  {
    // AI promotions' broadcast flavor, goal and partners; event card kind.
    version: 11,
    name: "promotion_plans",
    sql: `
ALTER TABLE promotion ADD COLUMN flavor TEXT;
ALTER TABLE promotion ADD COLUMN goal TEXT;
ALTER TABLE promotion ADD COLUMN tv_network_id INTEGER;
ALTER TABLE promotion ADD COLUMN ppv_network_id INTEGER;
`,
  },
];
