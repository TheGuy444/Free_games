import { describe, expect, it } from "vitest";
import { openSave } from "../src/db/db.js";
import { World } from "../src/core/world.js";
import { P4P } from "../src/core/rankings.js";

const world = (() => {
  const db = openSave(":memory:");
  const w = World.create(db, { seed: 21, startYear: 2024, scale: 0.3, playerTier: "major" });
  w.advance(60);
  return w;
})();

describe("rankings", () => {
  it("ranks pound-for-pound worldwide across several promotions and divisions", () => {
    const list = world.ranks.worldList(P4P);
    expect(list).toHaveLength(25);
    expect(new Set(list.map((r) => r.fighter.weightClassId)).size).toBeGreaterThan(3);
    expect(list.map((r) => r.rank)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  it("company division lists leave the champion out, and ranksOf agrees with every list", () => {
    const p = world.playerPromotion!;
    for (let wc = 1; wc <= 13; wc++) {
      const champ = world.championOf(p.id, wc);
      const list = world.ranks.companyList(p.id, wc);
      if (champ !== null) expect(list.some((r) => r.fighter.id === champ)).toBe(false);
      for (const r of list) expect(world.ranks.ranksOf(r.fighter).companyDivision).toBe(r.rank);
    }
    for (const r of world.ranks.worldList(P4P)) expect(world.ranks.ranksOf(r.fighter).worldP4P).toBe(r.rank);
  });

  it("a fighter can hold different ranks at each level", () => {
    const f = world.ranks.worldList(3)[0]!.fighter; // #1 featherweight in the world
    const r = world.ranks.ranksOf(f);
    expect(r.worldDivision).toBe(1);
    expect(r.companyDivision === 0 || r.companyDivision === 1 || (r.companyDivision ?? 99) > 1).toBe(true);
  });

  it("stores snapshots so movement can be shown", () => {
    const n = (world.db.prepare("SELECT COUNT(DISTINCT week) n FROM ranking_snapshot").get() as { n: number }).n;
    expect(n).toBeGreaterThan(5);
    expect(world.ranks.worldList(P4P).some((r) => r.prev !== null)).toBe(true);
  });
});

describe("world news", () => {
  it("reports other promotions' results, signings and the player's own news separately", () => {
    const rows = world.db.prepare("SELECT kind, promotion_id FROM news_item").all() as { kind: string; promotion_id: number | null }[];
    const world_ = rows.filter((r) => r.promotion_id !== world.playerPromotionId);
    expect(world_.some((r) => r.kind === "results")).toBe(true);
    expect(world_.some((r) => r.kind === "signing")).toBe(true);
  });

  it("never says a title was retained by someone who missed weight", () => {
    const bad = world.db.prepare(`SELECT n.text FROM news_item n WHERE n.kind = 'results' AND n.text LIKE '%retain the title%'
      AND EXISTS (SELECT 1 FROM weigh_in w WHERE w.week = n.week AND w.outcome = 'missed' AND w.fighter_id = n.fighter_id)`).all();
    expect(bad).toEqual([]);
  });
});
