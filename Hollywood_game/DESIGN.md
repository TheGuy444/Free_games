# TOWN HALL — Hollywood Studio Tycoon :: Game Design Document

> Living spec. Everything the game must do is written here so nothing gets lost.
> Keep this file updated when a feature is added / changed / cut.

---

## 1. High concept

A long-horizon **Hollywood studio tycoon** sim (in the spirit of *Hollywood Mogul*,
*Game Dev Tycoon* and *Empire of the Ants* economy sims). You found a studio in
1920, and over **decades** you:

* **hire writers** or **buy scripts** off the open market,
* **cast actors** from a huge persistent actor database (thousands of careers
  simulated across decades),
* **build productions** — budget, props/sets/VFX upgrades, genre, director,
* **release films** whose success comes from genre-vs-trend fit + star power +
  craft + randomness — including **cult classics** and **absolute stinkers**,
* survive **world events**: actor strikes, world wars, blacklists, pandemics,
  antitrust decrees, the arrival of TV / colour / CGI / streaming,
* build **franchises/series**, resurrect **dead franchises as reboots**, and
* **sell IP rights** to rivals — the *"Marvel sells Avengers in the 70s"*
  mechanic: cash now, and the agony of watching someone else farm it later.

**Win condition:** no hard win. Score = studio valuation. Stretch goals:
survive to 2020, own a 8-film+ franchise with >$4B cumulative gross, win
10 Best Pictures, discover an unknown into a megastar, make a $0-budget cult
classic.

---

## 2. Non-negotiable pillars

1. **Decades of simulation must be fast.** Target: 5,000+ actors, 100 years
   (5,200 weekly ticks) headless in seconds; interactive weekly ticks < 25 ms.
2. **One persistent, queryable universe.** Actor DB, script market, rival
   studios, trends, IP ownership all live in SQLite, not in a Python dict that
   dies with the request.
3. **Determinism.** Same seed ⇒ same history. Every random draw derives from
   `hash(seed, entity_id, tick)`. Save/load is just a tick + a few counters.
4. **Everything the UI shows comes from an API.** No hardcoded UI data.
5. **No third-party dependencies.** Python stdlib + SQLite + vanilla JS.

---

## 3. Technology plan

| Layer | Choice | Why |
|---|---|---|
| Backend | Python 3 stdlib `http.server.ThreadingHTTPServer` | zero deps, JSON API |
| Storage | SQLite (WAL, `synchronous=NORMAL`), indexed | scale + persistence + set-based updates |
| Sim | Tick engine, weekly ticks, **set-based SQL bulk updates** for population churn | speed |
| RNG | SplitMix64 derived per-entity streams + per-row LCG stored in SQL | determinism without Python loops |
| Frontend | Single-page HTML/CSS/JS dashboard, canvas charts, `fetch` API | no build step |
| Perf tricks | server-side pagination/sorting for actor tables; hot-cache of relevant actors; fast-forward mode that batches ticks in one request | rich DB stays snappy |

Directory layout:

```
hollywood/
  DESIGN.md            <- this file
  README.md            <- how to run
  run.py               <- entrypoint (starts server)
  setup.sh             <- creates .venv (optional), no external packages needed
  game/
    config.py          <- all tuning constants, genres, eras, events, upgrade tiers
    names.py           <- procedural name pools
    rng.py             <- SplitMix64 / streams / SQL-LCG helpers
    db.py              <- schema, migrations, pragmas, connection mgmt
    state.py           <- game meta, date math, new-game bootstrap
    sim/
      engine.py        <- tick orchestration (weekly / monthly / yearly passes)
      world.py         <- eras, trends, world events
      events.py        <- event definitions + effect application
      actors.py        <- generation, careers, aging, fame, death, contracts
      casting.py       <- open calls / talent discovery / role audition results
      scripts.py       <- writers, script market, optioning
      production.py    <- pre-production, shooting, post, upgrades, hazards
      boxoffice.py     <- scoring, release, gross, cult classics, awards
      franchise.py     <- series, sequels, reboots, IP rights sale/buyback
      economy.py       <- cash, loans, overhead, rivals, valuation
      rivals.py        <- rival studio aggregate behaviour
    api.py             <- JSON routes
    server.py          <- HTTP + static file serving
    web/index.html, app.js, style.css
  saves/               <- sqlite game saves (one file per save)
  tests/               <- headless sim + perf smoke tests
```

