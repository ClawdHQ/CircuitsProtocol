// Maps a Skill.id (from this package's BUILTIN_SKILLS catalog, skillCatalog.ts) to how it's
// actually invoked, if at all. A skillId with no entry here is reference-only: an owner can
// install it as a declared capability, but nothing in this codebase can call it — the catalog's
// `url` field is almost always a docs page, GitHub repo, or npm package, not a live endpoint, so
// most entries genuinely have nothing to wire up without external integration work this package
// can't responsibly fabricate.
//
// A small, individually-verified subset IS hardcoded below with real endpoints (GoPlus, CoinGecko,
// 1inch) — each confirmed live via an actual HTTP request (not just a docs page) during wiring,
// scoped to Ethereum mainnet (chainId "1") and Base mainnet (chainId "8453") specifically, the two
// EVM mainnets both GoPlus's and 1inch's own supported-chain lists confirm coverage for. Arc
// mainnet is deliberately excluded: as of this wiring, Arc is still testnet-only (mainnet targeted
// for summer 2026 per Circle's own announcements), so no third-party data provider — GoPlus,
// CoinGecko, and 1inch were all checked directly — indexes it yet. Re-check and add Arc once its
// mainnet is live and a provider actually covers it; don't add a chainId no provider can serve.
//
// Lives in custody-core (not packages/hosted-agent-runtime or apps/web) because callAgentSkill
// (agentSkillActions.ts) needs to resolve it, and custody-core is the lower-level package both
// hosted-agent-runtime and apps/web already depend on — the reverse import direction isn't
// available from either.
export type SkillInvocation =
  | { kind: "mcp"; url: string; priceUsdc: string }
  | {
      kind: "http";
      /** May contain `{paramName}` placeholders, substituted from the matching key in a call's
       * `input` (see agentSkillActions.ts's substitutePathParams). Any input key not consumed by
       * a placeholder becomes a GET query-string param or a POST JSON body field. */
      endpoint: string;
      method: "GET" | "POST";
      priceUsdc: string;
      inputSchema: Record<string, unknown>;
      /** Static headers (auth, etc.) merged onto every call to this endpoint. Read from
       * `process.env` at registry-construction time below — never a literal secret in source. */
      headers?: Record<string, string>;
    }
  /// The one skill wired up without any operator configuration: calls another ClawdHQ hosted
  /// agent's own MCP server (see apps/web's .../hosted/[chain]/[agentChainId]/mcp route) rather
  /// than a third party — both sides are real ClawdHQ agents, so there's nothing here to verify
  /// externally the way a third-party API's contract would need to be. See invokeSkill in
  /// agentSkillActions.ts for how `{chain, agentChainId, message}` input resolves to a URL.
  | { kind: "clawdhq-agent"; priceUsdc: string };

const CLAWDHQ_AGENT_SKILL_ID = "clawdhq-agent";

/** Beyond the handful hardcoded below, third-party entries are never wired here with guessed
 * endpoints/schemas — this codebase can verify a catalog entry's name/description/docs-link via
 * static research, but not every live API's actual request contract, and most of the catalog
 * (a GitHub repo, an npm package, a self-hosted framework) has no hosted endpoint to verify at
 * all. An operator who has deployed/verified a further real integration configures it via this
 * env var instead: a JSON object of `Record<skillId, SkillInvocation>`, merged on top of (and
 * able to override) the hardcoded entries below. Parsed once at module load; a malformed value is
 * logged and ignored rather than crashing the process. */
function loadOperatorRegistry(): Record<string, SkillInvocation> {
  const raw = process.env.HOSTED_RUNTIME_SKILL_REGISTRY_JSON;
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, SkillInvocation>;
    }
    console.error("[skillRegistry] HOSTED_RUNTIME_SKILL_REGISTRY_JSON must be a JSON object — ignoring.");
  } catch (error) {
    console.error("[skillRegistry] failed to parse HOSTED_RUNTIME_SKILL_REGISTRY_JSON — ignoring.", error);
  }
  return {};
}

// Ethereum mainnet / Base mainnet chain-id enum shared by every chain-scoped schema below — see
// this file's top-of-file comment for why these two specifically (and not Arc).
const EVM_MAINNET_CHAIN_ID_SCHEMA = { type: "string", enum: ["1", "8453"], description: 'EVM chain id: "1" for Ethereum mainnet, "8453" for Base mainnet.' };

const GOPLUS_TOKEN_SECURITY_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    chainId: EVM_MAINNET_CHAIN_ID_SCHEMA,
    contract_addresses: { type: "string", description: "One token contract address (0x...) to screen for honeypot/rug-pull/malicious-owner risk. Comma-separate to check multiple in one call." },
  },
  required: ["chainId", "contract_addresses"],
};

