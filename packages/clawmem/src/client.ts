import type Database from "better-sqlite3";
import { openDatabase } from "./db.js";
import type { ChainId, ChainIdentity, ClawMemConfig, MemoryEntry } from "./types.js";

export class ClawMem {
  private readonly db: Database.Database;

  constructor(config: ClawMemConfig = {}) {
    this.db = openDatabase(config.databaseUrl);
  }

  close(): void {
    this.db.close();
  }

  // === agent identity ===

  registerAgent(agentKey: string, name?: string): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO agents (agent_key, name, created_at) VALUES (?, ?, ?)`)
      .run(agentKey, name ?? null, Date.now());
  }

  linkChainIdentity(agentKey: string, chain: ChainId, chainAgentId: string, address: string): void {
    this.registerAgent(agentKey);
    this.db
      .prepare(
        `INSERT INTO chain_identities (agent_key, chain, chain_agent_id, address, linked_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(chain, chain_agent_id) DO UPDATE SET agent_key = excluded.agent_key, address = excluded.address`,
      )
      .run(agentKey, chain, chainAgentId, address, Date.now());
  }

  resolveAgentKey(chain: ChainId, chainAgentId: string): string | undefined {
    const row = this.db
      .prepare(`SELECT agent_key FROM chain_identities WHERE chain = ? AND chain_agent_id = ?`)
      .get(chain, chainAgentId) as { agent_key: string } | undefined;
    return row?.agent_key;
  }

  getChainIdentities(agentKey: string): ChainIdentity[] {
    const rows = this.db
      .prepare(`SELECT chain, chain_agent_id, address, linked_at FROM chain_identities WHERE agent_key = ?`)
      .all(agentKey) as { chain: ChainId; chain_agent_id: string; address: string; linked_at: number }[];
    return rows.map((row) => ({
      chain: row.chain,
      chainAgentId: row.chain_agent_id,
      address: row.address,
      linkedAt: row.linked_at,
    }));
  }

  // === memory ===

  remember<T>(agentKey: string, namespace: string, key: string, value: T): void {
    const now = Date.now();
    const serialized = JSON.stringify(value);
    this.db
      .prepare(
        `INSERT INTO memories (agent_key, namespace, key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_key, namespace, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(agentKey, namespace, key, serialized, now, now);
  }

  recall<T>(agentKey: string, namespace: string, key: string): T | undefined {
    const row = this.db
      .prepare(`SELECT value FROM memories WHERE agent_key = ? AND namespace = ? AND key = ?`)
      .get(agentKey, namespace, key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  forget(agentKey: string, namespace: string, key: string): void {
    this.db.prepare(`DELETE FROM memories WHERE agent_key = ? AND namespace = ? AND key = ?`).run(agentKey, namespace, key);
  }

  list(agentKey: string, namespace?: string): MemoryEntry[] {
    const rows = namespace
      ? (this.db
          .prepare(`SELECT * FROM memories WHERE agent_key = ? AND namespace = ? ORDER BY updated_at DESC`)
          .all(agentKey, namespace) as Row[])
      : (this.db.prepare(`SELECT * FROM memories WHERE agent_key = ? ORDER BY updated_at DESC`).all(agentKey) as Row[]);

    return rows.map((row) => ({
      agentKey: row.agent_key,
      namespace: row.namespace,
      key: row.key,
      value: JSON.parse(row.value),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  search(agentKey: string, namespace: string, query: string, topK = 5): MemoryEntry[] {
    const entries = this.list(agentKey, namespace);
    if (!entries.length) return [];

    const queryTokens = tokenize(query);
    if (!queryTokens.size) return entries.slice(0, topK);

    const scored = entries.map((entry) => {
      const text = typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value);
      const entryTokens = tokenize(text);
      const keyTokens = tokenize(entry.key);
      const textScore = jaccardSimilarity(queryTokens, entryTokens);
      const keyBonus = jaccardSimilarity(queryTokens, keyTokens) * 0.4;
      return { entry, score: textScore + keyBonus };
    });

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .filter((s) => s.score > 0)
      .map((s) => s.entry);
  }

  clearAgent(agentKey: string): void {
    this.db.prepare(`DELETE FROM memories WHERE agent_key = ?`).run(agentKey);
    this.db.prepare(`DELETE FROM chain_identities WHERE agent_key = ?`).run(agentKey);
    this.db.prepare(`DELETE FROM agents WHERE agent_key = ?`).run(agentKey);
  }
}

interface Row {
  agent_key: string;
  namespace: string;
  key: string;
  value: string;
  created_at: number;
  updated_at: number;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\W+/)
      .filter((t) => t.length > 1),
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  return intersection / (a.size + b.size - intersection);
}
