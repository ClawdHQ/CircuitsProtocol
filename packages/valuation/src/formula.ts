import {
  CAPABILITY_BASE_VALUE_USDC,
  CURRENT_FORMULA_VERSION,
  RECENCY_FLOOR_FACTOR,
  RECENCY_HALF_LIFE_SECONDS,
  REPUTATION_FACTOR_MAX,
  REPUTATION_FACTOR_MIN,
  TIER_REVENUE_MULTIPLIER,
} from "./constants.js";
import type { AgentValuationInput, AgentValuationResult } from "./types.js";

function reputationFactor(reputationBps: number): number {
  const clamped = Math.min(10_000, Math.max(0, reputationBps));
  const span = REPUTATION_FACTOR_MAX - REPUTATION_FACTOR_MIN;
  return REPUTATION_FACTOR_MIN + (clamped / 10_000) * span;
}

function recencyFactor(lastJobAtSeconds: number, nowSeconds: number): number {
  if (lastJobAtSeconds <= 0) return RECENCY_FLOOR_FACTOR;
  const elapsed = Math.max(0, nowSeconds - lastJobAtSeconds);
  const decayed = 2 ** (-elapsed / RECENCY_HALF_LIFE_SECONDS);
  return RECENCY_FLOOR_FACTOR + (1 - RECENCY_FLOOR_FACTOR) * decayed;
}

function capabilityComponentUsdc(input: AgentValuationInput): bigint {
  const count = (input.supportsX402 ? 1 : 0) + (input.supportsA2A ? 1 : 0) + (input.supportsMcp ? 1 : 0);
  return CAPABILITY_BASE_VALUE_USDC * BigInt(count);
}

/**
 * Computes an agent's off-chain, display-only "fair value" reference price from its on-chain
 * capabilities and revenue history. This is never enforced on-chain: buyers may bid above or
 * below it freely. Pure function of its inputs — callers decide how often to recompute (e.g. a
 * cache refreshed on revenue-changing events, or fresh at read time).
 */
export function computeFairValue(input: AgentValuationInput): AgentValuationResult {
  const revenueMultiplier = TIER_REVENUE_MULTIPLIER[input.tier];
  const revenueComponentUsdc = (input.usdcRevenue * BigInt(Math.round(revenueMultiplier * 1000))) / 1000n;
  const capabilityUsdc = capabilityComponentUsdc(input);
  const repFactor = reputationFactor(input.reputationBps);
  const recFactor = recencyFactor(input.lastJobAtSeconds, input.nowSeconds);

  const base = revenueComponentUsdc + capabilityUsdc;
  const combinedFactorMicros = BigInt(Math.round(repFactor * recFactor * 1_000_000));
  const fairValueUsdc = (base * combinedFactorMicros) / 1_000_000n;

  return {
    fairValueUsdc,
    breakdown: {
      revenueComponentUsdc,
      capabilityComponentUsdc: capabilityUsdc,
      reputationFactor: repFactor,
      recencyFactor: recFactor,
    },
    formulaVersion: CURRENT_FORMULA_VERSION,
  };
}
