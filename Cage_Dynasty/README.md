# Cage Dynasty

> **AI created free game.** Anyone is free to use, copy, modify, share or sell it
> however they wish. It is fully free and open source, and no attribution is
> needed. See [`LICENSE`](LICENSE) (public domain, the Unlicense).

An original MMA promotion management sim. You run a fight promotion inside a
generated world with decades of history: sign fighters, book cards, sell
shows, and follow every fight through play-by-play.

## Stack

| Layer | Choice |
| --- | --- |
| UI | HTML + TypeScript in an Electron desktop shell |
| Sim core | TypeScript, deterministic seeded RNG, runs headless or in the app |
| Database | SQLite save files (`better-sqlite3`), versioned migrations; schema kept portable to Postgres |

All SQL lives in `src/db/repo.ts` and `src/db/migrations.ts`. The sim core never writes SQL.

## Layout

```
src/core/        sim: world generation, weekly loop, fights, careers
src/db/          schema migrations, save-file open, repository (all SQL)
src/cli/sim.ts   headless runner for balance and scale testing
src/app/         Electron main process, preload bridge, renderer page
test/            vitest tests
```

## Run it

```bash
npm install
npm test                                   # unit tests
npm run sim -- --years 30 --scale 1        # headless sim, prints stats
npm run sim -- --years 130 --out saves/big.sqlite
npm run fight -- --seed 7 --rounds 5       # print one fight's play-by-play
npm run fight -- --calibrate 5000          # finish rates and pace vs real-MMA ranges
npm run play -- --seed 5                   # scripted promoter session: book, weigh in, fight, callouts
npm run web                                # play in a browser at http://localhost:5173
```

Desktop app:

```bash
npm run rebuild:electron   # rebuild SQLite's native module for Electron
npm run app
npm run rebuild:node       # switch back before running tests or the CLI
```

## Phase 0 benchmarks (headless, one CPU core)

| Run | Active fighters | Fights stored | Speed | Save size |
| --- | --- | --- | --- | --- |
| 130 years, scale 1 | ~10,200 | 1.55 million | ~1.1 s per sim year | 370 MB |
| 10 years, scale 5 | ~40,000 | 476,000 | ~4.7 s per sim year | n/a |

Career lengths from the 130-year run (retirees with 10+ fights): median 33,
middle half 26 to 39, 1.6% reach 50+, hard stop at 70. A fighter's full fight
history query takes under 1 ms.

## Fight engine (Phase 1)

`src/core/fight/` simulates a fight in 3-5 second steps. Each step, style
profiles, skills, stamina and damage decide who acts and what they try:
strikes (jab to spinning attacks), clinch work, takedowns, ground position
(guard, half, side, mount, back), ground-and-pound, submissions, sweeps,
stand-ups, cuts and doctor checks, knockdowns, rocked fighters, referee and
corner stoppages. Three judges with their own biases score each round 10-9 or
10-8. Events are stored as compact codes and turned into play-by-play text at
view time (`narrate.ts`), so wording can improve without touching saves.

Calibration, 5,000 three-round fights between random fighters:

| Measure | Engine | Rough real-MMA range |
| --- | --- | --- |
| KO/TKO | 33% | 30-35% |
| Submission | 19% | 17-22% |
| Decision | 47% | 45-50% |
| Sig. strikes landed per fighter per minute | 3.4 | 3-4.5 |
| Takedowns per fighter per 15 min | 1.4 | 1-1.5 |

Martial-arts styles (`src/core/fighter-gen.ts` STYLE_SHAPES) shape 23 detailed
stats: punch and kick speed, technique and power, head movement, shots and
sprawl, clinch striking, control, takedowns (trips and throws) and defense, top
game (control, passing, ground and pound, subs) and bottom game (guard
retention, sweeps, subs, getting up). The engine reads them directly: wrestlers
shoot from open range and win on top but are weak off their back, jiu-jitsu is
the mirror image and pulls guard, judo, sambo and Greco throw from the clinch,
sambo is top-heavy with leg locks, MMA-first fighters are blended. Smarter
fighters steer toward their edges (game plan), leg kicks slow a fighter down,
and weak areas round out a little each year. Tuning knobs live in `KNOBS` in
`engine.ts`; `npm run calibrate` prints the overall numbers and a per-style
table (win rate vs the field, shots vs clinch takedowns, top vs bottom time,
where submissions come from). Every style wins 45-58% against the field, with
wrestling on top, as in real MMA.

