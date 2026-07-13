import { parseUnits } from "viem";
import { prisma, Prisma, LlmCallKind, LlmProvider, type Chain } from "@clawdhq/custody-db";
import { getDecryptedAgentWallet } from "./agentWalletCustody.js";
import { getOrCreateLlmBillingTreasuryWallet, isLlmBillingTreasuryActive } from "./llmBillingTreasuryCustody.js";
import { isEvmPrismaChain, viemChainFor, rpcUrlFor, usdcAddressFor, type EvmPrismaChain } from "./evmChainConfig.js";
import { transferErc20Amount, readUsdcBalance } from "./signingEvmAdapter.js";

// Platform LLM billing — see custody-db/prisma/schema.prisma's own "Platform LLM billing" header
// for the Virtuals-inference-payment framing this mirrors: a predetermined, per-call cost
// deducted from a balance the agent pre-loaded. Two pieces: chargeAgentLlmCredit (called from
// packages/hosted-agent-runtime before every PLATFORM-billed LLM call) and topUpAgentLlmCredit
// (owner-triggered, a real on-chain transfer from the agent's own AgentWallet).

/** Thrown by chargeAgentLlmCredit when a PLATFORM-billed agent's balance can't cover the call —
 * callers (llmClient.ts) should treat this like SpendRejection/PaymentRejection: a normal,
 * expected outcome to surface, not a system failure. */
export class LlmCreditRejection extends Error {}

// Predetermined per-call costs, not per-token metering — matches Virtuals Protocol's own
// "per-inference cost model that is predetermined" shape (see the whitepaper's Agent Inference
// Payments page) rather than billing the literal token count. Env-configurable since these are
// illustrative example rates, not verified pricing tied to any specific provider's real costs —
// set them to whatever actually covers your platform LLM spend before relying on this in
// production.
function reactiveCallCostUsdc(): Prisma.Decimal {
  return new Prisma.Decimal(process.env.PLATFORM_LLM_COST_REACTIVE_USDC ?? "0.01");
}
function tickCallCostUsdc(): Prisma.Decimal {
  return new Prisma.Decimal(process.env.PLATFORM_LLM_COST_TICK_USDC ?? "0.005");
}

export function platformLlmCostFor(callKind: LlmCallKind): Prisma.Decimal {
  return callKind === LlmCallKind.REACTIVE_REPLY ? reactiveCallCostUsdc() : tickCallCostUsdc();
}

/** Current prepaid balance for a PLATFORM-billed agent — 0 (not an error) if no AgentLlmCredit
 * row exists yet, i.e. the agent has never topped up. */
export async function getAgentLlmCreditBalance(chain: Chain, agentChainId: string): Promise<Prisma.Decimal> {
  const credit = await prisma.agentLlmCredit.findUnique({ where: { chain_agentChainId: { chain, agentChainId } } });
  return credit?.balanceUsdc ?? new Prisma.Decimal(0);
}

/** Debits `platformLlmCostFor(callKind)` from the agent's balance and logs the call — called
 * once per completed PLATFORM-billed LLM call (see llmClient.ts). Unlike executeAgentSpend,
 * there's no PENDING/ATTEMPTING state here: this only ever runs *after* the LLM call already
 * succeeded, so there's nothing to roll back on failure — a failure here (e.g. a DB hiccup) means
 * the call already happened and should be logged best-effort, not retried or reversed.
 *
 * The balance check + decrement is wrapped in a single transaction so two concurrent charges
 * against the same agent (a reactive call and a tick landing at once) can't both read a balance
 * that covers them individually but not together. */
