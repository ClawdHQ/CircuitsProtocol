import "./loadEnv.js";
import { prisma } from "@clawdhq/custody-db";
import { runHostedRuntimeTick } from "@clawdhq/hosted-agent-runtime";

// Near-literal copy of scheduler.ts's tryClaim/tick/runTick/shutdown structure — same atomic-
// claim-via-conditional-UPDATE shape as Subscription.lockedUntil, applied to
// HostedRuntimeConfig.lockedUntil instead. Kept as its own process/file rather than folded into
// scheduler.ts: the two claim entirely different row types for entirely different reasons
// (subscription due-dates vs. a hosted agent's goal-driven tick cadence), and mirroring
// scheduler.ts's proven shape is more legible than parameterizing one function over both.

const TICK_INTERVAL_MS = Number(process.env.HOSTED_RUNTIME_SCHEDULER_TICK_INTERVAL_MS ?? 60_000);
const LOCK_DURATION_MS = Number(process.env.HOSTED_RUNTIME_SCHEDULER_LOCK_DURATION_MS ?? 5 * 60_000);
const MAX_CONFIGS_PER_TICK = 25;

let shuttingDown = false;
let tickInFlight = false;

/** Atomically claims one due HostedRuntimeConfig via a single conditional UPDATE — see
 * HostedRuntimeConfig.lockedUntil's doc comment in packages/custody-db/prisma/schema.prisma.
 * Returns whether this process won the claim. */
async function tryClaim(id: string, now: Date, lockUntil: Date): Promise<boolean> {
  const result = await prisma.hostedRuntimeConfig.updateMany({
    where: {
      id,
      isActive: true,
      nextTickAt: { lte: now },
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
    },
    data: { lockedUntil: lockUntil },
  });
  return result.count === 1;
}

async function releaseLock(id: string): Promise<void> {
  try {
    await prisma.hostedRuntimeConfig.update({ where: { id }, data: { lockedUntil: null } });
  } catch (error) {
    console.error(`[hosted-runtime-scheduler] failed to release lock for config ${id}:`, error);
  }
}

async function tick(): Promise<void> {
  const now = new Date();
  const due = await prisma.hostedRuntimeConfig.findMany({
    where: {
      isActive: true,
      nextTickAt: { lte: now },
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
    },
    take: MAX_CONFIGS_PER_TICK,
  });

  if (due.length === 0) return;
  console.log(`[hosted-runtime-scheduler] ${due.length} hosted agent(s) due`);

  for (const candidate of due) {
    const lockUntil = new Date(Date.now() + LOCK_DURATION_MS);
    const claimed = await tryClaim(candidate.id, now, lockUntil);
    if (!claimed) continue;

    try {
      // Re-fetch after claiming, same reasoning scheduler.ts's tick() documents — the claim's
      // WHERE clause already re-validated isActive/nextTickAt/lockedUntil atomically, but other
      // fields (llmBilling, mode) could still have changed between the findMany above and the
      // claim.
      const fresh = await prisma.hostedRuntimeConfig.findUniqueOrThrow({ where: { id: candidate.id } });
      const result = await runHostedRuntimeTick(fresh);
      console.log(`[hosted-runtime-scheduler] ran ${fresh.chain}:${fresh.agentChainId}: ${result.summary}`);
    } catch (error) {
      // runHostedRuntimeTick already advances nextTickAt on failure — this catch only keeps one
      // agent's failure from stopping every other due agent in the same tick.
      console.error(`[hosted-runtime-scheduler] config ${candidate.id} failed:`, error instanceof Error ? error.message : error);
    } finally {
      await releaseLock(candidate.id);
    }
  }
}

async function runTick(): Promise<void> {
  if (tickInFlight || shuttingDown) return;
  tickInFlight = true;
  try {
    await tick();
  } catch (error) {
    console.error("[hosted-runtime-scheduler] tick failed:", error);
  } finally {
    tickInFlight = false;
  }
}

async function main(): Promise<void> {
  console.log(`[hosted-runtime-scheduler] starting — tick every ${TICK_INTERVAL_MS}ms, lock TTL ${LOCK_DURATION_MS}ms`);

  await runTick();
  const interval = setInterval(runTick, TICK_INTERVAL_MS);

  const shutdown = (signal: string) => {
    console.log(`[hosted-runtime-scheduler] ${signal} received, stopping new ticks (in-flight work is left to finish)`);
    shuttingDown = true;
    clearInterval(interval);
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error) => {
  console.error("[hosted-runtime-scheduler] fatal error", error);
  process.exitCode = 1;
});
