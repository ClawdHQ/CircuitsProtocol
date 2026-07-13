import { createHash } from "node:crypto";
import { parseUnits } from "viem";
import { PublicKey } from "@solana/web3.js";
import { prisma, SubscriptionRunStatus, type Subscription } from "@clawdhq/custody-db";
import { getDecryptedSubscriptionWallet } from "./subscriptionCustody.js";
import { checkSubscriptionRisk } from "./subscriptionRisk.js";
import { isEvmPrismaChain } from "./evmChainConfig.js";
import { getSigningEvmAdapter } from "./signingEvmAdapter.js";
import { isSolanaPrismaChain } from "./solanaChainConfig.js";
import { getSigningSolanaAdapter, ensureOwnUsdcAta } from "./signingSolanaAdapter.js";
import { isSuiPrismaChain } from "./suiChainConfig.js";
import { getSigningSuiAdapter, keypairFromSuiSecret, resolveExactUsdcCoin, signAndExecuteSui, retryOnFreshObjectLag } from "./signingSuiAdapter.js";

export interface RunSubscriptionResult {
  runId: string;
  jobChainId: string;
  txHashOrRef: string;
}

const FREQUENCY_MS: Record<Subscription["frequency"], number> = {
  DAILY: 24 * 60 * 60 * 1000,
  WEEKLY: 7 * 24 * 60 * 60 * 1000,
  MONTHLY: 30 * 24 * 60 * 60 * 1000,
};

// A failed run must still advance nextRunAt (by a shorter backoff, not the full frequency) —
// otherwise a persistently-failing subscription (e.g. underfunded) stays "due" forever and the
// autonomous scheduler would retry it every single tick in a tight loop. 1 hour is short enough
// to recover promptly once the owner fixes the underlying issue, long enough not to hammer the
// chain/logs.
const RETRY_BACKOFF_MS = 60 * 60 * 1000;

/** Hashes task/deliverable text into the 32-byte digest the contracts expect in place of a real
 * IPFS CID hash — same convention as apps/web/src/lib/hash.ts's sha256Hex, reimplemented here
 * with node:crypto instead of WebCrypto so this package has no browser-API dependency. */
function sha256Hex(input: string): `0x${string}` {
  return `0x${createHash("sha256").update(input, "utf8").digest("hex")}`;
}

/** Same digest as sha256Hex, as the plain byte array Anchor's generated client expects for a
 * `[u8; 32]` IDL type (Solana has no equivalent of viem's `0x`-hex `Hex` type). */
function sha256Bytes(input: string): number[] {
  return Array.from(createHash("sha256").update(input, "utf8").digest());
}

/** The full risk-check -> decrypt -> sign -> postJob -> record pipeline for one subscription
 * run — shared by the owner-triggered "Run Now" route (apps/web) and the autonomous scheduler
 * (apps/indexer). The state machine below (PENDING -> ATTEMPTING -> SUBMITTED ->
 * SUCCEEDED/FAILED) is written *before* broadcasting the transaction, not only after, so a
 * crash mid-flight (this process holds a decrypted key while broadcasting) leaves forensic
 * evidence a reconciliation pass can check against chain state, rather than silent ambiguity or
 * a blind retry.
 *
 * Chain-family-agnostic at the top level, branches internally — EVM is implemented below;
 * Solana/Sui branches slot in alongside it so the risk gate/state-machine/backoff logic stays
 * shared across all chains rather than tripling. */