---

## 4. Time model

* Start year selectable: **1920, 1930, 1950, 1970, 1990**.
* **Tick = 1 week.** 52 weeks/year. Weeks 0-51. Months derived `week//4`.
* Speeds: `pause`, `1x` (weekly ≈ 700 ms real), `4x`, `MAX` (run 5/26/52 weeks
  per request — used for the "fast forward" button and for tests).
* Yearly milestones (week 51 → new year): awards ceremony, actor aging/death,
  decade change, catalogue revenue, rival expansion, franchise heat reset.

---

## 5. Eras & trends

**Genres (10):** `drama, comedy, action, sci-fi, horror, western, musical,
crime, romance, animation`. Subgenres add flavour + trend specificity
(e.g. `film noir`, `screwball`, `space opera`, `slasher`, `superhero`,
`animated feature`).

Each genre has a **heat** value `h ∈ [0.25, 2.2]`, mean-reverting random walk:
`h' = clamp(h + decay*(1-h) + shock + event_shock + noise)`.
Heat drives: box-office multiplier, audience demand, script market supply,
which actors are hot.

**Eras** (decade-flavoured biases + unlocks + set pieces):

| Era | Bias / unlock |
|---|---|
| 1920s | silent western/comedy huge; animation born. No sound tech. |
| 1930s | **Sound** unlock; musicals & horror boom; Great Depression → escapist bias; Hays Code censor content |
| 1940s | **WWII**: draft, rationing, propaganda prestige, blackout on some genres |
| 1950s | **TV Boom**: theatrical attendance structural decline; epics & sci-fi respond |
| 1960s | blacklist thaw, New Hollywood begins, franchise thinking starts |
| 1970s | blockbuster era: action/sci-fi heat ceiling rises, big opens |
| 1980s | merchandising + VHS home video revenue line; sequel epidemic |
| 1990s | CGI/VFX arms race, animation renaissance, multiplexes |
| 2000s | franchise dominance, sequels/remakes supply, global box office |
| 2010s | **superhero** heat spike, streaming begins (theatres weaken) |
| 2020s | streaming war, IP saturation, event-film-or-bust |

Tech unlocks (`sound, colour, widescreen, tv, vhs, cgi, imax, streaming`) gate
production-value ceilings, genre viability and new revenue lines.

---

## 6. Actor universe

### 6.1 Actor record
`id, name, birth_year, age, gender, photo_hue (generated avatar),`
**craft skills 0-100**: `drama, comedy, action, musical, dance, stunts, voice, drama_comic_balance`
**traits 0-100**: `charisma, discipline, versatility, bankability, ego,
scandal_prone, substance_risk, reliability, likeability, press`
**state**: `fame 0-100`, `star_power` (derived), `bankability` (derived),
`draw` (audience pull), `career_status ∈ {unknown, working, star, blacklistable,
retired, dead, deceased}`, `studio_contract_id?`, `fee_per_film`,
`stats`: films, leads, awards, nominations, biggest_gross, decade_active bits,
`hidden`: true_skill vs *perceived* skill (the player sees a scout report with
error bars — you can misjudge someone), `cult_following 0-100`.

### 6.2 Career simulation (set-based, yearly)
* Fame decays toward baseline (`fame * 0.93 + recency_bonus`).
* Skill grows with work; declines after 60; `stunts` falls faster.
* Retirement: age threshold from per-row LCG (55-80) or scandal.
* Death: age-based mortality curve + vices + event modifiers (war, pandemic).
* Legend/cult preservation: cult_following keeps `deceased` actors monetizable
  (archive footage, biopics, estate licensing).
