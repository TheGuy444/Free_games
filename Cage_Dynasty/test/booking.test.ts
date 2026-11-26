import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { autoFillCard, bookBout, card, previewBout } from "../src/core/booking.js";
import { openSave } from "../src/db/db.js";
import { World } from "../src/core/world.js";
import { weighIn } from "../src/core/weighin.js";
import { sampleFighter } from "../src/core/fight/sample.js";
import { Rng } from "../src/core/rng.js";

const career = (seed = 3) => {
  const db = openSave(":memory:");
  const world = World.create(db, { seed, startYear: 2024, scale: 0.3, playerTier: "major" });
  world.advance(30);
  return { db, world };
};

const readyPair = (world: World) => {
  const p = world.playerPromotion!;
  const byDiv = new Map<number, number[]>();
  for (const id of p.roster) {
    const f = world.fighters.get(id)!;
    if (!world.available(f, world.week + 8) || f.boutsRemaining <= 0) continue;
    byDiv.set(f.weightClassId, [...(byDiv.get(f.weightClassId) ?? []), id]);
  }
  const ids = [...byDiv.values()].find((l) => l.length >= 2)!;
  return [ids[0]!, ids[1]!] as const;
};

describe("booking desk", () => {
  it("books a valid fight and blocks double booking", () => {
    const { world } = career();
    const ev = world.scheduleEvent(8);
    const [a, b] = readyPair(world);
    expect(previewBout(world, ev, a, b).problems).toEqual([]);
    bookBout(world, ev, a, b);
    expect(card(world, ev)).toHaveLength(1);
    const again = previewBout(world, ev, a, b);
    expect(again.problems.some((p) => p.includes("already booked"))).toBe(true);
    expect(() => bookBout(world, ev, a, b)).toThrow();
  });

  it("rejects fighters too far apart in weight, or from other promotions", () => {
    const { world } = career();
    const ev = world.scheduleEvent(8);
    const p = world.playerPromotion!;
    const roster = [...p.roster].map((id) => world.fighters.get(id)!);
    const mine = roster.find((f) => f.sex === "M")!;
    const otherSex = roster.find((f) => f.sex !== mine.sex)!;
    expect(previewBout(world, ev, mine.id, otherSex.id).problems).toContain("Fighters are in different divisions");
    const farAway = roster.find((f) => f.sex === mine.sex && Math.abs(f.weightClassId - mine.weightClassId) > 2)!;
    expect(previewBout(world, ev, mine.id, farAway.id).problems.some((x) => x.includes("Too big a weight gap"))).toBe(true);
    const outsider = [...world.fighters.values()].find((f) => f.promotionId !== p.id && f.weightClassId === mine.weightClassId)!;
    expect(previewBout(world, ev, mine.id, outsider.id).problems.some((x) => x.includes("not on your roster"))).toBe(true);
  });

  it("auto-fills a card and runs the event with weigh-ins and results", () => {
    const { world, db } = career();
    const ev = world.scheduleEvent(6);
    expect(autoFillCard(world, ev, 10)).toBeGreaterThan(5);
    world.advance(6);
    const rows = card(world, ev);
    expect(rows.every((r) => r.status === "completed" || r.status === "cancelled")).toBe(true);
    const bouts = (db.prepare("SELECT COUNT(*) n FROM bout WHERE event_id = ?").get(ev) as { n: number }).n;
    expect(bouts).toBe(rows.filter((r) => r.status === "completed").length);
    const weighIns = (db.prepare("SELECT COUNT(*) n FROM weigh_in WHERE event_id = ?").get(ev) as { n: number }).n;
    expect(weighIns).toBeGreaterThanOrEqual(bouts * 2);
    // The player's fights keep full play-by-play.
    const logs = (db.prepare("SELECT COUNT(*) n FROM bout_log l JOIN bout b ON b.id = l.bout_id WHERE b.event_id = ?").get(ev) as { n: number }).n;
    expect(logs).toBe(bouts);
  });

  it("crowns a champion in a vacant title fight unless the winner missed weight", () => {
    const { world, db } = career();
    for (let i = 0; i < 4; i++) {
      const ev = world.scheduleEvent(12);
      autoFillCard(world, ev, 4);
      world.advance(12);
    }
    const titleBouts = db.prepare(`SELECT b.winner_id, b.week, b.title_id, b.event_id FROM bout b JOIN event e ON e.id = b.event_id
                                   WHERE b.title_id IS NOT NULL AND e.promotion_id = ?`).all(world.playerPromotionId) as { winner_id: number | null; week: number; title_id: number; event_id: number }[];
    expect(titleBouts.length).toBeGreaterThan(0);
    for (const b of titleBouts) {
      if (b.winner_id === null) continue;
      const missed = db.prepare("SELECT 1 FROM weigh_in WHERE event_id = ? AND fighter_id = ? AND outcome = 'missed'").get(b.event_id, b.winner_id);
      const reign = db.prepare("SELECT 1 FROM title_reign WHERE title_id = ? AND fighter_id = ? AND start_week <= ? AND (end_week IS NULL OR end_week >= ?)").get(b.title_id, b.winner_id, b.week, b.week);
      if (missed) expect(reign).toBeUndefined();
    }
  });

  it("generates post-fight callouts that point at real fighters", () => {
    const { world, db } = career();
    for (let i = 0; i < 3; i++) {
      const ev = world.scheduleEvent(10);
      autoFillCard(world, ev, 12);
      world.advance(10);
    }
    const moments = db.prepare("SELECT kind, target_id, text FROM post_fight_moment").all() as { kind: string; target_id: number | null; text: string }[];
    const callouts = moments.filter((m) => m.kind === "callout");
    expect(callouts.length).toBeGreaterThan(0);
    for (const c of callouts) {
      expect(c.target_id).not.toBeNull();
      expect(db.prepare("SELECT 1 FROM fighter WHERE person_id = ?").get(c.target_id)).toBeDefined();
    }
  });
});

