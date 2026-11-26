import Database from "better-sqlite3";
import { MIGRATIONS } from "./migrations.js";

export type DB = Database.Database;

/** Open (or create) a save file and bring its schema up to date. */
export function openSave(path: string): DB {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("cache_size = -65536"); // 64 MB page cache
  db.pragma("temp_store = MEMORY");
  migrate(db);
  return db;
}

export function migrate(db: DB): number {
  const current = db.pragma("user_version", { simple: true }) as number;
  const pending = MIGRATIONS.filter((m) => m.version > current).sort((a, b) => a.version - b.version);
  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    })();
  }
  return db.pragma("user_version", { simple: true }) as number;
}
