import { describe, expect, it } from "vitest";
import { openSave } from "../src/db/db.js";
import { World } from "../src/core/world.js";
import { buildSchedule, pickPlan } from "../src/core/schedule.js";

const count = (m: Map<number, string>, k: string) => [...m.values()].filter((x) => x === k).length;

describe("calendars", () => {
  it("a PPV-led global runs a PPV a month with TV cards between, nearly every week", () => {
    const s = buildSchedule(1, "global", "ppv_led", "prestige", "ok", 0);
    expect(count(s, "ppv")).toBe(12);
    expect(count(s, "tv")).toBe(30);
    expect(s.has(0)).toBe(false);
    const ppvWeeks = [...s].filter(([, k]) => k === "ppv").map(([w]) => w).sort((a, b) => a - b);
    for (let i = 1; i < ppvWeeks.length; i++) expect(ppvWeeks[i]! - ppvWeeks[i - 1]!).toBeGreaterThanOrEqual(3);
  });

  it("small shows run about one card a month and never PPV; broke promotions cut back", () => {
    const local = buildSchedule(9, "local", "grassroots", "profit", "ok", 0);
    expect(count(local, "ppv")).toBe(0);
    expect(local.size).toBeLessThanOrEqual(10);
    const regional = buildSchedule(9, "regional", "all_tv", "development", "ok", 0);
    expect(count(regional, "tv")).toBe(12);
    expect(buildSchedule(9, "regional", "all_tv", "development", "broke", 0).size).toBeLessThan(regional.size);
    for (const tier of ["regional", "local"] as const) for (let id = 1; id < 40; id++) expect(pickPlan(id, tier).ppvNetworkId).toBeNull();
  });
});

describe("AI promotions run their own calendars", () => {
  it("globals differ, PPVs and TV cards are named and broadcast by kind, and plans survive a reload", () => {
    const db = openSave(":memory:");
    const world = World.create(db, { seed: 5, startYear: 2024, scale: 0.3, playerTier: "major" });
    const globals = world.promotions.filter((p) => p.tier === "global");
    expect(new Set(globals.map((p) => p.plan!.flavor)).size).toBe(globals.length);
    world.advance(52);
    const rows = db.prepare(`SELECT p.tier, p.flavor, e.broadcast, e.name FROM event e JOIN promotion p ON p.id = e.promotion_id
                             WHERE e.status = 'completed' AND e.week > 0 AND p.id != ?`).all(world.playerPromotionId) as { tier: string; flavor: string; broadcast: string; name: string }[];
    expect(rows.filter((r) => r.tier !== "global" && r.tier !== "major" && r.broadcast === "ppv")).toEqual([]);
    const ppvLed = globals.find((p) => p.plan!.flavor === "ppv_led");
    if (ppvLed) {
      const mine = rows.filter((r) => r.flavor === "ppv_led");
      expect(mine.length).toBeGreaterThanOrEqual(36);
      expect(mine.filter((r) => r.broadcast === "ppv").length).toBeGreaterThanOrEqual(6);
      expect(mine.some((r) => r.name.includes("Fight Night"))).toBe(true);
    }
    const regional = world.promotions.find((p) => p.tier === "regional")!;
    expect(rows.filter((r) => r.tier === "regional").length / world.promotions.filter((p) => p.tier === "regional").length).toBeLessThanOrEqual(14);
    world.flush();
    const again = World.load(db);
    const r2 = again.promotion(regional.id)!;
    expect(r2.plan).toEqual(regional.plan);
    const sorted = (m: Map<number, string>) => [...m].sort((a, b) => a[0] - b[0]);
    expect(sorted(r2.cardKinds!)).toEqual(sorted(regional.cardKinds!));
    expect(again.promotion(world.playerPromotionId!)!.plan).toBeUndefined();
  });
});
