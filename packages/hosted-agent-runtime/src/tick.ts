import { prisma as custodyPrisma, RuntimeMode, type HostedRuntimeConfig, type Chain as CustodyChain } from "@clawdhq/custody-db";
import { prisma as socialPrisma, AutonomyLevel, type Chain as SocialChain } from "@clawdhq/social-db";
import { postJobFromAgentWallet, payFromAgentWallet, callResolvedAgentSkill, swapAgentWalletUsdcForWeth } from "@clawdhq/custody-core";
import { resolveLlmKey, decideAgentAction, type AgentAction } from "./llmClient.js";
import { loadAgentPersonaContext, loadResolvedAgentSkills, loadKnowledgeCandidates, type ResolvedSkill, type KnowledgeCandidate } from "./persona.js";
import { acquireKnowledge } from "./knowledgeAcquisition.js";

// How often a hosted agent's goal-driven loop runs — env-configurable rather than per-agent
// (unlike Subscription's owner-chosen frequency): a proactive "does my agent want to do
// anything right now" check is a platform-operational concern, not something each owner should
// have to tune, at least in this first version.
const TICK_INTERVAL_MS = Number(process.env.HOSTED_RUNTIME_TICK_INTERVAL_MS ?? 5 * 60_000);
const RECENT_ACTIVITY_LIMIT = 5;

async function summarizeRecentActivity(chain: CustodyChain, agentChainId: string): Promise<string> {
  const policy = await custodyPrisma.agentSpendPolicy.findUnique({ where: { chain_agentChainId: { chain, agentChainId } } });
  if (!policy) return "No spend history yet.";

  const logs = await custodyPrisma.agentSpendLog.findMany({
    where: { agentSpendPolicyId: policy.id },
    orderBy: { createdAt: "desc" },
    take: RECENT_ACTIVITY_LIMIT,
  });
  if (logs.length === 0) return "No spend history yet.";

  return logs
    .map((log) => `- ${log.createdAt.toISOString()}: ${log.action} ${log.amountUsdc.toString()} USDC -> ${log.status}${log.error ? ` (${log.error})` : ""}`)
    .join("\n");
}

async function handleAction(chain: CustodyChain, agentChainId: string, action: AgentAction, skills: ResolvedSkill[], knowledgeCandidates: KnowledgeCandidate[]): Promise<string> {
  if (action.kind === "NO_ACTION") return "no action taken this tick";

  if (action.kind === "POST_JOB") {
    if (!action.hiredAgentId || !action.taskDescription || !action.budgetUsdc) {
      return "POST_JOB decided but missing required fields — ignored.";
    }
    try {
      const result = await postJobFromAgentWallet(chain, agentChainId, action.hiredAgentId, action.taskDescription, action.budgetUsdc, 7);
      return `posted job ${result.targetRef} (tx ${result.txHashOrRef})`;
    } catch (error) {
      // A rejected/failed spend is a normal, expected tick outcome (cap hit, disallowed action,
      // insufficient balance) — already recorded to AgentSpendLog by executeAgentSpend. Don't
      // let it fail the whole tick, same "never throw out of a tick for a routine outcome"
      // discipline packages/agent-runtime's own tick loop documents.
      const message = error instanceof Error ? error.message : String(error);
      return `POST_JOB rejected: ${message}`;
    }
  }

  if (action.kind === "X402_PAYMENT") {
    if (!action.recipient || !action.amountUsdc) {
      return "X402_PAYMENT decided but missing required fields — ignored.";
    }
    try {
      const result = await payFromAgentWallet(chain, agentChainId, action.recipient, action.amountUsdc, action.reason ?? "");
      return `paid ${action.amountUsdc} USDC to ${action.recipient} (tx ${result.txHashOrRef})`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `X402_PAYMENT rejected: ${message}`;
    }
  }

  if (action.kind === "SWAP") {
    if (!action.amountUsdc) {
      return "SWAP decided but missing amountUsdc — ignored.";
    }
    try {
      const result = await swapAgentWalletUsdcForWeth(chain, agentChainId, action.amountUsdc);
      return `swapped ${action.amountUsdc} USDC for WETH (${result.targetRef}, tx ${result.txHashOrRef})`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `SWAP rejected: ${message}`;
    }
  }

  if (action.kind === "USE_SKILL") {
    if (!action.skillId) {
      return "USE_SKILL decided but missing skillId — ignored.";
    }
    // The model was only ever shown skills from this same already-resolved list (see
    // describeAvailableSkills in llmClient.ts) — a skillId it names but that isn't in here is a
    // hallucinated/stale id, not something worth a fresh resolution attempt.
    const skill = skills.find((s) => s.skillId === action.skillId);
    if (!skill) {
      return `USE_SKILL decided but "${action.skillId}" isn't one of this agent's resolvable skills — ignored.`;
    }
    let input: unknown = {};
    if (action.skillInput) {
      try {
        input = JSON.parse(action.skillInput);
      } catch {
        return `USE_SKILL decided but skillInput wasn't valid JSON — ignored.`;
      }
    }
    try {
      const { txHashOrRef } = await callResolvedAgentSkill(chain, agentChainId, skill.skillId, skill.invocation, input);
      return `called skill ${action.skillId} (ref ${txHashOrRef})`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `USE_SKILL rejected: ${message}`;
    }
  }

  if (action.kind === "USE_KNOWLEDGE") {
    if (!action.knowledgeContributionId) {
      return "USE_KNOWLEDGE decided but missing knowledgeContributionId — ignored.";
    }
    // Same "only ever shown its own already-resolved candidates" discipline USE_SKILL applies —
    // an id the model names that isn't in this tick's shortlist (see loadKnowledgeCandidates in
    // persona.ts) is hallucinated/stale, not worth a fresh lookup.
    const candidate = knowledgeCandidates.find((k) => k.id === action.knowledgeContributionId);
    if (!candidate) {
      return `USE_KNOWLEDGE decided but "${action.knowledgeContributionId}" isn't one of the knowledge contributions this agent was shown — ignored.`;
    }
    try {
      const { summary } = await acquireKnowledge(chain, agentChainId, candidate, action.knowledgeInput);
      return summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `USE_KNOWLEDGE rejected: ${message}`;
    }
  }

  return "unrecognized action kind — ignored";
}

