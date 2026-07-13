import "./loadEnv.js";
import { prisma } from "@clawdhq/custody-db";
import { runSubscription } from "@clawdhq/custody-core";

// Same "hardcoded default, optionally overridable via env" convention as config.ts's
// POLL_INTERVAL_MS/LOG_BATCH_BLOCKS.
const TICK_INTERVAL_MS = Number(process.env.SCHEDULER_TICK_INTERVAL_MS ?? 60_000);
// Generous vs. actual postJob broadcast latency — this is only a safety net for a crash that
// skips the finally-block release below, not the normal unlock path.
const LOCK_DURATION_MS = Number(process.env.SCHEDULER_LOCK_DURATION_MS ?? 5 * 60_000);
// Bounds how much work one tick takes on; a slow/rate-limited RPC shouldn't let a single tick
// run indefinitely long and delay the next one.
const MAX_SUBSCRIPTIONS_PER_TICK = 25;

let shuttingDown = false;
let tickInFlight = false;

/** Atomically claims one due subscription via a single conditional UPDATE — see
 * Subscription.lockedUntil's doc comment in packages/custody-db/prisma/schema.prisma. Returns
 * whether this process won the claim; false means an overlapping tick (or another scheduler
 * instance) already has it, or it's no longer due. */
async function tryClaim(id: string, now: Date, lockUntil: Date): Promise<boolean> {
  const result = await prisma.subscription.updateMany({
    where: {
      id,
      isActive: true,
      nextRunAt: { lte: now },
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
    },
    data: { lockedUntil: lockUntil },
  });
  return result.count === 1;
}

async function releaseLock(id: string): Promise<void> {
  try {
    await prisma.subscription.update({ where: { id }, data: { lockedUntil: null } });
  } catch (error) {
    console.error(`[scheduler] failed to release lock for subscription ${id}:`, error);
  }
}

async function tick(): Promise<void> {
  const now = new Date();
  const due = await prisma.subscription.findMany({
    where: {
      isActive: true,
      nextRunAt: { lte: now },
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
    },
    take: MAX_SUBSCRIPTIONS_PER_TICK,
  });

  if (due.length === 0) return;
  console.log(`[scheduler] ${due.length} subscription(s) due`);

  for (const candidate of due) {
    const lockUntil = new Date(Date.now() + LOCK_DURATION_MS);
    const claimed = await tryClaim(candidate.id, now, lockUntil);
    if (!claimed) continue;

    try {
      // Re-fetch after claiming rather than reuse `candidate` — the claim's WHERE clause
      // already re-validated isActive/nextRunAt/lockedUntil atomically, but budget/task fields
      // could still have changed between the findMany above and the claim (e.g. the owner
      // edited the subscription); run against the freshest row rather than a stale in-memory one.
      const fresh = await prisma.subscription.findUniqueOrThrow({ where: { id: candidate.id } });
      const result = await runSubscription(fresh);
      console.log(
        `[scheduler] ran subscription ${fresh.id}: run=${result.runId} job=${result.jobChainId} tx=${result.txHashOrRef}`
      );
    } catch (error) {
      // runSubscription already records the failure on the SubscriptionRun row and pushes
      // nextRunAt out by the retry backoff — this catch only keeps one subscription's failure
      // from stopping every other due subscription in the same tick.
      console.error(`[scheduler] subscription ${candidate.id} failed:`, error instanceof Error ? error.message : error);
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
    // A systemic failure (e.g. DB connection dropped) — log loudly and let the next interval
    // retry, rather than crashing the whole process. Unlike the read-mirror listeners in
    // main.ts, this process holds decrypted signing keys mid-run; killing it on every transient
    // hiccup would stop scheduling *every* subscription until a supervisor notices and restarts
    // it, which is a worse outcome than just retrying on the next tick.
    console.error("[scheduler] tick failed:", error);
  } finally {
    tickInFlight = false;
  }
}

async function main(): Promise<void> {
  console.log(`[scheduler] starting — tick every ${TICK_INTERVAL_MS}ms, lock TTL ${LOCK_DURATION_MS}ms`);

  await runTick();
  const interval = setInterval(runTick, TICK_INTERVAL_MS);

  const shutdown = (signal: string) => {
    console.log(`[scheduler] ${signal} received, stopping new ticks (in-flight work is left to finish)`);
    shuttingDown = true;
    clearInterval(interval);
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error) => {
  console.error("[scheduler] fatal error", error);
  process.exitCode = 1;
});
