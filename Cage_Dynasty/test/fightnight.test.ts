import { describe, expect, it } from "vitest";
import { openSave } from "../src/db/db.js";
import { World } from "../src/core/world.js";
import { autoFillCard } from "../src/core/booking.js";
import { fightNightCard, runFightNight } from "../src/core/fightnight.js";
import { calloutHype, flair, flairBand } from "../src/core/personality.js";
import { postFightMoments } from "../src/core/postfight.js";
import { Rng } from "../src/core/rng.js";
import type { FighterState } from "../src/core/model.js";

const career = () => {
  const db = openSave(":memory:");
  const world = World.create(db, { seed: 33, startYear: 2024, scale: 0.3, playerTier: "major" });
  world.advance(12);
  return world;
};

describe("fight night", () => {
  it("stops on the eve of the player's show and runs it on demand, prelims first", () => {
    const world = career();
    world.holdPlayerEvents = true;
    const ev = world.scheduleEvent(6);
    autoFillCard(world, ev, 8);
    const start = world.week;
    expect(world.advance(20)).toBe(ev);
    expect(world.week).toBe(start + 5);
    // Still held: advancing again does nothing.
    expect(world.advance(3)).toBe(ev);
    expect(world.week).toBe(start + 5);

    const before = fightNightCard(world, ev);
    expect(before.bouts.length).toBeGreaterThanOrEqual(6);
    expect(before.bouts[0]!.slot).toBe("Main event");

    const night = runFightNight(world, ev);
    expect(world.week).toBe(start + 6);
    expect(world.fightNightDue()).toBeNull();
    expect(night.bouts.length).toBe(before.bouts.length);
    // Running order: last prelim first, main event last.
    expect(night.bouts[night.bouts.length - 1]!.slot).toBe("Main event");
    for (let i = 1; i < night.bouts.length; i++) expect(night.bouts[i - 1]!.order).toBeGreaterThan(night.bouts[i]!.order);
    for (const b of night.bouts) if (!b.cancelled) expect(b.result!.hasLog).toBe(true);
    expect(night.summary.attendance).toBeGreaterThan(0);
    // The world carries on after the show.
    expect(world.advance(2)).toBeNull();
  });

  it("doesn't hold when the app hasn't asked it to", () => {
    const world = career();
    const ev = world.scheduleEvent(3);
    autoFillCard(world, ev, 6);
    expect(world.advance(5)).toBeNull();
    expect((world.db.prepare("SELECT status FROM event WHERE id = ?").get(ev) as { status: string }).status).toBe("completed");
  });
});

describe("personality", () => {
  const fighter = (id: number, cha: number, mic: number, prof: number, traits: string[] = []) =>
    ({ id, name: `Test Fighter${id}`, sex: "M", traits, attrs: { charisma: cha, mic_skill: mic, professionalism: prof } }) as unknown as FighterState;

  it("places quiet professionals at the stoic end and loud ones at the outlandish end", () => {
    expect(flair(fighter(1, 70, 30, 95))).toBeLessThan(25);
    expect(flair(fighter(2, 90, 90, 20, ["diva"]))).toBeGreaterThan(85);
    expect(flairBand(flair(fighter(2, 90, 90, 20, ["diva"])))).toBe("outlandish");
    expect(flair(fighter(3, 50, 50, 50))).toBe(flair(fighter(3, 50, 50, 50)));
    expect(calloutHype(95)).toBeGreaterThan(calloutHype(10) * 2);
  });

  it("outlandish fighters call people out more often than stoic ones", () => {
    const count = (f: FighterState) => {
      const rng = new Rng(5);
      let n = 0;
      const target = fighter(99, 50, 50, 50);
      for (let i = 0; i < 400; i++) {
        const m = postFightMoments({ winner: f, loser: target, method: "DEC_U", isMainEvent: false, titleWon: false, isChampion: () => false, rankOf: () => 5,
          calloutTarget: target, retiring: [], regionName: () => "Ohio", promotionName: "Test FC" }, rng);
        if (m.some((x) => x.kind === "callout")) n++;
      }
      return n;
    };
    expect(count(fighter(4, 90, 90, 20, ["diva"]))).toBeGreaterThan(count(fighter(5, 40, 30, 95)) * 1.5);
  });
});
