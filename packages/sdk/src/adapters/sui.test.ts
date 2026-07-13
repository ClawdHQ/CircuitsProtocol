import { describe, expect, it } from "vitest";
import { SuiAdapter } from "./sui.js";

const PACKAGE_ID = "0x" + "ab".repeat(32);
const PROTOCOL_STATE_ID = "0x" + "cd".repeat(32);
const USDC_COIN_TYPE = `${PACKAGE_ID}::usdc::USDC`;
const SENDER = "0x" + "11".repeat(32);

function buildAdapter(): SuiAdapter {
  return new SuiAdapter({
    packageId: PACKAGE_ID,
    client: {} as never,
    protocolStateId: PROTOCOL_STATE_ID,
    usdcCoinType: USDC_COIN_TYPE,
  });
}

function moveCallOf(tx: { getData: () => { commands: { MoveCall?: { module: string; function: string } }[] } }) {
  const command = tx.getData().commands.find((c) => c.MoveCall);
  if (!command?.MoveCall) throw new Error("expected a MoveCall command");
  return command.MoveCall;
}

function moveCallsOf(tx: { getData: () => { commands: { MoveCall?: { module: string; function: string } }[] } }) {
  return tx.getData().commands.filter((c) => c.MoveCall).map((c) => c.MoveCall!);
}

