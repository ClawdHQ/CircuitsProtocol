import { PublicKey } from "@solana/web3.js";
import { prisma } from "@clawdhq/custody-db";
import { getDecryptedSubscriptionWallet } from "./subscriptionCustody.js";
import { getSigningEvmAdapter, localEvmSigner } from "./signingEvmAdapter.js";
import { isEvmPrismaChain, type EvmPrismaChain } from "./evmChainConfig.js";
import { getSigningSolanaAdapter } from "./signingSolanaAdapter.js";
import { isSolanaPrismaChain, type SolanaPrismaChain } from "./solanaChainConfig.js";
import { getSigningSuiAdapter, keypairFromSuiSecret, signAndExecuteSui } from "./signingSuiAdapter.js";
import { isSuiPrismaChain, type SuiPrismaChain } from "./suiChainConfig.js";

// The custodied subscription wallet is the on-chain `employer` for a job it posted (there's no
// employer-transfer function on any chain's contract), so only it can call confirmDelivery/
// cancelJob/disputeJob for that job later — never the human owner's own personal wallet. These
// functions relay the owner's explicit, authenticated instruction (checked by the caller before
// invoking any of these) through the custodied key, keeping a human actively choosing every
// fund-release decision without needing on-chain employer-role transfer, which doesn't exist.
//
// Worth being honest about, not just here but in the UI: this app never stores or reviews
// deliverable *content* (submitDeliverable only puts a hash on-chain) — "confirm" has always
// been a payment-release consent checkpoint, not a content-inspection gate, for manual jobs too.

export type RelayChain = EvmPrismaChain | SolanaPrismaChain | SuiPrismaChain;

/** Marks the SubscriptionRun that posted this job as resolved — see subscriptionRisk.ts's
 * maxConcurrentOpenJobs check, which counts SUBMITTED-but-unresolved runs as "open." No-ops
 * silently if no matching run is found — the on-chain action itself already succeeded by the
 * time this is called; this is bookkeeping, not a gate. */
async function markResolved(subscriptionId: string, jobChainId: string): Promise<void> {
  await prisma.subscriptionRun.updateMany({ where: { subscriptionId, jobChainId }, data: { jobResolved: true } });
}

async function requireWallet(subscriptionId: string): Promise<{ address: string; privateKey: string }> {
  const wallet = await getDecryptedSubscriptionWallet(subscriptionId);
  if (!wallet) throw new Error("No wallet has been provisioned for this subscription");
  return wallet;
}

export async function confirmSubscriptionJob(subscriptionId: string, chain: RelayChain, jobChainId: string, rating: number): Promise<string> {
  const wallet = await requireWallet(subscriptionId);

  let txHash: string;
  if (isEvmPrismaChain(chain)) {
    txHash = await getSigningEvmAdapter(chain, localEvmSigner(chain, wallet.privateKey)).confirmDelivery(BigInt(jobChainId), rating);
  } else if (isSolanaPrismaChain(chain)) {
    // Unlike EVM, SolanaAdapter.confirmDelivery needs the hired agent's id explicitly (it can't
    // resolve it from the job account alone the way disputeJob does) — read it off the
    // subscription row rather than adding an agentId param to this function's public signature.
    const subscription = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    txHash = await getSigningSolanaAdapter(chain, wallet.privateKey).confirmDelivery({
      employer: new PublicKey(wallet.address),
      agentId: Number(subscription.hiredAgentId),
      jobId: Number(jobChainId),
      rating,
    });
  } else {
    // SuiAdapter.confirmDelivery needs the hired agent's Sui *object* id too (not the numeric
    // agent_id) — same event-scan resolution as the postJob path in subscriptionRunJob.ts.
    const subscription = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    const keypair = keypairFromSuiSecret(wallet.privateKey);
    const adapter = getSigningSuiAdapter(chain);
    const hiredAgent = await adapter.getAgentByChainId(Number(subscription.hiredAgentId));
    if (!hiredAgent) throw new Error(`Couldn't find agent #${subscription.hiredAgentId} on-chain.`);
    const tx = adapter.confirmDelivery({ jobId: jobChainId, agentId: hiredAgent.objectId, rating });
    const result = await signAndExecuteSui(chain, keypair, tx);
    txHash = result.digest;
  }
  await markResolved(subscriptionId, jobChainId);
  return txHash;
}

/** Only valid while the job is still Pending (unaccepted) — a contract-level restriction, not
 * just a UX nicety. Once a hired agent has accepted, only disputeJob remains available. */
export async function cancelSubscriptionJob(subscriptionId: string, chain: RelayChain, jobChainId: string): Promise<string> {
  const wallet = await requireWallet(subscriptionId);

  let txHash: string;
  if (isEvmPrismaChain(chain)) {
    txHash = await getSigningEvmAdapter(chain, localEvmSigner(chain, wallet.privateKey)).cancelJob(BigInt(jobChainId));
  } else if (isSolanaPrismaChain(chain)) {
    txHash = await getSigningSolanaAdapter(chain, wallet.privateKey).cancelJob({ employer: new PublicKey(wallet.address), jobId: Number(jobChainId) });
  } else {
    const keypair = keypairFromSuiSecret(wallet.privateKey);
    const tx = getSigningSuiAdapter(chain).cancelJob(jobChainId);
    const result = await signAndExecuteSui(chain, keypair, tx);
    txHash = result.digest;
  }
  await markResolved(subscriptionId, jobChainId);
  return txHash;
}

export async function disputeSubscriptionJob(subscriptionId: string, chain: RelayChain, jobChainId: string): Promise<string> {
  const wallet = await requireWallet(subscriptionId);

  let txHash: string;
  if (isEvmPrismaChain(chain)) {
    txHash = await getSigningEvmAdapter(chain, localEvmSigner(chain, wallet.privateKey)).disputeJob(BigInt(jobChainId));
  } else if (isSolanaPrismaChain(chain)) {
    txHash = await getSigningSolanaAdapter(chain, wallet.privateKey).disputeJob({ signer: new PublicKey(wallet.address), jobId: Number(jobChainId) });
  } else {
    const subscription = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    const keypair = keypairFromSuiSecret(wallet.privateKey);
    const adapter = getSigningSuiAdapter(chain);
    const hiredAgent = await adapter.getAgentByChainId(Number(subscription.hiredAgentId));
    if (!hiredAgent) throw new Error(`Couldn't find agent #${subscription.hiredAgentId} on-chain.`);
    const tx = adapter.disputeJob(jobChainId, hiredAgent.objectId);
    const result = await signAndExecuteSui(chain, keypair, tx);
    txHash = result.digest;
  }
  await markResolved(subscriptionId, jobChainId);
  return txHash;
}