Favourite win rate by skill gap: 55% (0-3 overall), 66% (3-6), 75% (6-10), 90% (10+).

Fidelity in the world sim: global promotions run every bout through the
engine and keep full play-by-play for main events; major promotions use the
engine without the log; regional and local bouts use the one-roll resolver.

## Booking, weight cuts and callouts (Phase 2)

You run a major promotion. The game screens (desktop app or `npm run web`):

- **Office:** schedule events (1-52 weeks out) and read your news feed.
- **Booking desk** (`src/core/matchmaking.ts`): the shows screen lists your
  upcoming shows with Add, Alter (name, date, region, broadcast, venue) and
  Cancel. The selected show lists its date, place and broadcaster, then the
  bouts split into main card and prelims, each with weight class, belt, an info
  button, move up and down, swap corners and remove. "Add bout" opens a
  matchmaking screen: event, card position, weight class, title and rounds;
  two fighter lists sortable by ranking, name, regional popularity or rating,
  with search (and other divisions for superfights); a panel per fighter (age,
  height, hometown, record overall and in your promotion, style, rank, traits,
  camp time, pay, popularity in the show's region, likely usage, momentum, last
  fight); and a column with the fight's draw for this show and region, an
  estimated betting line, their history, notes and anything that blocks it.
  "Auto-fill card" still books the rest. Cancelled bouts offer replacements.
  Past results show weigh-ins and in-cage moments, with "Book it" on callouts.
- **Fight viewer:** play-by-play for every bout on your cards.

Rules that run every fight week (`src/core/world.ts`, `weighin.ts`, `postfight.ts`, `booking.ts`):

- **Camp injuries:** booked fighters can get hurt in the weeks before the event.
- **Weigh-ins:** risk depends on the cut (walk-around weight vs limit), short
  notice, age, recent misses and professionalism. Outcomes: made, drained
  (starts tired, weaker chin), missed (20% fine, catchweight, cannot win a
  belt, champions are stripped), hospitalised (bout off). Two recent misses
  move a fighter up a division. Across 30 sim years: 2.9% miss, 0.1% hospitalised.
- **Titles:** every promotion above local tier has belts per division, with
  reigns and defenses stored. AI promotions book title fights in main events.
- **Post-fight moments:** winners call out champions, ranked fighters above
  them, or someone who beat them, in a voice set by personality (showman,
  trash talker, quiet, respectful). Veterans retire in the cage with a speech.
  Losers sometimes ask for the rematch. Booking a callout or rematch adds hype.
- **Popularity:** grows with wins, finishes, charisma, titles and big stages.
- **Save and load:** the app reopens your career where you left it.
- **Rankings** (`src/core/rankings.ts`): one score per fighter (rating, tier of
  promotion, belt and defenses, streaks, inactivity) feeds four lists: world
  P4P (top 25 across every company), company P4P, world division (top 25) and
  company division (top 15, champion listed separately). A fighter can be the
  company #1 featherweight, #25 P4P in the world and #1 featherweight worldwide.
  Snapshots every 4 weeks drive the movement arrows.
- **News:** results of other promotions' big cards, title changes, notable
  signings and departures, injuries, retirements and callouts, with an
  importance level so the feed can show headlines only.
- **News front page:** notable items get a written headline and short story
  (`src/core/stories.ts`). The News tab opens like a newspaper: a lead story with
  the fighter's portrait (or the promotion's logo) top right, two shorter
  stories, a row of briefs, then the running feed. Portraits and logos are
  generated SVGs seeded by id, so there are no image files.
- **Fighter profile** (`src/core/profile.ts`): tabs for General (name,
  nickname, date of birth, hometown, height, reach, stance, accolades: belts,
  peak P4P rank, amateur pedigree such as Olympic medals), Health (head, body,
  arms, legs and a career outlook), Standup, Clinch and Ground. The detailed
  stats on those tabs are the ones the fight engine uses.
  Body, arm and leg wear builds up from fights and injuries, heals partly each
  year, and adds to the retirement risk once it gets heavy.

## Superfights, money and broadcasting (Phase 3)

