import { describe, expect, it } from "vitest";
import { openSave } from "../src/db/db.js";
import { MIGRATIONS } from "../src/db/migrations.js";
import { World } from "../src/core/world.js";
import { CAREER } from "../src/core/constants.js";
import type { FighterState } from "../src/core/model.js";

const newWorld = (seed = 7) => {
  const db = openSave(":memory:");
  return { db, world: World.create(db, { seed, startYear: 1996, scale: 0.3 }) };
};

describe("database", () => {
  it("migrates a new save to the latest version", () => {
    const db = openSave(":memory:");
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.at(-1)!.version);
  });
});

describe("world", () => {
  it("generates promotions, fighters and signed rosters", () => {
    const { db, world } = newWorld();
    expect(world.promotions.length).toBeGreaterThan(10);
    const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    expect(n("SELECT COUNT(*) n FROM fighter WHERE status != 'retired'")).toBe(world.fighters.size);
    expect(n("SELECT COUNT(*) n FROM contract WHERE end_week IS NULL")).toBeGreaterThan(world.fighters.size / 2);
  });

  it("sims a year of events and bouts", () => {
    const { db, world } = newWorld();
    world.advance(52);
    world.flush();
    const bouts = (db.prepare("SELECT COUNT(*) n FROM bout").get() as { n: number }).n;
    expect(bouts).toBeGreaterThan(1000);
    expect(world.year).toBe(1997);
  });

  it("is deterministic: same seed, same history", () => {
    const run = () => {
      const { db, world } = newWorld(99);
      world.advance(26);
      return db.prepare("SELECT red_id, blue_id, winner_id, method FROM bout ORDER BY id LIMIT 500").all();
    };
    expect(run()).toEqual(run());
  });

  it("forces retirement at the fight cap", () => {
    const { world } = newWorld();
    const f = [...world.fighters.values()][0] as FighterState;
    f.wins = CAREER.forcedRetirement;
    f.losses = 0;
    expect(world.shouldRetire(f)).toBe(true);
  });
});

describe("starting records", () => {
  it("look like real MMA records: winners at the top, unbeaten prospects, few .500 elites", () => {
    const world = World.create(openSave(":memory:"), { seed: 31, startYear: 2024, scale: 0.3 });
    const fs = [...world.fighters.values()].filter((f) => f.status === "active" && f.wins + f.losses >= 5);
    const pct = (f: { wins: number; losses: number }) => f.wins / (f.wins + f.losses);
    const top = [...fs].sort((a, b) => b.rating - a.rating).slice(0, 50);
    expect(top.filter((f) => pct(f) >= 0.75).length).toBeGreaterThanOrEqual(35);
    expect(fs.filter((f) => f.losses === 0).length).toBeGreaterThanOrEqual(10);
    const global = world.promotions.filter((p) => p.tier === "global").flatMap((p) => [...p.roster].map((id) => world.fighters.get(id)!)).filter((f) => f.wins + f.losses >= 5);
    expect(global.reduce((s, f) => s + pct(f), 0) / global.length).toBeGreaterThan(0.7);
  });
});
