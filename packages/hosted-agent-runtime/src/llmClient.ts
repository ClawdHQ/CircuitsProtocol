import { generateText, generateObject, jsonSchema, dynamicTool, stepCountIs, type LanguageModel, type JSONSchema7, type ToolSet } from "ai";
import { z } from "zod";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { LlmProvider, LlmBilling, LlmCallKind, type Chain } from "@clawdhq/custody-db";
import { getDecryptedAgentLlmKey, assertAgentLlmCreditCovers, chargeAgentLlmCredit, callResolvedAgentSkill, listResolvedSkillTools } from "@clawdhq/custody-core";
import type { ResolvedSkill, KnowledgeCandidate } from "./persona.js";

// Two LLM routing paths, chosen by llmBilling:
//  - BYO_KEY: the owner's own account with a specific provider (Anthropic/OpenAI/Gemini),
//    called directly with their key. What model gets called is that provider's own configured
//    default (see BYO_DEFAULT_MODEL below) — a BYO key only ever talks to the one provider it
//    belongs to, so RegisterWizard's cross-provider Foundation Model picker (which includes
//    models no single provider serves, e.g. Llama/DeepSeek/Qwen) doesn't directly apply here.
//  - PLATFORM: routes through a single ClawdHQ-held OpenRouter key instead of a per-provider
//    one — OpenRouter fronts dozens of underlying models (including the open ones no
//    Anthropic/OpenAI/Gemini key could ever serve) behind one API, so platform billing can honor
//    whatever Foundation Model an owner picked without ClawdHQ provisioning a key for every
//    provider it might need.

// PLATFORM path: CognitiveLayer.foundationModel (RegisterWizard.tsx's FOUNDATION_MODELS ids)
// mapped to an OpenRouter slug, each independently overridable via env since OpenRouter's exact
// current slug for a given model can change without notice.
// HOSTED_RUNTIME_OPENROUTER_FALLBACK_MODEL covers any foundationModel value that isn't in this
// table (a stale persona, a manifest-imported value, etc.).
const FOUNDATION_MODEL_TO_OPENROUTER_SLUG: Record<string, string> = {
  // STANDARD tier — the first 3 (llama/qwen/claude-haiku) are the original ids/slugs, kept
  // byte-for-byte so already-stored personas keep resolving identically.
  "llama-3.3-70b": process.env.HOSTED_RUNTIME_OPENROUTER_SLUG_LLAMA_3_3_70B || "meta-llama/llama-3.3-70b-instruct",
  "qwen-2.5-72b": process.env.HOSTED_RUNTIME_OPENROUTER_SLUG_QWEN_2_5_72B || "qwen/qwen-2.5-72b-instruct",
  "claude-haiku-4.5": process.env.HOSTED_RUNTIME_OPENROUTER_SLUG_CLAUDE_HAIKU_4_5 || "anthropic/claude-haiku-4.5",
  "gpt-5.6-luna": process.env.HOSTED_RUNTIME_OPENROUTER_SLUG_GPT_5_6_LUNA || "openai/gpt-5.6-luna",
  "gemini-3.5-flash": process.env.HOSTED_RUNTIME_OPENROUTER_SLUG_GEMINI_3_5_FLASH || "google/gemini-3.5-flash",
  "mistral-medium-3.5": process.env.HOSTED_RUNTIME_OPENROUTER_SLUG_MISTRAL_MEDIUM_3_5 || "mistralai/mistral-medium-3.5",
  // PLUS tier — deepseek-r1/gpt-4o are the other 2 original ids/slugs, also kept byte-for-byte.
  "deepseek-r1": process.env.HOSTED_RUNTIME_OPENROUTER_SLUG_DEEPSEEK_R1 || "deepseek/deepseek-r1",
  "gpt-4o": process.env.HOSTED_RUNTIME_OPENROUTER_SLUG_GPT_4O || "openai/gpt-4o",
  "gpt-5.6-terra": process.env.HOSTED_RUNTIME_OPENROUTER_SLUG_GPT_5_6_TERRA || "openai/gpt-5.6-terra",
  "claude-sonnet-5": process.env.HOSTED_RUNTIME_OPENROUTER_SLUG_CLAUDE_SONNET_5 || "anthropic/claude-sonnet-5",
  "claude-fable-5": process.env.HOSTED_RUNTIME_OPENROUTER_SLUG_CLAUDE_FABLE_5 || "anthropic/claude-fable-5",
  "deepseek-v4-flash": process.env.HOSTED_RUNTIME_OPENROUTER_SLUG_DEEPSEEK_V4_FLASH || "deepseek/deepseek-v4-flash",
  "glm-5.2": process.env.HOSTED_RUNTIME_OPENROUTER_SLUG_GLM_5_2 || "z-ai/glm-5.2",
  "qwen3.7-max": process.env.HOSTED_RUNTIME_OPENROUTER_SLUG_QWEN3_7_MAX || "qwen/qwen3.7-max",
  // PRO tier — all new.
  "gpt-5.6-sol": process.env.HOSTED_RUNTIME_OPENROUTER_SLUG_GPT_5_6_SOL || "openai/gpt-5.6-sol",
  "claude-opus-4.8": process.env.HOSTED_RUNTIME_OPENROUTER_SLUG_CLAUDE_OPUS_4_8 || "anthropic/claude-opus-4.8",
  "gemini-3.1-pro": process.env.HOSTED_RUNTIME_OPENROUTER_SLUG_GEMINI_3_1_PRO || "google/gemini-3.1-pro-preview",
  "deepseek-v4-pro": process.env.HOSTED_RUNTIME_OPENROUTER_SLUG_DEEPSEEK_V4_PRO || "deepseek/deepseek-v4-pro",
  "grok-4.5": process.env.HOSTED_RUNTIME_OPENROUTER_SLUG_GROK_4_5 || "x-ai/grok-4.5",
};
const OPENROUTER_FALLBACK_SLUG = process.env.HOSTED_RUNTIME_OPENROUTER_FALLBACK_MODEL || "anthropic/claude-haiku-4.5";

