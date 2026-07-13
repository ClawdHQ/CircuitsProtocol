import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { prisma, WalletStatus, type PipelineWallet, type Chain } from "@clawdhq/custody-db";
import { LocalRootKeyProvider, encryptPrivateKey as encryptWithProvider, decryptPrivateKey as decryptWithProvider, type RootKeyProvider } from "./envelopeEncryption.js";

// Pipeline-wallet custody: one custodied EVM keypair per pipeline (not pooled per owner), same
// capital-bounded-exposure philosophy as SubscriptionWallet. Uses its own root key
// (PIPELINE_KMS_PROVIDER/PIPELINE_LOCAL_ROOT_KEY, separate from Subscriptions' CUSTODY_* vars
// and every other domain's) so a compromise of one custodied-signing domain doesn't expose the
// others. EVM-only — Orchestration doesn't support Solana/Sui chains at all (see
// evmChainConfig.ts's EvmPrismaChain), so unlike subscriptionCustody.ts there's no
// generateSolanaWallet/generateSuiWallet branch here.
//
// *** DEV-MODE WARNING *** — see envelopeEncryption.ts's LocalRootKeyProvider doc comment: the
// only provider implemented right now is dev-only and NOT an acceptable root-of-trust for a
// wallet that ever holds real money. PIPELINE_KMS_PROVIDER must point at a real KMS before any
// pipeline wallet is funded with real value.

function getRootKeyProvider(): RootKeyProvider {
  const provider = process.env.PIPELINE_KMS_PROVIDER || "local";
  if (provider === "local") return new LocalRootKeyProvider("PIPELINE_LOCAL_ROOT_KEY");
  throw new Error(
    `PIPELINE_KMS_PROVIDER="${provider}" has no implementation yet — only "local" (dev-only, see envelopeEncryption.ts's warning) exists. ` +
      "Implement a real KMS-backed RootKeyProvider before funding any pipeline wallet in production.",
  );
}

async function encryptPrivateKey(plaintext: string): Promise<string> {
  return encryptWithProvider(plaintext, getRootKeyProvider());
}

async function decryptPrivateKey(encryptedPrivateKey: string): Promise<string> {
  return decryptWithProvider(encryptedPrivateKey, getRootKeyProvider());
}

/** Idempotent: returns the existing wallet if one was already provisioned for this pipeline
 * rather than generating a second one. */
export async function provisionPipelineWallet(pipelineId: string, chain: Chain): Promise<PipelineWallet> {
  const existing = await prisma.pipelineWallet.findUnique({ where: { pipelineId } });
  if (existing) return existing;

  const privateKey = generatePrivateKey();
  const address = privateKeyToAccount(privateKey).address;
  const encryptedPrivateKey = await encryptPrivateKey(privateKey);

  try {
    return await prisma.pipelineWallet.create({
      data: { pipelineId, chain, address, encryptedPrivateKey, keyVersion: 1, status: WalletStatus.ACTIVE },
    });
  } catch {
    // Lost a race with a concurrent provision call for the same pipeline — the unique
    // constraint on PipelineWallet.pipelineId rejected our insert, so fetch the row the other
    // call created rather than surface an error for what's actually a successful idempotent
    // outcome (same tradeoff subscriptionCustody.ts's provisionSubscriptionWallet documents).
    const winner = await prisma.pipelineWallet.findUnique({ where: { pipelineId } });
    if (!winner) throw new Error(`Failed to provision or find PipelineWallet for pipeline ${pipelineId}`);
    return winner;
  }
}

/** Decrypted key material, for transient use signing a single operation — callers must not log
 * or persist the returned privateKey. Returns null if no wallet has been provisioned yet or it
 * was revoked/withdrawn. */
export async function getDecryptedPipelineWallet(pipelineId: string): Promise<{ address: string; privateKey: string } | null> {
  const wallet = await prisma.pipelineWallet.findUnique({ where: { pipelineId } });
  if (!wallet || wallet.status !== WalletStatus.ACTIVE) return null;
  return { address: wallet.address, privateKey: await decryptPrivateKey(wallet.encryptedPrivateKey) };
}
