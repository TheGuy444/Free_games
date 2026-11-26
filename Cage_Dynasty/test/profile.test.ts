import { describe, expect, it } from "vitest";
import { openSave } from "../src/db/db.js";
import { World } from "../src/core/world.js";
import { makeApi } from "../src/app/api.js";
import { physicals } from "../src/core/profile.js";

const world = (() => {
  const db = openSave(":memory:");
  const w = World.create(db, { seed: 44, startYear: 2024, scale: 0.3, playerTier: "major" });
  w.advance(52);
  return w;
})();
type Prof = {
  general: { born: string; height: string; amateur: string[]; pro: string[] };
  health: { parts: { part: string; health: number }[]; outlook: string };
  standup: { rows: { value: number }[] }[];
  clinch: unknown[];
  ground: unknown[];
};
const api = makeApi(world) as unknown as { fighterProfile: (id: number) => Prof | null };

describe("fighter profile", () => {
  it("has general, health, standup, clinch and ground pages", () => {
    const f = [...world.fighters.values()].find((x) => x.wins + x.losses > 10)!;
    const p = api.fighterProfile(f.id)!;
    expect(p.general.born).toMatch(/\d{4} \(age \d+\)/);
    expect(p.health.parts.map((x) => x.part)).toEqual(["Head", "Body", "Arms", "Legs"]);
    for (const x of p.health.parts) expect(x.health).toBeGreaterThanOrEqual(1);
    for (const g of p.standup) for (const r of g.rows) expect(r.value).toBeGreaterThanOrEqual(1);
    expect(p.clinch.length).toBeGreaterThan(0);
    expect(p.ground.length).toBeGreaterThan(0);
  });

  it("wears fighters down with fights, and Olympic medals stay rare", () => {
    const active = [...world.fighters.values()].filter((f) => f.wins + f.losses > 0);
    expect(active.some((f) => f.wear.legs > 0 && f.wear.body > 0)).toBe(true);
    let olympians = 0;
    for (const f of active.slice(0, 400)) if (api.fighterProfile(f.id)!.general.amateur.some((a) => a.startsWith("Olympic"))) olympians++;
    expect(olympians).toBeLessThan(400 * 0.03);
  });

  it("heavier divisions are taller", () => {
    expect(physicals(1, "M", 8).heightCm).toBeGreaterThan(physicals(1, "M", 1).heightCm);
  });
});
