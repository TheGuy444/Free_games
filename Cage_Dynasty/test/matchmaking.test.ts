import { describe, expect, it } from "vitest";
import { openSave } from "../src/db/db.js";
import { World } from "../src/core/world.js";
import { autoFillCard, bookBout, card } from "../src/core/booking.js";
import { alterShow, cancelShow, fighterPanel, lockReplacement, matchupInfo, moneyline, pickerList, placeBout, replacementInfo, showDetails, swapCorners } from "../src/core/matchmaking.js";
import { MAIN_CARD_SIZE } from "../src/core/excitement.js";

const career = () => {
  const db = openSave(":memory:");
  const world = World.create(db, { seed: 21, startYear: 2024, scale: 0.3, playerTier: "major" });
  world.advance(12);
  return world;
};
const booked = (w: World, ev: number) => card(w, ev).filter((b) => b.status === "booked");

describe("booking desk", () => {
  it("places bouts by slot, swaps corners, and keeps big egos off the prelims", () => {
    const world = career();
    const ev = world.scheduleEvent(10);
    autoFillCard(world, ev, 8);
    const list = booked(world, ev);
    expect(list.length).toBeGreaterThanOrEqual(6);
    const last = list[list.length - 1]!;
    placeBout(world, last.id, "main");
    expect(booked(world, ev)[0]!.id).toBe(last.id);
    placeBout(world, last.id, "co");
    expect(booked(world, ev)[1]!.id).toBe(last.id);
    placeBout(world, last.id, "prelims");
    expect(booked(world, ev).findIndex((b) => b.id === last.id)).toBeGreaterThanOrEqual(MAIN_CARD_SIZE);
    const { redId, blueId } = booked(world, ev)[0]!;
    swapCorners(world, booked(world, ev)[0]!.id);
    expect(booked(world, ev)[0]!.redId).toBe(blueId);
    expect(booked(world, ev)[0]!.blueId).toBe(redId);
    // A ranked big ego can't be moved to the prelims.
    const top = booked(world, ev)[0]!;
    const star = top.red!;
    star.traits = ["diva"];
    if (world.rankOf(star) !== null || world.titlesOf(star.id).length) expect(() => placeBout(world, top.id, "prelims")).toThrow(/big ego/);
  });

  it("alters and cancels shows, refusing a date the booked fighters can't make", () => {
    const world = career();
    const a = world.scheduleEvent(4), b = world.scheduleEvent(20);
    autoFillCard(world, a, 4);
    const shared = booked(world, a)[0]!;
    const free = [...world.playerPromotion!.roster].map((id) => world.fighters.get(id)!)
      .find((f) => f.id !== shared.redId && f.id !== shared.blueId && f.weightClassId === shared.red!.weightClassId && world.available(f) && !booked(world, a).some((x) => x.redId === f.id || x.blueId === f.id));
    if (free) {
      // Book the same fighter on show b, then try to pull b to within the rest window of a.
      const id = (() => { try { return bookBout(world, b, shared.redId, free.id); } catch { return null; } })();
      if (id) expect(() => alterShow(world, b, { weeksAhead: 6 })).toThrow(/Too close|needs/);
    }
    const s = alterShow(world, b, { name: "Renamed Night", broadcast: "tv", weeksAhead: 26 });
    expect(s.name).toBe("Renamed Night");
    expect(s.weeksAway).toBe(26);
    cancelShow(world, a);
    expect(showDetails(world, a).status).toBe("cancelled");
    expect(booked(world, a)).toHaveLength(0);
  });

  it("picker, fighter panel and matchup column report status, camp, line and history", () => {
    const world = career();
    const ev = world.scheduleEvent(10);
    const wc = [...world.playerPromotion!.roster].map((id) => world.fighters.get(id)!)[0]!.weightClassId;
    const rows = pickerList(world, ev, wc, "ranking");
    expect(rows.length).toBeGreaterThan(2);
    const byName = pickerList(world, ev, wc, "name").map((r) => r.name);
    expect(byName).toEqual([...byName].sort((x, y) => x.localeCompare(y)));
    expect(pickerList(world, ev, wc, "name", byName[0]!.slice(0, 4)).some((r) => r.name === byName[0])).toBe(true);
    const ok = rows.filter((r) => r.ok);
    const [x, y] = [ok[0]!, ok[1]!];
    const panel = fighterPanel(world, x.id, ev)!;
    expect(panel.camp.text).toMatch(/full camp/);
    expect(panel.pay).toMatch(/win bonus/);
    const m = matchupInfo(world, ev, x.id, y.id, false)!;
    expect(m.drawText).toMatch(/draw of this fight/);
    expect(m.line).toMatch(/[+-]\d+/);
    expect(m.history).toEqual(["These two have never fought."]);
    bookBout(world, ev, x.id, y.id);
    expect(pickerList(world, ev, wc, "ranking").find((r) => r.id === x.id)!.status).toBe("on this card");
  });

  it("replaces an injured fighter in the same slot and hides the old bout", () => {
    const world = career();
    const ev = world.scheduleEvent(8);
    autoFillCard(world, ev, 7);
    const target = booked(world, ev)[1]!;
    const hurt = target.red!;
    hurt.injuredUntil = world.week + 20;
    world.repo.setBookingStatus(target.id, "cancelled", `${hurt.name} injured in camp`, null);
    const info = replacementInfo(world, target.id);
    expect(info.kept.id).toBe(target.blueId);
    expect(info.out.id).toBe(hurt.id);
    expect(info.slot).toBe(2);
    const pick = info.options.find((o) => o.problems.length === 0)!;
    expect(pick).toBeTruthy();
    lockReplacement(world, target.id, pick.id);
    const now = booked(world, ev);
    expect(now[1]!.blueId).toBe(target.blueId);
    expect(now[1]!.redId).toBe(pick.id);
    expect(() => lockReplacement(world, target.id, pick.id)).toThrow(/already has a replacement/);
  });

  it("moneyline is symmetric around even", () => {
    expect(moneyline(0.5)).toBe("-100");
    expect(moneyline(0.75)).toBe("-300");
    expect(moneyline(0.25)).toBe("+300");
  });
});
