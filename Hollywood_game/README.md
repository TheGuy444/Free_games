# Hollywood Tycoon

A studio-management simulation: you found a film studio, buy scripts, cast stars,
ride trends, survive depressions and talkies and streaming, and try to own the
century. Design is spelled out in [`DESIGN.md`](DESIGN.md).

No internet, no dependencies: **Python standard library + SQLite + vanilla JS.**

## Run it

```bash
python3 run.py                    # dashboard at http://localhost:8000
python3 run.py --new              # found a new studio first
python3 run.py --port 9000 --host 0.0.0.0      # reach it from your phone
python3 run.py --list             # list saved studios
python3 run.py --load 1938_foo.sqlite          # resume one
python3 run.py --headless --years 30 --start 1928 --seed 7   # no browser, just play
```

One SQLite file per studio in `saves/`. The world saves itself as the calendar
moves — there is no save button to forget.

Requires Python 3.10+ (3.13/3.14 fine). Nothing to `pip install`.

## The loop

1. **Scripts** — read coverage, buy or option a script, put a staff writer to work.
2. **Greenlight** — pick scale (poverty quickie → event picture), budget, prints &
   ads, hire a director.
3. **Cast** — audition per role: fit, chemistry, fee, scandal risk. Or hold an
   open call and find a face nobody has priced yet.
4. **Shoot** — phases tick week by week (development → pre-production → shooting →
   post). Hazards and world events interrupt. Test screenings tell you what you
   already fear; reshoots cost money and time.
5. **Release** — critics, audiences, word of mouth, box office. Phenomenon to
   stinker. Cult classics find their own audience years later.
6. **Own it** — turn a hit into a series, farm it, or sell the rights to a rival
   for money today and regret tomorrow.

## The press (newspaper, reviews, typecasting)

* **Release reviews.** Every picture you open pops up *The critics have spoken*:
  a critics' score (Fresh / Rotten) and an audience score, four outlets'
  marks out of ten, a verdict word from *Unwatchable* to *Masterpiece!*, and a
  write-up that names who carried the picture, who was great in support and
  who was miscast. The people named get a fame bump (or a dent), and the
  headline explains *why* it hit or flopped (hot genre, star power, word of
  mouth, missing leads, series fatigue...).
* **The Daily Marquee** (Newspaper tab). Front page, reviews, new releases,
  the stars (deaths, retirements, breakouts, gossip), world news, awards, a
  box office wire and back issues for every week you have played.
* **Weekly box office chart.** Top 10 / 50 / 100 with last week's position,
  weeks in release and weeks at #1. Our pictures, the rivals' and a steady
  stream of independents all play out week by week (our money is still
  booked on release - the chart is how the run *looks*).
* **Record book.** Most weeks at #1, longest unbroken #1 run, most weeks in
  the top 10 / 50 / 100, biggest opening, biggest gross - all-time and ours.
  Breaking a record makes the paper.
* **Actor awards.** Every acting statuette in town is tracked (rival pictures
  now have leads, so someone always wins). Each actor shows their trophy
  shelf and the pictures they won for; the Awards tab ranks the most
  decorated performers.
* **Typecasting and range.** Actors start unassigned. Keep casting someone in
  Westerns and they become a *Cowboy*; they can carry several labels
  (*Action Star*, *Comedienne*, *Scream Queen*...) and the more they carry the
  more range they have. A label plays its own genre a little better (+3 fit);
  three or more labels make an actor a little better at everything (+1.5).

Time runs at four speeds (space to play/pause, Enter for four weeks), and the
calendar is simulated a week at a time so everything stays consistent.

## Titles: a bag, not a dice roll

Titles are built from large word tables (adjectives, nouns, tails, places,
names, single words, phrase templates, genre flavour words). Each world keeps
a bag of every title already used, including yours, rivals', indies' and the
script market's, and never draws the same one twice. Reboots keep the name
but get a fresh title ("...: Begins", "The New ..."). Sequels get a new
number or subtitle.

## Selling a series: rivals can borrow

A rival bidding for one of your series can take a bank loan secured on the
series itself, on top of its own cash and credit line. How much it borrows
depends on how aggressive the studio is (70-90% of the price). The bank wants
a down payment and lends only what the series' sequels and the studio's own
pictures can pay back. The rights desk shows how much of each bid is borrowed.
The buyer then pays 6% interest and 10% of the principal every year.
An over-borrowed studio can go under, and then the series turns up at the
estate sale. A bought series keeps selling on the audience it had with you.

## Characters, spin-offs, team-ups and icons