// Testnet cost control: forces every PLATFORM-billed OpenRouter call onto one free model
// regardless of which foundationModel the owner picked, while agentLlmCredit.ts's
// chargeAgentLlmCredit/assertAgentLlmCreditCovers still charge based on that model's real tier —
// two separate lookups keyed by the same foundationModel id, deliberately decoupled so this can
// be flipped off at mainnet without touching pricing at all. Default free model was live-checked
// against OpenRouter's actual $0-priced models (its free-tier roster rotates — if this one starts
// getting rate-limited, swap the env var by hand; no automatic in-process fallback between free
// models, matching this package's existing no-retry stance).
const OPENROUTER_FREE_MODE = process.env.HOSTED_RUNTIME_OPENROUTER_FREE_MODE !== "false"; // default on
const OPENROUTER_FREE_MODEL = process.env.HOSTED_RUNTIME_OPENROUTER_FREE_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free";

// BYO_KEY path: one configured model per provider, not owner-selectable per call — env
// overridable the same way the OpenRouter slugs above are.
const BYO_DEFAULT_MODEL: Record<"ANTHROPIC" | "OPENAI" | "GEMINI", string> = {
  ANTHROPIC: process.env.HOSTED_RUNTIME_ANTHROPIC_MODEL || "claude-haiku-4-5",
  OPENAI: process.env.HOSTED_RUNTIME_OPENAI_MODEL || "gpt-4o-mini",
  GEMINI: process.env.HOSTED_RUNTIME_GEMINI_MODEL || "gemini-2.0-flash",
};

function resolveModel(llmKey: ResolvedLlmKey, foundationModel: string): LanguageModel {
  switch (llmKey.provider) {
    case LlmProvider.ANTHROPIC:
      return createAnthropic({ apiKey: llmKey.apiKey })(BYO_DEFAULT_MODEL.ANTHROPIC);
    case LlmProvider.OPENAI:
      return createOpenAI({ apiKey: llmKey.apiKey })(BYO_DEFAULT_MODEL.OPENAI);
    case LlmProvider.GEMINI:
      return createGoogleGenerativeAI({ apiKey: llmKey.apiKey })(BYO_DEFAULT_MODEL.GEMINI);
    case LlmProvider.OPENROUTER: {
      // Safe to override unconditionally here (never touches the ANTHROPIC/OPENAI/GEMINI
      // branches above) because resolveLlmKey's PLATFORM branch is the only code path in this
      // codebase that ever constructs a { provider: OPENROUTER } key — a BYO_KEY agent's stored
      // AgentLlmKey.provider can never be OPENROUTER, since the llm-key route's BYO_PROVIDERS
      // allow-list is hardcoded to [ANTHROPIC, OPENAI, GEMINI].
      const slug = OPENROUTER_FREE_MODE ? OPENROUTER_FREE_MODEL : (FOUNDATION_MODEL_TO_OPENROUTER_SLUG[foundationModel] ?? OPENROUTER_FALLBACK_SLUG);
      return createOpenRouter({ apiKey: llmKey.apiKey })(slug);
    }
  }
}

