import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { prisma, LlmBillingTreasuryWalletStatus, type LlmBillingTreasuryWallet } from "@clawdhq/custody-db";
import { LocalRootKeyProvider, encryptPrivateKey as encryptWithProvider, decryptPrivateKey as decryptWithProvider, type RootKeyProvider } from "./envelopeEncryption.js";
import type { EvmPrismaChain } from "./evmChainConfig.js";

// Platform LLM billing treasury: one custodied wallet per chain, same "no capital-bounding
// reason to mint per-agent" shape as FacilitatorWallet — except unlike the facilitator (which
// only ever relays payer -> recipient and never holds a balance of its own), this wallet *does*
// accumulate: every hosted agent's LLM credit top-up (see agentLlmCredit.ts's
// topUpAgentLlmCredit) lands here as a real on-chain transfer from that agent's own AgentWallet.
// Own root key (LLM_BILLING_TREASURY_KMS_PROVIDER/LLM_BILLING_TREASURY_LOCAL_ROOT_KEY), isolated
// from every other custody domain for the usual reason — see AgentWallet's own doc comment.
//
// *** DEV-MODE WARNING *** — see envelopeEncryption.ts's LocalRootKeyProvider doc comment: the
// only provider implemented right now is dev-only and NOT an acceptable root-of-trust for a
// wallet real top-ups will accumulate real USDC in.

function getRootKeyProvider(): RootKeyProvider {
  const provider = process.env.LLM_BILLING_TREASURY_KMS_PROVIDER || "local";
  if (provider === "local") return new LocalRootKeyProvider("LLM_BILLING_TREASURY_LOCAL_ROOT_KEY");
  throw new Error(
    `LLM_BILLING_TREASURY_KMS_PROVIDER="${provider}" has no implementation yet — only "local" (dev-only, see envelopeEncryption.ts's warning) exists. ` +
      "Implement a real KMS-backed RootKeyProvider before this wallet ever holds a real top-up.",
  );
}

async function encryptPrivateKey(plaintext: string): Promise<string> {
  return encryptWithProvider(plaintext, getRootKeyProvider());
}

async function decryptPrivateKey(encryptedPrivateKey: string): Promise<string> {
  return decryptWithProvider(encryptedPrivateKey, getRootKeyProvider());
}

/** Idempotent: returns the chain's existing treasury wallet (whatever its status) rather than
 * provisioning a second one — same reasoning getOrCreateFacilitatorWallet documents. */
export async function getOrCreateLlmBillingTreasuryWallet(chain: EvmPrismaChain): Promise<LlmBillingTreasuryWallet> {
  const existing = await prisma.llmBillingTreasuryWallet.findFirst({ where: { chain } });
  if (existing) return existing;

  const privateKey = generatePrivateKey();
  const address = privateKeyToAccount(privateKey).address;
  const encryptedPrivateKey = await encryptPrivateKey(privateKey);

  try {
    return await prisma.llmBillingTreasuryWallet.create({
      data: { chain, address, encryptedPrivateKey, keyVersion: 1, status: LlmBillingTreasuryWalletStatus.ACTIVE },
    });
  } catch {
    const winner = await prisma.llmBillingTreasuryWallet.findFirst({ where: { chain } });
    if (!winner) throw new Error(`Failed to provision or find an LlmBillingTreasuryWallet for ${chain}`);
    return winner;
  }
}

/** Address only, safe to expose to clients — never includes key material. */
export async function getLlmBillingTreasuryAddress(chain: EvmPrismaChain): Promise<string | null> {
  const wallet = await prisma.llmBillingTreasuryWallet.findFirst({ where: { chain } });
  return wallet?.address ?? null;
}

/** True unless the chain's treasury has been explicitly revoked — checked by
 * topUpAgentLlmCredit before accepting a new top-up into it, same "application-layer kill
 * switch, cheaper and faster than relying solely on chain state" reasoning
 * setFacilitatorKillSwitch documents. Defaults to true (treated as active) if no wallet has been
 * provisioned yet, since provisioning always starts a wallet ACTIVE. */
export async function isLlmBillingTreasuryActive(chain: EvmPrismaChain): Promise<boolean> {
  const wallet = await prisma.llmBillingTreasuryWallet.findFirst({ where: { chain } });
  return !wallet || wallet.status === LlmBillingTreasuryWalletStatus.ACTIVE;
}

/** Application-layer kill switch — stops new top-ups from being accepted into this chain's
 * treasury without touching whatever balance it's already accumulated. Same shape as
 * setFacilitatorKillSwitch. */
export async function setLlmBillingTreasuryKillSwitch(chain: EvmPrismaChain, enabled: boolean): Promise<void> {
  await prisma.llmBillingTreasuryWallet.updateMany({
    where: { chain },
    data: { status: enabled ? LlmBillingTreasuryWalletStatus.REVOKED : LlmBillingTreasuryWalletStatus.ACTIVE },
  });
}
