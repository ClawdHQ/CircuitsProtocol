import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { SuiAdapter } from "@clawdhq/sdk";
import { computeFairValue, type AgentTier } from "@clawdhq/valuation";
import { ListingMode, ListingStatus, prisma, type Chain } from "@clawdhq/marketplace-db";
import {
  provisionAgentWallet,
  getOrCreateRegistrarWallet,
  getDecryptedRegistrarWallet,
  signAndExecuteSui,
  keypairFromSuiSecret,
  type SuiPrismaChain,
} from "@clawdhq/custody-core";
import { POLL_INTERVAL_MS, type SuiIndexerConfig } from "../config.js";

/** Same cast reasoning as the EVM listener's `toCustodyChain` — marketplace-db's and
 * custody-core's Chain-shaped types are deliberately duplicated with identical string values
 * but distinct nominal TS types. */
function toCustodyChain(chain: Chain): SuiPrismaChain {
  return chain as unknown as SuiPrismaChain;
}

/** Sui's JSON-RPC renders an `address` field as a 66-char `0x`-prefixed hex string, but a
 * freshly-registered agent's still-unset `agent_wallet` could in principle come back in either
 * the short (`0x0`) or fully zero-padded form depending on the node/SDK version — this tolerates
 * both rather than hardcoding an exact expected length. */
function isZeroSuiAddress(value: string): boolean {
  return /^0x0*$/.test(value);
}

interface SuiEventCursor {
  txDigest: string;
  eventSeq: string;
}

/** This fullnode rejects `Any`-combinator event queries ("'Any' queries are not supported"),
 * confirmed empirically against a live local network — so `agent_exchange`'s events,
 * `marketplace::JobCompletedEvent` (needed for the valuation-cache trigger), and
 * `registry::AgentRegisteredEvent` (needed for the wallet-provisioning trigger) each need their
 * own independent query and resume position, rather than one combined query with one cursor.
 * All three cursors still live in the single `lastEventCursor` column — it's just an opaque
 * JSON string as far as the schema is concerned. */
