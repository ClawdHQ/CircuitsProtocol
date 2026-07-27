import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { createCircleClient, getVerifiedDeveloperWallet, AGENT_WALLET_BLOCKCHAINS, CircleAgentWalletError } from "@clawdhq/circle";
import { prisma, WalletStatus, AgentWalletCustodyType, type AgentWallet, type Chain } from "@clawdhq/custody-db";
import { LocalRootKeyProvider, encryptPrivateKey as encryptWithProvider, decryptPrivateKey as decryptWithProvider, type RootKeyProvider } from "./envelopeEncryption.js";
import { getDecryptedCircleAgentWalletCredential, saveCircleAgentWalletCredential, type CircleCredentialInput } from "./circleAgentCredentialCustody.js";
import { isEvmPrismaChain, type EvmPrismaChain } from "./evmChainConfig.js";
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

/** Same idempotent contract as provisionAgentWallet, but checks for a live (unconsumed,
 * unexpired) PendingCircleAgentWalletIntent for (chain, ownerAddress) first — see that model's
 * own schema doc comment for why this has to happen *before* the agent's first on-chain wallet
 * binding, never after. Falls through to plain provisionAgentWallet's LOCAL auto-provisioning
 * (unchanged) when no intent exists, which is the common case for every agent whose owner never
 * touched the wizard's Circle-wallet step. Re-validates the Circle wallet against Circle itself
 * rather than trusting the intent row's own onboarding-time validation, since credentials could
 * have been rotated or the wallet deleted in the time since — a stale/now-invalid intent falls
 * through to LOCAL auto-provisioning rather than failing registration outright. EVM-only (Circle
 * Agent Wallets don't apply to Solana/Sui, see evmChainConfig.ts's isEvmPrismaChain), so a
 * non-EVM chain skips the intent lookup entirely. */
export async function provisionAgentWalletForOwner(chain: Chain, agentChainId: string, ownerAddress: string): Promise<AgentWallet> {
  const existing = await prisma.agentWallet.findUnique({ where: { chain_agentChainId: { chain, agentChainId } } });
  if (existing) return existing;

  if (!isEvmPrismaChain(chain)) return provisionAgentWallet(chain, agentChainId);

  const intent = await prisma.pendingCircleAgentWalletIntent.findUnique({ where: { chain_ownerAddress: { chain, ownerAddress } } });
  const isLive = intent && !intent.consumedAt && intent.expiresAt > new Date();
  if (!intent || !isLive) return provisionAgentWallet(chain, agentChainId);

  try {
    const credential = await getDecryptedCircleAgentWalletCredential(intent.circleCredentialId);
    const client = createCircleClient({ apiKey: credential.apiKey, entitySecret: credential.entitySecret });
    const circleWallet = await getVerifiedDeveloperWallet(client, intent.circleWalletId);

    const created = await prisma.agentWallet.create({
      data: {
        chain,
        agentChainId,
        address: circleWallet.address,
        custodyType: AgentWalletCustodyType.CIRCLE,
        circleWalletId: circleWallet.id,
        circleCredentialId: intent.circleCredentialId,
        status: WalletStatus.ACTIVE,
      },
    });
    await prisma.pendingCircleAgentWalletIntent.update({ where: { id: intent.id }, data: { consumedAt: new Date() } });
    return created;
  } catch (err) {
    // Revalidation failed (credential rotated, wallet deleted on Circle's side, transient Circle
    // API error) or lost a create race — either way, don't leave this agent without a wallet at
    // all. Re-check for a winner first (same race-recovery shape provisionAgentWallet's own
    // catch uses) before falling all the way back to a fresh LOCAL wallet.
    const winner = await prisma.agentWallet.findUnique({ where: { chain_agentChainId: { chain, agentChainId } } });
    if (winner) return winner;
    console.error(`[agentWalletCustody] Circle intent for ${chain}:${ownerAddress} failed, falling back to LOCAL custody:`, err instanceof Error ? err.message : err);
    return provisionAgentWallet(chain, agentChainId);
  }
}

