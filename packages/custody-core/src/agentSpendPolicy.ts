import { prisma, Prisma, SpendAction, AgentSpendStatus, type Chain, type AgentSpendPolicy } from "@clawdhq/custody-db";

/** Thrown by checkAgentSpendPolicy for every rejection reason (disabled, action not allowed,
 * cap exceeded, no policy configured) — callers should treat this exactly like RiskRejection/
 * PaymentRejection: record it as a FAILED AgentSpendLog entry, `.message` safe to surface. */
export class SpendRejection extends Error {}

async function todaysSpentAmount(agentSpendPolicyId: string): Promise<Prisma.Decimal> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const logs = await prisma.agentSpendLog.findMany({
    where: { agentSpendPolicyId, status: AgentSpendStatus.SUCCEEDED, createdAt: { gte: startOfDay } },
    select: { amountUsdc: true },
  });
  return logs.reduce((sum, log) => sum.plus(log.amountUsdc), new Prisma.Decimal(0));
}

/** Gates every autonomous spend attempt — both an owner-triggered manual spend and the
 * scheduled tick loop (Phase 5) — through the same checks: policy exists and is enabled, the
 * action is on the owner-configured allowlist, and today's already-spent total plus this amount
 * doesn't exceed dailyCapUsdc. Mirrors checkSubscriptionRisk's shape (a pure gate, no side
 * effects) — the AgentWallet's own live balance is checked separately by whatever chain-specific
 * `execute` callback actually broadcasts, same division subscriptionRisk.ts/subscriptionRunJob.ts
 * already have. */
export async function checkAgentSpendPolicy(chain: Chain, agentChainId: string, action: SpendAction, amountUsdc: Prisma.Decimal): Promise<AgentSpendPolicy> {
  const policy = await prisma.agentSpendPolicy.findUnique({ where: { chain_agentChainId: { chain, agentChainId } } });
  if (!policy) throw new SpendRejection("No spend policy has been configured for this agent yet — autonomous spending is off by default.");
  if (!policy.isEnabled) throw new SpendRejection("Autonomous spending is currently disabled for this agent.");
  if (!policy.allowedActions.includes(action)) throw new SpendRejection(`"${action}" isn't on this agent's allowed-actions list.`);

  const spentToday = await todaysSpentAmount(policy.id);
  if (spentToday.plus(amountUsdc).gt(policy.dailyCapUsdc)) {
    throw new SpendRejection(`This would exceed the agent's daily spend cap (${policy.dailyCapUsdc.toString()} USDC) — already spent ${spentToday.toString()} today.`);
  }

  return policy;
}

export interface AgentSpendExecutionResult {
  txHashOrRef: string;
  targetRef?: string;
}

/** The full check -> log -> execute -> record pipeline for one autonomous spend, shared by every
 * concrete spend action (postJobFromAgentWallet, and Phase 5's x402-payment action) and by both
 * an owner-triggered manual spend and the scheduled tick loop. Mirrors runSubscription's state
 * machine exactly: the AgentSpendLog row is written PENDING *before* `execute` runs (which is
 * where the AgentWallet key gets decrypted and a transaction gets broadcast), so a crash
 * mid-flight leaves forensic evidence instead of silent ambiguity. `execute` is a callback
 * rather than this function branching per-chain itself, since what "spend" means differs by
 * action (postJob vs. an x402 payment) — this function only owns the policy/audit-trail
 * bookkeeping common to all of them. */
export async function executeAgentSpend(
  chain: Chain,
  agentChainId: string,
  action: SpendAction,
  amountUsdc: string,
  execute: () => Promise<AgentSpendExecutionResult>,
): Promise<AgentSpendExecutionResult> {
  const amount = new Prisma.Decimal(amountUsdc);
  const policy = await checkAgentSpendPolicy(chain, agentChainId, action, amount);

  const log = await prisma.agentSpendLog.create({
    data: { agentSpendPolicyId: policy.id, action, amountUsdc: amount, status: AgentSpendStatus.PENDING },
  });

  try {
    await prisma.agentSpendLog.update({ where: { id: log.id }, data: { status: AgentSpendStatus.ATTEMPTING } });
    const result = await execute();
    await prisma.agentSpendLog.update({
      where: { id: log.id },
      data: { status: AgentSpendStatus.SUCCEEDED, txHashOrRef: result.txHashOrRef, targetRef: result.targetRef },
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.agentSpendLog.update({ where: { id: log.id }, data: { status: AgentSpendStatus.FAILED, error: message } });
    throw error;
  }
}