interface SuiCombinedCursor {
  agentExchange: SuiEventCursor | null;
  jobCompleted: SuiEventCursor | null;
  agentRegistered: SuiEventCursor | null;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function toListingMode(mode: unknown): ListingMode {
  return Number(mode) === 1 ? ListingMode.AUCTION : ListingMode.OPEN;
}

function toListingStatus(status: unknown): ListingStatus {
  const byIndex = [ListingStatus.ACTIVE, ListingStatus.SOLD, ListingStatus.CANCELLED, ListingStatus.EXPIRED];
  return byIndex[Number(status)] ?? ListingStatus.ACTIVE;
}

/** Sui timestamps (`clock.timestamp_ms()`) are already milliseconds, unlike EVM/Solana's
 * unix-seconds `created_at`/`end_time` fields — no `* 1000` here. */
function toDateTimeMs(ms: unknown): Date {
  return new Date(Number(ms));
}

/** Every `agent_exchange` event's underlying transaction touches exactly one `Listing`
 * object — created for `ListingCreatedEvent`, mutated for every other event type — so this
 * sidesteps needing to correlate the event's numeric `listing_id` to an object id via any
 * separate mapping: the transaction's own object changes already say which Listing it was. */
async function resolveListingObjectId(client: SuiJsonRpcClient, txDigest: string): Promise<string | undefined> {
  const block = await client.getTransactionBlock({ digest: txDigest, options: { showObjectChanges: true } });
  const match = block.objectChanges?.find(
    (change) =>
      (change.type === "created" || change.type === "mutated") &&
      "objectType" in change &&
      change.objectType.endsWith("::agent_exchange::Listing")
  );
  return match && "objectId" in match ? match.objectId : undefined;
}

/** Re-reads the Listing's full current state and upserts it — same "events are re-sync
 * triggers, not payloads" principle as the EVM listener. Unlike EVM, this always applies
 * cleanly here since the Listing object itself (unlike a Sui `Bid`, which lives inside a
 * `Table` and can be fully removed with no trace) is always independently fetchable. */
async function syncListing(adapter: SuiAdapter, config: SuiIndexerConfig, listingObjectId: string): Promise<void> {
  const listing = await adapter.getListing(listingObjectId);
  if (!listing) return;
  const fields = listing.fields;

  const highestBidId = BigInt(String(fields.highest_bid_id ?? "0"));
  const endTime = BigInt(String(fields.end_time ?? "0"));

  await prisma.listing.upsert({
    where: { chain_chainListingId: { chain: config.prismaChain, chainListingId: listingObjectId } },
    create: {
      chain: config.prismaChain,
      chainListingId: listingObjectId,
      agentChainId: String(fields.agent_id),
      seller: String(fields.seller),
      mode: toListingMode(fields.mode),
      status: toListingStatus(fields.status),
      fairValueSnapshotUsdc: BigInt(String(fields.fair_value_snapshot)),
      reservePriceUsdc: BigInt(String(fields.reserve_price)),
      endTime: endTime === 0n ? null : toDateTimeMs(endTime),
      highestBidChainId: highestBidId === 0n ? null : highestBidId.toString(),
      createdAtChain: toDateTimeMs(fields.created_at),
      updatedAtChain: toDateTimeMs(fields.updated_at),
    },
    update: {
      status: toListingStatus(fields.status),
      endTime: endTime === 0n ? null : toDateTimeMs(endTime),
      highestBidChainId: highestBidId === 0n ? null : highestBidId.toString(),
      updatedAtChain: toDateTimeMs(fields.updated_at),
    },
  });
}

/** Bids are the one place this listener trusts an event's own payload instead of re-reading
 * chain state: a Sui `Bid` lives inside the Listing's `Table` and is fully deleted once
 * withdrawn/outbid/accepted, so there is nothing left to "re-fetch" after the fact — the
 * event *is* the only remaining record of what happened. Each of `BidPlacedEvent`/
 * `BidWithdrawnEvent`/`BidOutbidRefundedEvent` carries a complete, self-consistent snapshot
 * of that one state transition (bid_id, bidder, amount), so trusting it here doesn't have
 * the staleness risk the EVM listener's design note warns about. */
async function upsertBidFromEvent(
  config: SuiIndexerConfig,
  chainListingId: string,
  chainBidId: string,
  bidder: string,
  amountUsdc: bigint,
  active: boolean,
  createdAtMs: number
): Promise<void> {
  const listing = await prisma.listing.findUnique({
    where: { chain_chainListingId: { chain: config.prismaChain, chainListingId } },
  });
  if (!listing) return;

  await prisma.bid.upsert({
    where: { chain_listingDbId_chainBidId: { chain: config.prismaChain, listingDbId: listing.id, chainBidId } },
    create: {
      chain: config.prismaChain,
      chainBidId,
      listingDbId: listing.id,
      bidder,
      amountUsdc,
      active,
      createdAtChain: new Date(createdAtMs),
    },
    update: { active, amountUsdc },
  });
}

/** Scoped by `chainListingId`, not just `chainBidId` — Sui's bid ids are only unique within
 * their own listing (see the Bid model's doc comment in schema.prisma), so an unscoped
 * `updateMany` on `chainBidId` alone would incorrectly flip bid #1 on *every* Sui listing
 * inactive instead of just the one this event is actually about. */
async function markBidInactive(config: SuiIndexerConfig, chainListingId: string, chainBidId: string): Promise<void> {
  const listing = await prisma.listing.findUnique({
    where: { chain_chainListingId: { chain: config.prismaChain, chainListingId } },
  });
  if (!listing) return;

  await prisma.bid.updateMany({
    where: { chain: config.prismaChain, listingDbId: listing.id, chainBidId },
    data: { active: false },
  });
}

/** Triggered by `marketplace::JobCompletedEvent` (a revenue-changing event, same trigger the
 * EVM listener uses), not a periodic sweep: `adapter.getAgentByChainId` resolves the event's
 * numeric `hired_agent_id` to the Agent's object id via `AgentRegisteredEvent`, so this only
 * ever does the (nontrivial) event-scan work for an agent that actually just changed, rather
 * than re-scanning every agent on every cycle the way a full sweep would. */
async function syncAgentValuation(adapter: SuiAdapter, config: SuiIndexerConfig, agentId: string): Promise<void> {
  const agent = await adapter.getAgentByChainId(BigInt(agentId));
  if (!agent) return;
  const fields = agent.fields;

  const result = computeFairValue({
    usdcRevenue: BigInt(String(fields.usdc_revenue)),
    tier: Number(fields.tier) as AgentTier,
    reputationBps: Number(fields.reputation_bps),
    // Sui timestamps are milliseconds (clock.timestamp_ms()), unlike EVM/Solana's unix seconds.
    lastJobAtSeconds: Math.floor(Number(fields.last_job_at) / 1000),
    supportsX402: Boolean(fields.supports_x402),
    supportsA2A: Boolean(fields.supports_a2a),
    supportsMcp: Boolean(fields.supports_mcp),
    nowSeconds: Math.floor(Date.now() / 1000),
  });

  await prisma.agentValuationCache.upsert({
    where: { chain_agentChainId: { chain: config.prismaChain, agentChainId: agentId } },
    create: {
      chain: config.prismaChain,
      agentChainId: agentId,
      fairValueUsdc: result.fairValueUsdc,
      formulaVersion: result.formulaVersion,
    },
    update: { fairValueUsdc: result.fairValueUsdc, formulaVersion: result.formulaVersion },
  });
}

/** Triggered by `registry::AgentRegisteredEvent` — provisions the agent's canonical custodied
 * wallet and binds it on-chain via the registrar-gated `registry::set_agent_wallet`, mirroring
 * the EVM listener's read-first-then-write shape (unlike the Solana port, Sui is event-driven
 * with a resume cursor rather than a full re-poll, so there's no "every cycle re-examines every
 * agent" idempotency guard to lean on here — the on-chain read prevents a redundant, failing
 * `set_agent_wallet` call if this event is ever reprocessed, e.g. after a cursor rollback).
 * Unlike EVM/Solana, no destination account needs pre-creating: a Sui `Coin<USDC>` object can be
 * transferred to any address directly, so there's no ATA-style bootstrapping step here. */
async function provisionAgentWalletOnChain(adapter: SuiAdapter, config: SuiIndexerConfig, agentId: string): Promise<void> {
  const agent = await adapter.getAgentByChainId(BigInt(agentId));
  if (!agent) return;
  const currentWallet = String(agent.fields.agent_wallet ?? "0x0");
  if (!isZeroSuiAddress(currentWallet)) return; // already set on-chain

  const custodyChain = toCustodyChain(config.prismaChain);
  const custodyWallet = await provisionAgentWallet(custodyChain, agentId);

  await getOrCreateRegistrarWallet(custodyChain);
  const registrar = await getDecryptedRegistrarWallet(custodyChain);
  if (!registrar) {
    console.error(`[indexer:sui] could not load a RegistrarWallet for ${custodyChain} — cannot set agent ${agentId}'s wallet on-chain`);
    return;
  }

  try {
    const tx = adapter.setAgentWallet(agent.objectId, custodyWallet.address);
    const registrarKeypair = keypairFromSuiSecret(registrar.privateKey);
    await signAndExecuteSui(custodyChain, registrarKeypair, tx);
    console.log(`[indexer:sui] agent ${agentId} wallet set on-chain: ${custodyWallet.address}`);
  } catch (err) {
    // Most likely a benign race (another process's call already landed between our read-first
    // check and this write, so the module's own EWalletAlreadySet abort fired) rather than a
    // failure worth crashing the poll cycle over.
    console.error(`[indexer:sui] setAgentWallet(${agentId}) failed:`, err instanceof Error ? err.message : err);
  }
}

async function processEvent(
  client: SuiJsonRpcClient,
  adapter: SuiAdapter,
  config: SuiIndexerConfig,
  event: { type: string; parsedJson: unknown; timestampMs?: string | null; id: { txDigest: string } }
): Promise<void> {
  const shortType = event.type.split("::").pop();
  const parsed = event.parsedJson as Record<string, unknown>;
  const timestampMs = Number(event.timestampMs ?? Date.now());

  // JobCompletedEvent's transaction touches a Job, and AgentRegisteredEvent's touches an
  // Agent, neither a Listing — resolveListingObjectId only applies to the agent_exchange
  // events below, so this branches on category first rather than unconditionally resolving a
  // Listing id up front.
  if (shortType === "JobCompletedEvent") {
    await syncAgentValuation(adapter, config, String(parsed.hired_agent_id));
    return;
  }
  if (shortType === "AgentRegisteredEvent") {
    await provisionAgentWalletOnChain(adapter, config, String(parsed.agent_id));
    return;
  }

  const listingObjectId = await resolveListingObjectId(client, event.id.txDigest);
  if (!listingObjectId) return; // defensive; every agent_exchange tx touches exactly one Listing

  switch (shortType) {
    case "ListingCreatedEvent":
    case "ListingCancelledEvent":
    case "ListingExpiredUnsoldEvent":
      await syncListing(adapter, config, listingObjectId);
      return;

    case "BidPlacedEvent":
      // highest_bid_id/end_time (anti-snipe) may have changed alongside the new bid.
      await syncListing(adapter, config, listingObjectId);
      await upsertBidFromEvent(config, listingObjectId, String(parsed.bid_id), String(parsed.bidder), BigInt(String(parsed.amount)), true, timestampMs);
      return;

    case "BidWithdrawnEvent":
      await markBidInactive(config, listingObjectId, String(parsed.bid_id));
      return;

    case "BidOutbidRefundedEvent":
      await syncListing(adapter, config, listingObjectId);
      await markBidInactive(config, listingObjectId, String(parsed.bid_id));
      return;

    case "ListingSoldEvent":
      await syncListing(adapter, config, listingObjectId);
      await markBidInactive(config, listingObjectId, String(parsed.bid_id));
      return;

    default:
      return;
  }
}

/** Polls a single event query/cursor pair one page forward, processing everything it
 * returns. Returns the resume cursor to use next time — same "advance whenever any progress
 * was made, regardless of hasNextPage" reasoning as before (see the git history of this
 * file for the bug that taught that lesson): `hasNextPage: false` only means no *more* pages
 * beyond this one right now, not that this page had nothing worth remembering. */
async function pollOnce(
  client: SuiJsonRpcClient,
  adapter: SuiAdapter,
  config: SuiIndexerConfig,
  query: Parameters<SuiJsonRpcClient["queryEvents"]>[0]["query"],
  cursor: SuiEventCursor | null
): Promise<{ processedCount: number; nextCursor: SuiEventCursor | null; hasNextPage: boolean }> {
  const page = await client.queryEvents({ query, cursor, limit: 50, order: "ascending" });
  for (const event of page.data) {
    await processEvent(client, adapter, config, event);
  }
  return {
    processedCount: page.data.length,
    nextCursor: page.data.length > 0 && page.nextCursor ? page.nextCursor : cursor,
    hasNextPage: page.hasNextPage,
  };
}

export async function runSuiListener(config: SuiIndexerConfig): Promise<never> {
  const client = new SuiJsonRpcClient({ network: "testnet", url: config.rpcUrl });
  const adapter = new SuiAdapter({
    packageId: config.packageId,
    client,
    protocolStateId: config.protocolStateId,
    usdcCoinType: config.usdcCoinType,
  });

  const existingCursor = await prisma.indexerCursor.findUnique({ where: { chain: config.prismaChain } });
  const parsedCursor = existingCursor?.lastEventCursor ? (JSON.parse(existingCursor.lastEventCursor) as SuiCombinedCursor) : null;
  let agentExchangeCursor: SuiEventCursor | null = parsedCursor?.agentExchange ?? null;
  let jobCompletedCursor: SuiEventCursor | null = parsedCursor?.jobCompleted ?? null;
  let agentRegisteredCursor: SuiEventCursor | null = parsedCursor?.agentRegistered ?? null;

  console.log(
    `[indexer:sui] starting — agent_exchange cursor: ${agentExchangeCursor ? JSON.stringify(agentExchangeCursor) : "(genesis)"}, ` +
      `JobCompleted cursor: ${jobCompletedCursor ? JSON.stringify(jobCompletedCursor) : "(genesis)"}, ` +
      `AgentRegistered cursor: ${agentRegisteredCursor ? JSON.stringify(agentRegisteredCursor) : "(genesis)"}`
  );

  for (;;) {
    const agentExchangeResult = await pollOnce(
      client,
      adapter,
      config,
      { MoveEventModule: { package: config.packageId, module: "agent_exchange" } },
      agentExchangeCursor
    );
    const jobCompletedResult = await pollOnce(
      client,
      adapter,
      config,
      { MoveEventType: `${config.packageId}::marketplace::JobCompletedEvent` },
      jobCompletedCursor
    );
    const agentRegisteredResult = await pollOnce(
      client,
      adapter,
      config,
      { MoveEventType: `${config.packageId}::registry::AgentRegisteredEvent` },
      agentRegisteredCursor
    );

    const totalProcessed = agentExchangeResult.processedCount + jobCompletedResult.processedCount + agentRegisteredResult.processedCount;
    if (totalProcessed > 0) {
      console.log(
        `[indexer:sui] processed ${agentExchangeResult.processedCount} agent_exchange event(s), ` +
          `${jobCompletedResult.processedCount} JobCompleted event(s), ` +
          `${agentRegisteredResult.processedCount} AgentRegistered event(s)`
      );
    }

    agentExchangeCursor = agentExchangeResult.nextCursor;
    jobCompletedCursor = jobCompletedResult.nextCursor;
    agentRegisteredCursor = agentRegisteredResult.nextCursor;

    if (totalProcessed > 0) {
      const combined: SuiCombinedCursor = {
        agentExchange: agentExchangeCursor,
        jobCompleted: jobCompletedCursor,
        agentRegistered: agentRegisteredCursor,
      };
      await prisma.indexerCursor.upsert({
        where: { chain: config.prismaChain },
        create: { chain: config.prismaChain, lastEventCursor: JSON.stringify(combined) },
        update: { lastEventCursor: JSON.stringify(combined) },
      });
    }

    if (!agentExchangeResult.hasNextPage && !jobCompletedResult.hasNextPage && !agentRegisteredResult.hasNextPage) {
      await sleep(POLL_INTERVAL_MS);
    }
  }
}
