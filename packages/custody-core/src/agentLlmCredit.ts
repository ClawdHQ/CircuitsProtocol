import { parseUnits } from "viem";
import { prisma, Prisma, LlmCallKind, LlmProvider, type Chain } from "@clawdhq/custody-db";
import { getAgentEvmSigner } from "./agentEvmSigner.js";
import { getAgentWalletAddress } from "./agentWalletCustody.js";
import { getOrCreateLlmBillingTreasuryWallet, isLlmBillingTreasuryActive } from "./llmBillingTreasuryCustody.js";
import { isEvmPrismaChain, viemChainFor, rpcUrlFor, usdcAddressFor, type EvmPrismaChain } from "./evmChainConfig.js";
import { transferErc20Amount, readUsdcBalance } from "./signingEvmAdapter.js";
import { tierForFoundationModel, FOUNDATION_MODEL_TIER_IDS, DEFAULT_FOUNDATION_MODEL_TIER, type FoundationModelTier } from "./llmModelCatalog.js";

// Platform LLM billing — see custody-db/prisma/schema.prisma's own "Platform LLM billing" header
// for the Virtuals-inference-payment framing this mirrors: a predetermined, per-call cost
// deducted from a balance the agent pre-loaded. Rate now varies by the selected Foundation
// Model's tier (see llmModelCatalog.ts) — a PRO-tier pick costs more per call than STANDARD, even
// though llmClient.ts's OPENROUTER_FREE_MODE may route the *actual* inference to a free model
// during testnet; these are two deliberately decoupled lookups keyed by the same foundationModel
// id. Credits are a pure display/conversion layer on top of the underlying USDC amounts (see
// usdcToCredits/creditsToUsdc below) — $1 = 100 credits, nothing about the schema changes.
//
// Three pieces: chargeAgentLlmCredit (called from packages/hosted-agent-runtime after every
// PLATFORM-billed LLM call succeeds), assertAgentLlmCreditCovers (pre-flight, called before),
// and topUpAgentLlmCredit (a real on-chain transfer from the agent's own AgentWallet — owner-
// triggered via the UI, or automatically via tryAutoRecharge when a charge/pre-flight check
// would otherwise fail).

/** Thrown by chargeAgentLlmCredit when a PLATFORM-billed agent's balance can't cover the call —
 * callers (llmClient.ts) should treat this like SpendRejection/PaymentRejection: a normal,
 * expected outcome to surface, not a system failure. */
export class LlmCreditRejection extends Error {}

// Predetermined per-call costs, not per-token metering — matches Virtuals Protocol's own
// "per-inference cost model that is predetermined" shape (see the whitepaper's Agent Inference
// Payments page) rather than billing the literal token count. Env-configurable since these are
// illustrative example rates, not verified pricing tied to any specific provider's real costs —
// set them to whatever actually covers your platform LLM spend before relying on this in
// production. STANDARD keeps the original, unprefixed env var names so nothing shifts for
// anything already relying on them; PLUS/PRO are new, separate env vars.
function reactiveCallCostUsdc(tier: FoundationModelTier): Prisma.Decimal {
  switch (tier) {
    case "PLUS": return new Prisma.Decimal(process.env.PLATFORM_LLM_COST_REACTIVE_PLUS_USDC || "0.03");
    case "PRO": return new Prisma.Decimal(process.env.PLATFORM_LLM_COST_REACTIVE_PRO_USDC || "0.10");
    default: return new Prisma.Decimal(process.env.PLATFORM_LLM_COST_REACTIVE_USDC || "0.01");
  }
}
function tickCallCostUsdc(tier: FoundationModelTier): Prisma.Decimal {
  switch (tier) {
    case "PLUS": return new Prisma.Decimal(process.env.PLATFORM_LLM_COST_TICK_PLUS_USDC || "0.015");
    case "PRO": return new Prisma.Decimal(process.env.PLATFORM_LLM_COST_TICK_PRO_USDC || "0.05");
    default: return new Prisma.Decimal(process.env.PLATFORM_LLM_COST_TICK_USDC || "0.005");
  }
}

