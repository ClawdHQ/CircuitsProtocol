import { AnchorProvider } from "@coral-xyz/anchor";
import { Connection, PublicKey, type Transaction, type VersionedTransaction } from "@solana/web3.js";
import { SolanaAdapter } from "@clawdhq/sdk";
import { computeFairValue, type AgentTier } from "@clawdhq/valuation";
import { ListingMode, ListingStatus, prisma, type Chain } from "@clawdhq/marketplace-db";
import {
  provisionAgentWallet,
  getOrCreateRegistrarWallet,
  getDecryptedRegistrarWallet,
  getSigningSolanaAdapter,
  ensureUsdcAtaFor,
  type SolanaPrismaChain,
} from "@clawdhq/custody-core";
import { POLL_INTERVAL_MS, type SolanaIndexerConfig } from "../config.js";

/** Same cast reasoning as the EVM listener's `toCustodyChain` — marketplace-db's and
 * custody-core's Chain-shaped types are deliberately duplicated with identical string values
 * but distinct nominal TS types. */
function toCustodyChain(chain: Chain): SolanaPrismaChain {
  return chain as unknown as SolanaPrismaChain;
}

/** A signer-less stand-in for `AnchorProvider`'s required wallet — the indexer only ever
 * reads, mirroring `apps/web`'s `useSolanaAdapter.ts` `READ_ONLY_WALLET`. */
const READ_ONLY_WALLET: {
  publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
  signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]>;
} = {
  publicKey: PublicKey.default,
  signTransaction: () => {
    throw new Error("SolanaAdapter (indexer): read-only, cannot sign.");
  },
  signAllTransactions: () => {
    throw new Error("SolanaAdapter (indexer): read-only, cannot sign.");
  },
};

function toListingMode(mode: Record<string, unknown>): ListingMode {
  return "auction" in mode ? ListingMode.AUCTION : ListingMode.OPEN;
}

function toListingStatus(status: Record<string, unknown>): ListingStatus {
  if ("sold" in status) return ListingStatus.SOLD;
  if ("cancelled" in status) return ListingStatus.CANCELLED;
  if ("expired" in status) return ListingStatus.EXPIRED;
  return ListingStatus.ACTIVE;
}

function tierToNumber(tier: Record<string, unknown>): AgentTier {
  if ("verified" in tier) return 1;
  if ("elite" in tier) return 2;
  return 0;
}

function toDateTime(unixSeconds: unknown): Date {
  return new Date(Number(unixSeconds) * 1000);
}