export interface TickResult {
  hostedRuntimeConfigId: string;
  summary: string;
}

/** One scheduled goal-driven tick for one hosted-runtime agent — shared by apps/indexer's
 * hostedRuntimeScheduler.ts (autonomous) and any future owner-triggered "run now" equivalent.
 * Mirrors runSubscription's contract: takes an already-claimed config row, does the work,
 * advances nextTickAt either way (success or failure), and rethrows on failure so the caller can
 * log it — this function itself never suppresses an error, callers own that decision. */
export async function runHostedRuntimeTick(config: HostedRuntimeConfig): Promise<TickResult> {
  const chain = config.chain;
  const socialChain = chain as unknown as SocialChain;

  // BYO_ENDPOINT-mode rows aren't supposed to run ClawdHQ's own runtime at all — the reactive
  // .../a2a route already rejects these, but the scheduler's claim query (isActive/nextTickAt
  // only) doesn't filter on mode, so this function is the last line of defense against ticking
  // an agent that's supposed to be self-hosted. Still advances nextTickAt so a stray row like
  // this doesn't get reclaimed every tick.
  if (config.mode !== RuntimeMode.HOSTED) {
    await custodyPrisma.hostedRuntimeConfig.update({ where: { id: config.id }, data: { nextTickAt: new Date(Date.now() + TICK_INTERVAL_MS) } });
    return { hostedRuntimeConfigId: config.id, summary: `mode is ${config.mode}, not HOSTED — skipped` };
  }

  try {
    const goal = await socialPrisma.agentGoal.findUnique({ where: { chain_agentChainId: { chain: socialChain, agentChainId: config.agentChainId } } });
    const autonomyLevel = goal?.autonomyLevel ?? AutonomyLevel.RESPOND_ONLY;

    // RESPOND_ONLY means exactly what it says: this agent only answers inbound messages (the
    // reactive .../a2a route), it doesn't act on its own schedule. Skipping the LLM call
    // entirely here isn't just semantically correct, it also means a RESPOND_ONLY agent never
    // burns LLM credits on ticks that were never going to do anything — the default (no AgentGoal
    // row at all) resolves to this same skip, so a freshly hosted agent with no goal set doesn't
    // spend anything until its owner actually gives it one.
    if (autonomyLevel === AutonomyLevel.RESPOND_ONLY) {
      await custodyPrisma.hostedRuntimeConfig.update({
        where: { id: config.id },
        data: { lastTickAt: new Date(), nextTickAt: new Date(Date.now() + TICK_INTERVAL_MS) },
      });
      return { hostedRuntimeConfigId: config.id, summary: "autonomyLevel is RESPOND_ONLY — skipped proactive tick" };
    }

    // FULLY_AUTONOMOUS is reserved for a future phase with broader unattended authority than a
    // capped daily spend (see AgentGoal's schema doc comment) — nothing implements that broader
    // authority yet, so treat it as a configuration error rather than silently running it at the
    // same level as RESPOND_AND_SPEND.
    if (autonomyLevel === AutonomyLevel.FULLY_AUTONOMOUS) {
      throw new Error("autonomyLevel FULLY_AUTONOMOUS is reserved and not implemented yet — set RESPOND_AND_SPEND instead.");
    }

    const [persona, recentActivity, llmKey, skills] = await Promise.all([
      loadAgentPersonaContext(socialChain, config.agentChainId),
      summarizeRecentActivity(chain, config.agentChainId),
      resolveLlmKey(chain, config.agentChainId, config.llmBilling),
      loadResolvedAgentSkills(socialChain, config.agentChainId),
    ]);
    // Depends on persona (knowledgeDomains/goal drive the keyword ranking), so it can't join the
    // Promise.all above — sequenced after, same as decideAgentAction itself already is.
    const knowledgeCandidates = await loadKnowledgeCandidates(persona);

    const action = await decideAgentAction(chain, config.agentChainId, config.llmBilling, persona, recentActivity, llmKey, skills, knowledgeCandidates);
    const summary = await handleAction(chain, config.agentChainId, action, skills, knowledgeCandidates);

    await custodyPrisma.hostedRuntimeConfig.update({
      where: { id: config.id },
      data: { lastTickAt: new Date(), executionCount: { increment: 1 }, nextTickAt: new Date(Date.now() + TICK_INTERVAL_MS) },
    });

    return { hostedRuntimeConfigId: config.id, summary };
  } catch (error) {
    // Unlike a rejected spend (handled and summarized above), this catch is for things that mean
    // the tick itself couldn't run at all (no LLM key configured, provider outage, insufficient
    // LLM credits, the FULLY_AUTONOMOUS guard above) — still push nextTickAt out so a
    // persistently-broken agent doesn't get retried in a tight loop, then rethrow so the
    // scheduler's own log line captures what happened.
    await custodyPrisma.hostedRuntimeConfig.update({
      where: { id: config.id },
      data: { nextTickAt: new Date(Date.now() + TICK_INTERVAL_MS) },
    });
    throw error;
  }
}
