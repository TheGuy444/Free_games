import { describe, expect, it } from "vitest";
import { openSave } from "../src/db/db.js";
import { World } from "../src/core/world.js";
import { cash, deals, launchOwnNetwork, launchOwnPpv, MONEY, offers, outlets, ownMedia, signDeal } from "../src/core/business.js";
import { castingPool, currentSeason, startSeason, CAST_PER_DIVISION } from "../src/core/reality.js";
import { rateCard } from "../src/core/excitement.js";

const career = (tier: "major" | "local" = "major", weeks = 10) => {
  const db = openSave(":memory:");
  const world = World.create(db, { seed: 7, startYear: 2024, scale: 0.3, playerTier: tier });
  world.advance(weeks);
  return world;
};

describe("card rating", () => {
  it("weights the main event far more than the prelims", () => {
    const base = [60, 60, 60, 60, 60, 60, 60, 60];
    const badMain = rateCard([20, ...base.slice(1)]);
    const badPrelim = rateCard([...base.slice(0, 7), 20]);
    expect(rateCard(base)).toBe(60);
    expect(badMain).toBeLessThan(badPrelim);
    expect(60 - badPrelim).toBeLessThanOrEqual(5);
  });
});

describe("broadcasting", () => {
  it("signs one TV partner, refuses a second, and can launch its own network and PPV", () => {
    const world = career();
    const p = world.playerPromotion!;
    const tv = offers(world, p).filter((o) => o.kind === "tv");
    expect(tv.length).toBeGreaterThan(0);
    signDeal(world, p, tv[0]!.networkId);
    expect(deals(world, p.id).filter((d) => d.kind === "tv")).toHaveLength(1);
    const other = offers(world, p).find((o) => o.kind === "tv");
    if (other) expect(() => signDeal(world, p, other.networkId)).toThrow(/already have a TV partner/);
    expect(outlets(world, p).tv).toBeTruthy();

    const before = cash(world, p.id);
    launchOwnNetwork(world, p, "Test Network");
    launchOwnPpv(world, p);
    expect(cash(world, p.id)).toBe(before - MONEY.ownNetworkLaunch - MONEY.ownPpvLaunch);
    const own = ownMedia(world, p.id);
    expect(own.network && own.ppv).toBe(true);
    expect(own.subscribers).toBeGreaterThan(0);
    expect(() => launchOwnPpv(world, p)).toThrow();
  });
});

describe("event money and records", () => {
  it("every finished card has a gate and a rating, and PPV cards report buys separately", () => {
    const world = career("major", 0);
    const w0 = world.week;
    world.advance(52);
    const rows = world.db.prepare("SELECT broadcast, gate, ppv_buys, ppv_revenue, tv_viewers, rating FROM event WHERE status = 'completed' AND week > ?").all(w0) as
      { broadcast: string; gate: number; ppv_buys: number | null; ppv_revenue: number | null; tv_viewers: number | null; rating: number | null }[];
    expect(rows.length).toBeGreaterThan(20);
    for (const r of rows) {
      expect(r.gate).toBeGreaterThan(0);
      expect(r.rating).not.toBeNull();
      if (r.broadcast === "ppv") { expect(r.ppv_buys).toBeGreaterThan(0); expect(r.ppv_revenue).toBeGreaterThan(0); }
      if (r.broadcast === "tv") expect(r.tv_viewers).toBeGreaterThan(0);
    }
    expect(rows.some((r) => r.broadcast === "ppv")).toBe(true);
    const fotn = world.db.prepare("SELECT event_id, COUNT(*) n FROM bout WHERE fotn = 1 GROUP BY event_id HAVING n > 1").all();
    expect(fotn).toEqual([]);
  });
});

describe("reality series", () => {
  it("needs a TV outlet, runs the bracket to a final, and signs the finalists", () => {
    const world = career();
    const p = world.playerPromotion!;
    const divs = [...new Set([...world.fighters.values()].map((f) => f.weightClassId))]
      .filter((wc) => castingPool(world, wc).length >= CAST_PER_DIVISION).slice(0, 2) as [number, number];
    expect(divs).toHaveLength(2);
    expect(() => startSeason(world, divs)).toThrow(/TV partner/);
    signDeal(world, p, offers(world, p).find((o) => o.kind === "tv")!.networkId);
    const id = startSeason(world, divs);
    world.advance(16);
    expect(currentSeason(world, p.id)).toBeUndefined();
    const bouts = world.db.prepare("SELECT COUNT(*) n FROM reality_bout WHERE season_id = ?").get(id) as { n: number };
    expect(bouts.n).toBe(14);
    const top = world.db.prepare("SELECT fighter_id FROM reality_cast WHERE season_id = ? AND status IN ('winner','finalist')").all(id) as { fighter_id: number }[];
    expect(top).toHaveLength(4);
    expect(top.filter((t) => world.fighters.get(t.fighter_id)!.promotionId === p.id).length).toBeGreaterThanOrEqual(3);
  });
});

import { previewBout } from "../src/core/booking.js";

describe("big ego trait", () => {
  it("a ranked big ego refuses an unranked, less popular opponent", () => {
    const world = career();
    const p = world.playerPromotion!;
    const roster = [...p.roster].map((id) => world.fighters.get(id)!).filter((f) => f.status === "active");
    const star = roster.find((f) => world.rankOf(f) !== null && roster.some((o) => o.weightClassId === f.weightClassId && o.sex === f.sex && world.rankOf(o) === null))!;
    const scrub = roster.find((o) => o.weightClassId === star.weightClassId && o.sex === star.sex && world.rankOf(o) === null)!;
    star.traits = ["diva"];
    for (const r of Object.keys(star.regionPop)) { star.regionPop[+r] = 80; scrub.regionPop[+r] = 5; }
    star.popularity = 80; scrub.popularity = 5;
    for (const f of [star, scrub]) { f.lastFightWeek = null; f.injuredUntil = null; }
    const ev = world.scheduleEvent(8);
    const pv = previewBout(world, ev, star.id, scrub.id, false);
    expect(pv.problems.some((x) => x.includes("big ego"))).toBe(true);
    star.traits = [];
    expect(previewBout(world, ev, star.id, scrub.id, false).problems.some((x) => x.includes("big ego"))).toBe(false);
  });
});
