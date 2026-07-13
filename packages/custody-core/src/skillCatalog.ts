export interface Skill {
  id: string;
  emoji: string;
  name: string;
  desc: string;
  cat: string;
  price: string;
  /** Who actually builds/maintains this — replaces a fabricated install count with something
   * real and checkable. "ClawdHQ" for the in-house entries, "Community" for user-published. */
  publisher: string;
  /** Real homepage/docs/repo for the underlying tool. Null only for in-house entries, which
   * link nowhere external, and for user-published skills (nothing to verify a link against). */
  url: string | null;
  isCustom?: boolean;
  /** Set only for isCustom entries (apps/web's useSkills.ts, from PublishedSkill.verifiedAt) —
   * whether this listing's endpoint actually resolves to a callable SkillInvocation. Undefined
   * for every BUILTIN_SKILLS entry: every entry below is unconditionally live (see this file's
   * top comment), so "undefined" here just means "not tracked per-entry," not "not live." */
  isLive?: boolean;
  /** Set only for isCustom entries — the publishing Profile's id, so the UI can gate the
   * remove/delete control to the actual creator rather than showing it to every viewer now that
   * published skills are visible to everyone (not the prior browser-local-only model, where
   * "isCustom" alone was an implicit ownership check). */
  creatorProfileId?: string;
}

export const SKILL_CATEGORIES = ["DeFi", "Exchange", "Wallet", "Analytics", "Security", "Developer", "Automation", "Memory", "Social", "Productivity", "Gaming"];

/** Every entry below has a real, unconditionally-active `SKILL_INVOCATIONS` entry in
 * skillRegistry.ts — an agent that installs one of these can actually call it today, right now,
 * with no further operator configuration. This file used to also carry ~74 reference-only
 * entries (real, verified-to-exist tools/protocols with no callable endpoint this codebase could
 * responsibly wire — a GitHub repo, an npm package, a self-hosted framework, or a third-party
 * platform needing per-agent credentials this codebase has nowhere to store yet) — removed
 * 2026-07-11 at the operator's explicit request, since a marketplace listing an agent can
 * "install" but that silently does nothing when called is worse than not listing it at all.
 * That reference-only content still exists in git history if a future pass wants to revisit any
 * of it with a real integration (e.g. once a per-agent credential vault exists for the
 * exchange/wallet/social entries, or once a chosen subset gets deliberately wired the way GoPlus/
 * CoinGecko were).
 *
 * `1inch` was removed from this list too, for the same reason, despite having real, tested,
 * ready invocation code (see skillRegistry.ts) — `SKILL_1INCH_API_KEY` isn't currently set in
 * this deployment, so as things stand it would list as installable but never actually resolve.
 * Re-add its BUILTIN_SKILLS entry (skillRegistry.ts already handles the rest automatically) once
 * an operator configures that key.
 *
 * Lives here (not apps/web) so it's importable from both apps/web's UI (useSkills.ts /
 * @/lib/skills.ts re-export it) and packages/hosted-agent-runtime, which needs these
 * descriptions too, to tell an LLM what an installed skill actually is — the same reasoning
 * skillRegistry.ts's own placement documents. */
export const BUILTIN_SKILLS: Skill[] = [
  {
    id: "clawdhq-agent",
    emoji: "🤝",
    name: "Ask Another Agent",
    desc: "Calls another ClawdHQ hosted agent's own MCP server (ask_agent tool) and returns its reply — both sides are real ClawdHQ agents, so there's no third-party integration to verify.",
    cat: "Automation",
    price: "Free",
    publisher: "ClawdHQ",
    url: null,
  },
  { id: "goplus", emoji: "🛡️", name: "GoPlus Security", desc: "Live: real-time honeypot/rug-pull/malicious-owner token screening on Ethereum + Base mainnet, fully keyless — GoPlus's public API needs no account.", cat: "Security", price: "$0.25", publisher: "GoPlus Labs", url: "https://gopluslabs.io" },
  { id: "goplus-agentguard", emoji: "🔰", name: "GoPlus Address Screening", desc: "Live: pre-transaction check of a wallet/contract address on Ethereum + Base mainnet for phishing, sanctions, and known-malicious flags, fully keyless. Wired to GoPlus's own address_security API directly — the original agentguard CLI it's named after has no hosted API of its own and calls this same endpoint under the hood.", cat: "Security", price: "$0.50", publisher: "GoPlus Security", url: "https://api.gopluslabs.io" },
  { id: "coingecko-cli", emoji: "🦎", name: "CoinGecko Market Prices", desc: "Live: real spot prices for any CoinGecko-listed asset, fully keyless (optionally faster with an operator's free demo key).", cat: "Analytics", price: "$0.25", publisher: "CoinGecko", url: "https://www.coingecko.com/en/api" },
];
