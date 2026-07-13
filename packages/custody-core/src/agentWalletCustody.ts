import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { prisma, WalletStatus, type AgentWallet, type Chain } from "@clawdhq/custody-db";
import { LocalRootKeyProvider, encryptPrivateKey as encryptWithProvider, decryptPrivateKey as decryptWithProvider, type RootKeyProvider } from "./envelopeEncryption.js";
import { isSolanaPrismaChain } from "./solanaChainConfig.js";
import { isSuiPrismaChain } from "./suiChainConfig.js";

// Agent-wallet custody: one custodied keypair per (agentId, chain) — the canonical destination
// every earning flow (job payout, launchpad creator allocation, x402 earnings, Degen venue
// settlement) redirects to on-chain, replacing the old "push straight to the owner at
// settlement time" behavior. Unlike SubscriptionWallet/TradingWallet, this wallet is meant to
// accumulate rather than stay capital-bounded to one activity — see agentWalletClaim.ts for how
// an owner pulls funds back out. Uses its own root key (AGENT_WALLET_KMS_PROVIDER/
// AGENT_WALLET_LOCAL_ROOT_KEY, separate from Subscriptions'/Degen's/the facilitator's) so a
// compromise of one domain's root key doesn't expose the others' custodied wallets.
//
// *** DEV-MODE WARNING *** — see envelopeEncryption.ts's LocalRootKeyProvider doc comment: the
// only provider implemented right now is dev-only and NOT an acceptable root-of-trust for a
// wallet that ever holds real money. AGENT_WALLET_KMS_PROVIDER must point at a real KMS before
// any agent wallet is funded with real value.

function getRootKeyProvider(): RootKeyProvider {
  const provider = process.env.AGENT_WALLET_KMS_PROVIDER || "local";
  if (provider === "local") return new LocalRootKeyProvider("AGENT_WALLET_LOCAL_ROOT_KEY");
  throw new Error(
    `AGENT_WALLET_KMS_PROVIDER="${provider}" has no implementation yet — only "local" (dev-only, see envelopeEncryption.ts's warning) exists. ` +
      "Implement a real KMS-backed RootKeyProvider before funding any agent wallet in production.",
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

function generateSolanaWallet(): { address: string; secretMaterial: string } {
  const keypair = Keypair.generate();
  return { address: keypair.publicKey.toBase58(), secretMaterial: bs58.encode(keypair.secretKey) };
}

function generateSuiWallet(): { address: string; secretMaterial: string } {
  const keypair = Ed25519Keypair.generate();
  return { address: keypair.toSuiAddress(), secretMaterial: keypair.getSecretKey() };
}

/** Idempotent: returns the existing wallet if one was already provisioned for this
 * (chain, agentChainId) pair rather than generating a second one — safe to call from both the
 * indexer's event-driven provisioning trigger and a historical-backfill script without risking
 * two wallets for the same agent. */
export async function provisionAgentWallet(chain: Chain, agentChainId: string): Promise<AgentWallet> {
  const existing = await prisma.agentWallet.findUnique({ where: { chain_agentChainId: { chain, agentChainId } } });
  if (existing) return existing;

  const generated = isSolanaPrismaChain(chain) ? generateSolanaWallet() : isSuiPrismaChain(chain) ? generateSuiWallet() : generateEvmWallet();
  const encryptedPrivateKey = await encryptPrivateKey(generated.secretMaterial);

  try {
    return await prisma.agentWallet.create({
      data: { chain, agentChainId, address: generated.address, encryptedPrivateKey, keyVersion: 1, status: WalletStatus.ACTIVE },
    });
  } catch {
    // Lost a race with a concurrent provision call for the same agent — the unique constraint
    // on AgentWallet rejected our insert, so fetch the row the other call created rather than
    // surface an error for what's actually a successful idempotent outcome.
    const winner = await prisma.agentWallet.findUnique({ where: { chain_agentChainId: { chain, agentChainId } } });
    if (!winner) throw new Error(`Failed to provision or find AgentWallet for ${chain}:${agentChainId}`);
    return winner;
  }
}

/** Address only, safe to expose to clients (e.g. so the on-chain setAgentWallet call and the
 * Wallet tab's balance read both know where to look) — never includes key material. Returns
 * null if no wallet has been provisioned yet. */
export async function getAgentWalletAddress(chain: Chain, agentChainId: string): Promise<string | null> {
  const wallet = await prisma.agentWallet.findUnique({ where: { chain_agentChainId: { chain, agentChainId } } });
  return wallet?.address ?? null;
}

/** Decrypted key material, for transient use signing a single operation — callers must not log
 * or persist the returned privateKey. Its encoding depends on the wallet's chain family (hex for
 * EVM, base58 secret key for Solana, Bech32 secret key for Sui). Returns null if no wallet has
 * been provisioned yet or it was revoked. */
export async function getDecryptedAgentWallet(chain: Chain, agentChainId: string): Promise<{ address: string; privateKey: string } | null> {
  const wallet = await prisma.agentWallet.findUnique({ where: { chain_agentChainId: { chain, agentChainId } } });
  if (!wallet || wallet.status !== WalletStatus.ACTIVE) return null;
  return { address: wallet.address, privateKey: await decryptPrivateKey(wallet.encryptedPrivateKey) };
}