function toBase58(pubkey: unknown): string {
  return (pubkey as PublicKey).toBase58();
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function syncListing(config: SolanaIndexerConfig, listing: Record<string, unknown>): Promise<void> {
  const listingId = BigInt(String(listing.listingId));
  const agentId = BigInt(String(listing.agentId));
  const endTime = BigInt(String(listing.endTime));
  const highestBidId = BigInt(String(listing.highestBidId));
  const createdAt = listing.createdAt;
  const updatedAt = listing.updatedAt;

  await prisma.listing.upsert({
    where: { chain_chainListingId: { chain: config.prismaChain, chainListingId: listingId.toString() } },
    create: {
      chain: config.prismaChain,
      chainListingId: listingId.toString(),
      agentChainId: agentId.toString(),
      seller: toBase58(listing.seller),
      mode: toListingMode(listing.mode as Record<string, unknown>),
      status: toListingStatus(listing.status as Record<string, unknown>),
      fairValueSnapshotUsdc: BigInt(String(listing.fairValueSnapshot)),
      reservePriceUsdc: BigInt(String(listing.reservePrice)),
      endTime: endTime === 0n ? null : toDateTime(endTime),
      highestBidChainId: highestBidId === 0n ? null : highestBidId.toString(),
      createdAtChain: toDateTime(createdAt),
      updatedAtChain: toDateTime(updatedAt),
    },
    update: {
      status: toListingStatus(listing.status as Record<string, unknown>),
      endTime: endTime === 0n ? null : toDateTime(endTime),
      highestBidChainId: highestBidId === 0n ? null : highestBidId.toString(),
      updatedAtChain: toDateTime(updatedAt),
    },
  });
}

/** Listings are always synced first in `pollOnce` (every cycle re-fetches the full set), so
 * a bid's parent listing row is guaranteed to already exist — unlike the EVM listener's
 * "sync it now if missing" fallback, which only handles that because it processes a bounded
 * batch of *changed* ids, not everything. */
async function syncBid(config: SolanaIndexerConfig, bid: Record<string, unknown>): Promise<void> {
  const bidId = BigInt(String(bid.bidId));
  const listingId = BigInt(String(bid.listingId));

  const listing = await prisma.listing.findUnique({
    where: { chain_chainListingId: { chain: config.prismaChain, chainListingId: listingId.toString() } },
  });
  if (!listing) return;

  await prisma.bid.upsert({
    where: { chain_listingDbId_chainBidId: { chain: config.prismaChain, listingDbId: listing.id, chainBidId: bidId.toString() } },
    create: {
      chain: config.prismaChain,
      chainBidId: bidId.toString(),
      listingDbId: listing.id,
      bidder: toBase58(bid.bidder),
      amountUsdc: BigInt(String(bid.amount)),
      active: Boolean(bid.active),
      createdAtChain: toDateTime(bid.createdAt),
    },
    update: {
      active: Boolean(bid.active),
      amountUsdc: BigInt(String(bid.amount)),
    },
  });
}

async function syncAgentValuation(config: SolanaIndexerConfig, agent: Record<string, unknown>): Promise<void> {
  const agentId = BigInt(String(agent.agentId));
  const result = computeFairValue({
    usdcRevenue: BigInt(String(agent.usdcRevenue)),
    tier: tierToNumber(agent.tier as Record<string, unknown>),
    reputationBps: Number(agent.reputationBps),
    lastJobAtSeconds: Number(agent.lastJobAt),
    supportsX402: Boolean(agent.supportsX402),
    supportsA2A: Boolean(agent.supportsA2A),
    supportsMcp: Boolean(agent.supportsMcp),
    nowSeconds: Math.floor(Date.now() / 1000),
  });

  await prisma.agentValuationCache.upsert({
    where: { chain_agentChainId: { chain: config.prismaChain, agentChainId: agentId.toString() } },
    create: {
      chain: config.prismaChain,
      agentChainId: agentId.toString(),
      fairValueUsdc: result.fairValueUsdc,
      formulaVersion: result.formulaVersion,
    },
    update: { fairValueUsdc: result.fairValueUsdc, formulaVersion: result.formulaVersion },
  });
}

/** Provisions an agent's canonical custodied wallet and binds it on-chain via the registrar-
 * gated `set_agent_wallet` instruction — see clawdhq_agent's lib.rs `payout_authority` for why
 * job payouts/launchpad creator allocations need this set before they route to the agent's own
 * wallet instead of falling back to `owner`. No separate "AgentRegistered event" detection is
 * needed the way the EVM listener has one: Solana's full-poll model (see `pollOnce`) already
 * re-examines every agent's current on-chain state every cycle, so a plain `agentWallet ==
 * PublicKey.default` check here is both the idempotency guard and the trigger. Also
 * pre-creates the agent wallet's USDC ATA (registrar-funded, since a freshly generated wallet
 * has no SOL of its own to pay its own rent with) — `confirmDelivery`/`autoReleaseExpired`
 * require that ATA to already exist. */
async function provisionAgentWalletOnChain(config: SolanaIndexerConfig, agent: Record<string, unknown>): Promise<void> {
  const agentWallet = agent.agentWallet as PublicKey;
  if (!agentWallet.equals(PublicKey.default)) return; // already set on-chain

  const agentId = Number(String(agent.agentId));
  const custodyChain = toCustodyChain(config.prismaChain);

  const custodyWallet = await provisionAgentWallet(custodyChain, agentId.toString());

  await getOrCreateRegistrarWallet(custodyChain);
  const registrar = await getDecryptedRegistrarWallet(custodyChain);
  if (!registrar) {
    console.error(`[indexer:solana] could not load a RegistrarWallet for ${custodyChain} — cannot set agent ${agentId}'s wallet on-chain`);
    return;
  }

  const custodyWalletPubkey = new PublicKey(custodyWallet.address);
  try {
    const signingAdapter = getSigningSolanaAdapter(custodyChain, registrar.privateKey);
    const registrarPubkey = new PublicKey(registrar.address);
    await signingAdapter.setAgentWallet(registrarPubkey, agentId, custodyWalletPubkey);
    await ensureUsdcAtaFor(custodyChain, registrar.privateKey, custodyWalletPubkey);
    console.log(`[indexer:solana] agent ${agentId} wallet set on-chain: ${custodyWallet.address}`);
  } catch (err) {
    // Most likely a benign race (another process's call already landed between our read-first
    // check and this write, so the program's own WalletAlreadySet revert fired) rather than a
    // failure worth crashing the poll cycle over.
    console.error(`[indexer:solana] setAgentWallet(${agentId}) failed:`, err instanceof Error ? err.message : err);
  }
}

/** Solana has no `getLogs`-style bounded-range query for account state, so — per the plan —
 * this polls the full set of Listing/Bid/Agent accounts every cycle (via `getProgramAccounts`
 * under `SolanaAdapter.getAllListings`/`getAllBids`/`getAllAgents`, the same memcmp-based
 * technique `getAgentsByOwner` already uses) and treats each cycle as a complete resync,
 * rather than reacting to discrete events the way the EVM/Sui listeners do. */
async function pollOnce(adapter: SolanaAdapter, config: SolanaIndexerConfig): Promise<void> {
  const [listings, bids, agents] = await Promise.all([adapter.getAllListings(), adapter.getAllBids(), adapter.getAllAgents()]);

  for (const listing of listings) await syncListing(config, listing);
  for (const bid of bids) await syncBid(config, bid);
  for (const agent of agents) await syncAgentValuation(config, agent);
  for (const agent of agents) await provisionAgentWalletOnChain(config, agent);

  console.log(`[indexer:solana] synced ${listings.length} listing(s), ${bids.length} bid(s), ${agents.length} agent valuation(s)`);
}

export async function runSolanaListener(config: SolanaIndexerConfig): Promise<never> {
  const connection = new Connection(config.rpcUrl, "confirmed");
  const provider = new AnchorProvider(connection, READ_ONLY_WALLET, { commitment: "confirmed" });
  const adapter = new SolanaAdapter({
    programId: config.programId,
    connection,
    provider,
    usdcMint: new PublicKey(config.usdcMint),
    treasuryAddress: config.treasuryAddress ? new PublicKey(config.treasuryAddress) : undefined,
  });

  console.log(`[indexer:solana] starting full-poll loop against program ${config.programId}`);

  for (;;) {
    await pollOnce(adapter, config);

    const lastSlot = BigInt(await connection.getSlot());
    await prisma.indexerCursor.upsert({
      where: { chain: config.prismaChain },
      create: { chain: config.prismaChain, lastSlot },
      update: { lastSlot },
    });

    await sleep(POLL_INTERVAL_MS);
  }
}
