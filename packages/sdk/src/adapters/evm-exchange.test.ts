import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { EvmAgentExchangeAdapter } from "./evm-exchange.js";

const EXCHANGE_ADDRESS = "0x1111111111111111111111111111111111111111".slice(0, 42) as Address;
const USDC_ADDRESS = "0x2222222222222222222222222222222222222222".slice(0, 42) as Address;
const SENDER = "0x3333333333333333333333333333333333333333".slice(0, 42) as Address;

interface RecordedCall {
  functionName: string;
  args?: readonly unknown[];
}

/** A minimal fake PublicClient/WalletClient pair that records every `readContract`/
 * `writeContract` call and returns canned results by function name. Passed into the real
 * viem `getContract`, so ABI encoding/decoding is exercised for real — only the actual RPC
 * transport is faked — which is what makes this a meaningful check that
 * `EvmAgentExchangeAdapter`'s argument order and tuple-decoding match the real ABI, not
 * just that the adapter calls *some* function. */
function buildFakeClients(readResults: Record<string, unknown>) {
  const readCalls: RecordedCall[] = [];
  const writeCalls: RecordedCall[] = [];

  const publicClient = {
    async readContract(args: { functionName: string; args?: readonly unknown[] }) {
      readCalls.push({ functionName: args.functionName, args: args.args });
      if (!(args.functionName in readResults)) {
        throw new Error(`No canned result for readContract(${args.functionName})`);
      }
      return readResults[args.functionName];
    },
  };

  const walletClient = {
    account: { address: SENDER },
    async writeContract(args: { functionName: string; args?: readonly unknown[] }) {
      writeCalls.push({ functionName: args.functionName, args: args.args });
      return "0xhash";
    },
  };

  return { publicClient, walletClient, readCalls, writeCalls };
}

describe("EvmAgentExchangeAdapter", () => {
  describe("getListing", () => {
    it("maps the listings() tuple to named fields in the correct positional order", async () => {
      const { publicClient, walletClient } = buildFakeClients({
        listings: [7n, 3n, SENDER, 1, 0, 100_000_000n, 50_000_000n, 9_999n, 2n, 111n, 222n],
      });
      const adapter = new EvmAgentExchangeAdapter({
        contractAddress: EXCHANGE_ADDRESS,
        publicClient: publicClient as never,
        walletClient: walletClient as never,
      });

      const listing = await adapter.getListing(7n);
      expect(listing).toEqual({
        listingId: "7",
        agentId: "3",
        seller: SENDER,
        mode: 1, // Auction
        status: 0, // Active
        fairValueSnapshotUsdc: 100_000_000n,
        reservePriceUsdc: 50_000_000n,
        endTime: 9_999n,
        highestBidId: "2",
      });
    });
  });

  describe("getBid", () => {
    it("maps the bids() tuple to named fields in the correct positional order", async () => {
      const { publicClient, walletClient } = buildFakeClients({
        bids: [2n, 7n, SENDER, 60_000_000n, true, 333n],
      });
      const adapter = new EvmAgentExchangeAdapter({
        contractAddress: EXCHANGE_ADDRESS,
        publicClient: publicClient as never,
        walletClient: walletClient as never,
      });

      const bid = await adapter.getBid(2n);
      expect(bid).toEqual({
        bidId: "2",
        listingId: "7",
        bidder: SENDER,
        amountUsdc: 60_000_000n,
        active: true,
      });
    });
  });

  describe("write methods", () => {
    it("createListing passes arguments in (agentId, mode, fairValue, reserve, endTime) order", async () => {
      const { publicClient, walletClient, writeCalls } = buildFakeClients({});
      const adapter = new EvmAgentExchangeAdapter({
        contractAddress: EXCHANGE_ADDRESS,
        publicClient: publicClient as never,
        walletClient: walletClient as never,
      });

      await adapter.createListing({ agentId: 3n, mode: 0, fairValueSnapshotUsdc: 100n, reservePriceUsdc: 0n, endTime: 0n });

      expect(writeCalls).toHaveLength(1);
      expect(writeCalls[0].functionName).toBe("createListing");
      expect(writeCalls[0].args).toEqual([3n, 0, 100n, 0n, 0n]);
    });

    it("placeBid checks the USDC allowance before bidding, and approves if insufficient", async () => {
      const { publicClient, walletClient, readCalls, writeCalls } = buildFakeClients({
        usdc: USDC_ADDRESS,
        allowance: 0n, // insufficient -> adapter must call approve before placeBid
      });
      const adapter = new EvmAgentExchangeAdapter({
        contractAddress: EXCHANGE_ADDRESS,
        publicClient: publicClient as never,
        walletClient: walletClient as never,
      });

      await adapter.placeBid(1n, 60_000_000n);

      expect(readCalls.map((c) => c.functionName)).toEqual(["usdc", "allowance"]);
      expect(writeCalls.map((c) => c.functionName)).toEqual(["approve", "placeBid"]);
      expect(writeCalls[0].args).toEqual([EXCHANGE_ADDRESS, 60_000_000n]);
      expect(writeCalls[1].args).toEqual([1n, 60_000_000n]);
    });

    it("placeBid skips the approval call when the existing allowance is already sufficient", async () => {
      const { publicClient, walletClient, writeCalls } = buildFakeClients({
        usdc: USDC_ADDRESS,
        allowance: 1_000_000_000n,
      });
      const adapter = new EvmAgentExchangeAdapter({
        contractAddress: EXCHANGE_ADDRESS,
        publicClient: publicClient as never,
        walletClient: walletClient as never,
      });

      await adapter.placeBid(1n, 60_000_000n);
      expect(writeCalls.map((c) => c.functionName)).toEqual(["placeBid"]);
    });

    it("acceptBid, settleAuction, withdrawBid, and cancelListing each call the matching contract function with a single id argument", async () => {
      const { publicClient, walletClient, writeCalls } = buildFakeClients({});
      const adapter = new EvmAgentExchangeAdapter({
        contractAddress: EXCHANGE_ADDRESS,
        publicClient: publicClient as never,
        walletClient: walletClient as never,
      });

      await adapter.acceptBid(1n, 2n);
      await adapter.settleAuction(1n);
      await adapter.withdrawBid(2n);
      await adapter.cancelListing(1n);

      expect(writeCalls).toEqual([
        { functionName: "acceptBid", args: [1n, 2n] },
        { functionName: "settleAuction", args: [1n] },
        { functionName: "withdrawBid", args: [2n] },
        { functionName: "cancelListing", args: [1n] },
      ]);
    });
  });
});