export interface ResolvedLlmKey {
  provider: LlmProvider;
  apiKey: string;
}

/** Resolves which LLM credentials a hosted-runtime agent's call should use: its own BYO
 * provider key (packages/custody-core's AgentLlmKey — ANTHROPIC/OPENAI/GEMINI) if `llmBilling`
 * is BYO_KEY, called directly; or the platform's single OpenRouter key from env when PLATFORM.
 * Throws rather than silently falling back — a BYO_KEY agent with no key saved is a
 * configuration bug (the llm-key save route is supposed to prevent this at the source), not
 * something that should quietly start spending the platform's own key. */
export async function resolveLlmKey(chain: Chain, agentChainId: string, llmBilling: LlmBilling): Promise<ResolvedLlmKey> {
  if (llmBilling === LlmBilling.BYO_KEY) {
    const key = await getDecryptedAgentLlmKey(chain, agentChainId);
    if (!key) throw new Error(`Agent ${chain}:${agentChainId} is configured for BYO_KEY billing but has no active AgentLlmKey stored.`);
    return key;
  }

  const apiKey = process.env.HOSTED_RUNTIME_PLATFORM_OPENROUTER_KEY;
  if (!apiKey) throw new Error("No platform OpenRouter key configured (HOSTED_RUNTIME_PLATFORM_OPENROUTER_KEY) — set one before enabling platform-billed hosted agents.");
  return { provider: LlmProvider.OPENROUTER, apiKey };
}

export interface AgentPersonaContext {
  displayName: string;
  worldview: string;
  /** Free-text description of how this agent should sound (e.g. "Professor-level expert who
   * explains complex topics simply") — distinct from `communicationStyle`'s fixed enum, this is
   * the owner's own words. Previously stored on CognitiveLayer and editable in the UI but never
   * actually read into a prompt anywhere. */
  voicePersona: string;
  customSystemPrompt: string;
  communicationStyle: "formal" | "casual" | "technical" | "friendly";
  personality: string[];
  knowledgeDomains: string[];
  goal: string | null;
  /** RegisterWizard's Foundation Model id (e.g. "claude-haiku-4.5") — only consulted by
   * resolveModel on the PLATFORM/OpenRouter path (mapped to an OpenRouter slug); a BYO_KEY
   * agent's model is provider-determined instead (see BYO_DEFAULT_MODEL). Previously stored but
   * never actually used to pick a model at all. */
  foundationModel: string;
  /** The most recent knowledge-marketplace acquisitions (packages/hosted-agent-runtime's
   * knowledgeAcquisition.ts, via persona.ts's loadAcquiredKnowledge) — a paid-for Prompt's text,
   * a Dataset's sample, or a Model's inference output, already reduced to plain text. Spliced
   * into buildSystemPrompt below, so a USE_KNOWLEDGE acquisition shapes every future reply and
   * tick decision, not just a one-off report that it happened. */
  acquiredKnowledge: { title: string; content: string }[];
}

function buildSystemPrompt(persona: AgentPersonaContext): string {
  const lines = [
    `You are ${persona.displayName || "an autonomous agent"} on ClawdHQ, an on-chain agent marketplace.`,
    `Communication style: ${persona.communicationStyle}.`,
  ];
  if (persona.voicePersona) lines.push(`Voice: ${persona.voicePersona}`);
  if (persona.personality.length) lines.push(`Personality traits: ${persona.personality.join(", ")}.`);
  if (persona.knowledgeDomains.length) lines.push(`Areas of expertise: ${persona.knowledgeDomains.join(", ")}.`);
  if (persona.worldview) lines.push(`Core operating philosophy: ${persona.worldview}`);
  if (persona.goal) lines.push(`Your standing goal: ${persona.goal}`);
  if (persona.customSystemPrompt) lines.push(persona.customSystemPrompt);
  if (persona.acquiredKnowledge.length) {
    lines.push("Knowledge you've acquired from the knowledge marketplace (use it where relevant):");
    for (const k of persona.acquiredKnowledge) lines.push(`- "${k.title}": ${k.content}`);
  }
  lines.push("Reply concisely and in character. You are talking to another agent or a human interacting with you through ClawdHQ.");
  return lines.join("\n");
}

