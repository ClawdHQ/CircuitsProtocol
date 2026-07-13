import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import type { ProtocolStats } from "../types.js";

export interface SuiAdapterConfig {
  packageId: string;
  client: SuiJsonRpcClient;
  protocolStateId: string;
  usdcCoinType: string;
}

/** Builds PTBs against the `clawdhq_agent` Move package's `registry`, `marketplace`, and
 * `launchpad` modules. Callers are responsible for signing and executing the returned
 * `Transaction` (e.g. via a wallet's `signAndExecuteTransaction`). */
export class SuiAdapter {
  readonly packageId: string;
  readonly protocolStateId: string;
  readonly usdcCoinType: string;
  private readonly client: SuiJsonRpcClient;

  constructor(config: SuiAdapterConfig) {
    this.packageId = config.packageId;
    this.protocolStateId = config.protocolStateId;
    this.usdcCoinType = config.usdcCoinType;
    this.client = config.client;
  }

  private target(module: string, fn: string): `${string}::${string}::${string}` {
    return `${this.packageId}::${module}::${fn}`;
  }

  /** Shares the resulting `Agent` rather than transferring it to the caller: `post_job` needs
   * to be callable by an arbitrary employer, `place_bid`/`create_listing`/etc. by an arbitrary
   * bidder — none of whom could ever reference an object owned by someone else. `owner` stays
   * the actual authorization mechanism throughout (every function that used to require
   * caller-equals-object-owner now checks `agent.owner == ctx.sender()` instead) — confirmed
   * empirically against a live local network, where transferring instead of sharing made
   * `post_job` uncallable by anyone but the agent's own owner (i.e. only self-hire worked). */
  registerAgent(args: {
    name: string;
    agentUri: string;
    endpoint: string;
    metadataHash: number[];
    supportsX402: boolean;
    supportsA2A: boolean;
    supportsMcp: boolean;
    feeCoin: string;
  }): Transaction {
    const tx = new Transaction();
    const agent = tx.moveCall({
      target: this.target("registry", "register_agent"),
      arguments: [
        tx.object(this.protocolStateId),
        tx.pure.string(args.name),
        tx.pure.string(args.agentUri),
        tx.pure.string(args.endpoint),
        tx.pure.vector("u8", args.metadataHash),
        tx.pure.bool(args.supportsX402),
        tx.pure.bool(args.supportsA2A),
        tx.pure.bool(args.supportsMcp),
        tx.object(args.feeCoin),
        tx.object.clock(),
      ],
    });
    tx.moveCall({
      target: "0x2::transfer::public_share_object",
      typeArguments: [this.target("registry", "Agent")],
      arguments: [agent],
    });
    return tx;
  }

  /** Peer-to-peer transfer, outside `agent_exchange` — a pure field update (`Agent` is shared,
   * see `registerAgent`'s doc comment, so there's no native custody to move). Blocked while
   * listed; cancel the listing first. */
  transferAgentOwnership(args: { agentId: string; newOwner: string }): Transaction {
    const tx = new Transaction();
    tx.moveCall({
      target: this.target("registry", "transfer_agent_ownership"),
      arguments: [tx.object(args.agentId), tx.pure.address(args.newOwner), tx.object.clock()],
    });
    return tx;
  }

  /** Shares the resulting `Job` rather than transferring it to the caller: `accept_job`/
   * `submit_deliverable` need to be called by the hired agent's owner and `confirm_delivery`/
   * `cancel_job`/`dispute_job` by the employer — two potentially different addresses, neither
   * of which could reference an owned object belonging to the other. None of `marketplace`'s
   * job functions check object custody (they check struct fields like `job.employer`/
   * `agent.owner`), so a shared Job changes no authorization logic — confirmed empirically
   * against a live local network, where transferring instead of sharing silently made
   * `accept_job` uncallable by anyone but the employer itself. */
  postJob(args: {
    hiredAgentId: string;
    employerAgentId: number | bigint;
    taskHash: number[];
    budgetCoin: string;
    deadlineMs: number | bigint;
  }): Transaction {
    const tx = new Transaction();
    const job = tx.moveCall({
      target: this.target("marketplace", "post_job"),
      arguments: [
        tx.object(this.protocolStateId),
        tx.object(args.hiredAgentId),
        tx.pure.u64(args.employerAgentId),
        tx.pure.vector("u8", args.taskHash),
        tx.object(args.budgetCoin),
        tx.pure.u64(args.deadlineMs),
        tx.object.clock(),
      ],
    });
    tx.moveCall({
      target: "0x2::transfer::public_share_object",
      typeArguments: [this.target("marketplace", "Job")],
      arguments: [job],
    });
    return tx;
  }

