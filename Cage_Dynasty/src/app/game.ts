import { existsSync } from "node:fs";
import { WEEKS_PER_YEAR } from "../core/constants.js";
import { World } from "../core/world.js";
import { openSave } from "../db/db.js";

/** Open a save, or start a new career: generate the world and two years of history. */
export function openOrCreate(path: string, seed = Date.now() >>> 0): World {
  const isNew = !existsSync(path);
  const db = openSave(path);
  if (!isNew) return World.load(db);
  const world = World.create(db, { seed, startYear: 2024, scale: 1, playerTier: "major" });
  world.advance(2 * WEEKS_PER_YEAR);
  world.flush();
  return world;
}
