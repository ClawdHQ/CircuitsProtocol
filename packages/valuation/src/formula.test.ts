import { describe, expect, it } from "vitest";
import { computeFairValue } from "./formula.js";
import { CURRENT_FORMULA_VERSION, RECENCY_FLOOR_FACTOR, REPUTATION_FACTOR_MAX, REPUTATION_FACTOR_MIN } from "./constants.js";
import type { AgentValuationInput } from "./types.js";

const NOW = 1_800_000_000;

function baseInput(overrides: Partial<AgentValuationInput> = {}): AgentValuationInput {
  return {
    usdcRevenue: 10_000_000n, // $10
    tier: 0,
    reputationBps: 5000,
    lastJobAtSeconds: NOW,
    supportsX402: false,
    supportsA2A: false,
    supportsMcp: false,
    nowSeconds: NOW,
    ...overrides,
  };
}

describe("computeFairValue", () => {
  it("stamps the current formula version", () => {
    expect(computeFairValue(baseInput()).formulaVersion).toBe(CURRENT_FORMULA_VERSION);
  });

  it("is monotonic non-decreasing in revenue", () => {
    const low = computeFairValue(baseInput({ usdcRevenue: 10_000_000n }));
    const high = computeFairValue(baseInput({ usdcRevenue: 20_000_000n }));
    expect(high.fairValueUsdc).toBeGreaterThan(low.fairValueUsdc);
  });

  it("gives a higher revenue multiplier to higher tiers", () => {
    const basic = computeFairValue(baseInput({ tier: 0 }));
    const verified = computeFairValue(baseInput({ tier: 1 }));
    const elite = computeFairValue(baseInput({ tier: 2 }));
    expect(verified.fairValueUsdc).toBeGreaterThan(basic.fairValueUsdc);
    expect(elite.fairValueUsdc).toBeGreaterThan(verified.fairValueUsdc);
  });

  it("credits capabilities even at zero revenue, so pre-revenue agents aren't valued at zero", () => {
    const noCapabilities = computeFairValue(baseInput({ usdcRevenue: 0n }));
    const oneCapability = computeFairValue(baseInput({ usdcRevenue: 0n, supportsX402: true }));
    const allCapabilities = computeFairValue(
      baseInput({ usdcRevenue: 0n, supportsX402: true, supportsA2A: true, supportsMcp: true }),
    );
    expect(noCapabilities.fairValueUsdc).toBe(0n);
    expect(oneCapability.fairValueUsdc).toBeGreaterThan(0n);
    expect(allCapabilities.fairValueUsdc).toBeGreaterThan(oneCapability.fairValueUsdc);
  });

  it("clamps the reputation factor to REPUTATION_FACTOR_MIN at reputationBps=0", () => {
    const result = computeFairValue(baseInput({ reputationBps: 0 }));
    expect(result.breakdown.reputationFactor).toBeCloseTo(REPUTATION_FACTOR_MIN);
  });

  it("clamps the reputation factor to REPUTATION_FACTOR_MAX at reputationBps=10000", () => {
    const result = computeFairValue(baseInput({ reputationBps: 10_000 }));
    expect(result.breakdown.reputationFactor).toBeCloseTo(REPUTATION_FACTOR_MAX);
  });

  it("never lets the recency factor drop below the floor for an agent that never completed a job", () => {
    const result = computeFairValue(baseInput({ lastJobAtSeconds: 0 }));
    expect(result.breakdown.recencyFactor).toBe(RECENCY_FLOOR_FACTOR);
  });

  it("never lets the recency factor drop below the floor no matter how stale the last job is", () => {
    const veryStale = computeFairValue(baseInput({ lastJobAtSeconds: NOW - 100 * 365 * 24 * 60 * 60, nowSeconds: NOW }));
    expect(veryStale.breakdown.recencyFactor).toBeGreaterThanOrEqual(RECENCY_FLOOR_FACTOR);
    expect(veryStale.breakdown.recencyFactor).toBeCloseTo(RECENCY_FLOOR_FACTOR, 3);
  });

  it("values a recently active agent higher than an otherwise-identical stale one", () => {
    const fresh = computeFairValue(baseInput({ lastJobAtSeconds: NOW, nowSeconds: NOW }));
    const stale = computeFairValue(baseInput({ lastJobAtSeconds: NOW - 90 * 24 * 60 * 60, nowSeconds: NOW }));
    expect(fresh.fairValueUsdc).toBeGreaterThan(stale.fairValueUsdc);
  });
});