describe("SuiAdapter PTB construction", () => {
  it("targets registry::register_agent and shares the resulting Agent (not transferred — an arbitrary employer/bidder must be able to reference it later)", () => {
    const adapter = buildAdapter();
    const tx = adapter.registerAgent({
      name: "agent-one",
      agentUri: "ipfs://uri",
      endpoint: "https://endpoint.example",
      metadataHash: new Array(32).fill(0),
      supportsX402: true,
      supportsA2A: true,
      supportsMcp: true,
      feeCoin: "0x" + "22".repeat(32),
    });

    const calls = moveCallsOf(tx);
    expect(calls[0].module).toBe("registry");
    expect(calls[0].function).toBe("register_agent");
    expect(calls[1].function).toBe("public_share_object");
    expect((calls[1] as unknown as { typeArguments: string[] }).typeArguments).toEqual([`${PACKAGE_ID}::registry::Agent`]);
    expect(tx.getData().commands.some((c) => c.$kind === "TransferObjects")).toBe(false);
  });

  it("targets marketplace::post_job (no type arguments — the function isn't generic) and shares the resulting Job", () => {
    const adapter = buildAdapter();
    const tx = adapter.postJob({
      hiredAgentId: "0x" + "33".repeat(32),
      employerAgentId: 0,
      taskHash: new Array(32).fill(1),
      budgetCoin: "0x" + "44".repeat(32),
      deadlineMs: Date.now() + 86_400_000,
    });

    const calls = moveCallsOf(tx);
    expect(calls[0].module).toBe("marketplace");
    expect(calls[0].function).toBe("post_job");
    expect((calls[0] as unknown as { typeArguments: string[] }).typeArguments).toEqual([]);

    // Job must be shared, not transferred to the caller — accept_job/submit_deliverable need
    // to be called by the hired agent's owner and confirm_delivery/cancel_job by the
    // employer, two potentially different addresses that could never reference an owned
    // object belonging to the other.
    expect(calls[1].function).toBe("public_share_object");
    expect((calls[1] as unknown as { typeArguments: string[] }).typeArguments).toEqual([`${PACKAGE_ID}::marketplace::Job`]);
    expect(tx.getData().commands.some((c) => c.$kind === "TransferObjects")).toBe(false);
  });

  it("targets launchpad::create_launch (no type arguments) and shares the resulting Launch — the creator position is transferred on-chain by create_launch itself now, not by this PTB", () => {
    const adapter = buildAdapter();
    const tx = adapter.createLaunch({
      agentId: "0x" + "55".repeat(32),
      name: "Agent Coin",
      symbol: "AGT",
      creatorAllocBps: 1_000,
      feeCoin: "0x" + "66".repeat(32),
    });

    const calls = moveCallsOf(tx);
    expect(calls[0].module).toBe("launchpad");
    expect(calls[0].function).toBe("create_launch");
    expect((calls[0] as unknown as { typeArguments: string[] }).typeArguments).toEqual([]);
    expect(calls[1].function).toBe("public_share_object");
    expect((calls[1] as unknown as { typeArguments: string[] }).typeArguments).toEqual([`${PACKAGE_ID}::launchpad::Launch`]);
    // No client-built TransferObjects for the position: create_launch now transfers it
    // on-chain to registry::payout_authority(agent) itself (see launchpad.move), the same
    // contract-enforced trust model release_escrow already uses for job payouts.
    expect(tx.getData().commands.some((c) => c.$kind === "TransferObjects")).toBe(false);
  });

  it("targets launchpad::graduate_launch against the configured protocol state", () => {
    const adapter = buildAdapter();
    const tx = adapter.graduateLaunch("0x" + "77".repeat(32));
    const moveCall = moveCallOf(tx);
    expect(moveCall.module).toBe("launchpad");
    expect(moveCall.function).toBe("graduate_launch");
  });

  it("buyTokens with an existing positionId calls buy_tokens directly, with no extra MoveCall", () => {
    const adapter = buildAdapter();
    const tx = adapter.buyTokens({
      launchId: "0x" + "88".repeat(32),
      positionId: "0x" + "99".repeat(32),
      usdcCoin: "0x" + "aa".repeat(32),
      minTokensOut: 1,
    });
    const calls = moveCallsOf(tx);
    expect(calls).toHaveLength(1);
    expect(calls[0].function).toBe("buy_tokens");
  });

  it("buyTokens without a positionId opens one inline via new_position, then transfers it to the sender", () => {
    const adapter = buildAdapter();
    const tx = adapter.buyTokens({
      launchId: "0x" + "88".repeat(32),
      launchNumericId: 3,
      sender: SENDER,
      usdcCoin: "0x" + "aa".repeat(32),
      minTokensOut: 1,
    });
    const calls = moveCallsOf(tx);
    expect(calls.map((c) => c.function)).toEqual(["new_position", "buy_tokens"]);
    expect(tx.getData().commands.some((c) => c.$kind === "TransferObjects")).toBe(true);
  });

  it("newPosition targets launchpad::new_position and transfers the result to the sender", () => {
    const adapter = buildAdapter();
    const tx = adapter.newPosition(3, SENDER);
    const moveCall = moveCallOf(tx);
    expect(moveCall.module).toBe("launchpad");
    expect(moveCall.function).toBe("new_position");
    expect(tx.getData().commands.some((c) => c.$kind === "TransferObjects")).toBe(true);
  });

  it("transferAgentOwnership targets registry::transfer_agent_ownership with no extra transfer command", () => {
    const adapter = buildAdapter();
    const tx = adapter.transferAgentOwnership({ agentId: "0x" + "33".repeat(32), newOwner: SENDER });
    const moveCall = moveCallOf(tx);
    expect(moveCall.module).toBe("registry");
    expect(moveCall.function).toBe("transfer_agent_ownership");
    expect(tx.getData().commands.some((c) => c.$kind === "TransferObjects")).toBe(false);
  });

  it("createListing targets agent_exchange::create_listing against the configured protocol state, with no type arguments", () => {
    const adapter = buildAdapter();
    const tx = adapter.createListing({
      agentId: "0x" + "33".repeat(32),
      mode: 0,
      fairValueSnapshot: 500_000_000,
      reservePrice: 0,
      endTimeMs: 0,
    });
    const moveCall = moveCallOf(tx);
    expect(moveCall.module).toBe("agent_exchange");
    expect(moveCall.function).toBe("create_listing");
    expect((moveCall as unknown as { typeArguments: string[] }).typeArguments).toEqual([]);
    expect(tx.getData().commands.some((c) => c.$kind === "TransferObjects")).toBe(false);
  });

  it("cancelListing targets agent_exchange::cancel_listing with both the listing and the agent", () => {
    const adapter = buildAdapter();
    const tx = adapter.cancelListing("0x" + "77".repeat(32), "0x" + "33".repeat(32));
    const moveCall = moveCallOf(tx);
    expect(moveCall.module).toBe("agent_exchange");
    expect(moveCall.function).toBe("cancel_listing");
  });

  it("placeBid with a pre-made bidCoin targets agent_exchange::place_bid directly, no type arguments, no splitCoins", () => {
    const adapter = buildAdapter();
    const tx = adapter.placeBid({ listingId: "0x" + "77".repeat(32), bidCoin: "0x" + "44".repeat(32) });
    const moveCall = moveCallOf(tx);
    expect(moveCall.module).toBe("agent_exchange");
    expect(moveCall.function).toBe("place_bid");
    expect((moveCall as unknown as { typeArguments: string[] }).typeArguments).toEqual([]);
    expect(tx.getData().commands.some((c) => c.$kind === "SplitCoins")).toBe(false);
  });

  it("placeBid with splitFromCoin+amount splits that exact amount inline before calling place_bid", () => {
    const adapter = buildAdapter();
    const tx = adapter.placeBid({ listingId: "0x" + "77".repeat(32), splitFromCoin: "0x" + "44".repeat(32), amount: 500_000_000n });
    const commands = tx.getData().commands;
    expect(commands[0].$kind).toBe("SplitCoins");
    const moveCall = moveCallOf(tx);
    expect(moveCall.function).toBe("place_bid");
  });

  it("withdrawBid targets agent_exchange::withdraw_bid", () => {
    const adapter = buildAdapter();
    const tx = adapter.withdrawBid({ listingId: "0x" + "77".repeat(32), bidId: 1 });
    const moveCall = moveCallOf(tx);
    expect(moveCall.module).toBe("agent_exchange");
    expect(moveCall.function).toBe("withdraw_bid");
  });

  it("acceptBid targets agent_exchange::accept_bid with the listing, the agent, and the configured protocol state", () => {
    const adapter = buildAdapter();
    const tx = adapter.acceptBid({ listingId: "0x" + "77".repeat(32), agentId: "0x" + "33".repeat(32), bidId: 1 });
    const moveCall = moveCallOf(tx);
    expect(moveCall.module).toBe("agent_exchange");
    expect(moveCall.function).toBe("accept_bid");
  });

  it("settleAuction targets agent_exchange::settle_auction with the listing and the agent, callable permissionlessly (no sender-only args)", () => {
    const adapter = buildAdapter();
    const tx = adapter.settleAuction("0x" + "77".repeat(32), "0x" + "33".repeat(32));
    const moveCall = moveCallOf(tx);
    expect(moveCall.module).toBe("agent_exchange");
    expect(moveCall.function).toBe("settle_auction");
  });
});
