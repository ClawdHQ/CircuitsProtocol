import { parseUnits } from "viem";
import { type Pipeline, type PipelineStep } from "@clawdhq/custody-db";
import { getDecryptedPipelineWallet } from "./pipelineCustody.js";
import { isEvmPrismaChain, viemChainFor, rpcUrlFor, usdcAddressFor } from "./evmChainConfig.js";
import { readUsdcBalance } from "./signingEvmAdapter.js";

/** Thrown by checkPipelineRisk — callers should treat this like any other run failure, not as
 * a distinct error class to handle specially (mirrors subscriptionRisk.ts's RiskRejection). */
export class RiskRejection extends Error {}

/** Gates a pipeline run (both the owner-triggered "Run Pipeline" and the indexer's
 * auto-advance-on-completion) through a pre-flight balance check. `stepsAboutToPost` is every
 * step that's about to be submitted in this one call — a single step for SERIAL (this one, or
 * the next one once its predecessor completes), every PENDING step at once for PARALLEL — so
 * the balance check covers their combined budget rather than under-checking a batch and letting
 * some posts in the batch fail on insufficient funds partway through. */
export async function checkPipelineRisk(pipeline: Pipeline, stepsAboutToPost: PipelineStep[]): Promise<void> {
  if (!isEvmPrismaChain(pipeline.chain)) {
    throw new RiskRejection(`Orchestration only supports EVM chains — ${pipeline.chain} isn't wired up.`);
  }
  if (stepsAboutToPost.length === 0) return;

  const wallet = await getDecryptedPipelineWallet(pipeline.id);
  if (!wallet) throw new RiskRejection("No wallet has been provisioned for this pipeline yet.");

  const chain = pipeline.chain;
  const requiredBudget = stepsAboutToPost.reduce((sum, step) => sum + parseUnits(step.budgetUsdc.toString(), 6), 0n);

  let balance: bigint;
  try {
    balance = await readUsdcBalance(wallet.address as `0x${string}`, viemChainFor(chain), rpcUrlFor(chain), usdcAddressFor(chain));
  } catch {
    throw new RiskRejection(`Couldn't reach ${chain} for a pre-flight balance check.`);
  }

  if (balance < requiredBudget) {
    const requiredUsdc = (Number(requiredBudget) / 1e6).toFixed(2);
    const balanceUsdc = (Number(balance) / 1e6).toFixed(2);
    throw new RiskRejection(`Pipeline wallet balance (${balanceUsdc} USDC) is below what's required to post ${stepsAboutToPost.length} step(s) (${requiredUsdc} USDC). Deposit more first.`);
  }
}