const CIRCLE_INTENT_TTL_MS = 30 * 60 * 1000;

/** Validates an owner-supplied Circle wallet/credential pair (the Register Agent wizard's
 * "bring your own Circle Agent Wallet" step) and, if it checks out, stores the credential and a
 * pending intent for provisionAgentWalletForOwner to consume once the agent's AgentRegistered
 * event actually arrives. Throws CircleAgentWalletError (safe to show the owner directly) if the
 * wallet isn't a Developer-Controlled wallet on the requested chain — see
 * getVerifiedDeveloperWallet's own doc comment. Always overwrites any existing pending intent for
 * this (chain, ownerAddress): a second wizard submission is meant to replace the first, not queue
 * behind it. */
export async function savePendingCircleAgentWalletIntent(
  chain: EvmPrismaChain,
  ownerAddress: string,
  circleWalletId: string,
  credential: CircleCredentialInput,
): Promise<void> {
  // Indexed as Record<string, string> rather than by EvmPrismaChain directly: AGENT_WALLET_BLOCKCHAINS
  // (defined in @clawdhq/circle, which has no notion of this app's own chain-naming types) is
  // keyed by a narrower set than EvmPrismaChain — BSC_TESTNET has no Circle blockchain at all
  // (see agentWallets.ts's own doc comment) — so the lookup is checked explicitly instead of
  // relying on TS to reject an unsupported key at compile time.
  const expectedBlockchain = (AGENT_WALLET_BLOCKCHAINS as Record<string, string>)[chain];
  if (!expectedBlockchain) {
    throw new CircleAgentWalletError(`ClawdHQ doesn't support Circle agent wallets on ${chain} yet.`);
  }

  const client = createCircleClient({ apiKey: credential.apiKey, entitySecret: credential.entitySecret });
  const circleWallet = await getVerifiedDeveloperWallet(client, circleWalletId);

  if (circleWallet.blockchain !== expectedBlockchain) {
    throw new CircleAgentWalletError(`That wallet is on ${circleWallet.blockchain}, but you're registering an agent on ${chain} — bring a wallet that matches the chain you're registering on.`);
  }

  const savedCredential = await saveCircleAgentWalletCredential(ownerAddress, credential);

  await prisma.pendingCircleAgentWalletIntent.upsert({
    where: { chain_ownerAddress: { chain, ownerAddress } },
    create: { chain, ownerAddress, circleWalletId, circleCredentialId: savedCredential.id, expiresAt: new Date(Date.now() + CIRCLE_INTENT_TTL_MS) },
    update: { circleWalletId, circleCredentialId: savedCredential.id, expiresAt: new Date(Date.now() + CIRCLE_INTENT_TTL_MS), consumedAt: null },
  });
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
 * been provisioned yet or it was revoked. Solana/Sui wallets are always LOCAL-custodied (Circle
 * Agent Wallets are EVM-only, see agentEvmSigner.ts), so this only ever throws in practice if an
 * EVM caller reaches this function directly instead of going through getAgentEvmSigner — kept as
 * a defensive check, not the primary branch point. */
export async function getDecryptedAgentWallet(chain: Chain, agentChainId: string): Promise<{ address: string; privateKey: string } | null> {
  const wallet = await prisma.agentWallet.findUnique({ where: { chain_agentChainId: { chain, agentChainId } } });
  if (!wallet || wallet.status !== WalletStatus.ACTIVE) return null;
  if (wallet.custodyType === AgentWalletCustodyType.CIRCLE || !wallet.encryptedPrivateKey) {
    throw new Error(`AgentWallet ${chain}:${agentChainId} is Circle-custodied — no local private key exists; use getAgentEvmSigner instead.`);
  }
  return { address: wallet.address, privateKey: await decryptPrivateKey(wallet.encryptedPrivateKey) };
}