- **Champ vs champ:** two champions can meet up to two divisions apart; the
  lighter one moves up and the heavier belt is on the line. A double champ
  keeps both belts but must defend each within a year (warned 12 weeks ahead)
  or vacate one; the profile shows the defend-by week and a Vacate button.
- **Halls of fame** (`src/core/halloffame.ts`): one per promotion and one
  global. Retired fighters are inducted yearly on a career score, with a
  citation built from their belts and wins. Legends from before the save
  starts are seeded so the halls aren't empty.
- **Traits** (`src/core/traits.ts`): knockout artist, lives on the shot,
  wrestler who loves to strike, brawler, safe fighter, big ego (refuses
  unranked lesser-known opponents and won't fight on the prelims while ranked),
  company man, hometown hero, slow starter. Traits change how the engine fights
  each man and show on the profile. `npm run calibrate` prints win rates by trait.
- **Regional popularity** (`src/core/popularity.ts`): each fighter has a
  popularity per region, built mostly where he fights. Events are held in a
  region, and booking shows what slot each fighter draws there (main event,
  main card or prelims).
- **Cards and ratings** (`src/core/excitement.ts`): the top five bouts are the
  main card, the rest are prelims. Every fight gets a 0-100 rating; the card
  rating weights the main event most, then the co-main, then the main card, with
  prelims counting a little. The best fight over the bar wins Fight of the Night.
- **Money** (`src/core/business.ts`): cash and a ledger per promotion. Gate and
  PPV are tracked separately per event, with TV viewers, sponsors, costs and
  profit. Venues run from a 3k club to a 50k stadium.
- **Broadcasting:** sign with a fictional TV network (Northlight Sports, Atlas
  Broadcasting, Harbor TV, Vantage One) for a fee per event and a yearly event
  quota, or a PPV platform (Ringside Direct, PayView Network) for a share of
  buys. Or launch your own network (subscriptions) or your own PPV platform.
  Each event is TV, PPV or neither, so a hybrid model works: TV cards most
  weeks and PPV for the big ones.
- **Reality series** (`src/core/reality.ts`): "The Proving Ground" casts 8
  unsigned prospects in each of two divisions and airs one bout a week on your
  TV outlet, through quarterfinals, semifinals and a final. Winners and
  finalists sign with you.
- **Records:** highest gate, highest PPV buys, best and worst card, best and
  worst fight, most Fight of the Night bonuses, per promotion or worldwide, on
  the Business tab.

- **AI calendars** (`src/core/schedule.ts`): every AI promotion has a size, a
  broadcast model and a goal. Models: PPV-led (a numbered PPV every month and TV
  Fight Nights between, about 42 cards a year), Hybrid (TV most weeks, PPV for
  the biggest title fights), All TV, Own network, and Grassroots (untelevised
  shows). Goals: prestige (bigger rooms), profit (fewer, cheaper cards), growth
  (more cards, shows on the road) and development (signs young prospects).
  Size sets the pace: globals run a card nearly every week, majors about every
  other week, regionals about one TV card a month, locals 6-10 small shows.
  A planned PPV without a title fight or real stars moves to TV. Each new year a
  promotion replans: it cuts back after losses and expands when rich and growing;
  one deep in the red is rescued by new investors. AI promotions pay running
  costs per card and reinvest most of their profit. The World tab shows each
  promotion's model, goal, partners, calendar, next card and cash.
- **Stress test:** `npm run stress -- --years 8` runs a full career and prints,
  per year, cards and money by size and model, popularity, and any broken
  invariants (double bookings, champions not on the roster, empty events).

## What exists vs. what is next

Phase 0: schema, world generator, weekly sim, careers, headless runner.
Phase 1: fight engine, judges, play-by-play, fight viewer.
Phase 2: player promotion, booking desk, rankings, titles, camp injuries,
weigh-ins and weight cuts, callouts and speeches, save/load, browser mode,
world and company rankings, news feed.
Phase 3: styles, traits, regional popularity, superfights, halls of fame,
card ratings, money, broadcasting, reality series, records.

Known gaps: your roster is still filled automatically from free agents
(signing is Phase 4), purses are not paid out yet, and the 30-year headless
sim is about 3.5 s per sim year because of rankings, the hall of fame and the
business ledger.

## License

AI created free game, released into the public domain under the Unlicense
([`LICENSE`](LICENSE)). Use and modify it however you like; no attribution needed.
