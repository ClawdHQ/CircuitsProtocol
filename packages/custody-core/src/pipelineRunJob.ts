import { createHash } from "node:crypto";
import { parseUnits } from "viem";
import { prisma, PipelineStepStatus, type Pipeline, type PipelineStep } from "@clawdhq/custody-db";
import { getDecryptedPipelineWallet } from "./pipelineCustody.js";
import { isEvmPrismaChain } from "./evmChainConfig.js";
import { getSigningEvmAdapter, localEvmSigner } from "./signingEvmAdapter.js";

export interface PostPipelineStepResult {
  jobChainId: string;
  txHashOrRef: string;
}

/** Same digest convention as apps/web/src/lib/hash.ts's sha256Hex, reimplemented with
 * node:crypto since this package has no browser-API dependency (see subscriptionRunJob.ts's
 * identical helper). Note: unlike useMarketplaceActions.postJob, this never writes the
 * plaintext task description to marketplace-db's TaskDescription cache — custody-core has no
 * dependency on that package (a cross-database write from here would break the "each *-db
 * package is its own migration/access boundary" rule its own schema.prisma documents). A
 * pipeline-posted job's task text is only recoverable from PipelineStep.taskDescription itself,
 * same accepted gap subscriptionRunJob.ts already has for Subscription-posted jobs. */
function sha256Hex(input: string): `0x${string}` {
  return `0x${createHash("sha256").update(input, "utf8").digest("hex")}`;
}

/** The full decrypt -> sign -> postJob -> record pipeline for one pipeline step — shared by the
 * owner-triggered "Run Pipeline" route (apps/web) and the indexer's job-completion handler
 * (apps/indexer/src/pipelineEvents.ts) that auto-posts a SERIAL pipeline's next step. The state
 * machine below (PENDING -> ATTEMPTING -> SUBMITTED -> COMPLETED/FAILED) is written *before*
 * broadcasting the transaction, not only after, so a crash mid-flight (this process holds a
 * decrypted key while broadcasting) leaves forensic evidence a reconciliation pass can check
 * against chain state — same reasoning as subscriptionRunJob.ts's runSubscription.
 *
 * Caller is responsible for risk-gating (see pipelineRisk.ts) before calling this — this
 * function itself only guards against re-posting an already-posted step. */
export async function postPipelineStep(pipeline: Pipeline, step: PipelineStep): Promise<PostPipelineStepResult> {
  if (step.status !== PipelineStepStatus.PENDING) {
    throw new Error(`Step ${step.id} is already ${step.status} — refusing to post it again.`);
  }
  if (!isEvmPrismaChain(pipeline.chain)) {
    throw new Error(`Orchestration only supports EVM chains — ${pipeline.chain} isn't wired up.`);
  }
  const chain = pipeline.chain;

  await prisma.pipelineStep.update({ where: { id: step.id }, data: { status: PipelineStepStatus.ATTEMPTING } });

  try {
    const wallet = await getDecryptedPipelineWallet(pipeline.id);
    if (!wallet) throw new Error("No wallet has been provisioned for this pipeline yet — deposit funds first.");

    const adapter = getSigningEvmAdapter(chain, localEvmSigner(chain, wallet.privateKey));

    // The new job's id is *guessed* (`totalJobs + 1`, read just before submission) since
    // postJob's return value is only a tx hash — same accepted race-condition tradeoff
    // subscriptionRunJob.ts and useLaunchpadActions.ts's createLaunch already document.
    const statsBefore = await adapter.getProtocolStats();
    const jobChainId = (statsBefore.totalJobs + 1n).toString();

    const taskHash = sha256Hex(step.taskDescription);
    const deadlineSeconds = BigInt(Math.floor(Date.now() / 1000) + step.deadlineDays * 86400);
    const budget = parseUnits(step.budgetUsdc.toString(), 6);

    const txHashOrRef = await adapter.postJob({
      employerAgentId: 0n, // never validated against msg.sender on-chain — purely informational
      hiredAgentId: BigInt(step.agentChainId),
      taskHash,
      budget,
      deadline: deadlineSeconds,
    });

    await prisma.pipelineStep.update({
      where: { id: step.id },
      data: { status: PipelineStepStatus.SUBMITTED, jobChainId, txHashOrRef },
    });

    return { jobChainId, txHashOrRef };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.pipelineStep.update({ where: { id: step.id }, data: { status: PipelineStepStatus.FAILED, error: message } });
    throw err;
  }
}
