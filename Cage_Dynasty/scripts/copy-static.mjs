import { cpSync, mkdirSync } from "node:fs";
mkdirSync("dist/app/renderer", { recursive: true });
cpSync("src/app/renderer/index.html", "dist/app/renderer/index.html");
