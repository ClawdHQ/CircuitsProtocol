import { createPublicClient, createWalletClient, http, parseAbi, parseEventLogs, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { clawdHQAgentExchangeAbi, clawdHQCoreAbi, clawdHQCrossChainIdentityAbi, clawdHQGovernorAbi, clawdHQLaunchpadAbi } from "@clawdhq/sdk";
import { computeFairValue, type AgentTier } from "@clawdhq/valuation";
import { ListingMode, ListingStatus, ProposalCategory, ProposalState, prisma } from "@clawdhq/marketplace-db";
import {
  provisionAgentWallet,
  getOrCreateRegistrarWallet,
  getDecryptedRegistrarWallet,
  advancePipelineForJobOutcome,
  viemChainFor,
  rpcUrlFor,
  type EvmPrismaChain,
} from "@clawdhq/custody-core";
import { LOG_BATCH_BLOCKS, POLL_INTERVAL_MS, type EvmChainIndexerConfig } from "../config.js";
import { recordPendingRelay } from "../relayers/crossChainIdentity.js";

/** apps/web's `getOnChainAgentOwner` casts the other direction (marketplace-db's Chain ->
 * custody-db's Chain) for the same reason: these are deliberately duplicated enums with
 * identical string values but distinct nominal TS types across every *-db package (see each
 * schema.prisma's "keep in sync by hand" comment) — a straight `as unknown as` is the
 * established, intentional way to cross that boundary, not a type-safety gap being papered
 * over. */
function toCustodyChain(chain: EvmChainIndexerConfig["prismaChain"]): EvmPrismaChain {
  return chain as unknown as EvmPrismaChain;
}

function toListingMode(mode: number): ListingMode {
  return mode === 1 ? ListingMode.AUCTION : ListingMode.OPEN;
}

function toListingStatus(status: number): ListingStatus {
  const byIndex = [ListingStatus.ACTIVE, ListingStatus.SOLD, ListingStatus.CANCELLED, ListingStatus.EXPIRED];
  return byIndex[status] ?? ListingStatus.ACTIVE;
}

function toDateTime(unixSeconds: bigint): Date {
  return new Date(Number(unixSeconds) * 1000);
}

// Matches ClawdHQGovernor.sol's `category` uint8 ordering exactly (0=Parameters,1=Treasury,
// 2=Upgrade,3=Skill,4=Other — same order as the frontend's CATEGORY_STYLE map).
function toProposalCategory(category: number): ProposalCategory {
  const byIndex = [ProposalCategory.PARAMETERS, ProposalCategory.TREASURY, ProposalCategory.UPGRADE, ProposalCategory.SKILL, ProposalCategory.OTHER];
  return byIndex[category] ?? ProposalCategory.OTHER;
}

// Matches ClawdHQGovernor.sol's ProposalState enum ordering exactly.
function toProposalState(state: number): ProposalState {
  const byIndex = [
    ProposalState.ACTIVE,
    ProposalState.SUCCEEDED,
    ProposalState.DEFEATED,
    ProposalState.QUORUM_NOT_MET,
    ProposalState.CANCELED,
    ProposalState.EXECUTED,
  ];
  return byIndex[state] ?? ProposalState.ACTIVE;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Re-reads a listing's full current state directly from the contract and upserts it — the
 * indexer treats events purely as "something about this id changed, go re-sync it" triggers
 * rather than trying to reconstruct state incrementally from each event's own arguments.
 * That's simpler and more robust: there's exactly one code path that writes a Listing row,
 * and it can never drift from what's actually on-chain at read time. */
async function syncListing(publicClient: PublicClient, config: EvmChainIndexerConfig, listingId: bigint): Promise<void> {
  const listing = (await publicClient.readContract({
    address: config.exchangeAddress,
    abi: clawdHQAgentExchangeAbi,
    functionName: "listings",
    args: [listingId],
  })) as readonly [bigint, bigint, Address, number, number, bigint, bigint, bigint, bigint, bigint, bigint];

  const [, agentId, seller, mode, status, fairValueSnapshotUsdc, reservePriceUsdc, endTime, highestBidId, createdAt, updatedAt] = listing;
  if (createdAt === 0n) return; // listingId never existed on this contract (defensive; shouldn't happen for a real event)

  await prisma.listing.upsert({
    where: { chain_chainListingId: { chain: config.prismaChain, chainListingId: listingId.toString() } },
    create: {
      chain: config.prismaChain,
      chainListingId: listingId.toString(),
      agentChainId: agentId.toString(),
      seller,
      mode: toListingMode(mode),
      status: toListingStatus(status),
      fairValueSnapshotUsdc,
      reservePriceUsdc,
      endTime: endTime === 0n ? null : toDateTime(endTime),
      highestBidChainId: highestBidId === 0n ? null : highestBidId.toString(),
      createdAtChain: toDateTime(createdAt),
      updatedAtChain: toDateTime(updatedAt),
    },
    update: {
      status: toListingStatus(status),
      endTime: endTime === 0n ? null : toDateTime(endTime),
      highestBidChainId: highestBidId === 0n ? null : highestBidId.toString(),
      updatedAtChain: toDateTime(updatedAt),
    },
  });
}

async function syncBid(publicClient: PublicClient, config: EvmChainIndexerConfig, bidId: bigint): Promise<void> {
  const bid = (await publicClient.readContract({
    address: config.exchangeAddress,
    abi: clawdHQAgentExchangeAbi,
    functionName: "bids",
    args: [bidId],
  })) as readonly [bigint, bigint, Address, bigint, boolean, bigint];

  const [, listingId, bidder, amountUsdc, active, createdAt] = bid;
  if (createdAt === 0n) return;

  const listing = await prisma.listing.findUnique({
    where: { chain_chainListingId: { chain: config.prismaChain, chainListingId: listingId.toString() } },
  });
  if (!listing) {
    // The listing's own event is always emitted at or before any bid on it, but batches are
    // processed together, so make sure it exists before inserting a bid that references it.
    await syncListing(publicClient, config, listingId);
  }
  const listingDbId = (
    await prisma.listing.findUniqueOrThrow({
      where: { chain_chainListingId: { chain: config.prismaChain, chainListingId: listingId.toString() } },
    })
  ).id;

  await prisma.bid.upsert({
    where: { chain_listingDbId_chainBidId: { chain: config.prismaChain, listingDbId, chainBidId: bidId.toString() } },
    create: {
      chain: config.prismaChain,
      chainBidId: bidId.toString(),
      listingDbId,
      bidder,
      amountUsdc,
      active,
      createdAtChain: toDateTime(createdAt),
    },
    update: { active, amountUsdc },
  });
}

async function syncAgentValuation(publicClient: PublicClient, config: EvmChainIndexerConfig, agentId: bigint): Promise<void> {
  const card = (await publicClient.readContract({
    address: config.coreAddress,
    abi: clawdHQCoreAbi,
    functionName: "agents",
    args: [agentId],
  })) as readonly [
    bigint, Address, string, string, string, `0x${string}`, boolean, boolean, boolean, boolean, number, bigint, bigint, bigint, number, number, bigint, number,
  ];
  // AgentCard layout: agentId, owner, name, agentURI, endpoint, metadataHash, supportsX402,
  // supportsA2A, supportsMCP, active, tier, createdAt, updatedAt, lastJobAt, jobsCompleted,
  // jobsFailed, usdcRevenue, reputationBps.
  const [, , , , , , supportsX402, supportsA2A, supportsMCP, , tier, , , lastJobAt, , , usdcRevenue, reputationBps] = card;

  const result = computeFairValue({
    usdcRevenue,
    tier: tier as AgentTier,
    reputationBps,
    lastJobAtSeconds: Number(lastJobAt),
    supportsX402,
    supportsA2A,
    supportsMcp: supportsMCP,
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
    update: {
      fairValueUsdc: result.fairValueUsdc,
      formulaVersion: result.formulaVersion,
    },
  });
}

/** Re-reads a governance proposal's full current state directly from the contract and
 * upserts it — same "event is purely a resync trigger" convention as syncListing above, needed
 * here because a proposal's `state`/`votesFor`/`votesAgainst` keep changing after creation
 * (every VoteCast, and ProposalCanceled/ProposalExecuted). No-ops if this chain has no
 * ClawdHQGovernor deployed yet. */
interface GovernorProposalStruct {
  id: bigint;
  proposer: Address;
  proposerAgentId: bigint;
  category: number;
  title: string;
  description: string;
  startTime: bigint;
  endTime: bigint;
  quorumRequired: bigint;
  votesFor: bigint;
  votesAgainst: bigint;
  canceled: boolean;
  executed: boolean;
}

async function syncProposal(publicClient: PublicClient, config: EvmChainIndexerConfig, proposalId: bigint): Promise<void> {
  if (!config.governorAddress) return;
  const governorAddress = config.governorAddress;

  // Unlike `agents()`/`listings()` (public mapping getters with several unnamed positional
  // return values, decoded by viem as an array), `getProposal` has a single named-struct
  // return value — viem decodes that as a plain keyed object, not a tuple.
  const [proposal, state] = await Promise.all([
    publicClient.readContract({
      address: governorAddress,
      abi: clawdHQGovernorAbi,
      functionName: "getProposal",
      args: [proposalId],
    }) as Promise<GovernorProposalStruct>,
    publicClient.readContract({
      address: governorAddress,
      abi: clawdHQGovernorAbi,
      functionName: "state",
      args: [proposalId],
    }) as Promise<number>,
  ]);

  const { proposer, proposerAgentId, category, title, description, startTime, endTime, quorumRequired, votesFor, votesAgainst } = proposal;

  await prisma.governanceProposal.upsert({
    where: { chain_chainProposalId: { chain: config.prismaChain, chainProposalId: proposalId.toString() } },
    create: {
      chain: config.prismaChain,
      chainProposalId: proposalId.toString(),
      proposer,
      proposerAgentChainId: proposerAgentId.toString(),
      category: toProposalCategory(category),
      title,
      description,
      state: toProposalState(state),
      startTime: toDateTime(startTime),
      endTime: toDateTime(endTime),
      quorumRequired,
      votesFor,
      votesAgainst,
      createdAtChain: toDateTime(startTime), // no separate on-chain creation timestamp; startTime doubles as it
      updatedAtChain: new Date(),
    },
    update: {
      state: toProposalState(state),
      votesFor,
      votesAgainst,
      updatedAtChain: new Date(),
    },
  });
}

/** Unlike syncListing/syncBid, this writes a GovernanceVote row directly from the `VoteCast`
 * event's own arguments rather than re-reading the contract — there is no per-vote getter on
 * ClawdHQGovernor (only the aggregated `votesFor`/`votesAgainst` on the Proposal itself, which
 * syncProposal already re-reads), and a cast vote's own fields (support/weight) never change
 * after the fact, so there is nothing for a later resync to correct. Requires the parent
 * proposal's row to already exist — `processBatch` always syncs proposals before votes. */
async function syncVote(config: EvmChainIndexerConfig, args: { proposalId: bigint; agentId: bigint; voter: Address; support: boolean; weight: bigint }, blockTimestamp: bigint): Promise<void> {
  const proposal = await prisma.governanceProposal.findUnique({
    where: { chain_chainProposalId: { chain: config.prismaChain, chainProposalId: args.proposalId.toString() } },
  });
  if (!proposal) return; // defensive; syncProposal for this id already ran earlier in the same batch

  await prisma.governanceVote.upsert({
    where: {
      chain_proposalDbId_voterAgentChainId: { chain: config.prismaChain, proposalDbId: proposal.id, voterAgentChainId: args.agentId.toString() },
    },
    create: {
      chain: config.prismaChain,
      proposalDbId: proposal.id,
      voterAgentChainId: args.agentId.toString(),
      voter: args.voter,
      support: args.support,
      weight: args.weight,
      createdAtChain: toDateTime(blockTimestamp),
    },
    update: {},
  });
}

/** Direct-from-event write, same reasoning as syncVote: a trade is immutable once it happens —
 * there's no per-trade getter on ClawdHQLaunchpad to resync from, and nothing about a past
 * buy/sell ever changes. Upserts on (chain, txHash, logIndex) so re-processing the same block
 * range on a restart is a no-op rather than a duplicate row. */
async function syncTrade(
  config: EvmChainIndexerConfig,
  args: { launchId: bigint; trader: Address; side: "BUY" | "SELL"; tokenAmount: bigint; usdcAmount: bigint; txHash: string; logIndex: number },
  blockTimestamp: bigint,
): Promise<void> {
  await prisma.launchTrade.upsert({
    where: { chain_txHash_logIndex: { chain: config.prismaChain, txHash: args.txHash, logIndex: args.logIndex } },
    create: {
      chain: config.prismaChain,
      launchChainId: args.launchId.toString(),
      traderAddress: args.trader,
      side: args.side,
      tokenAmount: args.tokenAmount,
      usdcAmount: args.usdcAmount,
      txHash: args.txHash,
      logIndex: args.logIndex,
      createdAtChain: toDateTime(blockTimestamp),
    },
    update: {},
  });
}

const AGENT_WALLET_REGISTRY_ABI = parseAbi([
  "function agentWallet(uint256 agentId) view returns (address)",
  "function setAgentWallet(uint256 agentId, address wallet) external",
]);

/** Provisions an agent's canonical custodied wallet (custody-core's AgentWallet, generated
 * off-chain) and binds it on-chain via AgentWalletRegistry.sol's registrar-gated
 * `setAgentWallet` — a separate contract from ClawdHQCore (see AgentWalletRegistry.sol's doc
 * comment for why), which ClawdHQCore's `_payoutAddress` reads from at job-payout/launchpad-
 * creator-allocation time. No-ops if this chain has no registry deployed yet. Idempotent both
 * off-chain (provisionAgentWallet) and on-chain (a read-first check, plus setAgentWallet
 * itself reverts on a second call) — safe to re-run over the same event on a restart/replay or
 * from a historical-backfill script. */
async function provisionAgentWalletOnChain(publicClient: PublicClient, config: EvmChainIndexerConfig, agentId: bigint): Promise<void> {
  if (!config.agentWalletRegistryAddress) return;
  const registryAddress = config.agentWalletRegistryAddress;
  const custodyChain = toCustodyChain(config.prismaChain);

  const existingWallet = (await publicClient.readContract({
    address: registryAddress,
    abi: AGENT_WALLET_REGISTRY_ABI,
    functionName: "agentWallet",
    args: [agentId],
  })) as Address;
  if (existingWallet !== "0x0000000000000000000000000000000000000000") return; // already set on-chain

  const custodyWallet = await provisionAgentWallet(custodyChain, agentId.toString());

  await getOrCreateRegistrarWallet(custodyChain);
  const registrar = await getDecryptedRegistrarWallet(custodyChain);
  if (!registrar) {
    console.error(`[indexer:${config.chain}] could not load a RegistrarWallet for ${custodyChain} — cannot set agent ${agentId}'s wallet on-chain`);
    return;
  }

  const account = privateKeyToAccount(registrar.privateKey as `0x${string}`);
  const walletClient = createWalletClient({ account, chain: viemChainFor(custodyChain), transport: http(rpcUrlFor(custodyChain)) });

  try {
    const hash = await walletClient.writeContract({
      address: registryAddress,
      abi: AGENT_WALLET_REGISTRY_ABI,
      functionName: "setAgentWallet",
      args: [agentId, custodyWallet.address as Address],
      account,
      chain: viemChainFor(custodyChain),
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`[indexer:${config.chain}] agent ${agentId} wallet set on-chain: ${custodyWallet.address}`);
  } catch (err) {
    // Most likely a benign race (another process's call already landed between our read-first
    // check and this write, so the contract's own WalletAlreadySet revert fired) rather than a
    // failure worth crashing the batch over.
    console.error(`[indexer:${config.chain}] setAgentWallet(${agentId}) failed:`, err instanceof Error ? err.message : err);
  }
}

async function processBatch(publicClient: PublicClient, config: EvmChainIndexerConfig, fromBlock: bigint, toBlock: bigint): Promise<void> {
  const [exchangeLogsRaw, coreLogsRaw, crossChainIdentityLogsRaw, governorLogsRaw, launchpadLogsRaw] = await Promise.all([
    publicClient.getLogs({ address: config.exchangeAddress, fromBlock, toBlock }),
    publicClient.getLogs({ address: config.coreAddress, fromBlock, toBlock }),
    config.crossChainIdentityAddress
      ? publicClient.getLogs({ address: config.crossChainIdentityAddress, fromBlock, toBlock })
      : Promise.resolve([]),
    config.governorAddress ? publicClient.getLogs({ address: config.governorAddress, fromBlock, toBlock }) : Promise.resolve([]),
    publicClient.getLogs({ address: config.launchpadAddress, fromBlock, toBlock }),
  ]);

  const exchangeEvents = parseEventLogs({ abi: clawdHQAgentExchangeAbi, logs: exchangeLogsRaw });
  const coreEvents = parseEventLogs({ abi: clawdHQCoreAbi, logs: coreLogsRaw });
  const crossChainIdentityEvents = parseEventLogs({ abi: clawdHQCrossChainIdentityAbi, logs: crossChainIdentityLogsRaw });
  const governorEvents = parseEventLogs({ abi: clawdHQGovernorAbi, logs: governorLogsRaw });
  const launchpadEvents = parseEventLogs({ abi: clawdHQLaunchpadAbi, logs: launchpadLogsRaw });

  // Every `LinkRegistered` means `registerLink` sent one or more CCTP messages out — record a
  // pending relay so runCrossChainIdentityRelayer (a separate loop; see main.ts) picks it up.
  // Tracked at transaction granularity, not per-event: see recordPendingRelay's doc comment.
  const linkRegisteredTxHashes = new Set(
    crossChainIdentityEvents.filter((event) => event.eventName === "LinkRegistered").map((event) => event.transactionHash)
  );
  for (const txHash of linkRegisteredTxHashes) {
    await recordPendingRelay(config.prismaChain, txHash);
  }

  const dirtyListingIds = new Set<bigint>();
  const dirtyBidIds = new Set<bigint>();
  for (const event of exchangeEvents) {
    const args = event.args as Record<string, unknown>;
    if (typeof args.listingId === "bigint") dirtyListingIds.add(args.listingId);
    if (typeof args.bidId === "bigint") dirtyBidIds.add(args.bidId);
  }

  const dirtyAgentIds = new Set<bigint>();
  const newlyRegisteredAgentIds = new Set<bigint>();
  // A pipeline step's tracked job reaching a terminal on-chain outcome — keyed by jobId (a
  // given jobId only ever reaches one terminal state once, so last-write-in-batch is fine).
  const pipelineJobOutcomes = new Map<bigint, "completed" | "failed">();
  for (const event of coreEvents) {
    if (event.eventName === "JobCompleted") {
      const args = event.args as Record<string, unknown>;
      if (typeof args.agentId === "bigint") dirtyAgentIds.add(args.agentId);
      if (typeof args.jobId === "bigint") pipelineJobOutcomes.set(args.jobId, "completed");
    }
    if (event.eventName === "JobCancelled") {
      const args = event.args as Record<string, unknown>;
      if (typeof args.jobId === "bigint") pipelineJobOutcomes.set(args.jobId, "failed");
    }
    if (event.eventName === "DisputeResolved") {
      const args = event.args as Record<string, unknown>;
      if (typeof args.jobId === "bigint") pipelineJobOutcomes.set(args.jobId, args.releasedToAgent ? "completed" : "failed");
    }
    if (event.eventName === "AgentRegistered") {
      const args = event.args as Record<string, unknown>;
      if (typeof args.agentId === "bigint") newlyRegisteredAgentIds.add(args.agentId);
    }
  }

  const dirtyProposalIds = new Set<bigint>();
  const voteCastEvents: { proposalId: bigint; agentId: bigint; voter: Address; support: boolean; weight: bigint; blockNumber: bigint }[] = [];
  for (const event of governorEvents) {
    const args = event.args as Record<string, unknown>;
    if (event.eventName === "ProposalCreated" || event.eventName === "ProposalCanceled" || event.eventName === "ProposalExecuted") {
      if (typeof args.id === "bigint") dirtyProposalIds.add(args.id);
    }
    if (event.eventName === "VoteCast" && typeof args.proposalId === "bigint") {
      dirtyProposalIds.add(args.proposalId);
      voteCastEvents.push({
        proposalId: args.proposalId,
        agentId: args.agentId as bigint,
        voter: args.voter as Address,
        support: args.support as boolean,
        weight: args.weight as bigint,
        blockNumber: event.blockNumber,
      });
    }
  }

  const tradeEvents: { launchId: bigint; trader: Address; side: "BUY" | "SELL"; tokenAmount: bigint; usdcAmount: bigint; txHash: string; logIndex: number; blockNumber: bigint }[] = [];
  for (const event of launchpadEvents) {
    const args = event.args as Record<string, unknown>;
    if (event.eventName === "TokensPurchased" && typeof args.launchId === "bigint") {
      tradeEvents.push({
        launchId: args.launchId,
        trader: args.buyer as Address,
        side: "BUY",
        tokenAmount: args.tokensOut as bigint,
        usdcAmount: args.usdcIn as bigint,
        txHash: event.transactionHash,
        logIndex: event.logIndex,
        blockNumber: event.blockNumber,
      });
    }
    if (event.eventName === "TokensSold" && typeof args.launchId === "bigint") {
      tradeEvents.push({
        launchId: args.launchId,
        trader: args.seller as Address,
        side: "SELL",
        tokenAmount: args.tokensIn as bigint,
        usdcAmount: args.usdcOut as bigint,
        txHash: event.transactionHash,
        logIndex: event.logIndex,
        blockNumber: event.blockNumber,
      });
    }
  }

  // Listings before bids: syncBid looks up its parent listing's DB row. Same reasoning for
  // proposals before votes.
  for (const listingId of dirtyListingIds) await syncListing(publicClient, config, listingId);
  for (const bidId of dirtyBidIds) await syncBid(publicClient, config, bidId);
  for (const agentId of dirtyAgentIds) await syncAgentValuation(publicClient, config, agentId);
  for (const proposalId of dirtyProposalIds) await syncProposal(publicClient, config, proposalId);
  const voteBlockTimestamps = new Map<bigint, bigint>();
  for (const vote of voteCastEvents) {
    if (!voteBlockTimestamps.has(vote.blockNumber)) {
      const block = await publicClient.getBlock({ blockNumber: vote.blockNumber });
      voteBlockTimestamps.set(vote.blockNumber, block.timestamp);
    }
    await syncVote(config, vote, voteBlockTimestamps.get(vote.blockNumber)!);
  }
  const tradeBlockTimestamps = new Map<bigint, bigint>();
  for (const trade of tradeEvents) {
    if (!tradeBlockTimestamps.has(trade.blockNumber)) {
      const block = await publicClient.getBlock({ blockNumber: trade.blockNumber });
      tradeBlockTimestamps.set(trade.blockNumber, block.timestamp);
    }
    await syncTrade(config, trade, tradeBlockTimestamps.get(trade.blockNumber)!);
  }
  for (const agentId of newlyRegisteredAgentIds) await provisionAgentWalletOnChain(publicClient, config, agentId);
  for (const [jobId, outcome] of pipelineJobOutcomes) {
    try {
      await advancePipelineForJobOutcome(toCustodyChain(config.prismaChain), jobId.toString(), outcome);
    } catch (err) {
      // Not fatal to the batch — same "one thing failing shouldn't stop the rest of this
      // tick's processing" reasoning as scheduler.ts's per-subscription catch.
      console.error(`[indexer:${config.chain}] advancePipelineForJobOutcome(${jobId}, ${outcome}) failed:`, err instanceof Error ? err.message : err);
    }
  }

  if (exchangeEvents.length > 0 || coreEvents.length > 0 || crossChainIdentityEvents.length > 0 || governorEvents.length > 0) {
    console.log(
      `[indexer:${config.chain}] blocks ${fromBlock}-${toBlock}: ${exchangeEvents.length} exchange event(s), ` +
        `${dirtyListingIds.size} listing(s), ${dirtyBidIds.size} bid(s), ${dirtyAgentIds.size} valuation(s) resynced, ` +
        `${newlyRegisteredAgentIds.size} agent wallet(s) provisioned, ${linkRegisteredTxHashes.size} cross-chain link(s) queued for relay, ` +
        `${dirtyProposalIds.size} proposal(s) resynced, ${voteCastEvents.length} vote(s) recorded`
    );
  }
}

/** Runs forever, polling both contracts' logs in bounded block-range batches and persisting
 * a resume cursor after each batch so a restart never re-scans from genesis or silently
 * skips a range. */
export async function runEvmListener(config: EvmChainIndexerConfig): Promise<never> {
  const publicClient = createPublicClient({ transport: http(config.rpcUrl) });

  const cursor = await prisma.indexerCursor.findUnique({ where: { chain: config.prismaChain } });
  let fromBlock = cursor?.lastBlock ?? config.fromBlock;

  console.log(`[indexer:${config.chain}] starting from block ${fromBlock}`);

  for (;;) {
    const latest = await publicClient.getBlockNumber();
    if (fromBlock > latest) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const toBlock = fromBlock + LOG_BATCH_BLOCKS - 1n > latest ? latest : fromBlock + LOG_BATCH_BLOCKS - 1n;
    await processBatch(publicClient, config, fromBlock, toBlock);

    await prisma.indexerCursor.upsert({
      where: { chain: config.prismaChain },
      create: { chain: config.prismaChain, lastBlock: toBlock + 1n },
      update: { lastBlock: toBlock + 1n },
    });
    fromBlock = toBlock + 1n;

    if (toBlock >= latest) await sleep(POLL_INTERVAL_MS);
  }
}