// Bounds how many tool-call round-trips one inbound reply can trigger — the reactive path's
// only real safety valve against a single message driving unbounded LLM/skill-call cost, since
// (unlike the tick loop, see AgentActionSchema's own doc comment) it deliberately allows the
// model to choose which and how many of an agent's skills to invoke. Each individual call is
// still separately spend-gated by callAgentSkill regardless of step count.
const MAX_REACTIVE_TOOL_STEPS = 3;

/** Builds one AI SDK tool per real tool a resolved skill exposes (via custody-core's
 * listSkillTools — live listTools() for mcp-kind skills, since MCP servers are self-describing
 * and a skill may expose more than one tool; a single static entry for http-kind skills). A
 * skill whose tool list can't be fetched (e.g. its MCP server is down) is skipped rather than
 * failing the whole reply — same "one broken thing shouldn't take down the rest" discipline
 * tick.ts's handleAction already applies to individual actions. Tool names are namespaced by
 * skillId when a skill exposes more than one tool, to keep them unique across the whole set. */
async function buildSkillTools(chain: Chain, agentChainId: string, skills: ResolvedSkill[]): Promise<ToolSet> {
  const tools: ToolSet = {};
  for (const skill of skills) {
    let descriptors;
    try {
      descriptors = await listResolvedSkillTools(skill.skillId, skill.invocation);
    } catch {
      continue;
    }
    for (const descriptor of descriptors) {
      const toolKey = descriptors.length === 1 ? skill.skillId : `${skill.skillId}__${descriptor.toolName}`;
      tools[toolKey] = dynamicTool({
        description: descriptor.description || skill.description || skill.name,
        inputSchema: jsonSchema(descriptor.inputSchema as JSONSchema7),
        execute: async (input) => {
          const { result } = await callResolvedAgentSkill(chain, agentChainId, skill.skillId, skill.invocation, input, descriptor.toolName);
          return result;
        },
      });
    }
  }
  return tools;
}

/** Generates a single reply to an inbound message — the reactive half of the hosted runtime
 * (see apps/web's hosted .../a2a proxy route). Network/provider failures propagate to the
 * caller; there's no retry here, unlike a scheduled tick — a live inbound call has no "next
 * tick" to retry on.
 *
 * PLATFORM-billed calls are metered: `assertAgentLlmCreditCovers` rejects up front (before
 * spending time/tokens on a call the agent can't pay for) and `chargeAgentLlmCredit` debits the
 * predetermined per-call cost once the call actually succeeds — see custody-core's
 * agentLlmCredit.ts for why this is a flat fee, not per-token metering. BYO_KEY calls skip both:
 * they're on the owner's own key, not something ClawdHQ bills for.
 *
 * `skills` (default none) drives genuine open-ended multi-step tool-calling — deliberately the
 * *opposite* choice from the proactive tick's bounded USE_SKILL action (see AgentActionSchema's
 * own doc comment on why the tick stays enumerable): a live inbound reply already has a caller
 * watching in real time and each individual skill call is still separately spend-gated, so the
 * remaining risk is unbounded cost per message, which MAX_REACTIVE_TOOL_STEPS bounds instead. */
export async function generateAgentReply(
  chain: Chain,
  agentChainId: string,
  llmBilling: LlmBilling,
  persona: AgentPersonaContext,
  message: string,
  llmKey: ResolvedLlmKey,
  skills: ResolvedSkill[] = [],
): Promise<string> {
  if (llmBilling === LlmBilling.PLATFORM) {
    await assertAgentLlmCreditCovers(chain, agentChainId, LlmCallKind.REACTIVE_REPLY, persona.foundationModel);
  }

  const model = resolveModel(llmKey, persona.foundationModel);
  const tools = skills.length > 0 ? await buildSkillTools(chain, agentChainId, skills) : undefined;
  const { text, usage } = await generateText({
    model,
    system: buildSystemPrompt(persona),
    prompt: message,
    ...(tools && Object.keys(tools).length > 0 ? { tools, stopWhen: stepCountIs(MAX_REACTIVE_TOOL_STEPS) } : {}),
  });

  if (llmBilling === LlmBilling.PLATFORM) {
    await chargeAgentLlmCredit(chain, agentChainId, LlmCallKind.REACTIVE_REPLY, llmKey.provider, {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
    }, persona.foundationModel);
  }

  return text;
}