  acceptJob(jobId: string, agentId: string): Transaction {
    const tx = new Transaction();
    tx.moveCall({
      target: this.target("marketplace", "accept_job"),
      arguments: [tx.object(jobId), tx.object(agentId), tx.object.clock()],
    });
    return tx;
  }

  submitDeliverable(jobId: string, agentId: string, deliverableHash: number[]): Transaction {
    const tx = new Transaction();
    tx.moveCall({
      target: this.target("marketplace", "submit_deliverable"),
      arguments: [tx.object(jobId), tx.object(agentId), tx.pure.vector("u8", deliverableHash)],
    });
    return tx;
  }

  confirmDelivery(args: { jobId: string; agentId: string; rating: number }): Transaction {
    const tx = new Transaction();
    tx.moveCall({
      target: this.target("marketplace", "confirm_delivery"),
      arguments: [
        tx.object(args.jobId),
        tx.object(args.agentId),
        tx.object(this.protocolStateId),
        tx.pure.u8(args.rating),
        tx.object.clock(),
      ],
    });
    return tx;
  }

  cancelJob(jobId: string): Transaction {
    const tx = new Transaction();
    tx.moveCall({ target: this.target("marketplace", "cancel_job"), arguments: [tx.object(jobId)] });
    return tx;
  }

  disputeJob(jobId: string, agentId: string): Transaction {
    const tx = new Transaction();
    tx.moveCall({
      target: this.target("marketplace", "dispute_job"),
      arguments: [tx.object(jobId), tx.object(agentId)],
    });
    return tx;
  }

  /** Shares the resulting `Launch` rather than transferring it to the caller — `buy_tokens`/
   * `sell_tokens`/`graduate_launch` have no signer check at all (by design: anyone can buy
   * into or graduate a launch), so an owned `Launch` would make every buyer except the
   * creator unable to even reference it. Unlike `registerAgent`/`postJob`, the creator's
   * `LaunchPosition` is no longer returned here for the PTB to relay — `create_launch` now
   * transfers it on-chain to `registry::payout_authority(agent)` itself (the agent's
   * registered wallet if set, else its owner), the same fully-contract-enforced trust model
   * `confirmDelivery`'s escrow release already uses, so this adapter never needs to resolve or
   * pass a payout address at all. Also drops `typeArguments`: like `post_job`, none of
   * `create_launch`/`buy_tokens`/`sell_tokens` are actually generic (they take the concrete
   * `Coin<USDC>`, not a type-parameterized `Coin<T>`) — confirmed empirically, passing a type
   * argument to a non-generic function fails PTB resolution. */
  createLaunch(args: { agentId: string; name: string; symbol: string; creatorAllocBps: number; feeCoin: string }): Transaction {
    const tx = new Transaction();
    const launch = tx.moveCall({
      target: this.target("launchpad", "create_launch"),
      arguments: [
        tx.object(this.protocolStateId),
        tx.object(args.agentId),
        tx.pure.string(args.name),
        tx.pure.string(args.symbol),
        tx.pure.u16(args.creatorAllocBps),
        tx.object(args.feeCoin),
        tx.object.clock(),
      ],
    });
    tx.moveCall({
      target: "0x2::transfer::public_share_object",
      typeArguments: [this.target("launchpad", "Launch")],
      arguments: [launch],
    });
    return tx;
  }

  /** One-time-settable: binds `agentId` to its off-chain-provisioned custodied wallet.
   * Requires the registrar signer — called by the indexer's privileged wallet (see
   * registrarCustody.ts), never by an agent's own owner. */
  setAgentWallet(agentId: string, wallet: string): Transaction {
    const tx = new Transaction();
    tx.moveCall({
      target: this.target("registry", "set_agent_wallet"),
      arguments: [tx.object(this.protocolStateId), tx.object(agentId), tx.pure.address(wallet)],
    });
    return tx;
  }

  /** Rotates the authorized registrar signer — protocol-authority only. */
  setRegistrar(newRegistrar: string): Transaction {
    const tx = new Transaction();
    tx.moveCall({
      target: this.target("registry", "set_registrar"),
      arguments: [tx.object(this.protocolStateId), tx.pure.address(newRegistrar)],
    });
    return tx;
  }

