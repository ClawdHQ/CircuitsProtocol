// @coral-xyz/anchor ships genuinely different builds per environment: a CommonJS build for
// Node (no static named exports Node's own ESM loader can detect for BN/Program — breaks a
// plain named import under raw Node ESM, e.g. apps/indexer) and a browser ESM build with
// *only* named exports and no default at all (a static `import anchorPkg from "..."` fails
// there instead — that's what bundlers like Turbopack/webpack resolve `apps/web` to). There
// is no single static import statement both environments agree on, so this reads whichever
// shape is actually present at runtime via a namespace import: Node's CJS interop exposes
// `.default` (the real CJS `module.exports`); the browser ESM build has no `.default`, so
// its named exports are already directly on the namespace object.
import * as anchorNamespace from "@coral-xyz/anchor";
import type { AnchorProvider, Idl, Program as ProgramType } from "@coral-xyz/anchor";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, type Connection } from "@solana/web3.js";
import { createHash } from "node:crypto";
import clawdhqAgentIdl from "../abi/clawdhq-agent.idl.json" with { type: "json" };
import type { ProtocolStats } from "../types.js";

const anchorPkg = "default" in anchorNamespace ? (anchorNamespace as unknown as { default: typeof anchorNamespace }).default : anchorNamespace;
const { BN, Program } = anchorPkg;
type Program = ProgramType;

const PROTOCOL_SEED = Buffer.from("protocol");
const AGENT_SEED = Buffer.from("agent");
const JOB_SEED = Buffer.from("job");
const LAUNCH_SEED = Buffer.from("launch");
const BUYER_POSITION_SEED = Buffer.from("buyer_position");
const NAME_SEED = Buffer.from("name");
const LISTING_SEED = Buffer.from("listing");
const BID_SEED = Buffer.from("bid");
const ACTIVE_LISTING_SEED = Buffer.from("active_listing");

const le = (n: number | bigint): Buffer => new BN(n.toString()).toArrayLike(Buffer, "le", 8);
const sha256 = (input: Buffer): Buffer => createHash("sha256").update(input).digest();

interface UntypedAccountNamespace {
  [account: string]: {
    fetch: (address: PublicKey) => Promise<Record<string, unknown>>;
    all: (filters?: { memcmp: { offset: number; bytes: string } }[]) => Promise<{ account: Record<string, unknown> }[]>;
  };
}

export interface SolanaAdapterConfig {
  programId: string;
  connection: Connection;
  provider: AnchorProvider;
  usdcMint: PublicKey;
  /** Owner of the protocol's USDC fee account. Unlike EVM/Sui, this program can't
   * resolve the treasury's token account from on-chain state alone — the instruction
   * takes it as an explicit account, so the adapter needs the owner up front. */
  treasuryAddress?: PublicKey;
}

/** Talks to the `clawdhq_agent` Anchor program on Solana Devnet. */
export class SolanaAdapter {
  readonly program: Program;
  readonly programId: PublicKey;
  readonly usdcMint: PublicKey;
  readonly protocolState: PublicKey;
  readonly vault: PublicKey;
  readonly treasuryUsdcAta: PublicKey | undefined;

  constructor(config: SolanaAdapterConfig) {
    this.programId = new PublicKey(config.programId);
    this.program = new Program(clawdhqAgentIdl as Idl, config.provider);
    this.usdcMint = config.usdcMint;
    [this.protocolState] = PublicKey.findProgramAddressSync([PROTOCOL_SEED], this.programId);
    this.vault = getAssociatedTokenAddressSync(this.usdcMint, this.protocolState, true);
    this.treasuryUsdcAta = config.treasuryAddress
      ? getAssociatedTokenAddressSync(this.usdcMint, config.treasuryAddress)
      : undefined;
  }

  private requireTreasuryUsdcAta(): PublicKey {
    if (!this.treasuryUsdcAta) {
      throw new Error("SolanaAdapter: treasuryAddress was not configured, cannot resolve treasury USDC account.");
    }
    return this.treasuryUsdcAta;
  }