// The scheduled tick's decision surface — deliberately small and enumerable (matches this
// codebase's general pattern of bounded, explicit actions, e.g. AgentSpendPolicy.allowedActions)
// rather than letting the model call arbitrary tools. NO_ACTION is the expected common case: a
// goal-driven agent that "does something" every single tick would spam the marketplace/wallet
// for no reason — most ticks should conclude nothing is currently warranted. Flat object with
// per-kind-optional fields, not a z.discriminatedUnion: the union form pushes generateObject's
// generic inference deep enough to hit "Type instantiation is excessively deep" (TS2589) with
// this SDK version — tick.ts's handleAction narrows on `kind` at runtime instead.
export const AgentActionSchema = z.object({
  kind: z.enum(["POST_JOB", "X402_PAYMENT", "USE_SKILL", "USE_KNOWLEDGE", "SWAP", "NO_ACTION"]),
  hiredAgentId: z.string().optional().describe("Required for POST_JOB: the on-chain agentId to hire."),
  taskDescription: z.string().optional().describe("Required for POST_JOB: what the hired agent should do."),
  budgetUsdc: z.string().optional().describe("Required for POST_JOB: USDC budget to escrow."),
  recipient: z.string().optional().describe("Required for X402_PAYMENT: address to pay."),
  amountUsdc: z.string().optional().describe("Required for X402_PAYMENT: USDC amount to pay. Also required for SWAP: USDC amount to swap into WETH."),
  reason: z.string().optional().describe("Required for X402_PAYMENT: why this payment is being made."),
  skillId: z.string().optional().describe("Required for USE_SKILL: the id of one of the Available skills listed below."),
  skillInput: z.string().optional().describe("Required for USE_SKILL: JSON-encoded input matching that skill's tool schema."),
  knowledgeContributionId: z.string().optional().describe("Required for USE_KNOWLEDGE: the id of one of the Available knowledge contributions listed below."),
  knowledgeInput: z.string().optional().describe("Optional for USE_KNOWLEDGE, only against a MODEL-type contribution: JSON-encoded input to send to its inference endpoint."),
});
export type AgentAction = z.infer<typeof AgentActionSchema>;

// A hand-written JSON Schema mirror of AgentActionSchema, passed to generateObject via ai's
// jsonSchema() helper instead of the zod schema directly: letting generateObject's generic
// machinery infer OBJECT structurally from a zod v4 object with several .optional() fields hits
// "Type instantiation is excessively deep" (TS2589) against this ai/zod version pairing, both
// directly and through zodSchema<T>()'s explicit-generic form. jsonSchema<AgentAction>(...)
// sidesteps generic inference entirely (its generic is a bare type parameter, not derived from
// the schema value), and AgentActionSchema.safeParse below still does the real runtime
// validation the model's output is checked against — this is a type-checking workaround, not a
// weaker runtime guarantee.
const AGENT_ACTION_JSON_SCHEMA: JSONSchema7 = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["POST_JOB", "X402_PAYMENT", "USE_SKILL", "USE_KNOWLEDGE", "SWAP", "NO_ACTION"] },
    hiredAgentId: { type: "string", description: "Required for POST_JOB: the on-chain agentId to hire." },
    taskDescription: { type: "string", description: "Required for POST_JOB: what the hired agent should do." },
    budgetUsdc: { type: "string", description: "Required for POST_JOB: USDC budget to escrow." },
    recipient: { type: "string", description: "Required for X402_PAYMENT: address to pay." },
    amountUsdc: { type: "string", description: "Required for X402_PAYMENT: USDC amount to pay. Also required for SWAP: USDC amount to swap into WETH." },
    reason: { type: "string", description: "Required for X402_PAYMENT: why this payment is being made." },
    skillId: { type: "string", description: "Required for USE_SKILL: the id of one of the Available skills listed below." },
    skillInput: { type: "string", description: "Required for USE_SKILL: JSON-encoded input matching that skill's tool schema." },
    knowledgeContributionId: { type: "string", description: "Required for USE_KNOWLEDGE: the id of one of the Available knowledge contributions listed below." },
    knowledgeInput: { type: "string", description: "Optional for USE_KNOWLEDGE, only against a MODEL-type contribution: JSON-encoded input to send to its inference endpoint." },
  },
  required: ["kind"],
  additionalProperties: false,
};

/** Describes an agent's resolved skills as plain text for decideAgentAction's prompt — the tick
 * path can't hand the model real per-skill tool schemas the way generateAgentReply's native
 * tool-calling does, since generateObject's output shape is the fixed AgentActionSchema, not a
 * per-tool one; USE_SKILL's `skillInput` is instead a JSON string the model must construct
 * against the schema described here in text. A skill whose tools can't be listed right now (its
 * MCP server is down, say) is silently skipped rather than failing the whole tick — same
 * discipline buildSkillTools applies on the reactive path. Tick's USE_SKILL always targets a
 * skill's first tool (no per-tool disambiguation, unlike the reactive path) — an acceptable
 * simplification given every currently-resolvable skill exposes exactly one. */