* Newcomers **only** enter via the casting pipeline (§7) — nothing spawns from
  nowhere. (Initial universe generation happens once at game start and is
  labelled as the "studio records of the era".)
* Actors move on the **talent market** with an asking fee; player can sign
  multi-picture deals (cheaper per film, blocks the actor, guaranteed availability).

### 6.3 Player-actor interactions
Hire per-film · sign N-picture contract · fire/buy out · loan to rival
(cash + favours) · invest in rehab/coach (skill/reliability up, cost) ·
publicity push (fame up, scandal risk) · typecast (genre skill up, versatility
down) · blacklist (fame crash, availability up = cheap talent).

---

## 7. Casting mechanism (**how new actors enter the universe**)

* Every month the industry holds **open calls**. A pool of *discoveries* is
  generated procedurally: age 16-30, skewed skill distribution, rare
  "generational talent" outliers (1-2%), looks/charisma variance, era-flavoured
  names.
* The player may fund an **open call** (cost ↑ with scale): bigger spend ⇒
  bigger, better pool + guaranteed first-look. Rivals pick up whoever you pass
  on — so a passed-over star can become a rival's moneymaker.
* **Casting calls per role**: for each role in a production you post a breakdown;
  interested actors submit; you get a ranked shortlist with scout reports
  (perceived skill, chemistry estimate, fee, availability, risk flags).
* Chemistry: pairwise value from charisma/likeability/gender-age-fit/genre fit —
  real mechanic for "will this pairing sell tickets". Franchise casting persists
  (recasting a franchise lead = fan backlash unless justified by a reboot).
* Unknowns who land lead roles in hits become stars fast (fame feedback loop) —
  this is the "discover Audrey/Brando/Monna" fantasy.

---

## 8. Writers & scripts

### 8.1 Writers
`skill 0-100`, genre affinities, `fee` or `salary`, `productivity` (weeks per
script), `ego`, `alcohol`, `awards`. Hire as **staff** (weekly salary, you own
output, can be poached by rivals) or **freelance** (per script).
Writer room: assign multiple writers → quality up, cost up, style clash risk.
Writers improve with hits and get poached when famous; sequels can reuse the
same writer for continuity bonus.

### 8.2 Script record
`title, genres[], subgenre, quality (true) + reported_quality (with error),
franchise_potential 0-100, scale ∈ {short, indie, standard, epic, blockbuster},
budget_hint, hazard_modifier, content_tags (violence/romance/comedy/dark),
status ∈ {market, optioned, owned, produced, dead}`, writer, era_fit.

### 8.3 Script market
* Staff writers produce scripts → they land in your library.
* Market refreshes monthly with freelance/rival-writer scripts; supply and price
  scale with genre heat (hot genre = expensive, scarce).
* **Coverage**: pay a reader to reveal quality range & franchise potential
  (better coverage = smaller error). Buy blind = gamble (cheap stinkers, cheap
  masterpieces).
* Option fee (cheap now, % on production) vs full purchase (cash, full ownership).
* Rewrite/development: spend weeks+cash to raise quality, change genre, add
  franchise potential; risk: script collapses into development hell (writer quits,
  you lose most of the spend), or it becomes a legendary script (bidding war).
* Rewriting a dead franchise's script = **reboot pathway** (§11).

---

## 9. Productions

Pipeline: `greenlit → development → pre_production → shooting → post_production
→ ready → released (→ vaulted)`

### 9.1 Setup choices
Genre + subgenre · target audience/content rating (studio code constraints in
30s-60s) · **scale/budget** · shooting weeks · director (skill, vision,
temperament, discipline, hit history) · DOP/composer/editor as hireable
crafts (simplified to "department heads") · **role slots** (leads/supporting/
cameo, each with required genre skill, age range, gender, action/dance flags,
screen time weight).