/** Tier defaults to STANDARD so any caller not yet passing one keeps today's exact behavior. */
export function platformLlmCostFor(callKind: LlmCallKind, tier: FoundationModelTier = DEFAULT_FOUNDATION_MODEL_TIER): Prisma.Decimal {
  return callKind === LlmCallKind.REACTIVE_REPLY ? reactiveCallCostUsdc(tier) : tickCallCostUsdc(tier);
}

/** $1 = 100 credits. Pure in-memory conversion (via Prisma's arbitrary-precision Decimal) —
 * never written back into a Decimal(30,10) column, so there's nothing for that column's ceiling
 * to overflow on and nothing to migrate. AgentLlmCredit.balanceUsdc / AgentLlmUsage.costUsdc stay
 * USDC-denominated at rest; credits exist only where they're displayed or reasoned about. */
export const CREDITS_PER_USDC = 100;
export function usdcToCredits(usdc: Prisma.Decimal | string): string {
  return new Prisma.Decimal(usdc).times(CREDITS_PER_USDC).toString();
}
export function creditsToUsdc(credits: Prisma.Decimal | string | number): Prisma.Decimal {
  return new Prisma.Decimal(credits).dividedBy(CREDITS_PER_USDC);
}

/** Reverse-looks-up which tier a *past* AgentLlmUsage row was charged at, by matching its stored
 * costUsdc against the current rate table for that callKind — display only, since the row itself
 * doesn't store which foundationModel was selected (provider is always OPENROUTER for every
 * PLATFORM-billed row regardless of tier, so it can't be used for this either). Returns null if
 * no current tier's rate matches, which happens if an operator changes a *_USDC env var after the
 * row was charged — the row's costUsdc/credits shown is still always exactly correct, only the
 * tier *label* on that older row goes stale ("Legacy rate" in the UI). Deliberately zero schema
 * footprint; see this feature's plan doc for why that tradeoff was chosen over adding a column. */
export function tierForHistoricalCost(callKind: LlmCallKind, costUsdc: Prisma.Decimal | string): FoundationModelTier | null {
  const cost = new Prisma.Decimal(costUsdc);
  return FOUNDATION_MODEL_TIER_IDS.find((tier) => platformLlmCostFor(callKind, tier).equals(cost)) ?? null;
}

/** Current prepaid balance for a PLATFORM-billed agent — 0 (not an error) if no AgentLlmCredit
 * row exists yet, i.e. the agent has never topped up. */
export async function getAgentLlmCreditBalance(chain: Chain, agentChainId: string): Promise<Prisma.Decimal> {
  const credit = await prisma.agentLlmCredit.findUnique({ where: { chain_agentChainId: { chain, agentChainId } } });
  return credit?.balanceUsdc ?? new Prisma.Decimal(0);
}

/** The actual balance-check-and-decrement, unchanged in spirit from before tiers/auto-recharge
 * existed — extracted so chargeAgentLlmCredit can call it a second time after a successful
 * auto-recharge without duplicating the transaction body. Wrapped in a single transaction so two
 * concurrent charges against the same agent (a reactive call and a tick landing at once) can't
 * both read a balance that covers them individually but not together — this is what actually
 * prevents double-spend; nothing above or below this function provides that guarantee. */
async function runLlmCreditCharge(
  chain: Chain,
  agentChainId: string,
  callKind: LlmCallKind,
  provider: LlmProvider,
  usage: { inputTokens: number; outputTokens: number },
  tier: FoundationModelTier,
): Promise<void> {
  const cost = platformLlmCostFor(callKind, tier);

  await prisma.$transaction(async (tx) => {
    const credit = await tx.agentLlmCredit.findUnique({ where: { chain_agentChainId: { chain, agentChainId } } });
    const balance = credit?.balanceUsdc ?? new Prisma.Decimal(0);
    if (balance.lt(cost)) {
      throw new LlmCreditRejection(`This agent's LLM credit balance (${usdcToCredits(balance)} credits) can't cover this ${tier}-tier call (${usdcToCredits(cost)} credits) — top up before it can run on platform billing again.`);
    }

    await tx.agentLlmCredit.update({ where: { chain_agentChainId: { chain, agentChainId } }, data: { balanceUsdc: balance.minus(cost) } });
    await tx.agentLlmUsage.create({
      data: { chain, agentChainId, callKind, provider, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsdc: cost },
    });
  });
}

