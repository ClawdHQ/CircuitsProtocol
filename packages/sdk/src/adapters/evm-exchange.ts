import { getContract, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { clawdHQAgentExchangeAbi } from "../abi/index.js";
import type { BidSummary, ListingSummary } from "../types.js";
import { ensureErc20Allowance } from "./erc20.js";

export interface EvmAgentExchangeAdapterConfig {
  contractAddress: Address;
  publicClient: PublicClient;
  walletClient?: WalletClient;
}

interface UntypedContract {
  read: Record<string, (args?: readonly unknown[]) => Promise<unknown>>;
  write: Record<string, (args?: readonly unknown[]) => Promise<Hex>>;
}

/** Talks to the `ClawdHQAgentExchange` contract — the NFT-style agent ownership marketplace,
 * a separate contract from `ClawdHQCore`'s job-hiring marketplace (see `EvmAdapter`). Callers
 * must first approve this contract on Core via `EvmAdapter.approveAgentExchange` before
 * {createListing} will succeed. */
export class EvmAgentExchangeAdapter {
  private readonly contract: UntypedContract;
  private readonly contractAddress: Address;
  private readonly publicClient: PublicClient;
  private readonly walletClient?: WalletClient;
  private usdcAddress: Address | undefined;

  constructor(config: EvmAgentExchangeAdapterConfig) {
    this.contractAddress = config.contractAddress;
    this.publicClient = config.publicClient;
    this.walletClient = config.walletClient;
    this.contract = getContract({
      address: config.contractAddress,
      abi: clawdHQAgentExchangeAbi,
      client: { public: config.publicClient, wallet: config.walletClient },
    }) as unknown as UntypedContract;
  }

  private async ensureUsdcAllowance(owner: Address, amount: bigint): Promise<void> {
    if (amount === 0n) return;
    if (!this.usdcAddress) {
      this.usdcAddress = (await this.contract.read.usdc([])) as Address;
    }
    await ensureErc20Allowance(
      { public: this.publicClient, wallet: this.walletClient },
      this.usdcAddress,
      owner,
      this.contractAddress,
      amount
    );
  }

  private getSenderAddress(): Address {
    const address = this.walletClient?.account?.address;
    if (!address) throw new Error("EvmAgentExchangeAdapter: no connected wallet account to send this transaction from.");
    return address;
  }

  async getListing(listingId: bigint): Promise<ListingSummary> {
    const listing = (await this.contract.read.listings([listingId])) as unknown as readonly [
      bigint, bigint, Address, number, number, bigint, bigint, bigint, bigint, bigint, bigint,
    ];
    return {
      listingId: listing[0].toString(),
      agentId: listing[1].toString(),
      seller: listing[2],
      mode: listing[3],
      status: listing[4],
      fairValueSnapshotUsdc: listing[5],
      reservePriceUsdc: listing[6],
      endTime: listing[7],
      highestBidId: listing[8].toString(),
    };
  }

  async getBid(bidId: bigint): Promise<BidSummary> {
    const bid = (await this.contract.read.bids([bidId])) as unknown as readonly [bigint, bigint, Address, bigint, boolean, bigint];
    return {
      bidId: bid[0].toString(),
      listingId: bid[1].toString(),
      bidder: bid[2],
      amountUsdc: bid[3],
      active: bid[4],
    };
  }

  async getActiveListingIdForAgent(agentId: bigint): Promise<bigint> {
    return (await this.contract.read.activeListingIdByAgentId([agentId])) as bigint;
  }

  /** `mode`: 0 = Open (no expiry, seller accepts any bid at any time), 1 = Auction (fixed
   * `endTime`, strictly increasing bids, permissionless {settleAuction} at expiry). Open
   * listings must pass `endTime: 0n` and `reservePriceUsdc: 0n`; Auction listings must pass
   * an `endTime` in the future. */
  async createListing(args: {
    agentId: bigint;
    mode: number;
    fairValueSnapshotUsdc: bigint;
    reservePriceUsdc: bigint;
    endTime: bigint;
  }): Promise<Hex> {
    return this.contract.write.createListing([
      args.agentId,
      args.mode,
      args.fairValueSnapshotUsdc,
      args.reservePriceUsdc,
      args.endTime,
    ]) as Promise<Hex>;
  }

  /** Only succeeds for a listing with no bids yet; an Auction with a bid must run to expiry. */
  async cancelListing(listingId: bigint): Promise<Hex> {
    return this.contract.write.cancelListing([listingId]) as Promise<Hex>;
  }

  async placeBid(listingId: bigint, amountUsdc: bigint): Promise<Hex> {
    await this.ensureUsdcAllowance(this.getSenderAddress(), amountUsdc);
    return this.contract.write.placeBid([listingId, amountUsdc]) as Promise<Hex>;
  }

  /** Always allowed for Open-listing bids and non-highest Auction bids. The current-highest
   * Auction bid is locked until the auction's `endTime` passes or it settles. */
  async withdrawBid(bidId: bigint): Promise<Hex> {
    return this.contract.write.withdrawBid([bidId]) as Promise<Hex>;
  }

  /** Seller-only, Open-mode listings only. */
  async acceptBid(listingId: bigint, bidId: bigint): Promise<Hex> {
    return this.contract.write.acceptBid([listingId, bidId]) as Promise<Hex>;
  }

  /** Permissionless — callable by anyone once the auction's `endTime` has passed. */
  async settleAuction(listingId: bigint): Promise<Hex> {
    return this.contract.write.settleAuction([listingId]) as Promise<Hex>;
  }
}
