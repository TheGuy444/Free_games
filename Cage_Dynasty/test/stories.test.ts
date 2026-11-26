import { describe, expect, it } from "vitest";
import { openSave } from "../src/db/db.js";
import { World } from "../src/core/world.js";
import { makeApi } from "../src/app/api.js";

const world = (() => {
  const db = openSave(":memory:");
  const w = World.create(db, { seed: 33, startYear: 2024, scale: 0.3, playerTier: "major" });
  w.advance(30);
  return w;
})();

describe("news stories and front page", () => {
  it("writes a headline and story for notable results", () => {
    const rows = world.db.prepare("SELECT headline, story FROM news_item WHERE kind = 'results' AND importance >= 2 AND story IS NOT NULL").all() as { headline: string; story: string }[];
    expect(rows.length).toBeGreaterThan(5);
    for (const r of rows) {
      expect(r.headline.length).toBeGreaterThan(10);
      expect(r.story.split("\n\n").length).toBeGreaterThanOrEqual(2);
      expect(r.story).not.toMatch(/undefined|null|NaN/);
    }
  });

  it("builds a front page with a lead, shorter stories and briefs, one per fighter", () => {
    const api = makeApi(world) as unknown as { newsFront: (s: string) => { lead: { fighter_id: number | null } | null; second: { fighter_id: number | null }[]; briefs: { fighter_id: number | null }[] } };
    const f = api.newsFront("world");
    expect(f.lead).not.toBeNull();
    expect(f.second).toHaveLength(2);
    const ids = [f.lead!, ...f.second, ...f.briefs].map((n) => n.fighter_id).filter((x) => x !== null);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