/** Debits the cost of `foundationModel`'s tier from the agent's balance and logs the call —
 * called once per completed PLATFORM-billed LLM call (see llmClient.ts). Unlike executeAgentSpend,
 * there's no PENDING/ATTEMPTING state here: this only ever runs *after* the LLM call already
 * succeeded, so there's nothing to roll back on failure — a failure here (e.g. a DB hiccup) means
 * the call already happened and should be logged best-effort, not retried or reversed.
 *
 * On a rejection, makes one best-effort attempt to auto-recharge (tryAutoRecharge) before giving
 * up, then retries the charge exactly once — a second rejection after that propagates unmodified.
 * `foundationModel` is optional so existing callers not yet passing it keep working (resolves to
 * the cheapest/STANDARD tier via tierForFoundationModel's fallback). */
export async function chargeAgentLlmCredit(
  chain: Chain,
  agentChainId: string,
  callKind: LlmCallKind,
  provider: LlmProvider,
  usage: { inputTokens: number; outputTokens: number },
  foundationModel?: string,
): Promise<void> {
  const tier = tierForFoundationModel(foundationModel);
  try {
    await runLlmCreditCharge(chain, agentChainId, callKind, provider, usage, tier);
  } catch (err) {
    if (!(err instanceof LlmCreditRejection) || !(await tryAutoRecharge(chain, agentChainId))) throw err;
    await runLlmCreditCharge(chain, agentChainId, callKind, provider, usage, tier);
  }
}

/** Pre-flight check only — throws the same LlmCreditRejection chargeAgentLlmCredit would, without
 * moving anything beyond what tryAutoRecharge itself moves. Useful for callers (the reactive
 * route, the tick) that want to reject before spending time on an LLM call that's just going to
 * fail the charge afterward anyway. Also attempts one auto-recharge before failing, same as the
 * charge path, so a call doesn't get pre-flight-rejected only to have succeeded post-recharge. */
export async function assertAgentLlmCreditCovers(chain: Chain, agentChainId: string, callKind: LlmCallKind, foundationModel?: string): Promise<void> {
  const tier = tierForFoundationModel(foundationModel);
  const cost = platformLlmCostFor(callKind, tier);

  let balance = await getAgentLlmCreditBalance(chain, agentChainId);
  if (balance.lt(cost) && (await tryAutoRecharge(chain, agentChainId))) {
    balance = await getAgentLlmCreditBalance(chain, agentChainId);
  }
  if (balance.lt(cost)) {
    throw new LlmCreditRejection(`This agent's LLM credit balance (${usdcToCredits(balance)} credits) can't cover a ${callKind === LlmCallKind.REACTIVE_REPLY ? "reply" : "tick"} at the ${tier} tier (${usdcToCredits(cost)} credits) — top up before it can run on platform billing again.`);
  }
}

/** Moves `amountUsdc` from the agent's own AgentWallet to the chain's LlmBillingTreasuryWallet —
 * a real on-chain transfer, not an admin-settable ledger bump, so AgentLlmCredit.balanceUsdc can
 * never represent value that isn't actually sitting in the treasury. EVM-only for now, matching
 * every other spend/withdraw path in this codebase's current scope (postJobFromAgentWallet,
 * Subscriptions). Only credits the ledger after the transfer is confirmed on-chain. Called both
 * by the owner-triggered manual top-up UI and by tryAutoRecharge below — identical behavior
 * either way, the only difference is what decides to call it and with what amount. */
