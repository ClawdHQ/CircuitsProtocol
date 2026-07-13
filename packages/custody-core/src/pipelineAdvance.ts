import { prisma, PipelineExecutionMode, PipelineStatus, PipelineStepStatus } from "@clawdhq/custody-db";
import { checkPipelineRisk, RiskRejection } from "./pipelineRisk.js";
import { postPipelineStep } from "./pipelineRunJob.js";
import { type EvmPrismaChain } from "./evmChainConfig.js";

/** Recomputes an ACTIVE pipeline's status from its steps' current states — called after every
 * step transition. SERIAL: a single FAILED step breaks the whole chain immediately, since no
 * later step will ever be posted once its predecessor fails. PARALLEL: steps are independent,
 * so the pipeline only reaches a terminal state once every step has (COMPLETED or FAILED), and
 * the final verdict is FAILED if any of them did. No-op for a pipeline that isn't ACTIVE (DRAFT
 * hasn't started yet; COMPLETED/FAILED are already terminal). */
async function recomputePipelineStatus(pipelineId: string): Promise<void> {
  const pipeline = await prisma.pipeline.findUniqueOrThrow({ where: { id: pipelineId } });
  if (pipeline.status !== PipelineStatus.ACTIVE) return;

  const steps = await prisma.pipelineStep.findMany({ where: { pipelineId } });
  const hasFailed = steps.some((s) => s.status === PipelineStepStatus.FAILED);

  if (pipeline.executionMode === PipelineExecutionMode.SERIAL && hasFailed) {
    await prisma.pipeline.update({ where: { id: pipelineId }, data: { status: PipelineStatus.FAILED } });
    return;
  }

  const allTerminal = steps.every((s) => s.status === PipelineStepStatus.COMPLETED || s.status === PipelineStepStatus.FAILED);
  if (allTerminal) {
    await prisma.pipeline.update({ where: { id: pipelineId }, data: { status: hasFailed ? PipelineStatus.FAILED : PipelineStatus.COMPLETED } });
  }
}

/** Owner-triggered "Run Pipeline" — the manual-trigger counterpart to
 * advancePipelineForJobOutcome below, same shared postPipelineStep/checkPipelineRisk plumbing
 * Subscription's run-now route and autonomous scheduler share via runSubscription. SERIAL posts
 * only the first step (later ones are posted automatically as their predecessor completes, see
 * below); PARALLEL posts every step at once, since they don't depend on each other. */
export async function startPipeline(pipelineId: string): Promise<void> {
  const pipeline = await prisma.pipeline.findUniqueOrThrow({ where: { id: pipelineId } });
  if (pipeline.status !== PipelineStatus.DRAFT) {
    throw new RiskRejection(`Pipeline is already ${pipeline.status.toLowerCase()} — it can only be run once.`);
  }

  const steps = await prisma.pipelineStep.findMany({ where: { pipelineId }, orderBy: { position: "asc" } });
  if (steps.length === 0) throw new RiskRejection("Add at least one step before running.");

  const stepsToPostNow = pipeline.executionMode === PipelineExecutionMode.PARALLEL ? steps : [steps[0]];
  await checkPipelineRisk(pipeline, stepsToPostNow);

  await prisma.pipeline.update({ where: { id: pipelineId }, data: { status: PipelineStatus.ACTIVE } });

  for (const step of stepsToPostNow) {
    try {
      await postPipelineStep(pipeline, step);
    } catch (err) {
      // SERIAL only ever posts one step here — its failure means the pipeline never really got
      // going, so fail it outright rather than leaving it ACTIVE with nothing in flight and no
      // way to ever advance. PARALLEL posts several independent steps in this same loop — one
      // failing to post shouldn't stop the loop from still submitting the rest; the pipeline's
      // final verdict is left to recomputePipelineStatus below instead.
      if (pipeline.executionMode === PipelineExecutionMode.SERIAL) {
        await prisma.pipeline.update({ where: { id: pipelineId }, data: { status: PipelineStatus.FAILED } });
        throw err;
      }
    }
  }

  await recomputePipelineStatus(pipelineId);
}

/** Called by the indexer (see apps/indexer/src/pipelineEvents.ts) whenever a tracked job's
 * on-chain status reaches a terminal outcome — JobCompleted -> "completed"; JobCancelled ->
 * "failed"; DisputeResolved -> "completed" if releasedToAgent else "failed". Looks up the
 * PipelineStep by (chain, jobChainId) among steps still SUBMITTED — the filter is also this
 * function's idempotency guard: a step already advanced past SUBMITTED is silently ignored
 * rather than double-processed, and a jobChainId with no matching row just means that job wasn't
 * posted by any pipeline. For a SERIAL pipeline reaching "completed", automatically posts the
 * next PENDING step from the same custodied wallet — this is the actual "walk away and it runs
 * itself" behavior; PARALLEL pipelines have nothing left to chain, every step was already posted
 * up front by startPipeline. */
export async function advancePipelineForJobOutcome(chain: EvmPrismaChain, jobChainId: string, outcome: "completed" | "failed"): Promise<void> {
  const step = await prisma.pipelineStep.findFirst({
    where: { jobChainId, status: PipelineStepStatus.SUBMITTED, pipeline: { chain } },
    include: { pipeline: true },
  });
  if (!step) return;

  await prisma.pipelineStep.update({
    where: { id: step.id },
    data: { status: outcome === "completed" ? PipelineStepStatus.COMPLETED : PipelineStepStatus.FAILED },
  });

  const { pipeline } = step;
  if (pipeline.status !== PipelineStatus.ACTIVE) return; // defensive; shouldn't happen

  if (outcome === "completed" && pipeline.executionMode === PipelineExecutionMode.SERIAL) {
    const nextStep = await prisma.pipelineStep.findFirst({
      where: { pipelineId: pipeline.id, status: PipelineStepStatus.PENDING },
      orderBy: { position: "asc" },
    });
    if (nextStep) {
      try {
        await checkPipelineRisk(pipeline, [nextStep]);
        await postPipelineStep(pipeline, nextStep);
      } catch (err) {
        // postPipelineStep already records a FAILED step + error itself if it got far enough
        // to try; a bare RiskRejection (e.g. underfunded wallet) means it never got that far,
        // so record the same outcome by hand here instead.
        if (err instanceof RiskRejection) {
          await prisma.pipelineStep.update({ where: { id: nextStep.id }, data: { status: PipelineStepStatus.FAILED, error: err.message } });
        }
      }
    }
  }

  await recomputePipelineStatus(pipeline.id);
}