A series is a run of pictures; a **character** is who audiences come back for.
Each series gets named characters from the cast of its first picture, and a
supporting part that steals a series picture (a "Standout" review) becomes a
new character with a **breakout** tag.

* Characters keep their own fans. Sequel parts are named after them, and
  casting offers their actor back first. A reboot keeps most of their fans
  even when the series' own audience has gone.
* **Spin-off**: a breakout gets a series of their own (franchise screen,
  "Spin off"). The character moves to the new series and takes their fans.
* **Team-up**: put characters from two or more of your series in one picture
  (Series & libraries, "Team-up..."). It pools their audiences and becomes a
  series of its own. A hit feeds fans back to every member series, and a flop
  costs them all. Each team-up in a run draws a little less, and crowded casts
  are harder to write.
* **Icons**: a character with a second life (a reboot or their own series),
  or a long run through several faces, who stays loved. Icons barely fade,
  get a bigger reboot bump, shrug off recasting and earn licensing money
  every year. Characters go with their series when you sell it.
* Rival studios spin off characters and build team-ups too, rarely before
  2000. Their long-lived or twice-rebooted series become icons.

`python3 run.py --observe --years 100 --start 1920 --seed 7 [--autoplay]`
runs the town unattended and prints studio rise and fall, sequel share by
decade, series lengths, spin-offs, team-ups and icons.

## Layout

```
run.py                launcher (dashboard, headless play, save listing)
game/
  api.py              JSON API - the only thing the dashboard talks to
  server.py           stdlib threaded HTTP server (static + /api)
  config.py           every tuning table: genres, era curves, box office, events
  db.py               SQLite schema + helpers (WAL, one file per studio)
  state.py            World object: cash, prestige, reputation, ledger accrual
  universe.py         procedural world generation (thousands of actors, writers,
                      directors, rivals, a script market)
  names.py            name/title generation
  rng.py              deterministic RNG: seed + stream + entity + tick
  sim/
    engine.py         the week tick, year tick, fast-forward, end conditions
    world.py          trends, era drift, technology unlocks
    actors.py         aging, fame, fees, contracts, coaching, poaching
    casting.py        open calls, discovery pool, auditions, imperfect scouting
    scripts.py        script market, coverage, options, writers on staff
    production.py     greenlight to picture-ready: roles, upgrades, hazards
    boxoffice.py      release, word of mouth, outcomes, awards, library income
    franchise.py      series, sequels/reboots, rights offers, sell-down, buyback
    economy.py        overhead, loans, lot buildings, valuation
    events.py         world events and the decisions they force
    rivals.py         competing studios, bankruptcies, estate sales
    press.py          release reviews, headlines, the newspaper, stars & gossip news
    charts.py         weekly box office runs, top-100 chart, record book
    typecast.py       actor labels (Action Star, Cowboy...) and range
  web/                dashboard (index.html, app.js, views.js, views_b.js, views_c.js, style.css)
tests/
  test_sim.py         smoke + benchmark (6000 actors x 100 years)
  test_play.py        autoplayer - plays decades so balance can be measured
```

## Notes on the simulation

* **Determinism.** Every roll is derived from `seed + stream + entity + tick`, so
  the same save and the same decisions produce the same history.
* **Scale.** The talent universe is thousands of actors; population passes are
  set-based SQL, not Python loops (6000 actors × 100 years, with a full weekly box office chart, in
  about five seconds). Actor and script lists are paginated server-side — the
  browser never receives the whole town.
* **Scouting is a guess.** What your readers tell you about an unknown face or
  script is deliberately noisy; better casting offices reduce the error, they
  never remove it.
* **The library is a pension, not a printer.** Exploitation income per title
  ages off and is capped against what the picture did in cinemas, so you keep
  having to make movies.
* **You can lose.** Overhead kills idle lots; three years in the red closes the
  studio. An autoplayed bad run goes under in the 1940s; a good one owns the
  town by the 1960s.

## Tests

The dashboard itself can be smoke-tested headlessly with node (optional, only
useful when changing the UI): serve it, then run the checker, which boots the
real page, opens every tab and every modal, and audits the DOM for elements the
stylesheet cannot match.

```bash
node tests/ui/check.mjs        # BASE=http://127.0.0.1:8000 by default
```

```bash
python3 -m tests.test_sim --years 2         # quick smoke
python3 -m tests.test_sim --bench           # population + query benchmark
python3 -m tests.test_play --years 40 --seed 9   # 40 years of studio history
python3 -m tests.test_scenario                   # every screen's actions, end to end through the API
```