export async function topUpAgentLlmCredit(chain: Chain, agentChainId: string, amountUsdc: string): Promise<{ txHashOrRef: string }> {
  if (!isEvmPrismaChain(chain)) throw new Error(`topUpAgentLlmCredit isn't wired up for ${chain} yet — EVM only for now.`);
  const evmChain: EvmPrismaChain = chain;

  if (!(await isLlmBillingTreasuryActive(evmChain))) {
    throw new Error(`The LLM billing treasury for ${chain} has been revoked — top-ups are paused. Contact the platform operator.`);
  }

  const signer = await getAgentEvmSigner(evmChain, agentChainId);
  if (!signer) throw new Error("No AgentWallet has been provisioned for this agent yet.");

  const treasury = await getOrCreateLlmBillingTreasuryWallet(evmChain);
  const amount = parseUnits(amountUsdc, 6);

  const result = await transferErc20Amount(signer, evmChain, treasury.address as `0x${string}`, amount);

  await prisma.agentLlmCredit.upsert({
    where: { chain_agentChainId: { chain, agentChainId } },
    create: { chain, agentChainId, balanceUsdc: new Prisma.Decimal(amountUsdc) },
    update: { balanceUsdc: { increment: new Prisma.Decimal(amountUsdc) } },
  });

  return { txHashOrRef: result.txHashOrRef };
}

const AUTO_RECHARGE_ENABLED = process.env.LLM_CREDIT_AUTO_RECHARGE_ENABLED !== "false"; // default on
function autoRechargeAmountUsdc(): string {
  return process.env.LLM_CREDIT_AUTO_RECHARGE_AMOUNT_USDC || "1.00"; // = 100 credits
}

/** One best-effort top-up attempt when a charge/pre-flight check can't be covered — not a retry
 * loop, matching this codebase's existing "no retry logic" stance for LLM-adjacent calls (see
 * llmClient.ts's generateAgentReply doc comment). Every failure reason topUpAgentLlmCredit can
 * throw (no AgentWallet provisioned, treasury revoked, AgentWallet balance too low, RPC failure)
 * is swallowed uniformly here — callers always see the same LlmCreditRejection shape they'd have
 * gotten without auto-recharge, never a confusing top-up-specific error.
 *
 * Runs outside any DB transaction, same as the existing manual top-up flow already does — an RPC
 * call to a chain node has no business holding a Postgres transaction open. The balance-check-
 * and-decrement that actually prevents double-spend stays inside runLlmCreditCharge's untouched
 * transaction; this function only ever adds to the balance, on the same one-sided path the manual
 * top-up button already used, so it can't introduce a new double-spend surface. */
async function tryAutoRecharge(chain: Chain, agentChainId: string): Promise<boolean> {
  if (!AUTO_RECHARGE_ENABLED) return false;
  try {
    await topUpAgentLlmCredit(chain, agentChainId, autoRechargeAmountUsdc());
    return true;
  } catch (err) {
    console.error(`[agentLlmCredit] auto-recharge failed for ${chain}:${agentChainId}:`, err instanceof Error ? err.message : err);
    return false;
  }
}

/** Live AgentWallet balance, for the top-up UI to show "you have at most X USDC available to
 * top up with" before the owner picks an amount — same live-read discipline every balance check
 * in this codebase uses, never a cached value. Reads the address only (getAgentWalletAddress,
 * not getDecryptedAgentWallet) — this is a read, not a signed write, so it never needs key
 * material, LOCAL or CIRCLE. */
export async function getAgentWalletLiveBalance(chain: Chain, agentChainId: string): Promise<bigint | null> {
  if (!isEvmPrismaChain(chain)) return null;
  const address = await getAgentWalletAddress(chain, agentChainId);
  if (!address) return null;
  return readUsdcBalance(address as `0x${string}`, viemChainFor(chain), rpcUrlFor(chain), usdcAddressFor(chain));
}
