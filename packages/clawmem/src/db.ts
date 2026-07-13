import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_DATABASE_URL = "file:./data/clawmem.db";

export function resolveDatabasePath(databaseUrl?: string): string {
  const url = databaseUrl ?? process.env.CLAWMEM_DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const rawPath = url.startsWith("file:") ? url.slice("file:".length) : url;
  if (rawPath === ":memory:") return rawPath;
  return resolve(process.cwd(), rawPath);
}

export function openDatabase(databaseUrl?: string): Database.Database {
  const path = resolveDatabasePath(databaseUrl);
  if (path !== ":memory:") {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      agent_key TEXT PRIMARY KEY,
      name TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chain_identities (
      agent_key TEXT NOT NULL REFERENCES agents(agent_key) ON DELETE CASCADE,
      chain TEXT NOT NULL,
      chain_agent_id TEXT NOT NULL,
      address TEXT NOT NULL,
      linked_at INTEGER NOT NULL,
      PRIMARY KEY (chain, chain_agent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_chain_identities_agent_key ON chain_identities(agent_key);

    CREATE TABLE IF NOT EXISTS memories (
      agent_key TEXT NOT NULL,
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (agent_key, namespace, key)
    );
  `);
}
