import { describe, expect, it } from "vitest";
import { bookBout, previewBout } from "../src/core/booking.js";
import { openSave } from "../src/db/db.js";
import { DOUBLE_CHAMP_DEFENSE_WEEKS, World } from "../src/core/world.js";
import type { FighterState, TitleState } from "../src/core/model.js";

const career = () => {
  const db = openSave(":memory:");
  const world = World.create(db, { seed: 12, startYear: 2024, scale: 0.3, playerTier: "major" });
  world.advance(20);
  return world;
};
type Internals = { crown(t: TitleState, f: FighterState): void };

/** Two men from adjacent divisions on the player's roster, made champions of their divisions. */
function twoChamps(world: World) {
  const p = world.playerPromotion!;
  const roster = [...p.roster].map((id) => world.fighters.get(id)!).filter((f) => f.status === "active");
  const lower = roster.find((f) => f.sex === "M" && roster.some((g) => g.weightClassId === f.weightClassId + 1 && g.sex === "M"))!;
  const upper = roster.find((g) => g.weightClassId === lower.weightClassId + 1)!;
  for (const f of [lower, upper]) {
    const t = world.title(p.id, f.weightClassId);
    if (t.champion !== f.id) (world as unknown as Internals).crown(t, f);
  }
  for (const f of [lower, upper]) { f.lastFightWeek = null; f.injuredUntil = null; }
  return { p, lower, upper };
}

describe("champ vs champ", () => {
  it("books a superfight at the heavier division with that belt on the line", () => {
    const world = career();
    const { p, lower, upper } = twoChamps(world);
    const ev = world.scheduleEvent(10);
    const pv = previewBout(world, ev, upper.id, lower.id, true);
    expect(pv.problems).toEqual([]);
    expect(pv.titleEligible).toBe(true);
    expect(pv.notes.some((n) => n.startsWith("Champ vs champ"))).toBe(true);
    bookBout(world, ev, upper.id, lower.id, { title: true });
    const row = world.db.prepare("SELECT weight_class_id, title_id FROM booking WHERE event_id = ?").get(ev) as { weight_class_id: number; title_id: number };
    expect(row.weight_class_id).toBe(upper.weightClassId);
    expect(row.title_id).toBe(world.title(p.id, upper.weightClassId).id);
  });

  it("a double champ keeps both belts until one goes undefended for a year, and may vacate either", () => {
    const world = career();
    const { p, lower } = twoChamps(world);
    const upperTitle = world.title(p.id, lower.weightClassId + 1);
    (world as unknown as Internals).crown(upperTitle, lower);
    expect(world.titlesOf(lower.id)).toHaveLength(2);
    // Keep them out of the cage so no defense happens.
    lower.injuredUntil = world.week + 200;
    world.advance(DOUBLE_CHAMP_DEFENSE_WEEKS - 2);
    expect(world.titlesOf(lower.id).length).toBe(2);
    world.advance(4);
    expect(world.titlesOf(lower.id).length).toBe(0);
  });

  it("the player can vacate one belt by choice", () => {
    const world = career();
    const { p, lower } = twoChamps(world);
    const upperTitle = world.title(p.id, lower.weightClassId + 1);
    (world as unknown as Internals).crown(upperTitle, lower);
    expect(world.vacateByChoice(upperTitle.id)).toBe(true);
    expect(world.titlesOf(lower.id).map((t) => t.weightClassId)).toEqual([lower.weightClassId]);
  });
});

describe("hall of fame", () => {
  it("starts with legends in the global and company halls, and inducts real retirees over time", () => {
    const db = openSave(":memory:");
    const world = World.create(db, { seed: 4, startYear: 2024, scale: 0.3, playerTier: "major" });
    const count = (scope: number) => (db.prepare("SELECT COUNT(*) n FROM hall_of_fame WHERE scope = ?").get(scope) as { n: number }).n;
    expect(count(0)).toBeGreaterThan(3);
    const majors = world.promotions.filter((p) => p.tier === "global" || p.tier === "major");
    expect(majors.every((p) => count(p.id) >= 2)).toBe(true);
    const before = (db.prepare("SELECT COUNT(*) n FROM hall_of_fame").get() as { n: number }).n;
    world.advance(52 * 6);
    const after = (db.prepare("SELECT COUNT(*) n FROM hall_of_fame WHERE week > 0").get() as { n: number }).n;
    expect(after).toBeGreaterThan(0);
    expect(before).toBeGreaterThan(0);
  }, 60000);
});