### 9.2 Quality model (Game-Dev-Tycoon style, with chaos)
```
q = w1*script_quality
  + w2*cast_fit          (per-role: actor genre skill vs role need, weighted by screen time)
  + w3*chemistry         (lead pairing)
  + w4*direction
  + w5*production_values (sets/costumes/props/VFX/score/cinematography, genre-weighted)
  + w6*era_trend_fit
  + modifiers(traits, hazards, star clashes, censor cuts, rushed shoot, overtime)
final_quality = clamp(q + luck, 0, 100)
```
Genre weights differ: sci-fi/action lean VFX+sets, musicals lean dance+score+
casting, drama leans script+acting. Animation requires voice cast + VFX/sets and
no live shoot (or reduced).

### 9.3 Upgrades (props etc.)
Categories with tiers `T0..T6` (rented → studio-grade → state of the art):
`sets, costumes, props, special_effects, sound_stage, score, cinematography,
stunt_team, marketing_kit`. Each tier: `cost(scale, era_tech)` + `craft value`.
Per-genre weights. Some tiers require a tech unlock (colour film, CGI).
Marketing is its own spend line with diminishing returns and a **premiere**
event option.

### 9.4 Hazards (production-scoped, drawn from world state)
Lead injury / scandal / arrest / death mid-shoot · director meltdown or firing ·
weather/natural disaster on set · budget overrun & cost blowout · studio audit ·
censor cut demand · blacklisting · union slowdown/strike · animal/child actor
limit · substance relapse · lawsuits · rival poaches your star · prop fire on
backlot · bad test screening → reshoots (spend to fix quality) · **shutdown**
(event driven: war/strike/pandemic halts all shoots; you may move a shoot
overseas at extra cost & risk).

Every hazard produces a **headline** in the timeline with choices when
meaningful (pay hush money / drop actor / recast mid-film / delay / push on).

---

## 10. Release, box office, reception

### 10.1 Reception
`critics = f(quality, director prestige, genre bias, awards ambitions)`
`audience = f(quality*0.6 + star power + marketing + hype + trend fit)`
`word_of_mouth = audience` drives legs (multiplier on total gross).
Opening = `base(era) * star_draw * marketing_reach * trend_mult * quality_curve`
Total = `opening * legs(wom)` (0.6 → 4.5). Split: exhibitor cut ~50%, distribution
fee, studio net; plus **secondary lines**: home video (VHS/DVD/-streaming by
era), TV licensing, merchandise (franchise only), re-releases, foreign market
growth over decades.

### 10.2 Outcome tiers
`MASTERPIECE / HIT / SOLID / TROUGH / FLOP / STINKER` + special:
* **CULT CLASSIC**: moderate-or-bad opening, high `cult_score` (from quality
  that missed its era, extreme camp, so-bad-it's-good, controversial content,
  or franchise root with loyal fans). Effects: growing annual royalty income,
  fame creep for its stars for decades, reboot/remake value, licensing offers,
  "30th anniversary re-release" events.
* **STINKER**: box-office bomb, Razzie, reputation hit — but can become cult.
* **PHENOMENON/BLOCKBUSTER**: >10x budget: franchise auto-flag, merchandising,
  theme-park attraction offers, rival imitation flood (genre heat spike then
  crash — oversaturation).

### 10.3 Awards (annual)
Best Picture, Director, Lead Actor/Actress, Screenplay, Technical/Crafts, plus
**Razzies**. Wins: prestige ↑ (attracts better writers/actors, cheaper loans,
better distribution terms), actor fame ↑, script values ↑ for the writer.
Awards campaigning is a spendable line item. Snubs → press event (hype).

---

## 11. Franchises, series, reboots, rights (the Marvel mechanic)

### 11.1 Series
* Any release can be **promoted to a franchise root** if `franchise_potential`
  and performance pass a threshold (or you force it — risky, fans laugh).
* `franchise(id, name, root_movie, fan_base, heat, continuity, installments[],
  status ∈ {active, dormant, dead, sold_off}, rights_holder, license_years)`
* Sequels inherit `fan_base` → guaranteed opening floor + marketing synergy, but
  **fatigue**: installments/decade beyond 2 decay heat; quality drop-off if you
  churn them; recasting leads = backlash; a hit reboot can restore heat.
