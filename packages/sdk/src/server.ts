import { ClawMem, type ClawMemConfig } from "@clawdhq/clawmem";
import { EvmAdapter, type EvmAdapterConfig } from "./adapters/evm.js";
import { EvmAgentExchangeAdapter, type EvmAgentExchangeAdapterConfig } from "./adapters/evm-exchange.js";
import { SolanaAdapter, type SolanaAdapterConfig } from "./adapters/solana.js";
import { SuiAdapter, type SuiAdapterConfig } from "./adapters/sui.js";
import { RoutingEngine } from "./routing.js";
import type { EvmChainId } from "./types.js";

export interface ClawdHQSDKConfig {
  evm?: Partial<Record<EvmChainId, EvmAdapterConfig>>;
  evmExchange?: Partial<Record<EvmChainId, EvmAgentExchangeAdapterConfig>>;
  solana?: SolanaAdapterConfig;
  sui?: SuiAdapterConfig;
  clawMem?: ClawMemConfig;
}

/** Top-level entry point combining ClawMem (cross-chain identity + agent memory) with
 * the EVM/Solana/Sui chain adapters behind a single `RoutingEngine`. */
export class ClawdHQSDK {
  readonly clawMem: ClawMem;
  readonly routing: RoutingEngine;
  readonly evm: Partial<Record<EvmChainId, EvmAdapter>>;
  readonly evmExchange: Partial<Record<EvmChainId, EvmAgentExchangeAdapter>>;
  readonly solana?: SolanaAdapter;
  readonly sui?: SuiAdapter;

  constructor(config: ClawdHQSDKConfig = {}) {
    this.clawMem = new ClawMem(config.clawMem);

    this.evm = {};
    for (const [chain, evmConfig] of Object.entries(config.evm ?? {}) as [EvmChainId, EvmAdapterConfig][]) {
      this.evm[chain] = new EvmAdapter(evmConfig);
    }

    this.evmExchange = {};
    for (const [chain, exchangeConfig] of Object.entries(config.evmExchange ?? {}) as [EvmChainId, EvmAgentExchangeAdapterConfig][]) {
      this.evmExchange[chain] = new EvmAgentExchangeAdapter(exchangeConfig);
    }

    this.solana = config.solana ? new SolanaAdapter(config.solana) : undefined;
    this.sui = config.sui ? new SuiAdapter(config.sui) : undefined;

    this.routing = new RoutingEngine({
      evm: this.evm,
      evmExchange: this.evmExchange,
      solana: this.solana,
      sui: this.sui,
      clawMem: this.clawMem,
    });
  }

  close(): void {
    this.clawMem.close();
  }
}
