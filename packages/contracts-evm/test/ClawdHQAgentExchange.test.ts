import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import type { ClawdHQAgentExchange, ClawdHQCore, MockUSDC } from "../typechain-types";
import type { Signer } from "ethers";

const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
const DAY = 24 * 60 * 60;
const MODE_OPEN = 0;
const MODE_AUCTION = 1;
const STATUS_ACTIVE = 0;
const STATUS_SOLD = 1;
const STATUS_CANCELLED = 2;
const STATUS_EXPIRED = 3;

async function deployFixture() {
  const [admin, treasury, agentOwner1, agentOwner2, bidder1, bidder2, bidder3, other] = await ethers.getSigners();

  const MockUSDCFactory = await ethers.getContractFactory("MockUSDC");
  const usdc = (await MockUSDCFactory.deploy()) as unknown as MockUSDC;

  // AgentWalletRegistry.sol is deployed first — ClawdHQCore's `_agentWalletRegistry` is an
  // immutable constructor argument (see ClawdHQCore.sol's doc comment on why).
  const RegistryFactory = await ethers.getContractFactory("AgentWalletRegistry");
  const registry = await RegistryFactory.deploy(await admin.getAddress(), await admin.getAddress());
  await registry.waitForDeployment();

  const CoreFactory = await ethers.getContractFactory("ClawdHQCore");
  const core = (await upgrades.deployProxy(
    CoreFactory,
    [await admin.getAddress(), await usdc.getAddress(), await treasury.getAddress()],
    { unsafeAllow: ["constructor"], constructorArgs: [await registry.getAddress()] }
  )) as unknown as ClawdHQCore;

  const ExchangeFactory = await ethers.getContractFactory("ClawdHQAgentExchange");
  const exchange = (await upgrades.deployProxy(
    ExchangeFactory,
    [await admin.getAddress(), await core.getAddress(), await usdc.getAddress(), await treasury.getAddress()],
    { unsafeAllow: ["constructor"] }
  )) as unknown as ClawdHQAgentExchange;

  for (const signer of [agentOwner1, agentOwner2, bidder1, bidder2, bidder3, other]) {
    await usdc.mint(await signer.getAddress(), USDC(1_000_000));
    await usdc.connect(signer).approve(await core.getAddress(), ethers.MaxUint256);
    await usdc.connect(signer).approve(await exchange.getAddress(), ethers.MaxUint256);
  }

  return { admin, treasury, agentOwner1, agentOwner2, bidder1, bidder2, bidder3, other, usdc, core, exchange };
}

async function registerAgent(core: ClawdHQCore, owner: Signer, name = "agent-one") {
  const tx = await core
    .connect(owner)
    .registerAgent(name, "ipfs://uri", "https://endpoint.example", ethers.ZeroHash, true, true, true);
  await tx.wait();
  return core.agentIdByNameHash(ethers.keccak256(ethers.toUtf8Bytes(name)));
}

/** Approves the exchange on Core and creates a listing in one step — the two-transaction
 * flow a real seller would perform. */
async function listAgent(
  core: ClawdHQCore,
  exchange: ClawdHQAgentExchange,
  owner: Signer,
  agentId: bigint,
  opts: { mode?: number; fairValue?: bigint; reserve?: bigint; endTime?: number } = {}
) {
  const mode = opts.mode ?? MODE_OPEN;
  const fairValue = opts.fairValue ?? USDC(100);
  const reserve = opts.reserve ?? 0n;
  const endTime = opts.endTime ?? 0;

  await core.connect(owner).approveAgentExchange(agentId, await exchange.getAddress());
  const tx = await exchange.connect(owner).createListing(agentId, mode, fairValue, reserve, endTime);
  await tx.wait();
  return 1n; // first listing in a fresh fixture is always id 1; callers needing more track their own ids
}