* Series planning: 3-arc slate ("Phase 1") bonus for interconnected slates —
  shared cast and continuity → crossover bonus and valuation boost.
* TV series spin-off (from TV era on): steady income, fame support, no box office.

### 11.2 Reboots / conversions
* `Convert movie → franchise` (back-catalogue click).
* Dormant (no installment 12+ yrs) → `dormant`; 25+ → `dead`. You may **reboot**:
  new script (or remake of root script, cheap & high franchise_potential),
  modern trend fit bonus, purist backlash risk if trend/genre mismatch or weak
  cast, `legacy_fan_base` partially transfers, "reboot fatigue" world modifier if
  the industry reboots too much.
* Remake rights of *other studios'* dead franchises can be **licensed** (you pay,
  you make, revenue split) — so IP graveyard is a live market.

### 11.3 Selling rights (cash now, future agony)
Sellable assets:
* **Single film rights** (you lose re-release/TV/royalty income of that title).
* **Franchise IP outright** (no sequels ever again for you; buyer farms it).
* **Distribution rights only** (cash now, keep IP + a back-end percentage).
* **Merchandise/licensing rights** (fixed annual fee vs. royalty %).
* **Option on character rights with expiry** — the classic 1970s Avengers blunder:
  sell cheap with a "reverts if not filmed in 7 years" clause... or don't.
Buyer price formula = `NPV(future exploitation, buyer_appetite) * scarcity *
your_reputation * negotiation`, with **hidden rival buyer interest** so you can
hold out — and occasionally lose the deal. Rival studios get smarter/richer over
decades, so early sales are cheap-looking in hindsight: the UI shows an
"Opportunity Cost" column (what that IP *would* have earned you by 2020) to make
the regret land.
* **Buyback**: possible at premium (`market * 1.6+`) if the current holder is
  insolvent or you win a bidding war — sometimes permanently impossible.
* Selling your **studio's own library** in a cash crunch = survival mechanic with
  a lasting prestige/valuation wound.

---

## 12. World events

Data-driven definitions with effect hooks; each has: `id, name, era_weight,
duration_weeks, severity, headline, choices?, effects{}`.
Effect hook vocabulary: `halt_production, production_speed_mult, cost_mult,
salary_inflation, revenue_mult, attendance_mult, trend_shock{genre:±x},
script_supply_mult, actor_mortality_mult, actor_unavailable(draft),
credit_mult (loans), prestige_mult, marketing_mult, censor, home_video_mult,
franchise_heat_mult, rival_aggression`.

Canonical events to implement (min. set):
**Great Depression**, **WWII** (draft + propaganda + rationing), **Actor strike**,
**Screenwriters' strike**, **Blacklist / HUAC**, **Antitrust decree** (must divest
theatres → revenue cut), **Paramount boom**, **TV arrival**, **Hays Code
enforcement**, **New Hollywood wave**, **Blockbuster era dawn**, **80s recession**,
**VHS boom**, ** CGI revolution**, **Animation renaissance**, **Streamers
arrival**, **Pandemic**, **Talent-poaching war**, **Backlot fire**, **Payola /
scandal era**, **Franchise fatigue**, **Reboot fatigue**, **Writers' room
revolt**, **Rival merger** (fewer buyers for your IP... or richer ones),
**Star death of the decade**, **Award season scandal**, **Exchange-rate shock**
(foreign box office), **Oscars snub backlash**.

Also **market events**: buyer offers for your titles/franchises, talent dying
(their estate auctions rights), a rival going bankrupt (buy their library cheap).

---

## 13. Economy

