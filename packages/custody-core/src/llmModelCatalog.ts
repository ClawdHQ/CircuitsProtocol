export type FoundationModelTier = "STANDARD" | "PLUS" | "PRO";

export const FOUNDATION_MODEL_TIER_IDS: FoundationModelTier[] = ["STANDARD", "PLUS", "PRO"];

/** Fallback tier for any foundationModel string not in FOUNDATION_MODELS below (a stale
 * persona, a manifest-imported value, a since-removed id) — same "fall back to something cheap
 * and reliable, not expensive" philosophy as llmClient.ts's own OPENROUTER_FALLBACK_SLUG. */
export const DEFAULT_FOUNDATION_MODEL_TIER: FoundationModelTier = "STANDARD";

export interface FoundationModelTierMeta {
  id: FoundationModelTier;
  label: string;
  /** Inline-style badge colors (hex/rgba), matching the badgeBg/badgeColor pattern the frontend
   * already used per-model before this catalog existed — now per-tier instead, reusing this
   * repo's existing design tokens (packages/config/tailwind-tokens.js) rather than inventing a
   * new palette: STANDARD=emerald (state.emerald), PLUS=violet (accent.violet), PRO=amber
   * (state.amber). */
  badgeBg: string;
  badgeColor: string;
}

export const FOUNDATION_MODEL_TIERS: FoundationModelTierMeta[] = [
  { id: "STANDARD", label: "Standard", badgeBg: "rgba(16,185,129,0.12)", badgeColor: "#10B981" },
  { id: "PLUS", label: "Plus", badgeBg: "rgba(124,58,237,0.15)", badgeColor: "#7C3AED" },
  { id: "PRO", label: "Pro", badgeBg: "rgba(245,158,11,0.15)", badgeColor: "#F59E0B" },
];

export interface FoundationModelCatalogEntry {
  /** Persisted verbatim into social-db's CognitiveLayer.foundationModel, and looked up in
   * hosted-agent-runtime's FOUNDATION_MODEL_TO_OPENROUTER_SLUG for the actual OpenRouter slug —
   * two separate lookups keyed by the same id (see llmClient.ts's OPENROUTER_FREE_MODE). Changing
   * an id here is a breaking change for any agent whose persona already stored the old one. */
  id: string;
  label: string;
  vendor: string;
  tier: FoundationModelTier;
  description: string;
}

/** The 5 ids/labels/vendors marked "existing" below were the original catalog (still the exact
 * ids referenced by HOSTED_RUNTIME_OPENROUTER_SLUG_* in .env.example) — kept byte-for-byte so
 * already-registered agents' stored foundationModel values keep resolving identically. Everything
 * else was added later, live-verified against OpenRouter's actual current model listing rather
 * than training-data recall (see this feature's plan doc for what got corrected and why) — one
 * exception: claude-fable-5's PLUS placement is an informed guess (no independent pricing data
 * found for it), not a verified fact like the rest of this table. */
export const FOUNDATION_MODELS: FoundationModelCatalogEntry[] = [
  // STANDARD
  { id: "llama-3.3-70b", label: "Llama 3.3 70B", vendor: "Meta", tier: "STANDARD", description: "Open-weight, fast, and inexpensive — a solid default for straightforward replies." },
  { id: "qwen-2.5-72b", label: "Qwen 2.5 72B", vendor: "Alibaba", tier: "STANDARD", description: "Open-weight generalist model, competitive with much larger closed models." },
  { id: "claude-haiku-4.5", label: "Claude Haiku 4.5", vendor: "Anthropic", tier: "STANDARD", description: "Anthropic's fastest, most affordable current model." },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", vendor: "OpenAI", tier: "STANDARD", description: "OpenAI's lightweight, cost-efficient tier of the GPT-5.6 family." },
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", vendor: "Google", tier: "STANDARD", description: "Google's fast, low-latency model for everyday tasks." },
  { id: "mistral-medium-3.5", label: "Mistral Medium 3.5", vendor: "Mistral AI", tier: "STANDARD", description: "Efficient mid-size model, strong price-to-performance." },
  // PLUS
  { id: "deepseek-r1", label: "DeepSeek R1", vendor: "DeepSeek", tier: "PLUS", description: "Open-weight reasoning model — explicit chain-of-thought before answering." },
  { id: "gpt-4o", label: "GPT-4o", vendor: "OpenAI", tier: "PLUS", description: "OpenAI's established multimodal flagship, still a strong all-rounder." },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", vendor: "OpenAI", tier: "PLUS", description: "The balanced default of the GPT-5.6 family — everyday interactive and agentic work." },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", vendor: "Anthropic", tier: "PLUS", description: "Anthropic's balanced mainline model — strong reasoning at moderate cost." },
  { id: "claude-fable-5", label: "Claude Fable 5", vendor: "Anthropic", tier: "PLUS", description: "Anthropic's latest model, tuned for expressive, narrative-style output." },
  { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", vendor: "DeepSeek", tier: "PLUS", description: "Efficiency-optimized DeepSeek V4 — near-frontier quality, lower cost." },
  { id: "glm-5.2", label: "GLM 5.2", vendor: "Zhipu AI", tier: "PLUS", description: "Open-weight coding-first model, currently a top-ranked open-weight option." },
  { id: "qwen3.7-max", label: "Qwen3.7 Max", vendor: "Alibaba", tier: "PLUS", description: "Alibaba's larger current-generation Qwen model." },
  // PRO
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", vendor: "OpenAI", tier: "PRO", description: "The flagship of the GPT-5.6 family — highest reasoning ceiling, for demanding work." },
  { id: "claude-opus-4.8", label: "Claude Opus 4.8", vendor: "Anthropic", tier: "PRO", description: "Anthropic's current flagship — their most capable model." },
  { id: "gemini-3.1-pro", label: "Gemini 3.1 Pro", vendor: "Google", tier: "PRO", description: "Google's flagship frontier model for high-precision reasoning." },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", vendor: "DeepSeek", tier: "PRO", description: "DeepSeek's largest current model, built for demanding agentic workflows." },
  { id: "grok-4.5", label: "Grok 4.5", vendor: "xAI", tier: "PRO", description: "xAI's current flagship model." },
];

export function tierForFoundationModel(foundationModel: string | undefined): FoundationModelTier {
  if (!foundationModel) return DEFAULT_FOUNDATION_MODEL_TIER;
  return FOUNDATION_MODELS.find((m) => m.id === foundationModel)?.tier ?? DEFAULT_FOUNDATION_MODEL_TIER;
}

export function tierMetaFor(tier: FoundationModelTier): FoundationModelTierMeta {
  return FOUNDATION_MODEL_TIERS.find((t) => t.id === tier) ?? FOUNDATION_MODEL_TIERS[0];
}
