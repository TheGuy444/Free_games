/**
 * Browser mode: serves the game UI on http://localhost:5173 and answers the
 * same commands as the Electron app over HTTP.
 *   npm run web                     (uses saves/career.sqlite)
 *   npm run web -- --save saves/other.sqlite --port 8080
 */
import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeApi } from "./api.js";
import { openOrCreate } from "./game.js";

const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] ?? d : d; };
const save = arg("save", "saves/career.sqlite");
const port = Number(arg("port", "5173"));
mkdirSync(dirname(save), { recursive: true });
console.log(`Opening ${save} (a new career takes a few seconds to generate)...`);
const world = openOrCreate(save);
const api = makeApi(world) as unknown as Record<string, (...a: unknown[]) => unknown>;
const page = join(dirname(fileURLToPath(import.meta.url)), "renderer", "index.html");

const server = createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(readFileSync(page));
    return;
  }
  const m = req.url?.match(/^\/api\/(\w+)$/);
  if (req.method === "POST" && m) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const fn = api[m[1]!];
        if (!fn) throw new Error(`Unknown command ${m[1]}`);
        const out = fn(...(JSON.parse(body || "[]") as unknown[]));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(out ?? null));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }
  res.writeHead(404).end();
});
server.listen(port, "127.0.0.1", () => console.log(`Play at http://localhost:${port}`));
const shutdown = () => { world.flush(); world.db.close(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