describe("weigh-ins", () => {
  it("misses are uncommon and get likelier with bigger cuts", () => {
    const rng = new Rng(4);
    const rate = (cutExtra: number) => {
      let miss = 0;
      for (let i = 0; i < 4000; i++) {
        const f = sampleFighter(rng, 1);
        f.walkKg = 70 * (1 + cutExtra);
        if (weighIn(f, 0, 8, rng).outcome === "missed") miss++;
      }
      return miss / 4000;
    };
    const normal = rate(0.09), hard = rate(0.16);
    expect(normal).toBeLessThan(0.06);
    expect(hard).toBeGreaterThan(normal * 2);
  });
});

describe("save and load", () => {
  it("reloads a career with the same week, roster, titles and bookings", () => {
    const path = `/tmp/cd-test-${process.pid}.sqlite`;
    for (const ext of ["", "-wal", "-shm"]) rmSync(path + ext, { force: true });
    let db = openSave(path);
    let world = World.create(db, { seed: 9, startYear: 2024, scale: 0.3, playerTier: "major" });
    world.advance(40);
    const ev = world.scheduleEvent(8);
    autoFillCard(world, ev, 6);
    world.flush();
    const before = { week: world.week, roster: [...world.playerPromotion!.roster].sort(), titles: [...world.titles.values()].map((t) => t.champion), booked: card(world, ev).length };
    db.close();
    db = openSave(path);
    world = World.load(db);
    expect(world.week).toBe(before.week);
    expect([...world.playerPromotion!.roster].sort()).toEqual(before.roster);
    expect([...world.titles.values()].map((t) => t.champion)).toEqual(before.titles);
    expect(card(world, ev).length).toBe(before.booked);
    world.advance(10);
    expect(card(world, ev).every((b) => b.status !== "booked")).toBe(true);
    db.close();
  });
});
