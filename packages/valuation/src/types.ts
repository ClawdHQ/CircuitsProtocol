/** Matches the AgentTier enum stored on-chain (Basic/Verified/Elite) identically across EVM, Solana, and Sui. */
export type AgentTier = 0 | 1 | 2;

export interface AgentValuationInput {
  /** Lifetime USDC revenue, 6-decimal fixed point (matches usdcRevenue / usdc_revenue on-chain). */
  usdcRevenue: bigint;
  tier: AgentTier;
  /** 0-10000. */
  reputationBps: number;
  /** Unix seconds of the agent's last completed job; 0 if it has never completed one. */
  lastJobAtSeconds: number;
  supportsX402: boolean;
  supportsA2A: boolean;
  supportsMcp: boolean;
  /** Injected "now" for deterministic, testable recency scoring — callers should pass the
   * current time explicitly rather than this module reading the clock itself. */
  nowSeconds: number;
}

export interface AgentValuationBreakdown {
  revenueComponentUsdc: bigint;
  capabilityComponentUsdc: bigint;
  reputationFactor: number;
  recencyFactor: number;
}

export interface AgentValuationResult {
  /** Off-chain, display-only reference price. Never enforced on-chain — bids may land above or below it. */
  fairValueUsdc: bigint;
  breakdown: AgentValuationBreakdown;
  formulaVersion: string;
}
