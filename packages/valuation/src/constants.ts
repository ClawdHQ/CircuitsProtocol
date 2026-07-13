export const CURRENT_FORMULA_VERSION = "v1";

/** Indexed by AgentTier (Basic/Verified/Elite). Higher tiers imply more durable, trustworthy
 * revenue, so lifetime earnings are weighted more heavily for them. */
export const TIER_REVENUE_MULTIPLIER: readonly [number, number, number] = [1.0, 1.5, 2.5];

/** Flat USDC credit (6-decimal), per supported protocol, so a pre-revenue agent with real
 * capabilities isn't valued at zero. */
export const CAPABILITY_BASE_VALUE_USDC = 500_000n;

export const REPUTATION_FACTOR_MIN = 0.5;
export const REPUTATION_FACTOR_MAX = 1.5;

/** Recency decay: value halves every RECENCY_HALF_LIFE_SECONDS of inactivity since the agent's
 * last completed job, floored at RECENCY_FLOOR_FACTOR so a dormant agent's history never decays to zero. */
export const RECENCY_HALF_LIFE_SECONDS = 30 * 24 * 60 * 60;
export const RECENCY_FLOOR_FACTOR = 0.25;