  /** When the buyer has no existing `LaunchPosition` for this launch, omit `positionId`
   * and supply `launchNumericId` + `sender` instead — this chains `new_position` and
   * `buy_tokens` into one PTB and transfers the fresh position to the buyer afterward,
   * avoiding a separate up-front "open a position" transaction. */
  buyTokens(args: {
    launchId: string;
    usdcCoin: string;
    minTokensOut: number | bigint;
  } & ({ positionId: string } | { launchNumericId: number | bigint; sender: string })): Transaction {
    const tx = new Transaction();
    const position = "positionId" in args ? tx.object(args.positionId) : this.newPositionCall(tx, args.launchNumericId);
    tx.moveCall({
      target: this.target("launchpad", "buy_tokens"),
      arguments: [tx.object(args.launchId), position, tx.object(args.usdcCoin), tx.pure.u64(args.minTokensOut), tx.object.clock()],
    });
    if (!("positionId" in args)) tx.transferObjects([position], args.sender);
    return tx;
  }

  /** Opens an empty `LaunchPosition` for a launch as its own transaction — useful when
   * the buyer wants to hold a position before ever calling `buy_tokens` (e.g. to merge
   * multiple later), rather than always creating one inline within a buy. */
  newPosition(launchNumericId: number | bigint, sender: string): Transaction {
    const tx = new Transaction();
    const position = this.newPositionCall(tx, launchNumericId);
    tx.transferObjects([position], sender);
    return tx;
  }

  private newPositionCall(tx: Transaction, launchNumericId: number | bigint) {
    return tx.moveCall({
      target: this.target("launchpad", "new_position"),
      arguments: [tx.pure.u64(launchNumericId)],
    });
  }

  sellTokens(args: {
    launchId: string;
    positionId: string;
    tokenAmount: number | bigint;
    minUsdcOut: number | bigint;
    sender: string;
  }): Transaction {
    const tx = new Transaction();
    const payout = tx.moveCall({
      target: this.target("launchpad", "sell_tokens"),
      arguments: [
        tx.object(args.launchId),
        tx.object(args.positionId),
        tx.pure.u64(args.tokenAmount),
        tx.pure.u64(args.minUsdcOut),
        tx.object(this.protocolStateId),
      ],
    });
    tx.transferObjects([payout], args.sender);
    return tx;
  }

  graduateLaunch(launchId: string): Transaction {
    const tx = new Transaction();
    tx.moveCall({
      target: this.target("launchpad", "graduate_launch"),
      arguments: [tx.object(launchId), tx.object(this.protocolStateId), tx.object.clock()],
    });
    return tx;
  }

  /** References `agentId` (never takes custody of it — `Agent` is a normal shared object the
   * whole time it's listed, see `registerAgent`'s doc comment) and creates a fresh shared
   * `Listing` alongside it; unlike `Job`/`Launch`/`Agent` above (each shared by an explicit
   * follow-up `public_share_object` call from this SDK), `agent_exchange::create_listing`
   * shares the Listing internally, in Move — either approach is equally correct (Sui doesn't
   * care which side of the call issues the share), this one just happens to be the newest
   * code and didn't inherit the SDK-side convention the older ones already had. Mode 0 = Open
   * (no expiry/reserve), 1 = Auction. */
  createListing(args: {
    agentId: string;
    mode: number;
    fairValueSnapshot: number | bigint;
    reservePrice: number | bigint;
    endTimeMs: number | bigint;
  }): Transaction {
    const tx = new Transaction();
    tx.moveCall({
      target: this.target("agent_exchange", "create_listing"),
      arguments: [
        tx.object(this.protocolStateId),
        tx.object(args.agentId),
        tx.pure.u8(args.mode),
        tx.pure.u64(args.fairValueSnapshot),
        tx.pure.u64(args.reservePrice),
        tx.pure.u64(args.endTimeMs),
        tx.object.clock(),
      ],
    });
    return tx;
  }

  /** Only allowed while the listing has no bids yet (Open) / no bid at all (Auction) — an
   * Auction with a bid must run to `settleAuction` instead. */
  cancelListing(listingId: string, agentId: string): Transaction {
    const tx = new Transaction();
    tx.moveCall({
      target: this.target("agent_exchange", "cancel_listing"),
      arguments: [tx.object(listingId), tx.object(agentId), tx.object.clock()],
    });
    return tx;
  }