const GOPLUS_ADDRESS_SECURITY_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    address: { type: "string", description: "The wallet or contract address (0x...) to screen before an agent interacts with or sends funds to it." },
    chain_id: EVM_MAINNET_CHAIN_ID_SCHEMA,
  },
  required: ["address", "chain_id"],
};

const COINGECKO_PRICE_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    ids: { type: "string", description: 'Comma-separated CoinGecko coin ids, e.g. "bitcoin,ethereum".' },
    vs_currencies: { type: "string", description: 'Comma-separated currency codes to price against, e.g. "usd".' },
  },
  required: ["ids", "vs_currencies"],
};

const ONE_INCH_QUOTE_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    chainId: EVM_MAINNET_CHAIN_ID_SCHEMA,
    src: { type: "string", description: "Token contract address to sell — use 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE for native ETH." },
    dst: { type: "string", description: "Token contract address to buy." },
    amount: { type: "string", description: "Amount of src to sell, denominated in its smallest unit (wei)." },
  },
  required: ["chainId", "src", "dst", "amount"],
};

/** Requires a free 1inch developer-portal key (business.1inch.com/portal — self-serve, instant,
 * no approval wait) since every 1inch endpoint 401s without one, even a quote. Deliberately
 * excluded from SKILL_INVOCATIONS entirely (not registered with a broken/missing header) when
 * unset, so an agent with this skill installed just sees it as unavailable rather than a tool
 * that's always present but always fails — see loadResolvedAgentSkills's own "no entry = not
 * offered" contract. */
const ONE_INCH_API_KEY = process.env.SKILL_1INCH_API_KEY;

/** Optional: CoinGecko's keyless public tier (used when this is unset) already works, just at a
 * lower rate limit (~10-30 calls/min) than the free Demo tier (30 calls/min) a self-serve signup
 * at coingecko.com unlocks — see docs.coingecko.com/docs/keyless-public-api. */
const COINGECKO_DEMO_API_KEY = process.env.SKILL_COINGECKO_API_KEY;

export const SKILL_INVOCATIONS: Record<string, SkillInvocation> = {
  [CLAWDHQ_AGENT_SKILL_ID]: { kind: "clawdhq-agent", priceUsdc: "0" },

  // Live-verified 2026-07 by direct HTTP request (see this file's top-of-file comment).
  goplus: {
    kind: "http",
    endpoint: "https://api.gopluslabs.io/api/v1/token_security/{chainId}",
    method: "GET",
    priceUsdc: "0.25",
    inputSchema: GOPLUS_TOKEN_SECURITY_INPUT_SCHEMA,
  },
  "goplus-agentguard": {
    // GoPlus's own address/agentguard.io agentguard product (the catalog's original link,
    // github.com/GoPlusSecurity/agentguard) is a local CLI/runtime guard with no hosted API of
    // its own — it calls this same GoPlus Security API under the hood. Retargeted to that real,
    // live GoPlus endpoint (same publisher) rather than left unwired: pre-transaction malicious/
    // phishing/sanctioned-address screening, which is exactly this skill's stated purpose.
    kind: "http",
    endpoint: "https://api.gopluslabs.io/api/v1/address_security/{address}",
    method: "GET",
    priceUsdc: "0.50",
    inputSchema: GOPLUS_ADDRESS_SECURITY_INPUT_SCHEMA,
  },
  "coingecko-cli": {
    kind: "http",
    endpoint: "https://api.coingecko.com/api/v3/simple/price",
    method: "GET",
    priceUsdc: "0.25",
    inputSchema: COINGECKO_PRICE_INPUT_SCHEMA,
    headers: COINGECKO_DEMO_API_KEY ? { "x-cg-demo-api-key": COINGECKO_DEMO_API_KEY } : undefined,
  },
  ...(ONE_INCH_API_KEY
    ? {
        "1inch": {
          kind: "http" as const,
          endpoint: "https://api.1inch.dev/swap/v6.0/{chainId}/quote",
          method: "GET" as const,
          priceUsdc: "0.50",
          inputSchema: ONE_INCH_QUOTE_INPUT_SCHEMA,
          headers: { Authorization: `Bearer ${ONE_INCH_API_KEY}` },
        },
      }
    : {}),

  ...loadOperatorRegistry(),
};

export function resolveSkillInvocation(skillId: string): SkillInvocation | null {
  return SKILL_INVOCATIONS[skillId] ?? null;
}
