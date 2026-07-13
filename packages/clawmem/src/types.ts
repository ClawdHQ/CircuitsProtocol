export type ChainId = "bsc" | "base" | "eth" | "solana" | "sui";

export interface ChainIdentity {
  chain: ChainId;
  chainAgentId: string;
  address: string;
  linkedAt: number;
}

export interface MemoryEntry<T = unknown> {
  agentKey: string;
  namespace: string;
  key: string;
  value: T;
  createdAt: number;
  updatedAt: number;
}

export interface ClawMemConfig {
  /** Defaults to `CLAWMEM_DATABASE_URL`, e.g. `file:./data/clawmem.db`. */
  databaseUrl?: string;
}