export async function runSubscription(subscription: Subscription): Promise<RunSubscriptionResult> {
  const run = await prisma.subscriptionRun.create({
    data: { subscriptionId: subscription.id, status: SubscriptionRunStatus.PENDING },
  });

  try {
    await checkSubscriptionRisk(subscription);
    await prisma.subscriptionRun.update({ where: { id: run.id }, data: { status: SubscriptionRunStatus.ATTEMPTING } });

    let jobChainId: string;
    let txHashOrRef: string;

    if (isEvmPrismaChain(subscription.chain)) {
      const chain = subscription.chain;
      const wallet = await getDecryptedSubscriptionWallet(subscription.id);
      if (!wallet) throw new Error("No wallet has been provisioned for this subscription yet — deposit funds first.");

      const adapter = getSigningEvmAdapter(chain, wallet.privateKey);

      // The new job's id is *guessed* (`totalJobs + 1`, read just before submission) since none
      // of postJob's return values include a usable id — same accepted race-condition tradeoff
      // useLaunchpadActions.ts's createLaunch already documents for launch ids.
      const statsBefore = await adapter.getProtocolStats();
      jobChainId = (statsBefore.totalJobs + 1n).toString();

      const taskHash = sha256Hex(subscription.taskDescription);
      const deadlineSeconds = BigInt(Math.floor(Date.now() / 1000) + subscription.deadlineDays * 86400);
      const budget = parseUnits(subscription.budgetUsdc.toString(), 6);

      txHashOrRef = await adapter.postJob({
        employerAgentId: 0n, // never validated against msg.sender on-chain — purely informational
        hiredAgentId: BigInt(subscription.hiredAgentId),
        taskHash,
        budget,
        deadline: deadlineSeconds,
      });
    } else if (isSolanaPrismaChain(subscription.chain)) {
      const chain = subscription.chain;
      const wallet = await getDecryptedSubscriptionWallet(subscription.id);
      if (!wallet) throw new Error("No wallet has been provisioned for this subscription yet — deposit funds first.");

      // postJob's employerUsdcAta has no `init` constraint (see signingSolanaAdapter.ts) —
      // unlike EVM's allowance, which postJob itself ensures, Solana needs the account to exist
      // up front.
      await ensureOwnUsdcAta(chain, wallet.privateKey);
      const adapter = getSigningSolanaAdapter(chain, wallet.privateKey);

      // Solana's postJob requires the caller to supply jobId up front (its PDA is derived from
      // it, unlike EVM's auto-assigned id) — same guessed `totalJobs + 1` race-condition
      // tradeoff as the EVM branch above, just supplied as an input instead of read back after.
      const statsBefore = await adapter.getProtocolStats();
      const newJobId = Number(statsBefore.totalJobs) + 1;
      jobChainId = newJobId.toString();

      const taskHash = sha256Bytes(subscription.taskDescription);
      const deadlineSeconds = BigInt(Math.floor(Date.now() / 1000) + subscription.deadlineDays * 86400);
      const budget = parseUnits(subscription.budgetUsdc.toString(), 6);

      txHashOrRef = await adapter.postJob({
        employer: new PublicKey(wallet.address),
        employerAgentId: 0, // never validated on-chain — purely informational, same as EVM
        hiredAgentId: Number(subscription.hiredAgentId),
        jobId: newJobId,
        taskHash,
        budget,
        deadline: deadlineSeconds,
      });
    } else if (isSuiPrismaChain(subscription.chain)) {
      const chain = subscription.chain;
      const wallet = await getDecryptedSubscriptionWallet(subscription.id);
      if (!wallet) throw new Error("No wallet has been provisioned for this subscription yet — deposit funds first.");

      const keypair = keypairFromSuiSecret(wallet.privateKey);
      const adapter = getSigningSuiAdapter(chain);

      // Unlike EVM/Solana, post_job takes a *specific* Coin<USDC> object and escrows its whole
      // value (no separate amount check) — resolveExactUsdcCoin merges/splits whatever's needed
      // into one coin worth exactly the budget, as its own confirmed transaction.
      const budget = parseUnits(subscription.budgetUsdc.toString(), 6);
      const budgetCoinId = await resolveExactUsdcCoin(chain, wallet.privateKey, budget);

      // post_job's hiredAgentId/agentId params are Sui *object* ids, not the numeric agent_id
      // this app uses everywhere else (indexer rows, cross-chain agentChainId) — Agent is a
      // shared object with no owner-index, so this is the same event-scan lookup
      // getAgentsByOwner already documents (O(agents ever registered), accepted at this scale).
      const hiredAgent = await adapter.getAgentByChainId(Number(subscription.hiredAgentId));
      if (!hiredAgent) throw new Error(`Couldn't find agent #${subscription.hiredAgentId} on-chain.`);

      const taskHash = sha256Bytes(subscription.taskDescription);
      // Sui's postJob takes milliseconds (matching clock.timestamp_ms()), not seconds like
      // EVM/Solana's deadline.
      const deadlineMs = Date.now() + subscription.deadlineDays * 86400 * 1000;

      // budgetCoinId was very likely just created moments ago by resolveExactUsdcCoin's own
      // transaction — postJob's tx.object(budgetCoinId) call resolves it through a path that
      // can briefly lag behind that transaction's own already-finalized effects.
      const result = await retryOnFreshObjectLag(() => {
        const tx = adapter.postJob({
          hiredAgentId: hiredAgent.objectId,
          employerAgentId: 0, // never validated on-chain — purely informational, same as EVM/Solana
          taskHash,
          budgetCoin: budgetCoinId,
          deadlineMs,
        });
        return signAndExecuteSui(chain, keypair, tx);
      });
      // Unlike EVM/Solana, there's no job-id-guessing here: Job is a fresh object, so its real
      // id comes straight back in this same transaction's result — no race condition possible.
      const createdJob = result.objectChanges?.find(
        (c) => c.type === "created" && "objectType" in c && c.objectType.endsWith("::marketplace::Job"),
      );
      if (!createdJob || !("objectId" in createdJob)) throw new Error("Couldn't resolve the created Job's object id from the transaction result.");

      jobChainId = createdJob.objectId;
      txHashOrRef = result.digest;
    } else {
      throw new Error(`Live execution isn't wired up for ${subscription.chain} yet.`);
    }

    await prisma.subscriptionRun.update({ where: { id: run.id }, data: { status: SubscriptionRunStatus.SUBMITTED, jobChainId, txHashOrRef } });

    const nextRunAt = new Date(Date.now() + FREQUENCY_MS[subscription.frequency]);
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: { executionCount: { increment: 1 }, totalPaidUsdc: { increment: subscription.budgetUsdc }, nextRunAt },
    });

    await prisma.subscriptionRun.update({ where: { id: run.id }, data: { status: SubscriptionRunStatus.SUCCEEDED } });

    return { runId: run.id, jobChainId, txHashOrRef };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.subscriptionRun.update({ where: { id: run.id }, data: { status: SubscriptionRunStatus.FAILED, error: message } });
    await prisma.subscription.update({ where: { id: subscription.id }, data: { nextRunAt: new Date(Date.now() + RETRY_BACKOFF_MS) } });
    throw err;
  }
}