  /** For Auction listings this strictly-increasing bid auto-refunds the previous highest
   * bidder and may push `endTime` back by the anti-snipe window; for Open listings any
   * number of independent bids can sit concurrently. `place_bid` consumes a whole `Coin<USDC>`
   * as the bid amount (there's no separate "spend up to N of this coin" argument), so pass
   * `bidCoin` only if the caller already holds a coin worth exactly the intended bid; more
   * commonly, pass `splitFromCoin` + `amount` to split that exact amount off a larger coin
   * inline, in the same PTB — mirroring `buyTokens`'s existing "pass an id, or build one
   * inline" pattern above. */
  placeBid(args: { listingId: string } & ({ bidCoin: string } | { splitFromCoin: string; amount: bigint })): Transaction {
    const tx = new Transaction();
    const bidCoin = "bidCoin" in args ? tx.object(args.bidCoin) : tx.splitCoins(tx.object(args.splitFromCoin), [args.amount])[0];
    tx.moveCall({
      target: this.target("agent_exchange", "place_bid"),
      arguments: [tx.object(args.listingId), bidCoin, tx.object.clock()],
    });
    return tx;
  }

  /** Always allowed for Open bids and non-highest Auction bids; blocked for the current
   * highest Auction bid while its listing is still active — that bid is locked until the
   * auction's end time passes or someone calls `settleAuction`. */
  withdrawBid(args: { listingId: string; bidId: number | bigint }): Transaction {
    const tx = new Transaction();
    tx.moveCall({
      target: this.target("agent_exchange", "withdraw_bid"),
      arguments: [tx.object(args.listingId), tx.pure.u64(args.bidId), tx.object.clock()],
    });
    return tx;
  }

  /** Open-mode only — the seller can accept any open bid, at any time, above or below the
   * listing's fair-value snapshot. Auction listings only ever settle via `settleAuction`. */
  acceptBid(args: { listingId: string; agentId: string; bidId: number | bigint }): Transaction {
    const tx = new Transaction();
    tx.moveCall({
      target: this.target("agent_exchange", "accept_bid"),
      arguments: [tx.object(args.listingId), tx.object(args.agentId), tx.pure.u64(args.bidId), tx.object(this.protocolStateId), tx.object.clock()],
    });
    return tx;
  }

  /** Permissionless — callable by anyone once the auction's end time has passed, mirroring
   * `autoReleaseExpired`'s precedent since no chain can self-execute at a future timestamp.
   * Settles to the highest bidder if it met the reserve, otherwise expires the listing unsold
   * (the agent was never in the exchange's custody to begin with — see `registerAgent`'s doc
   * comment — so there's nothing to return, only the `active_listing_id` marker to clear). */
  settleAuction(listingId: string, agentId: string): Transaction {
    const tx = new Transaction();
    tx.moveCall({
      target: this.target("agent_exchange", "settle_auction"),
      arguments: [tx.object(listingId), tx.object(agentId), tx.object(this.protocolStateId), tx.object.clock()],
    });
    return tx;
  }

  async getObject(objectId: string) {
    return this.client.getObject({ id: objectId, options: { showContent: true } });
  }

  /** `Agent` is a shared object (see `registerAgent`'s doc comment), so `getOwnedObjects` can
   * never find one — there's no "owned by X" index for shared objects short of an off-chain
   * indexer. Interim mitigation: `AgentRegisteredEvent` gives the universe of every agent ever
   * registered (a discovery mechanism, not an ownership index — ownership can change
   * afterward via `transferAgentOwnership`/a sale), so each candidate's current on-chain state
   * is re-fetched and filtered by its live `owner` field. Correct, but O(agents ever
   * registered) rather than O(agents `owner` holds) — fine while the deployment is small;
   * Phase 6's indexer replaces this with a real query. */
  async getAgentsByOwner(owner: string): Promise<{ objectId: string; fields: Record<string, unknown> }[]> {
    const matches: { objectId: string; fields: Record<string, unknown> }[] = [];
    let cursor: { txDigest: string; eventSeq: string } | null | undefined;
    do {
      const page = await this.client.queryEvents({
        query: { MoveEventType: this.target("registry", "AgentRegisteredEvent") },
        cursor,
        limit: 50,
      });
      const digests = [...new Set(page.data.map((event) => event.id.txDigest))];
      if (digests.length > 0) {
        const blocks = await this.client.multiGetTransactionBlocks({ digests, options: { showObjectChanges: true } });
        for (const block of blocks) {
          const created = block.objectChanges?.find(
            (change) => change.type === "created" && "objectType" in change && change.objectType.includes("::registry::Agent"),
          );
          if (!created || !("objectId" in created)) continue;
          const current = await this.getObject(created.objectId);
          const content = current.data?.content as { fields?: Record<string, unknown> } | undefined;
          if (content?.fields && content.fields.owner === owner) {
            matches.push({ objectId: created.objectId, fields: content.fields });
          }
        }
      }
      cursor = page.hasNextPage ? page.nextCursor : null;
    } while (cursor);
    return matches;
  }

