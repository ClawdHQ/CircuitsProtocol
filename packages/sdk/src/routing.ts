import type { ClawMem } from "@clawdhq/clawmem";
import { EvmAdapter } from "./adapters/evm.js";
import { EvmAgentExchangeAdapter } from "./adapters/evm-exchange.js";
import { SolanaAdapter } from "./adapters/solana.js";
import { SuiAdapter } from "./adapters/sui.js";
import type { ChainId, EvmChainId } from "./types.js";

export interface RoutingEngineConfig {
  evm?: Partial<Record<EvmChainId, EvmAdapter>>;
  evmExchange?: Partial<Record<EvmChainId, EvmAgentExchangeAdapter>>;
  solana?: SolanaAdapter;
  sui?: SuiAdapter;
  clawMem: ClawMem;
}

/** Picks the right chain adapter for a given `ChainId` and resolves a logical agent's
 * cross-chain identity via `ClawMem`. Reads/writes themselves stay adapter-specific
 * (EVM, Solana, and Sui have fundamentally different transaction-building models), so
 * this layer unifies chain *selection*, not the call shape itself. */
export class RoutingEngine {
  readonly clawMem: ClawMem;
  private readonly evmAdapters: Partial<Record<EvmChainId, EvmAdapter>>;
  private readonly evmExchangeAdapters: Partial<Record<EvmChainId, EvmAgentExchangeAdapter>>;
  private readonly solanaAdapter?: SolanaAdapter;
  private readonly suiAdapter?: SuiAdapter;

  constructor(config: RoutingEngineConfig) {
    this.clawMem = config.clawMem;
    this.evmAdapters = config.evm ?? {};
    this.evmExchangeAdapters = config.evmExchange ?? {};
    this.solanaAdapter = config.solana;
    this.suiAdapter = config.sui;
  }

  getEvmAdapter(chain: EvmChainId): EvmAdapter {
    const adapter = this.evmAdapters[chain];
    if (!adapter) throw new Error(`No EVM adapter configured for chain "${chain}"`);
    return adapter;
  }

  getEvmExchangeAdapter(chain: EvmChainId): EvmAgentExchangeAdapter {
    const adapter = this.evmExchangeAdapters[chain];
    if (!adapter) throw new Error(`No EVM agent-exchange adapter configured for chain "${chain}"`);
    return adapter;
  }

  getSolanaAdapter(): SolanaAdapter {
    if (!this.solanaAdapter) throw new Error("No Solana adapter configured");
    return this.solanaAdapter;
  }

  getSuiAdapter(): SuiAdapter {
    if (!this.suiAdapter) throw new Error("No Sui adapter configured");
    return this.suiAdapter;
  }

  hasChain(chain: ChainId): boolean {
    if (chain === "solana") return this.solanaAdapter !== undefined;
    if (chain === "sui") return this.suiAdapter !== undefined;
    return this.evmAdapters[chain] !== undefined;
  }

  /** Looks up the logical ClawMem agent key linked to a `(chain, chainAgentId)` pair. */
  resolveAgentKey(chain: ChainId, chainAgentId: string): string | undefined {
    return this.clawMem.resolveAgentKey(chain, chainAgentId);
  }

  /** Returns every chain the logical agent has a linked on-chain identity on. */
  getAgentIdentities(agentKey: string) {
    return this.clawMem.getChainIdentities(agentKey);
  }
}