  /** Mirrors `payout_authority` in clawdhq_agent's lib.rs: the agent's registered
   * `agentWallet` if set, otherwise its `owner`. `agentWallet` decodes to `PublicKey.default`
   * (32 zero bytes) when unset — Rust's `Pubkey::default()` sentinel, same convention as
   * EVM's `address(0)`. */
  private payoutAuthorityFor(agent: Record<string, unknown>): PublicKey {
    const wallet = agent.agentWallet as PublicKey;
    return wallet.equals(PublicKey.default) ? (agent.owner as PublicKey) : wallet;
  }

  agentPda(agentId: number | bigint): PublicKey {
    return PublicKey.findProgramAddressSync([AGENT_SEED, le(agentId)], this.programId)[0];
  }

  jobPda(jobId: number | bigint): PublicKey {
    return PublicKey.findProgramAddressSync([JOB_SEED, le(jobId)], this.programId)[0];
  }

  launchPda(launchId: number | bigint): PublicKey {
    return PublicKey.findProgramAddressSync([LAUNCH_SEED, le(launchId)], this.programId)[0];
  }

  namePda(name: string): PublicKey {
    return PublicKey.findProgramAddressSync([NAME_SEED, sha256(Buffer.from(name))], this.programId)[0];
  }

  buyerPositionPda(launchId: number | bigint, buyer: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync([BUYER_POSITION_SEED, le(launchId), buyer.toBuffer()], this.programId)[0];
  }

  listingPda(listingId: number | bigint): PublicKey {
    return PublicKey.findProgramAddressSync([LISTING_SEED, le(listingId)], this.programId)[0];
  }

  bidPda(bidId: number | bigint): PublicKey {
    return PublicKey.findProgramAddressSync([BID_SEED, le(bidId)], this.programId)[0];
  }

  activeListingMarkerPda(agentId: number | bigint): PublicKey {
    return PublicKey.findProgramAddressSync([ACTIVE_LISTING_SEED, le(agentId)], this.programId)[0];
  }