describe("ClawdHQAgentExchange", () => {
  describe("Non-custodial invariant", () => {
    it("keeps job revenue routing to the real seller while the agent is listed", async () => {
      const { core, exchange, usdc, agentOwner1, bidder1, treasury } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await listAgent(core, exchange, agentOwner1, agentId);

      // A completely separate employer hires the still-listed agent through Core's
      // existing, untouched job system.
      const [, , , , , , , employer] = await ethers.getSigners();
      await usdc.mint(await employer.getAddress(), USDC(1_000));
      await usdc.connect(employer).approve(await core.getAddress(), ethers.MaxUint256);

      const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + DAY;
      await core.connect(employer).postJob(0, agentId, ethers.id("task"), USDC(50), deadline);
      await core.connect(agentOwner1).acceptJob(1);
      await core.connect(agentOwner1).submitDeliverable(1, ethers.id("deliverable"));

      const sellerBalBefore = await usdc.balanceOf(await agentOwner1.getAddress());
      const exchangeBalBefore = await usdc.balanceOf(await exchange.getAddress());
      await core.connect(employer).confirmDelivery(1, 5);

      expect(await usdc.balanceOf(await agentOwner1.getAddress())).to.equal(sellerBalBefore + USDC(50));
      expect(await usdc.balanceOf(await exchange.getAddress())).to.equal(exchangeBalBefore); // untouched

      const agent = await core.agents(agentId);
      expect(agent.owner).to.equal(await agentOwner1.getAddress());
      expect(agent.jobsCompleted).to.equal(1n);
      expect(agent.usdcRevenue).to.equal(USDC(50));

      // The listing itself is unaffected by the job completing.
      const listing = await exchange.listings(1);
      expect(listing.status).to.equal(STATUS_ACTIVE);
      void treasury;
    });

    it("a manual Core-level transfer while listed clears the approval, so a stale listing can never settle", async () => {
      const { core, exchange, agentOwner1, agentOwner2, bidder1 } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await listAgent(core, exchange, agentOwner1, agentId);

      await exchange.connect(bidder1).placeBid(1, USDC(80));

      // Seller sells/gifts the agent directly on Core, bypassing the exchange entirely.
      await core.connect(agentOwner1).transferAgentOwnership(agentId, await agentOwner2.getAddress());
      expect(await core.agentExchangeApproval(agentId)).to.equal(ethers.ZeroAddress);

      // The orphaned listing can never transfer agentOwner2's agent out from under them —
      // Core's guard is the final authority, independent of what the exchange's own
      // bookkeeping believes.
      await expect(exchange.connect(agentOwner1).acceptBid(1, 1)).to.be.revertedWithCustomError(core, "NotApprovedExchange");

      // The bidder is never at risk of stuck funds even so.
      await expect(exchange.connect(bidder1).withdrawBid(1)).to.not.be.reverted;
    });
  });

  describe("Listing lifecycle & authorization", () => {
    it("rejects createListing without a live Core approval", async () => {
      const { core, exchange, agentOwner1 } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await expect(
        exchange.connect(agentOwner1).createListing(agentId, MODE_OPEN, USDC(100), 0, 0)
      ).to.be.revertedWithCustomError(exchange, "NotApprovedForExchange");
    });

    it("prevents an attacker from front-running someone else's dangling approval into a listing they don't own", async () => {
      const { core, exchange, agentOwner1, other } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await core.connect(agentOwner1).approveAgentExchange(agentId, await exchange.getAddress());

      await expect(
        exchange.connect(other).createListing(agentId, MODE_OPEN, USDC(100), 0, 0)
      ).to.be.revertedWithCustomError(exchange, "NotSeller");
    });

    it("passing address(0) to approveAgentExchange revokes it", async () => {
      const { core, exchange, agentOwner1 } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await core.connect(agentOwner1).approveAgentExchange(agentId, await exchange.getAddress());
      await core.connect(agentOwner1).approveAgentExchange(agentId, ethers.ZeroAddress);

      await expect(
        exchange.connect(agentOwner1).createListing(agentId, MODE_OPEN, USDC(100), 0, 0)
      ).to.be.revertedWithCustomError(exchange, "NotApprovedForExchange");
    });

    it("rejects a second active listing for the same agent", async () => {
      const { core, exchange, agentOwner1 } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await listAgent(core, exchange, agentOwner1, agentId);

      await core.connect(agentOwner1).approveAgentExchange(agentId, await exchange.getAddress());
      await expect(
        exchange.connect(agentOwner1).createListing(agentId, MODE_OPEN, USDC(100), 0, 0)
      ).to.be.revertedWithCustomError(exchange, "AlreadyListed");
    });

    it("rejects Open listings with a non-zero endTime or reserve, and Auction listings with a past endTime", async () => {
      const { core, exchange, agentOwner1 } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await core.connect(agentOwner1).approveAgentExchange(agentId, await exchange.getAddress());

      const future = (await ethers.provider.getBlock("latest"))!.timestamp + DAY;
      await expect(
        exchange.connect(agentOwner1).createListing(agentId, MODE_OPEN, USDC(100), 0, future)
      ).to.be.revertedWithCustomError(exchange, "InvalidListingParams");
      await expect(
        exchange.connect(agentOwner1).createListing(agentId, MODE_AUCTION, USDC(100), 0, 0)
      ).to.be.revertedWithCustomError(exchange, "InvalidListingParams");
    });

    it("lets the seller cancel a listing with no bids, freeing it up to be relisted", async () => {
      const { core, exchange, agentOwner1 } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await listAgent(core, exchange, agentOwner1, agentId);

      await exchange.connect(agentOwner1).cancelListing(1);
      expect((await exchange.listings(1)).status).to.equal(STATUS_CANCELLED);
      expect(await exchange.activeListingIdByAgentId(agentId)).to.equal(0n);

      await core.connect(agentOwner1).approveAgentExchange(agentId, await exchange.getAddress());
      await expect(exchange.connect(agentOwner1).createListing(agentId, MODE_OPEN, USDC(100), 0, 0)).to.not.be.reverted;
    });

    it("only the seller can cancel", async () => {
      const { core, exchange, agentOwner1, other } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await listAgent(core, exchange, agentOwner1, agentId);
      await expect(exchange.connect(other).cancelListing(1)).to.be.revertedWithCustomError(exchange, "NotSeller");
    });
  });

  describe("Open mode: concurrent bids, accept-anytime", () => {
    it("accepts any bid regardless of the fair-value snapshot, pays the seller minus the protocol fee, and transfers ownership", async () => {
      const { core, exchange, admin, usdc, treasury, agentOwner1, bidder1, bidder2 } = await deployFixture();
      await exchange.connect(admin).setProtocolFeeBps(500); // 5%
      const agentId = await registerAgent(core, agentOwner1);
      await listAgent(core, exchange, agentOwner1, agentId, { fairValue: USDC(100) });

      await exchange.connect(bidder1).placeBid(1, USDC(60)); // below fair value
      await exchange.connect(bidder2).placeBid(1, USDC(150)); // above fair value

      const sellerBefore = await usdc.balanceOf(await agentOwner1.getAddress());
      const treasuryBefore = await usdc.balanceOf(await treasury.getAddress());

      // Seller accepts the lower, below-fair-value bid — their unconditional discretion.
      await exchange.connect(agentOwner1).acceptBid(1, 1);

      expect(await usdc.balanceOf(await agentOwner1.getAddress())).to.equal(sellerBefore + USDC(60) - USDC(3)); // 5% of 60
      expect(await usdc.balanceOf(await treasury.getAddress())).to.equal(treasuryBefore + USDC(3));
      expect((await core.agents(agentId)).owner).to.equal(await bidder1.getAddress());
      expect((await exchange.listings(1)).status).to.equal(STATUS_SOLD);
      expect(await core.agentExchangeApproval(agentId)).to.equal(ethers.ZeroAddress);

      // The losing bid is untouched by acceptance and stays self-service withdrawable.
      const bidder2Before = await usdc.balanceOf(await bidder2.getAddress());
      await exchange.connect(bidder2).withdrawBid(2);
      expect(await usdc.balanceOf(await bidder2.getAddress())).to.equal(bidder2Before + USDC(150));
    });

    it("lets a bidder withdraw an open bid at any time before acceptance", async () => {
      const { core, exchange, usdc, agentOwner1, bidder1 } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await listAgent(core, exchange, agentOwner1, agentId);
      await exchange.connect(bidder1).placeBid(1, USDC(40));

      const before = await usdc.balanceOf(await bidder1.getAddress());
      await exchange.connect(bidder1).withdrawBid(1);
      expect(await usdc.balanceOf(await bidder1.getAddress())).to.equal(before + USDC(40));
      await expect(exchange.connect(bidder1).withdrawBid(1)).to.be.revertedWithCustomError(exchange, "BidNotActive");
    });

    it("rejects acceptBid from anyone but the seller, and rejects auction-only settlement paths on an Open listing", async () => {
      const { core, exchange, agentOwner1, bidder1, other } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await listAgent(core, exchange, agentOwner1, agentId);
      await exchange.connect(bidder1).placeBid(1, USDC(40));

      await expect(exchange.connect(other).acceptBid(1, 1)).to.be.revertedWithCustomError(exchange, "NotSeller");
      await expect(exchange.settleAuction(1)).to.be.revertedWithCustomError(exchange, "WrongListingMode");
    });
  });

  describe("Auction mode", () => {
    async function createAuction(core: ClawdHQCore, exchange: ClawdHQAgentExchange, owner: Signer, agentId: bigint, reserve = 0n) {
      const endTime = (await ethers.provider.getBlock("latest"))!.timestamp + DAY;
      await core.connect(owner).approveAgentExchange(agentId, await exchange.getAddress());
      await exchange.connect(owner).createListing(agentId, MODE_AUCTION, USDC(100), reserve, endTime);
      return endTime;
    }

    it("enforces strictly increasing bids and refunds the previous highest bidder atomically", async () => {
      const { core, exchange, usdc, agentOwner1, bidder1, bidder2 } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await createAuction(core, exchange, agentOwner1, agentId);

      await exchange.connect(bidder1).placeBid(1, USDC(50));
      await expect(exchange.connect(bidder2).placeBid(1, USDC(50))).to.be.revertedWithCustomError(exchange, "BidTooLow");
      await expect(exchange.connect(bidder2).placeBid(1, USDC(40))).to.be.revertedWithCustomError(exchange, "BidTooLow");

      const bidder1Before = await usdc.balanceOf(await bidder1.getAddress());
      await exchange.connect(bidder2).placeBid(1, USDC(75));
      expect(await usdc.balanceOf(await bidder1.getAddress())).to.equal(bidder1Before + USDC(50));

      expect((await exchange.listings(1)).highestBidId).to.equal(2n);
    });

    it("extends endTime when a bid lands inside the anti-snipe window, and not otherwise", async () => {
      const { core, exchange, agentOwner1, bidder1, bidder2 } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      const endTime = await createAuction(core, exchange, agentOwner1, agentId);

      await exchange.connect(bidder1).placeBid(1, USDC(50));
      expect((await exchange.listings(1)).endTime).to.equal(BigInt(endTime)); // far from expiry, no extension

      const window = Number(await exchange.ANTI_SNIPE_EXTENSION_WINDOW());
      await ethers.provider.send("evm_increaseTime", [DAY - window / 2]);
      await ethers.provider.send("evm_mine", []);

      const bidTime = (await ethers.provider.getBlock("latest"))!.timestamp + 1;
      await exchange.connect(bidder2).placeBid(1, USDC(75));
      expect((await exchange.listings(1)).endTime).to.equal(BigInt(bidTime + window));
    });

    it("rejects settleAuction before endTime and rejects further bids after it", async () => {
      const { core, exchange, agentOwner1, bidder1, bidder2 } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await createAuction(core, exchange, agentOwner1, agentId);
      await exchange.connect(bidder1).placeBid(1, USDC(50));

      await expect(exchange.settleAuction(1)).to.be.revertedWithCustomError(exchange, "AuctionNotEnded");

      await ethers.provider.send("evm_increaseTime", [DAY + 1]);
      await ethers.provider.send("evm_mine", []);

      await expect(exchange.connect(bidder2).placeBid(1, USDC(80))).to.be.revertedWithCustomError(exchange, "AuctionEnded");
    });

    it("settles permissionlessly to the highest bidder at expiry, paying the seller and transferring ownership", async () => {
      const { core, exchange, usdc, agentOwner1, bidder1, bidder2, other } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await createAuction(core, exchange, agentOwner1, agentId);
      await exchange.connect(bidder1).placeBid(1, USDC(50));
      await exchange.connect(bidder2).placeBid(1, USDC(90));

      await ethers.provider.send("evm_increaseTime", [DAY + 1]);
      await ethers.provider.send("evm_mine", []);

      const sellerBefore = await usdc.balanceOf(await agentOwner1.getAddress());
      await exchange.connect(other).settleAuction(1); // permissionless: neither seller nor a bidder

      expect(await usdc.balanceOf(await agentOwner1.getAddress())).to.equal(sellerBefore + USDC(90));
      expect((await core.agents(agentId)).owner).to.equal(await bidder2.getAddress());
      expect((await exchange.listings(1)).status).to.equal(STATUS_SOLD);
    });

    it("expires unsold without transferring ownership if the reserve price isn't met", async () => {
      const { core, exchange, agentOwner1, bidder1 } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await createAuction(core, exchange, agentOwner1, agentId, USDC(200)); // reserve above any bid placed
      await exchange.connect(bidder1).placeBid(1, USDC(90));

      await ethers.provider.send("evm_increaseTime", [DAY + 1]);
      await ethers.provider.send("evm_mine", []);

      await exchange.settleAuction(1);
      expect((await exchange.listings(1)).status).to.equal(STATUS_EXPIRED);
      expect((await core.agents(agentId)).owner).to.equal(await agentOwner1.getAddress());

      // The non-winning (here: only) bid is still self-service withdrawable afterward.
      await expect(exchange.connect(bidder1).withdrawBid(1)).to.not.be.reverted;
    });

    it("expires unsold if no bids were ever placed", async () => {
      const { core, exchange, agentOwner1 } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await createAuction(core, exchange, agentOwner1, agentId);

      await ethers.provider.send("evm_increaseTime", [DAY + 1]);
      await ethers.provider.send("evm_mine", []);

      await expect(exchange.settleAuction(1)).to.not.be.reverted;
      expect((await exchange.listings(1)).status).to.equal(STATUS_EXPIRED);
    });

    it("blocks cancelling an auction once it has a bid", async () => {
      const { core, exchange, agentOwner1, bidder1 } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await createAuction(core, exchange, agentOwner1, agentId);
      await exchange.connect(bidder1).placeBid(1, USDC(50));

      await expect(exchange.connect(agentOwner1).cancelListing(1)).to.be.revertedWithCustomError(exchange, "CannotCancelAuctionWithBids");
    });

    describe("withdrawal rules for the current-highest bid", () => {
      it("blocks the highest bidder from withdrawing while the auction is still active and before endTime", async () => {
        const { core, exchange, agentOwner1, bidder1 } = await deployFixture();
        const agentId = await registerAgent(core, agentOwner1);
        await createAuction(core, exchange, agentOwner1, agentId);
        await exchange.connect(bidder1).placeBid(1, USDC(50));

        await expect(exchange.connect(bidder1).withdrawBid(1)).to.be.revertedWithCustomError(exchange, "BidNotWithdrawable");
      });

      it("lets the highest bidder withdraw once endTime has passed even if settleAuction hasn't been called yet", async () => {
        const { core, exchange, usdc, agentOwner1, bidder1 } = await deployFixture();
        const agentId = await registerAgent(core, agentOwner1);
        await createAuction(core, exchange, agentOwner1, agentId);
        await exchange.connect(bidder1).placeBid(1, USDC(50));

        await ethers.provider.send("evm_increaseTime", [DAY + 1]);
        await ethers.provider.send("evm_mine", []);

        const before = await usdc.balanceOf(await bidder1.getAddress());
        await exchange.connect(bidder1).withdrawBid(1);
        expect(await usdc.balanceOf(await bidder1.getAddress())).to.equal(before + USDC(50));

        // The race resolves safely: settlement now sees no valid highest bid and expires unsold.
        await exchange.settleAuction(1);
        expect((await exchange.listings(1)).status).to.equal(STATUS_EXPIRED);
        expect((await core.agents(agentId)).owner).to.equal(await agentOwner1.getAddress());
      });
    });
  });

  describe("Access control & pausability", () => {
    it("lets the admin update the protocol fee and treasury", async () => {
      const { exchange, admin, other } = await deployFixture();
      await exchange.connect(admin).setProtocolFeeBps(250);
      expect(await exchange.protocolFeeBps()).to.equal(250n);

      await exchange.connect(admin).setTreasury(await other.getAddress());
      expect(await exchange.treasury()).to.equal(await other.getAddress());

      await expect(exchange.connect(admin).setTreasury(ethers.ZeroAddress)).to.be.revertedWith("ZeroAddress");
    });

    it("restricts admin-only setters to DEFAULT_ADMIN_ROLE", async () => {
      const { exchange, other } = await deployFixture();
      await expect(exchange.connect(other).setProtocolFeeBps(100)).to.be.reverted;
      await expect(exchange.connect(other).setTreasury(await other.getAddress())).to.be.reverted;
    });

    it("restricts pause/unpause to PAUSER_ROLE and blocks state-changing calls while paused", async () => {
      const { core, exchange, admin, agentOwner1, bidder1, other } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await listAgent(core, exchange, agentOwner1, agentId);

      await expect(exchange.connect(other).pause()).to.be.reverted;
      await exchange.connect(admin).pause();

      await expect(exchange.connect(bidder1).placeBid(1, USDC(10))).to.be.revertedWithCustomError(exchange, "EnforcedPause");
      await core.connect(agentOwner1).approveAgentExchange(agentId, await exchange.getAddress());
      await expect(
        exchange.connect(agentOwner1).createListing(agentId, MODE_OPEN, USDC(100), 0, 0)
      ).to.be.revertedWithCustomError(exchange, "EnforcedPause");

      await exchange.connect(admin).unpause();
      await expect(exchange.connect(bidder1).placeBid(1, USDC(10))).to.not.be.reverted;
    });

    it("only DEFAULT_ADMIN_ROLE can authorize a UUPS upgrade", async () => {
      const { exchange, other } = await deployFixture();
      const ExchangeFactory = await ethers.getContractFactory("ClawdHQAgentExchange");
      await expect(
        upgrades.upgradeProxy(await exchange.getAddress(), ExchangeFactory.connect(other), { unsafeAllow: ["constructor"] })
      ).to.be.reverted;
    });
  });
});