export async function chargeAgentLlmCredit(
  chain: Chain,
  agentChainId: string,
  callKind: LlmCallKind,
  provider: LlmProvider,
  usage: { inputTokens: number; outputTokens: number },
): Promise<void> {
  const cost = platformLlmCostFor(callKind);

  await prisma.$transaction(async (tx) => {
    const credit = await tx.agentLlmCredit.findUnique({ where: { chain_agentChainId: { chain, agentChainId } } });
    const balance = credit?.balanceUsdc ?? new Prisma.Decimal(0);
    if (balance.lt(cost)) {
      throw new LlmCreditRejection(`This agent's LLM credit balance (${balance.toString()} USDC) can't cover this call (${cost.toString()} USDC) — top up before it can run on platform billing again.`);
    }

    await tx.agentLlmCredit.update({ where: { chain_agentChainId: { chain, agentChainId } }, data: { balanceUsdc: balance.minus(cost) } });
    await tx.agentLlmUsage.create({
      data: { chain, agentChainId, callKind, provider, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsdc: cost },
    });
  });
}

/** Pre-flight check only — throws the same LlmCreditRejection chargeAgentLlmCredit would,
 * without moving anything. Useful for callers (the reactive route, the tick) that want to reject
 * before spending time on an LLM call that's just going to fail the charge afterward anyway. */
export async function assertAgentLlmCreditCovers(chain: Chain, agentChainId: string, callKind: LlmCallKind): Promise<void> {
  const balance = await getAgentLlmCreditBalance(chain, agentChainId);
  const cost = platformLlmCostFor(callKind);
  if (balance.lt(cost)) {
    throw new LlmCreditRejection(`This agent's LLM credit balance (${balance.toString()} USDC) can't cover a ${callKind === LlmCallKind.REACTIVE_REPLY ? "reply" : "tick"} (${cost.toString()} USDC) — top up before it can run on platform billing again.`);
  }
}

/** Moves `amountUsdc` from the agent's own AgentWallet to the chain's LlmBillingTreasuryWallet —
 * a real on-chain transfer, not an admin-settable ledger bump, so AgentLlmCredit.balanceUsdc can
 * never represent value that isn't actually sitting in the treasury. EVM-only for now, matching
 * every other spend/withdraw path in this codebase's current scope (postJobFromAgentWallet,
 * Subscriptions). Only credits the ledger after the transfer is confirmed on-chain. */
export async function topUpAgentLlmCredit(chain: Chain, agentChainId: string, amountUsdc: string): Promise<{ txHashOrRef: string }> {
  if (!isEvmPrismaChain(chain)) throw new Error(`topUpAgentLlmCredit isn't wired up for ${chain} yet — EVM only for now.`);
  const evmChain: EvmPrismaChain = chain;

  if (!(await isLlmBillingTreasuryActive(evmChain))) {
    throw new Error(`The LLM billing treasury for ${chain} has been revoked — top-ups are paused. Contact the platform operator.`);
  }

  const wallet = await getDecryptedAgentWallet(evmChain, agentChainId);
  if (!wallet) throw new Error("No AgentWallet has been provisioned for this agent yet.");

  const treasury = await getOrCreateLlmBillingTreasuryWallet(evmChain);
  const amount = parseUnits(amountUsdc, 6);

  const result = await transferErc20Amount(
    wallet.privateKey,
    viemChainFor(evmChain),
    rpcUrlFor(evmChain),
    usdcAddressFor(evmChain),
    treasury.address as `0x${string}`,
    amount,
  );

  await prisma.agentLlmCredit.upsert({
    where: { chain_agentChainId: { chain, agentChainId } },
    create: { chain, agentChainId, balanceUsdc: new Prisma.Decimal(amountUsdc) },
    update: { balanceUsdc: { increment: new Prisma.Decimal(amountUsdc) } },
  });

  return { txHashOrRef: result.txHashOrRef };
}

/** Live AgentWallet balance, for the top-up UI to show "you have at most X USDC available to
 * top up with" before the owner picks an amount — same live-read discipline every balance check
 * in this codebase uses, never a cached value. */
export async function getAgentWalletLiveBalance(chain: Chain, agentChainId: string): Promise<bigint | null> {
  if (!isEvmPrismaChain(chain)) return null;
  const wallet = await getDecryptedAgentWallet(chain, agentChainId);
  if (!wallet) return null;
  return readUsdcBalance(wallet.address as `0x${string}`, viemChainFor(chain), rpcUrlFor(chain), usdcAddressFor(chain));
}