  /** Resolves the numeric `agent_id` (the identifier used everywhere off-chain — indexer DB
   * rows, the cross-chain `agentChainId` convention, `agent_exchange::Listing.agent_id`) to
   * the Agent's actual Sui object id, needed for any read that has to fetch its current
   * on-chain state. Unlike `getAgentsByOwner`'s `owner` filter, `agent_id` is assigned once at
   * registration and never changes, so — like `getJobsByEmployer`'s `employer` — the event's
   * own value can be trusted directly without a live re-check. */
  async getAgentByChainId(agentId: number | bigint): Promise<{ objectId: string; fields: Record<string, unknown> } | undefined> {
    let cursor: { txDigest: string; eventSeq: string } | null | undefined;
    do {
      const page = await this.client.queryEvents({
        query: { MoveEventType: this.target("registry", "AgentRegisteredEvent") },
        cursor,
        limit: 50,
      });
      const match = page.data.find((event) => String((event.parsedJson as { agent_id?: string } | undefined)?.agent_id) === String(agentId));
      if (match) {
        const block = await this.client.getTransactionBlock({ digest: match.id.txDigest, options: { showObjectChanges: true } });
        const created = block.objectChanges?.find(
          (change) => change.type === "created" && "objectType" in change && change.objectType.includes("::registry::Agent"),
        );
        if (created && "objectId" in created) {
          const current = await this.getObject(created.objectId);
          const content = current.data?.content as { fields?: Record<string, unknown> } | undefined;
          if (content?.fields) return { objectId: created.objectId, fields: content.fields };
        }
      }
      cursor = page.hasNextPage ? page.nextCursor : null;
    } while (cursor);
    return undefined;
  }

  /** `Job` is a shared object (see `postJob`'s doc comment), so — like `getAgentsByOwner` —
   * there's no `getOwnedObjects` index for it. Interim mitigation, same shape as
   * `getAgentsByOwner`: walk `JobPostedEvent`s to find every job whose `employer` field
   * matches (that field is set once at creation and never reassigned, unlike an agent's
   * `owner`, so the event's own value can be trusted directly — no live re-check needed)
   * then fetch each match's current object state (`status` etc. change over time). Still
   * can't answer "jobs assigned to my agent" or "all open jobs" without an off-chain indexer
   * watching the same event — Phase 6. */
  async getJobsByEmployer(employer: string): Promise<{ objectId: string; fields: Record<string, unknown> }[]> {
    const matches: { objectId: string; fields: Record<string, unknown> }[] = [];
    let cursor: { txDigest: string; eventSeq: string } | null | undefined;
    do {
      const page = await this.client.queryEvents({
        query: { MoveEventType: this.target("marketplace", "JobPostedEvent") },
        cursor,
        limit: 50,
      });
      const ownEvents = page.data.filter((event) => (event.parsedJson as { employer?: string } | undefined)?.employer === employer);
      const digests = [...new Set(ownEvents.map((event) => event.id.txDigest))];
      if (digests.length > 0) {
        const blocks = await this.client.multiGetTransactionBlocks({ digests, options: { showObjectChanges: true } });
        for (const block of blocks) {
          const created = block.objectChanges?.find(
            (change) => change.type === "created" && "objectType" in change && change.objectType.includes("::marketplace::Job"),
          );
          if (!created || !("objectId" in created)) continue;
          const current = await this.getObject(created.objectId);
          const content = current.data?.content as { fields?: Record<string, unknown> } | undefined;
          if (content?.fields) matches.push({ objectId: created.objectId, fields: content.fields });
        }
      }
      cursor = page.hasNextPage ? page.nextCursor : null;
    } while (cursor);
    return matches;
  }