  async registerAgent(args: {
    owner: PublicKey;
    agentId: number;
    name: string;
    agentUri: string;
    endpoint: string;
    metadataHash: number[];
    supportsX402: boolean;
    supportsA2A: boolean;
    supportsMcp: boolean;
  }): Promise<string> {
    const ownerUsdcAta = getAssociatedTokenAddressSync(this.usdcMint, args.owner);
    return this.program.methods
      .registerAgent(args.name, args.agentUri, args.endpoint, args.metadataHash, args.supportsX402, args.supportsA2A, args.supportsMcp)
      .accountsPartial({
        owner: args.owner,
        agentState: this.agentPda(args.agentId),
        nameRecord: this.namePda(args.name),
        usdcMint: this.usdcMint,
        ownerUsdcAta,
        vault: this.vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async postJob(args: {
    employer: PublicKey;
    employerAgentId: number;
    hiredAgentId: number;
    jobId: number;
    taskHash: number[];
    budget: bigint;
    deadline: bigint;
  }): Promise<string> {
    const employerUsdcAta = getAssociatedTokenAddressSync(this.usdcMint, args.employer);
    return this.program.methods
      .postJob(new BN(args.employerAgentId), new BN(args.hiredAgentId), args.taskHash, new BN(args.budget.toString()), new BN(args.deadline.toString()))
      .accountsPartial({
        employer: args.employer,
        hiredAgent: this.agentPda(args.hiredAgentId),
        jobState: this.jobPda(args.jobId),
        usdcMint: this.usdcMint,
        employerUsdcAta,
        vault: this.vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async acceptJob(agentOwner: PublicKey, agentId: number, jobId: number): Promise<string> {
    return this.program.methods
      .acceptJob()
      .accountsPartial({ agentOwner, agentState: this.agentPda(agentId), jobState: this.jobPda(jobId) })
      .rpc();
  }

  async submitDeliverable(agentOwner: PublicKey, agentId: number, jobId: number, deliverableHash: number[]): Promise<string> {
    return this.program.methods
      .submitDeliverable(deliverableHash)
      .accountsPartial({ agentOwner, agentState: this.agentPda(agentId), jobState: this.jobPda(jobId) })
      .rpc();
  }

  async confirmDelivery(args: { employer: PublicKey; agentId: number; jobId: number; rating: number }): Promise<string> {
    const agent = await this.getAgent(args.agentId);
    const payoutAuthority = this.payoutAuthorityFor(agent);
    const agentPayoutUsdcAta = getAssociatedTokenAddressSync(this.usdcMint, payoutAuthority);
    return this.program.methods
      .confirmDelivery(args.rating)
      .accountsPartial({
        employer: args.employer,
        agentState: this.agentPda(args.agentId),
        jobState: this.jobPda(args.jobId),
        usdcMint: this.usdcMint,
        vault: this.vault,
        agentPayoutAuthority: payoutAuthority,
        agentPayoutUsdcAta,
        treasuryUsdcAta: this.requireTreasuryUsdcAta(),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
  }

  async cancelJob(args: { employer: PublicKey; jobId: number }): Promise<string> {
    const employerUsdcAta = getAssociatedTokenAddressSync(this.usdcMint, args.employer);
    return this.program.methods
      .cancelJob()
      .accountsPartial({
        employer: args.employer,
        jobState: this.jobPda(args.jobId),
        usdcMint: this.usdcMint,
        employerUsdcAta,
        vault: this.vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
  }

  /** `agent_state`'s PDA seed depends on the job's `hired_agent_id`, which Anchor's TS
   * client can't auto-derive without first decoding the job account — so this fetches
   * the job to learn which agent is hired before building the instruction. */
  async disputeJob(args: { signer: PublicKey; jobId: number }): Promise<string> {
    const job = await this.getJob(args.jobId);
    const hiredAgentId = Number((job.hiredAgentId as { toString(): string }).toString());
    return this.program.methods
      .disputeJob()
      .accountsPartial({
        signer: args.signer,
        agentState: this.agentPda(hiredAgentId),
        jobState: this.jobPda(args.jobId),
      })
      .rpc();
  }

  /** `token_mint` has no PDA seeds (Anchor's `mint::decimals`/`mint::authority`
   * constraints just set up the new account, they don't derive its address) so the new
   * mint keypair must co-sign alongside the connected wallet — pass the full `Keypair`,
   * not just its public key, or the `init` will fail with a missing-signature error. */
  async createLaunch(args: {
    creator: PublicKey;
    agentId: number;
    launchId: number;
    name: string;
    symbol: string;
    creatorAllocBps: number;
    tokenMint: Keypair;
  }): Promise<string> {
    const agent = await this.getAgent(args.agentId);
    const payoutAuthority = this.payoutAuthorityFor(agent);
    const tokenMintPubkey = args.tokenMint.publicKey;
    const launchReserve = getAssociatedTokenAddressSync(tokenMintPubkey, this.launchPda(args.launchId), true);
    const creatorTokenAta = getAssociatedTokenAddressSync(tokenMintPubkey, payoutAuthority);
    const creatorUsdcAta = getAssociatedTokenAddressSync(this.usdcMint, args.creator);
    return this.program.methods
      .createLaunch(args.name, args.symbol, args.creatorAllocBps)
      .accountsPartial({
        creator: args.creator,
        agentState: this.agentPda(args.agentId),
        launchState: this.launchPda(args.launchId),
        tokenMint: tokenMintPubkey,
        launchReserve,
        agentPayoutAuthority: payoutAuthority,
        creatorTokenAta,
        usdcMint: this.usdcMint,
        creatorUsdcAta,
        vault: this.vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([args.tokenMint])
      .rpc();
  }

  async buyTokens(args: {
    buyer: PublicKey;
    launchId: number;
    tokenMint: PublicKey;
    usdcAmount: bigint;
    minTokensOut: bigint;
  }): Promise<string> {
    const buyerUsdcAta = getAssociatedTokenAddressSync(this.usdcMint, args.buyer);
    const buyerTokenAta = getAssociatedTokenAddressSync(args.tokenMint, args.buyer);
    const launchReserve = getAssociatedTokenAddressSync(args.tokenMint, this.launchPda(args.launchId), true);
    return this.program.methods
      .buyTokens(new BN(args.usdcAmount.toString()), new BN(args.minTokensOut.toString()))
      .accountsPartial({
        buyer: args.buyer,
        launchState: this.launchPda(args.launchId),
        buyerPosition: this.buyerPositionPda(args.launchId, args.buyer),
        usdcMint: this.usdcMint,
        buyerUsdcAta,
        vault: this.vault,
        tokenMint: args.tokenMint,
        launchReserve,
        buyerTokenAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async sellTokens(args: {
    seller: PublicKey;
    launchId: number;
    tokenMint: PublicKey;
    tokenAmount: bigint;
    minUsdcOut: bigint;
  }): Promise<string> {
    const sellerUsdcAta = getAssociatedTokenAddressSync(this.usdcMint, args.seller);
    const sellerTokenAta = getAssociatedTokenAddressSync(args.tokenMint, args.seller);
    const launchReserve = getAssociatedTokenAddressSync(args.tokenMint, this.launchPda(args.launchId), true);
    return this.program.methods
      .sellTokens(new BN(args.tokenAmount.toString()), new BN(args.minUsdcOut.toString()))
      .accountsPartial({
        seller: args.seller,
        launchState: this.launchPda(args.launchId),
        usdcMint: this.usdcMint,
        sellerUsdcAta,
        vault: this.vault,
        treasuryUsdcAta: this.requireTreasuryUsdcAta(),
        sellerTokenAta,
        launchReserve,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
  }

  async graduateLaunch(launchId: number): Promise<string> {
    return this.program.methods.graduateLaunch().accountsPartial({ launchState: this.launchPda(launchId) }).rpc();
  }

  /** Transfers an agent's ownership directly, peer-to-peer, outside the exchange. */
  async transferAgentOwnership(owner: PublicKey, agentId: number, newOwner: PublicKey): Promise<string> {
    return this.program.methods
      .transferAgentOwnership(newOwner)
      .accountsPartial({ owner, agentState: this.agentPda(agentId) })
      .rpc();
  }

  /** One-time-settable: binds `agentId` to its off-chain-provisioned custodied wallet.
   * Requires the registrar signer — called by the indexer's privileged wallet (see
   * registrarCustody.ts), never by an agent's own owner. */
  async setAgentWallet(registrar: PublicKey, agentId: number, wallet: PublicKey): Promise<string> {
    return this.program.methods
      .setAgentWallet(new BN(agentId), wallet)
      .accountsPartial({ registrar, protocolState: this.protocolState, agentState: this.agentPda(agentId) })
      .rpc();
  }

  /** Rotates the authorized registrar signer — protocol-admin only. */
  async setRegistrar(authority: PublicKey, newRegistrar: PublicKey): Promise<string> {
    return this.program.methods
      .setRegistrar(newRegistrar)
      .accountsPartial({ authority, protocolState: this.protocolState })
      .rpc();
  }

  // ==================================================== Agent exchange =====
  // NFT-style ownership marketplace, separate from the job-hiring escrow above. Unlike the
  // EVM exchange, there is no separate "approval" step: since the exchange instructions live
  // in this same program, `createListing` verifies `agent_state.owner == seller` directly —
  // see clawdhq_agent's lib.rs for the full non-custodial invariant this relies on.

  /** `mode`: 0 = Open (no expiry, seller accepts any bid at any time), 1 = Auction (fixed
   * `endTime`, strictly increasing bids, permissionless `settleAuction` at expiry). Open
   * listings must pass `endTime: 0` and `reservePrice: 0n`; Auction listings must pass an
   * `endTime` in the future. Reads `ProtocolState.nextListingId` to derive the listing PDA,
   * so callers should treat the current value as stale immediately after this resolves. */
  async createListing(args: {
    seller: PublicKey;
    agentId: number;
    mode: 0 | 1;
    fairValueSnapshot: bigint;
    reservePrice: bigint;
    endTime: number;
  }): Promise<{ signature: string; listingId: number }> {
    const protocol = await this.getProtocolStateRaw();
    const listingId = Number(protocol.nextListingId);
    const signature = await this.program.methods
      .createListing(
        args.mode === 1 ? { auction: {} } : { open: {} },
        new BN(args.fairValueSnapshot.toString()),
        new BN(args.reservePrice.toString()),
        new BN(args.endTime)
      )
      .accountsPartial({
        seller: args.seller,
        agentState: this.agentPda(args.agentId),
        listingState: this.listingPda(listingId),
        activeListingMarker: this.activeListingMarkerPda(args.agentId),
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    return { signature, listingId };
  }

  /** Only succeeds for a listing with no bids yet; an Auction with a bid must run to expiry. */
  async cancelListing(seller: PublicKey, listingId: number, agentId: number): Promise<string> {
    return this.program.methods
      .cancelListing()
      .accountsPartial({
        seller,
        listingState: this.listingPda(listingId),
        activeListingMarker: this.activeListingMarkerPda(agentId),
      })
      .rpc();
  }

  /** `previousHighestBidId`: pass the listing's current `highestBidId` when placing a bid
   * against an Auction that already has one (the previous bidder is refunded atomically);
   * omit it for Open bids or a listing's first Auction bid. */
  async placeBid(args: {
    bidder: PublicKey;
    listingId: number;
    amount: bigint;
    previousHighestBidId?: number;
  }): Promise<{ signature: string; bidId: number }> {
    const protocol = await this.getProtocolStateRaw();
    const bidId = Number(protocol.nextBidId);
    const bidderUsdcAta = getAssociatedTokenAddressSync(this.usdcMint, args.bidder);

    const accounts: Record<string, unknown> = {
      bidder: args.bidder,
      listingState: this.listingPda(args.listingId),
      bidState: this.bidPda(bidId),
      usdcMint: this.usdcMint,
      bidderUsdcAta,
      vault: this.vault,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      previousHighestBid: null,
      previousHighestBidderUsdcAta: null,
    };
    if (args.previousHighestBidId !== undefined) {
      const previousBid = await this.getBid(args.previousHighestBidId);
      accounts.previousHighestBid = this.bidPda(args.previousHighestBidId);
      accounts.previousHighestBidderUsdcAta = getAssociatedTokenAddressSync(this.usdcMint, previousBid.bidder as PublicKey);
    }

    // Anchor's generated .accountsPartial() types expect `undefined` for an omitted optional
    // account, but its JS client accepts `null` at runtime too (verified against the actual
    // program in clawdhq_agent's Anchor test suite) — this dynamically-built object doesn't
    // match the generated per-instruction type either way, hence the escape hatch.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const signature = await this.program.methods.placeBid(new BN(args.amount.toString())).accountsPartial(accounts as any).rpc();
    return { signature, bidId };
  }

  /** Always allowed for Open-listing bids and non-highest Auction bids. The current-highest
   * Auction bid is locked until the auction's `endTime` passes or it settles. */
  async withdrawBid(bidder: PublicKey, bidId: number, listingId: number): Promise<string> {
    const bidderUsdcAta = getAssociatedTokenAddressSync(this.usdcMint, bidder);
    return this.program.methods
      .withdrawBid()
      .accountsPartial({
        bidder,
        protocolState: this.protocolState,
        listingState: this.listingPda(listingId),
        bidState: this.bidPda(bidId),
        usdcMint: this.usdcMint,
        bidderUsdcAta,
        vault: this.vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
  }

  /** Seller-only, Open-mode listings only. */
  async acceptBid(args: { seller: PublicKey; agentId: number; listingId: number; bidId: number }): Promise<string> {
    const sellerUsdcAta = getAssociatedTokenAddressSync(this.usdcMint, args.seller);
    return this.program.methods
      .acceptBid()
      .accountsPartial({
        seller: args.seller,
        agentState: this.agentPda(args.agentId),
        listingState: this.listingPda(args.listingId),
        bidState: this.bidPda(args.bidId),
        activeListingMarker: this.activeListingMarkerPda(args.agentId),
        usdcMint: this.usdcMint,
        sellerUsdcAta,
        vault: this.vault,
        treasuryUsdcAta: this.requireTreasuryUsdcAta(),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
  }

  /** Permissionless — callable by anyone once the auction's `endTime` has passed. Pass
   * `highestBidId`/`sellerAddress` from the fetched `ListingState` when it has a highest
   * bid; omit both to settle a no-bid auction as expired. */
  async settleAuction(args: {
    agentId: number;
    listingId: number;
    highestBidId?: number;
    sellerAddress?: PublicKey;
  }): Promise<string> {
    const accounts: Record<string, unknown> = {
      protocolState: this.protocolState,
      agentState: this.agentPda(args.agentId),
      listingState: this.listingPda(args.listingId),
      activeListingMarker: this.activeListingMarkerPda(args.agentId),
      usdcMint: this.usdcMint,
      vault: this.vault,
      treasuryUsdcAta: this.requireTreasuryUsdcAta(),
      tokenProgram: TOKEN_PROGRAM_ID,
      highestBid: null,
      sellerUsdcAta: null,
    };
    if (args.highestBidId !== undefined && args.sellerAddress) {
      accounts.highestBid = this.bidPda(args.highestBidId);
      accounts.sellerUsdcAta = getAssociatedTokenAddressSync(this.usdcMint, args.sellerAddress);
    }
    // See placeBid's comment: Anchor's client accepts `null` for an omitted optional account
    // at runtime, but its generated types expect `undefined`, so this needs the same escape hatch.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.program.methods.settleAuction().accountsPartial(accounts as any).rpc();
  }

  async getListing(listingId: number): Promise<Record<string, unknown>> {
    return (this.program.account as UntypedAccountNamespace).listingState.fetch(this.listingPda(listingId));
  }

  /** Unfiltered `.all()` — there's no cheaper way to enumerate every listing on Solana (no
   * `getLogs`-style bounded-range query exists for account state), so an indexer polling this
   * treats each cycle as a full resync rather than an incremental one. Fine at this
   * deployment's scale; would need a real changed-since filter (or a log-subscription-based
   * design) if the listing count grew large. */
  async getAllListings(): Promise<Record<string, unknown>[]> {
    const accounts = await (this.program.account as UntypedAccountNamespace).listingState.all();
    return (accounts as { account: Record<string, unknown> }[]).map((entry) => entry.account);
  }

  async getBid(bidId: number): Promise<Record<string, unknown>> {
    return (this.program.account as UntypedAccountNamespace).bidState.fetch(this.bidPda(bidId));
  }

  async getAllBids(): Promise<Record<string, unknown>[]> {
    const accounts = await (this.program.account as UntypedAccountNamespace).bidState.all();
    return (accounts as { account: Record<string, unknown> }[]).map((entry) => entry.account);
  }

  async getAgent(agentId: number): Promise<Record<string, unknown>> {
    return (this.program.account as UntypedAccountNamespace).agentState.fetch(this.agentPda(agentId));
  }

  /** `AgentState.owner` sits right after the 8-byte Anchor discriminator and the
   * 8-byte `agent_id: u64` field, i.e. at byte offset 16. */
  async getAgentsByOwner(owner: PublicKey): Promise<Record<string, unknown>[]> {
    const accounts = await (this.program.account as UntypedAccountNamespace).agentState.all([
      { memcmp: { offset: 16, bytes: owner.toBase58() } },
    ]);
    return (accounts as { account: Record<string, unknown> }[]).map((entry) => entry.account);
  }

  async getAllAgents(): Promise<Record<string, unknown>[]> {
    const accounts = await (this.program.account as UntypedAccountNamespace).agentState.all();
    return (accounts as { account: Record<string, unknown> }[]).map((entry) => entry.account);
  }

  async getJob(jobId: number): Promise<Record<string, unknown>> {
    return (this.program.account as UntypedAccountNamespace).jobState.fetch(this.jobPda(jobId));
  }

  async getLaunch(launchId: number): Promise<Record<string, unknown>> {
    return (this.program.account as UntypedAccountNamespace).launchState.fetch(this.launchPda(launchId));
  }

  async getProtocolStats(): Promise<ProtocolStats> {
    const state = await this.getProtocolStateRaw();
    const asBigInt = (value: unknown): bigint => BigInt((value as { toString(): string }).toString());
    return {
      totalAgents: asBigInt(state.totalAgents),
      activeAgents: asBigInt(state.activeAgents),
      totalJobs: asBigInt(state.totalJobs),
      totalVolume: asBigInt(state.totalVolume),
      totalLaunches: asBigInt(state.totalLaunches),
      graduatedLaunches: asBigInt(state.graduatedLaunches),
    };
  }

  /** The full `ProtocolState` account, including counters (`nextListingId`/`nextBidId`/etc)
   * `getProtocolStats`'s `ProtocolStats` projection deliberately omits. */
  private async getProtocolStateRaw(): Promise<Record<string, unknown>> {
    return (this.program.account as UntypedAccountNamespace).protocolState.fetch(this.protocolState);
  }
}
