import { parseUnits } from "viem";
import { prisma, SubscriptionRunStatus, type Subscription } from "@clawdhq/custody-db";
import { getDecryptedSubscriptionWallet } from "./subscriptionCustody.js";
import { isEvmPrismaChain } from "./evmChainConfig.js";
import { viemChainFor, rpcUrlFor, usdcAddressFor } from "./evmChainConfig.js";
import { readUsdcBalance } from "./signingEvmAdapter.js";
import { isSolanaPrismaChain } from "./solanaChainConfig.js";
import { readSolanaUsdcBalance } from "./signingSolanaAdapter.js";
import { isSuiPrismaChain } from "./suiChainConfig.js";
import { readSuiUsdcBalance } from "./signingSuiAdapter.js";

/** Thrown by checkSubscriptionRisk — callers should treat this exactly like any other run
 * failure (record a FAILED SubscriptionRun with this message), not as a distinct error class
 * to handle specially. */
export class RiskRejection extends Error {}

/** Gates every subscription run — both the owner-triggered "Run Now" and the autonomous
 * scheduler — through the same checks, mirroring degen/riskEngine.ts's shape: kill switch,
 * concurrent-open-jobs cap, pre-flight balance check. */
export async function checkSubscriptionRisk(subscription: Subscription): Promise<void> {
  if (!subscription.isActive) {
    throw new RiskRejection("Subscription is paused.");
  }

  const openJobs = await prisma.subscriptionRun.count({
    where: { subscriptionId: subscription.id, status: SubscriptionRunStatus.SUBMITTED, jobResolved: false },
  });
  if (openJobs >= subscription.maxConcurrentOpenJobs) {
    throw new RiskRejection(`This subscription already has ${openJobs} open job(s), at its limit of ${subscription.maxConcurrentOpenJobs}. Resolve one before running again.`);
  }

  const wallet = await getDecryptedSubscriptionWallet(subscription.id);
  if (!wallet) throw new RiskRejection("No wallet has been provisioned for this subscription yet.");

  // Balance pre-check — EVM, Solana, and Sui.
  const budget = parseUnits(subscription.budgetUsdc.toString(), 6);
  if (isEvmPrismaChain(subscription.chain)) {
    const chain = subscription.chain;
    let balance: bigint;
    try {
      balance = await readUsdcBalance(wallet.address as `0x${string}`, viemChainFor(chain), rpcUrlFor(chain), usdcAddressFor(chain));
    } catch {
      throw new RiskRejection(`Couldn't reach ${chain} for a pre-flight balance check.`);
    }
    if (balance < budget) {
      throw new RiskRejection(`Wallet balance (${(Number(balance) / 1e6).toFixed(2)} USDC) is below the required budget (${subscription.budgetUsdc.toString()} USDC). Deposit more first.`);
    }
  } else if (isSolanaPrismaChain(subscription.chain)) {
    const chain = subscription.chain;
    let balance: bigint;
    try {
      balance = await readSolanaUsdcBalance(chain, wallet.address);
    } catch {
      throw new RiskRejection(`Couldn't reach ${chain} for a pre-flight balance check.`);
    }
    if (balance < budget) {
      throw new RiskRejection(`Wallet balance (${(Number(balance) / 1e6).toFixed(2)} USDC) is below the required budget (${subscription.budgetUsdc.toString()} USDC). Deposit more first.`);
    }
  } else if (isSuiPrismaChain(subscription.chain)) {
    const chain = subscription.chain;
    let balance: bigint;
    try {
      balance = await readSuiUsdcBalance(chain, wallet.address);
    } catch {
      throw new RiskRejection(`Couldn't reach ${chain} for a pre-flight balance check.`);
    }
    if (balance < budget) {
      throw new RiskRejection(`Wallet balance (${(Number(balance) / 1e6).toFixed(2)} USDC) is below the required budget (${subscription.budgetUsdc.toString()} USDC). Deposit more first.`);
    }
  }
}