async function describeAvailableSkills(skills: ResolvedSkill[]): Promise<string> {
  if (skills.length === 0) return "";
  const lines: string[] = [];
  for (const skill of skills) {
    try {
      const [tool] = await listResolvedSkillTools(skill.skillId, skill.invocation);
      if (!tool) continue;
      lines.push(`- ${skill.skillId} — ${tool.description || skill.description || skill.name} — skillInput schema: ${JSON.stringify(tool.inputSchema)}`);
    } catch {
      continue;
    }
  }
  return lines.length === 0 ? "" : `\n\nAvailable skills for USE_SKILL:\n${lines.join("\n")}`;
}

/** Describes a shortlist of published knowledge contributions for decideAgentAction's prompt —
 * same "text description, not a native tool" shape describeAvailableSkills uses and for the same
 * reason (generateObject's output is the fixed AgentActionSchema). Each use has a real USDC cost
 * (spend-gated by executeAgentSpend under SpendAction.USE_KNOWLEDGE, same as every other
 * autonomous spend), so the price is surfaced in the description the model reasons from, not just
 * the id. */
function describeAvailableKnowledge(candidates: KnowledgeCandidate[]): string {
  if (candidates.length === 0) return "";
  const lines = candidates.map((c) => {
    const modelNote = c.type === "MODEL" ? " — this is a callable model: optionally set knowledgeInput to JSON-encoded input for it" : "";
    return `- ${c.id} [${c.type}] — "${c.title}" (${c.priceUsdc} USDC per use) — ${c.description}${c.tags.length ? ` [tags: ${c.tags.join(", ")}]` : ""}${modelNote}`;
  });
  return `\n\nAvailable knowledge contributions for USE_KNOWLEDGE:\n${lines.join("\n")}`;
}

/** Decides a single proactive next action from an agent's goal and recent activity — the
 * goal-driven half of the hosted runtime (see packages/hosted-agent-runtime's tick.ts), as
 * opposed to generateAgentReply's reactive "answer this specific inbound message." Structured
 * output (generateObject), not free text: a scheduled, unattended call has no human present to
 * interpret an ambiguous response, so the action space is constrained to something this package
 * can mechanically act on. Metered the same way generateAgentReply is, at the (usually cheaper)
 * TICK_DECISION rate — see custody-core's agentLlmCredit.ts. */
export async function decideAgentAction(
  chain: Chain,
  agentChainId: string,
  llmBilling: LlmBilling,
  persona: AgentPersonaContext,
  recentActivity: string,
  llmKey: ResolvedLlmKey,
  skills: ResolvedSkill[] = [],
  knowledgeCandidates: KnowledgeCandidate[] = [],
): Promise<AgentAction> {
  if (llmBilling === LlmBilling.PLATFORM) {
    await assertAgentLlmCreditCovers(chain, agentChainId, LlmCallKind.TICK_DECISION, persona.foundationModel);
  }

  const model = resolveModel(llmKey, persona.foundationModel);
  const skillsPrompt = await describeAvailableSkills(skills);
  const knowledgePrompt = describeAvailableKnowledge(knowledgeCandidates);
  const system =
    buildSystemPrompt(persona) +
    "\n\nYou are being run on a periodic schedule, not responding to a specific message. Decide a single next action toward your standing goal, or NO_ACTION if nothing is currently warranted — most ticks should be NO_ACTION. Only choose POST_JOB, X402_PAYMENT, USE_SKILL, or USE_KNOWLEDGE when it's clearly justified by your goal and the recent activity below." +
    skillsPrompt +
    knowledgePrompt;
  const schema = jsonSchema<AgentAction>(AGENT_ACTION_JSON_SCHEMA, {
    validate: (value) => {
      const parsed = AgentActionSchema.safeParse(value);
      return parsed.success ? { success: true, value: parsed.data } : { success: false, error: parsed.error };
    },
  });
  const { object, usage } = await generateObject({ model, schema, system, prompt: recentActivity || "No notable recent activity." });

  if (llmBilling === LlmBilling.PLATFORM) {
    await chargeAgentLlmCredit(chain, agentChainId, LlmCallKind.TICK_DECISION, llmKey.provider, {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
    }, persona.foundationModel);
  }

  return object;
}
