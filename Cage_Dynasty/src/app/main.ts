/**
 * Electron main process. Owns the save file and the World; the renderer only
 * talks to it through the commands in api.ts (see preload.cts).
 */
import { app, BrowserWindow, ipcMain } from "electron";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeApi } from "./api.js";
import { openOrCreate } from "./game.js";

const here = dirname(fileURLToPath(import.meta.url));

app.whenReady().then(() => {
  const dir = join(app.getPath("userData"), "saves");
  mkdirSync(dir, { recursive: true });
  const world = openOrCreate(join(dir, "career.sqlite"));
  const api = makeApi(world);
  ipcMain.handle("api", (_e, name: string, args: unknown[]) => {
    const fn = (api as Record<string, (...a: unknown[]) => unknown>)[name];
    if (!fn) throw new Error(`Unknown command ${name}`);
    return fn(...args);
  });
  app.on("window-all-closed", () => {
    world.flush();
    world.db.close();
    app.quit();
  });
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(join(here, "renderer", "index.html"));
});
