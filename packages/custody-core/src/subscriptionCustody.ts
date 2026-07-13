import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { prisma, WalletStatus, type SubscriptionWallet, type Chain } from "@clawdhq/custody-db";
import { LocalRootKeyProvider, encryptPrivateKey as encryptWithProvider, decryptPrivateKey as decryptWithProvider, type RootKeyProvider } from "./envelopeEncryption.js";
import { isSolanaPrismaChain } from "./solanaChainConfig.js";
import { isSuiPrismaChain } from "./suiChainConfig.js";

// Subscription-wallet custody: one custodied keypair per subscription (not pooled per owner) —
// capital-bounded exposure, same philosophy as Degen's per-(agent,venue) wallets. Uses its own
// root key (CUSTODY_KMS_PROVIDER/CUSTODY_LOCAL_ROOT_KEY, separate from Degen's DEGEN_* vars and
// the x402 facilitator's FACILITATOR_* vars) so a compromise of one domain's root key doesn't
// expose the others' custodied wallets.
//
// *** DEV-MODE WARNING *** — see envelopeEncryption.ts's LocalRootKeyProvider doc comment: the
// only provider implemented right now is dev-only and NOT an acceptable root-of-trust for a
// wallet that ever holds real money. CUSTODY_KMS_PROVIDER must point at a real KMS before any
// subscription wallet is funded with real value.

function getRootKeyProvider(): RootKeyProvider {
  const provider = process.env.CUSTODY_KMS_PROVIDER || "local";
  if (provider === "local") return new LocalRootKeyProvider("CUSTODY_LOCAL_ROOT_KEY");
  throw new Error(
    `CUSTODY_KMS_PROVIDER="${provider}" has no implementation yet — only "local" (dev-only, see envelopeEncryption.ts's warning) exists. ` +
      "Implement a real KMS-backed RootKeyProvider before funding any subscription wallet in production.",
  );
}

async function encryptPrivateKey(plaintext: string): Promise<string> {
  return encryptWithProvider(plaintext, getRootKeyProvider());
}

async function decryptPrivateKey(encryptedPrivateKey: string): Promise<string> {
  return decryptWithProvider(encryptedPrivateKey, getRootKeyProvider());
}

function generateEvmWallet(): { address: string; secretMaterial: string } {
  const privateKey = generatePrivateKey();
  return { address: privateKeyToAccount(privateKey).address, secretMaterial: privateKey };
}

/** Base58 secret key, matching @solana/web3.js's Keypair.secretKey encoding convention used
 * elsewhere in this codebase (degenWithdraw.ts, bs58.decode) rather than a raw byte array. */
function generateSolanaWallet(): { address: string; secretMaterial: string } {
  const keypair = Keypair.generate();
  return { address: keypair.publicKey.toBase58(), secretMaterial: bs58.encode(keypair.secretKey) };
}

/** Bech32 secret key string (Ed25519Keypair.getSecretKey()'s native encoding) — re-importable
 * directly via Ed25519Keypair.fromSecretKey, no separate byte-array handling needed. */
function generateSuiWallet(): { address: string; secretMaterial: string } {
  const keypair = Ed25519Keypair.generate();
  return { address: keypair.toSuiAddress(), secretMaterial: keypair.getSecretKey() };
}

/** Idempotent: returns the existing wallet if one was already provisioned for this subscription
 * rather than generating a second one. The stored `encryptedPrivateKey` decrypts to a hex EVM
 * private key, a base58 Solana secret key, or a Bech32 Sui secret key depending on `chain`'s
 * family. */
export async function provisionSubscriptionWallet(subscriptionId: string, chain: Chain): Promise<SubscriptionWallet> {
  const existing = await prisma.subscriptionWallet.findUnique({ where: { subscriptionId } });
  if (existing) return existing;

  const generated = isSolanaPrismaChain(chain) ? generateSolanaWallet() : isSuiPrismaChain(chain) ? generateSuiWallet() : generateEvmWallet();
  const encryptedPrivateKey = await encryptPrivateKey(generated.secretMaterial);

  try {
    return await prisma.subscriptionWallet.create({
      data: { subscriptionId, chain, address: generated.address, encryptedPrivateKey, keyVersion: 1, status: WalletStatus.ACTIVE },
    });
  } catch {
    // Lost a race with a concurrent provision call for the same subscription — the unique
    // constraint on SubscriptionWallet.subscriptionId rejected our insert, so fetch the row the
    // other call created rather than surface an error for what's actually a successful
    // idempotent outcome.
    const winner = await prisma.subscriptionWallet.findUnique({ where: { subscriptionId } });
    if (!winner) throw new Error(`Failed to provision or find SubscriptionWallet for subscription ${subscriptionId}`);
    return winner;
  }
}

/** Decrypted key material, for transient use signing a single operation — callers must not log
 * or persist the returned privateKey. Its encoding depends on the wallet's chain family (hex for
 * EVM, base58 secret key for Solana, Bech32 secret key for Sui); callers already know which
 * chain they asked for. Returns null if no wallet has been provisioned yet or it was
 * revoked/withdrawn. */
export async function getDecryptedSubscriptionWallet(subscriptionId: string): Promise<{ address: string; privateKey: string } | null> {
  const wallet = await prisma.subscriptionWallet.findUnique({ where: { subscriptionId } });
  if (!wallet || wallet.status !== WalletStatus.ACTIVE) return null;
  return { address: wallet.address, privateKey: await decryptPrivateKey(wallet.encryptedPrivateKey) };
}
