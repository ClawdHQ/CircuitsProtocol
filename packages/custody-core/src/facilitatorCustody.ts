import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { prisma, FacilitatorWalletStatus, type FacilitatorWallet } from "@clawdhq/custody-db";
import { LocalRootKeyProvider, encryptPrivateKey as encryptWithProvider, decryptPrivateKey as decryptWithProvider, type RootKeyProvider } from "./envelopeEncryption.js";
import type { EvmPrismaChain } from "./evmChainConfig.js";

// x402 facilitator custody: unlike Subscriptions (one custodied wallet per subscription) or
// Degen (one per agent+venue), there is exactly one facilitator wallet per chain — it never
// holds funds of its own (it only calls X402Facilitator.pullPayment, moving USDC directly
// payer -> recipient through a pre-granted allowance), so there's no capital-bounding reason to
// mint a fresh one per payer or per call. Uses its own root key
// (FACILITATOR_KMS_PROVIDER/FACILITATOR_LOCAL_ROOT_KEY, separate from Degen's and Subscriptions'
// domains) so a compromise of one custodied-signing domain doesn't expose the others.
//
// *** DEV-MODE WARNING *** — see envelopeEncryption.ts's LocalRootKeyProvider doc comment: the
// only provider implemented right now is dev-only and NOT an acceptable root-of-trust once this
// key is authorized (via X402Facilitator.setFacilitator) against a contract holding real payer
// allowances.

function getRootKeyProvider(): RootKeyProvider {
  const provider = process.env.FACILITATOR_KMS_PROVIDER || "local";
  if (provider === "local") return new LocalRootKeyProvider("FACILITATOR_LOCAL_ROOT_KEY");
  throw new Error(
    `FACILITATOR_KMS_PROVIDER="${provider}" has no implementation yet — only "local" (dev-only, see envelopeEncryption.ts's warning) exists. ` +
      "Implement a real KMS-backed RootKeyProvider before authorizing this signer against a real facilitator contract.",
  );
}

async function encryptPrivateKey(plaintext: string): Promise<string> {
  return encryptWithProvider(plaintext, getRootKeyProvider());
}

async function decryptPrivateKey(encryptedPrivateKey: string): Promise<string> {
  return decryptWithProvider(encryptedPrivateKey, getRootKeyProvider());
}

/** Idempotent: returns the chain's existing facilitator wallet (whatever its status) rather
 * than provisioning a second one — a REVOKED wallet stays found-and-reused (its status is what
 * the kill switch toggles), not silently replaced by a fresh ACTIVE one. */
export async function getOrCreateFacilitatorWallet(chain: EvmPrismaChain): Promise<FacilitatorWallet> {
  const existing = await prisma.facilitatorWallet.findFirst({ where: { chain } });
  if (existing) return existing;

  const privateKey = generatePrivateKey();
  const address = privateKeyToAccount(privateKey).address;
  const encryptedPrivateKey = await encryptPrivateKey(privateKey);

  try {
    return await prisma.facilitatorWallet.create({
      data: { chain, address, encryptedPrivateKey, keyVersion: 1, status: FacilitatorWalletStatus.ACTIVE },
    });
  } catch {
    const winner = await prisma.facilitatorWallet.findFirst({ where: { chain } });
    if (!winner) throw new Error(`Failed to provision or find a FacilitatorWallet for ${chain}`);
    return winner;
  }
}

/** Decrypted key material plus current status, for transient use signing a single pull —
 * callers must not log or persist the returned privateKey. Returns null if no facilitator
 * wallet has been provisioned for this chain yet. */
export async function getDecryptedFacilitatorWallet(chain: EvmPrismaChain): Promise<{ address: string; privateKey: string; status: FacilitatorWalletStatus } | null> {
  const wallet = await prisma.facilitatorWallet.findFirst({ where: { chain } });
  if (!wallet) return null;
  return { address: wallet.address, privateKey: await decryptPrivateKey(wallet.encryptedPrivateKey), status: wallet.status };
}

/** Application-layer kill switch — checked before ever attempting a pull, cheaper and faster
 * than relying solely on the contract's own on-chain `paused` flag (which still exists as the
 * canonical, harder-to-bypass stop). Toggling this never touches payers' ERC20 allowances. */
export async function setFacilitatorKillSwitch(chain: EvmPrismaChain, enabled: boolean): Promise<void> {
  await prisma.facilitatorWallet.updateMany({
    where: { chain },
    data: { status: enabled ? FacilitatorWalletStatus.REVOKED : FacilitatorWalletStatus.ACTIVE },
  });
}