  /** `Launch` is a shared object (see `createLaunch`'s doc comment), so — like
   * `getAgentsByOwner` — there's no `getOwnedObjects` index for it. Same interim mitigation,
   * and unlike `getJobsByEmployer`, `LaunchCreatedEvent` doesn't carry `creator` at all, so
   * every candidate's current state has to be fetched regardless (not just to guard against
   * staleness) — there's no cheaper event-only path here. `creator` never changes after
   * creation, so what's fetched is always accurate. A global "all launches" browse feed still
   * needs an off-chain indexer — Phase 6. */
  async getLaunchesByCreator(creator: string): Promise<{ objectId: string; fields: Record<string, unknown> }[]> {
    const matches: { objectId: string; fields: Record<string, unknown> }[] = [];
    let cursor: { txDigest: string; eventSeq: string } | null | undefined;
    do {
      const page = await this.client.queryEvents({
        query: { MoveEventType: this.target("launchpad", "LaunchCreatedEvent") },
        cursor,
        limit: 50,
      });
      const digests = [...new Set(page.data.map((event) => event.id.txDigest))];
      if (digests.length > 0) {
        const blocks = await this.client.multiGetTransactionBlocks({ digests, options: { showObjectChanges: true } });
        for (const block of blocks) {
          // endsWith, not includes: `create_launch`'s same transaction also creates a
          // LaunchPosition, whose type string contains "::launchpad::Launch" as a prefix —
          // a substring match picks whichever of the two `objectChanges` happens to sort
          // first, silently returning the wrong object on roughly half of all launches.
          const created = block.objectChanges?.find(
            (change) => change.type === "created" && "objectType" in change && change.objectType.endsWith("::launchpad::Launch"),
          );
          if (!created || !("objectId" in created)) continue;
          const current = await this.getObject(created.objectId);
          const content = current.data?.content as { fields?: Record<string, unknown> } | undefined;
          if (content?.fields && content.fields.creator === creator) {
            matches.push({ objectId: created.objectId, fields: content.fields });
          }
        }
      }
      cursor = page.hasNextPage ? page.nextCursor : null;
    } while (cursor);
    return matches;
  }

  /** Finds the buyer's existing `LaunchPosition` for a specific launch, if any, so the
   * UI can decide whether `buyTokens` needs to open a new position inline. */
  async getPositionForLaunch(owner: string, launchNumericId: number | bigint): Promise<string | undefined> {
    const positions = await this.getOwnedObjectsOfType(owner, "launchpad::LaunchPosition");
    const match = positions.find((p) => String(p.fields.launch_id) === String(launchNumericId));
    return match?.objectId;
  }

  /** `Listing` is a shared object, so — unlike `getAgentsByOwner`/`getJobsByEmployer`/
   * `getLaunchesByCreator` above — there's no owner to index by at all; a global browse
   * feed needs an off-chain indexer watching `ListingCreatedEvent` (Phase 6), same
   * constraint as those. This is a single-listing-by-id lookup only. */
  async getListing(listingId: string): Promise<{ objectId: string; fields: Record<string, unknown> } | undefined> {
    const response = await this.getObject(listingId);
    const content = response.data?.content as { fields?: Record<string, unknown> } | undefined;
    const objectId = response.data?.objectId;
    return objectId && content?.fields ? { objectId, fields: content.fields } : undefined;
  }

  private async getOwnedObjectsOfType(
    owner: string,
    structSuffix: string,
  ): Promise<{ objectId: string; fields: Record<string, unknown> }[]> {
    const response = await this.client.getOwnedObjects({
      owner,
      filter: { StructType: `${this.packageId}::${structSuffix}` },
      options: { showContent: true },
    });
    return response.data
      .map((entry) => {
        const content = entry.data?.content as { fields?: Record<string, unknown> } | undefined;
        const objectId = entry.data?.objectId;
        return objectId && content?.fields ? { objectId, fields: content.fields } : undefined;
      })
      .filter((entry): entry is { objectId: string; fields: Record<string, unknown> } => entry !== undefined);
  }

  async getProtocolStats(): Promise<ProtocolStats> {
    const response = await this.getObject(this.protocolStateId);
    const content = response.data?.content as { fields?: Record<string, unknown> } | undefined;
    const fields = content?.fields ?? {};
    const asBigInt = (value: unknown): bigint => BigInt(typeof value === "string" || typeof value === "number" ? value : 0);
    return {
      totalAgents: asBigInt(fields.total_agents),
      activeAgents: asBigInt(fields.active_agents),
      totalJobs: asBigInt(fields.total_jobs),
      totalVolume: asBigInt(fields.total_volume),
      totalLaunches: asBigInt(fields.total_launches),
      graduatedLaunches: asBigInt(fields.graduated_launches),
    };
  }
}
