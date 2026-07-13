// Client-safe entry point: chain adapters + routing only, no `@clawdhq/clawmem`
// (better-sqlite3 is a native addon and must never reach a browser bundle).
// Server-side code (Next.js Route Handlers, Server Actions) should import the
// full ClawdHQSDK facade from "@clawdhq/sdk/server" instead.
export { clawdHQAgentExchangeAbi, clawdHQCoreAbi, clawdHQLaunchpadAbi, clawdHQStakingAbi, clawdHQEvaluatorPoolAbi, clawdHQCrossChainIdentityAbi, clawdHQGovernorAbi } from "./abi/index.js";
export { EvmAdapter, type EvmAdapterConfig } from "./adapters/evm.js";
export { EvmAgentExchangeAdapter, type EvmAgentExchangeAdapterConfig } from "./adapters/evm-exchange.js";
export { EvmLaunchpadAdapter, type EvmLaunchpadAdapterConfig } from "./adapters/evm-launchpad.js";
export { EvmStakingAdapter, type EvmStakingAdapterConfig } from "./adapters/evm-staking.js";
export { EvmEvaluatorPoolAdapter, type EvmEvaluatorPoolAdapterConfig, type EvaluatorCase } from "./adapters/evm-evaluator-pool.js";
export { EvmNegotiationAdapter, type EvmNegotiationAdapterConfig, type NegotiationSummary } from "./adapters/evm-negotiation.js";
export { EvmCrossChainIdentityAdapter, type EvmCrossChainIdentityAdapterConfig } from "./adapters/evm-cross-chain-identity.js";
export { EvmGovernorAdapter, type EvmGovernorAdapterConfig } from "./adapters/evm-governor.js";
export { EvmCctpAdapter, type EvmCctpAdapterConfig } from "./adapters/evm-cctp.js";
export { ensureErc20Allowance } from "./adapters/erc20.js";
export { SolanaAdapter, type SolanaAdapterConfig } from "./adapters/solana.js";
export { SuiAdapter, type SuiAdapterConfig } from "./adapters/sui.js";
export { RoutingEngine, type RoutingEngineConfig } from "./routing.js";
export type {
  AgentSummary,
  BidSummary,
  ChainId,
  EvmChainId,
  JobSummary,
  LaunchSummary,
  ListingSummary,
  ProposalSummary,
  ProtocolStats,
} from "./types.js";