Cash, weekly overhead (lot, staff payroll, insurance), loan lines (interest from
reputation), distribution deal (fee % vs. advance), theatre ownership (pre-1949,
then forced divestiture = scripted event), lot buildings/upgrades (sound stages,
backlot sets, VFX lab, casting office, writer's rooms, marketing dept) each giving
bonuses and unlocking tech. **Valuation** = f(net worth, prestige, franchise
portfolio NPV, library NPV, cashflow, debt). Rival studios have cash +
appetite for IP; they compete for genre heat and talent.

---

## 14. GUI (HTML dashboard)

Top bar: studio logo/name, date (week/year), cash, prestige, reputation,
valuation, speed controls (⏸ ▶ ⏩ ⏭ + "run 1 year"), event ticker.

Tabs:
1. **Lot** — active productions, deadlines, cash flow sparkline, headline cards,
   quick actions.
2. **Talent** — the big actor database: server-paginated, sortable, filterable
   (era, age, fame, skills, availability, contract, alive/legend), detail drawer
   with career graph, contract actions.
3. **Casting** — open calls (fund one), discovery pool, auditions per open role,
   shortlist with scout reports + chemistry matrix.
4. **Writers & Scripts** — staff/freelance market, your library, coverage,
   development, assign to production.
5. **Production** — per-film view: schedule bar, budget allocation sliders,
   upgrade tiers grid, cast table (role → actor), hazard log, quality forecast
   (with uncertainty band), test screening.
6. **Releases** — catalogue table (title, year, genre, budget, gross, critics,
   audience, outcome badge, cult badge, rights holder), box office chart by year,
   genre performance chart.
7. **Franchises** — series cards (fan base, heat, installments, status), plan
   sequel / reboot / spin-off, sell rights modal with offers & opportunity cost.
8. **World** — active events with effects & remaining weeks, timeline of history,
   trend heat bars per genre, era tech tree.
9. **Finances** — P&L, loans, valuation breakdown, IP deals ledger, insurance.
10. **Awards** — history of wins/noms, campaign control.

Design language: art-deco dark, gold accents, film-grain, Oscar-gold on black,
responsive grid, tiny sparklines in tables. Keyboard: `space` pause, `1/4/9` speed.

---

## 15. API surface (JSON over HTTP)

`POST /api/new_game {name, start_year, cash_preset, seed}` · `GET /api/state`
(dashboard payload) · `POST /api/tick {weeks}` · `GET /api/actors?search&sort&
filter&page` · `GET /api/actor/{id}` · `POST /api/actor/hire|contract|fire|
invest|blacklist` · `GET /api/casting/pool` · `POST /api/casting/open_call` ·
`GET /api/production/{id}/auditions` · `POST /api/production/create` ·
`POST /api/production/{id}/set_budget|upgrade|cast|director|test_screen|shutdown` ·
`GET /api/scripts/market|library` · `POST /api/scripts/buy|option|assign|develop|
writer/hire` · `GET /api/releases` · `POST /api/franchise/create|sequel|reboot|
sell|buyback` · `GET /api/franchises` · `GET /api/world` · `GET /api/finance` ·
`POST /api/finance/loan|repay|build` · `GET /api/events/log` · `POST /api/save`,
`/api/load`, `GET /api/saves` · `POST /api/reset`.

All list endpoints support `page/limit/sort/dir/q/filter` — the UI never pulls
the whole actor universe.

---

## 16. Performance targets & techniques

| Target | Technique |
|---|---|
| 5,000 actors, 100 years | yearly **set-based** SQL updates (`UPDATE actors SET ... WHERE ...`) instead of Python row loops |
| Deterministic per-actor noise | per-row LCG column `r` advanced in SQL, `noise = (r % 1000)/1000` |
| Weekly tick < 25 ms | only small hot sets touched in Python: active productions, contracted actors, event list |
| Actor list UI instant | SQL indexes + `LIMIT/OFFSET` + server-side sort/filter, plus `q` on indexed name |
| Fast-forward 1 year | one request, batched ticks, single transaction; progress returned |
| Save = instant | SQLite file copy; state = `game` row + tick |

Benchmark recorded in `tests/` output; run `python -m tests.test_sim --bench`.

---

## 17. Build order (checklist)

- [x] P0 Design doc, repo skeleton, SQLite schema, tick engine skeleton
- [x] P1 Universe gen (actors, writers, rivals), trends/eras, weekly tick + fast-forward
- [x] P2 Talent market, hiring/contracts, open-call casting pipeline, auditions, chemistry
- [x] P3 Writers, script market, coverage, option/buy, development
- [x] P4 Productions: budget, upgrades (props/sets/VFX...), directors, quality forecast, hazards
- [x] P5 Release + box office + reception + cult classics + stinkers + awards
- [x] P6 Franchises: series, sequels, reboots, conversions, rights sale/buyback/licensing
- [x] P7 World events (min. set above) with UI headlines + choices
- [x] P8 Finances: loans, lot buildings, valuation, secondary revenue lines
- [x] P9 Dashboard polish: charts, drawers, modals, keyboard speed control, save/load
- [x] P10 Perf tests + tuning pass, README
- [ ] P11 Nice-to-have: agent negotiations, international release markets, festival
      circuit (Cannes/Venice), Razzie night, biopics of deceased legends, director's
      cut, test-audience-driven reshoots UI, multi-slate "phase" planner, achievements.

---

## 18. Tuning backlog (things to balance after playing)

* Cult classic trigger rate (want ~4-8% of releases, not 20%).
* Stinker rate ~8-12%; must be survivable early, catastrophic late.
* Franchise fatigue slope; reboot bonus vs. backlash.
* Early-game money curve: 1920 start must not soft-lock (3 cheap genre scripts).
* Star salary inflation vs. fame feedback (avoid runaway A-list pricing).
* IP sale price curve: early sales should look obviously cheap by 1980.


---

## 18. The press (added)

* **Reviews** (`sim/press.py`, table `reviews`): on release, four era-appropriate
  fictional outlets score the picture out of ten from the critics' number
  (popcorn outlets lean on the audience, snob outlets on drama). Verdict word by
  the average. Each cast member gets a performance score
  (`fit*0.45 + craft*0.15 + charisma*0.08 + quality*0.22 - 8 ± 8`) and a grade
  (Standout/Strong/Fine/Weak/Miscast). The critic names the lead standout, the
  best supporting turn (≥68) and anyone below 42. Fame bumps: named star
  `+1.5 + 0.9*(score-5)`, praised support `+1 + 0.7*(score-5)`, other standouts
  +1, the singled-out weak link `-(1 + (42-perf)*0.06)`. Headline + "why"
  subhead from outcome, critics/audience split, heat, star power, word of mouth,
  marketing, fatigue and returning cast. Unseen reviews pop up in the dashboard.
* **News** (table `news`, sections front/release/review/boxoffice/stars/world/
  awards/records/business). World and industry log lines are mirrored in.
  Yearly: deaths, retirements and new stars among notable actors. Monthly:
  a gossip item (scandal-prone actors draw the bad ones; small fame effects).
* **Box office chart** (`sim/charts.py`, tables `box_runs`, `chart_hist`):
  each release gets a run, `decay = 0.42 + 0.30*legs_norm + 0.12*(wom-1)`,
  10-40 weeks, opening sized so the run sums to the booked gross. 7-10
  independent releases a week fill the chart. Ranking and record counters are
  one `UPDATE ... FROM (ROW_NUMBER() OVER ...)`. Top 10 of every week is kept
  for back issues. Records are checked weekly against `kv.records_v1`.
* **Typecasting** (`sim/typecast.py`, table `actor_genre`, `actors.labels`):
  XP per credit (lead 1.0, supporting 0.6, cameo 0.3, +0.35 standout). First
  label at ≥2.5 XP and ≥40% share; further labels at ≥2.5 XP and ≥22% share
  (less for versatile actors); kept while share ≥12%; max 4. Off-screen
  credits (history before the game, loan-outs, the yearly "town makes stars"
  pass) are booked yearly to the actor's best-fit genres. Effects: +3 fit in a
  label's genre, +1.5 everywhere for 3+ labels; each credit nudges the genre's
  core skill.
* **Acting awards**: rival releases now have a lead; if none of our leads win
  an acting category, the best rival lead does. Player win odds unchanged.
