import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import type { ClawdHQCore, ClawdHQLaunchpad, MockUSDC, MockUniswapV2Router } from "../typechain-types";
import type { Signer } from "ethers";

const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
const TOKEN = (n: number) => ethers.parseUnits(n.toString(), 18);
const TRADE_FEE_BPS = 200n; // 2%, matches ClawdHQLaunchpad.TRADE_FEE_BPS
const DAY = 24 * 60 * 60;
// Matches ClawdHQLaunchpad.BuybackInterval's declaration order exactly (Solidity enums compile
// to a plain uint8, so these are just numeric literals, not a generated JS enum).
const DAILY = 0;
const WEEKLY = 1;
const MONTHLY = 2;
const QUARTERLY = 3;

async function advanceTime(seconds: number): Promise<void> {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

async function deployFixture() {
  const [admin, treasury, employer, agentOwner1, agentOwner2, other] = await ethers.getSigners();

  const MockUSDCFactory = await ethers.getContractFactory("MockUSDC");
  const usdc = (await MockUSDCFactory.deploy()) as unknown as MockUSDC;

  const RegistryFactory = await ethers.getContractFactory("AgentWalletRegistry");
  const registry = await RegistryFactory.deploy(await admin.getAddress(), await admin.getAddress());
  await registry.waitForDeployment();

  const CoreFactory = await ethers.getContractFactory("ClawdHQCore");
  const core = (await upgrades.deployProxy(
    CoreFactory,
    [await admin.getAddress(), await usdc.getAddress(), await treasury.getAddress()],
    { unsafeAllow: ["constructor"], constructorArgs: [await registry.getAddress()] }
  )) as unknown as ClawdHQCore;

  const LaunchpadFactory = await ethers.getContractFactory("ClawdHQLaunchpad");
  const launchpad = (await upgrades.deployProxy(
    LaunchpadFactory,
    [await admin.getAddress(), await core.getAddress(), await usdc.getAddress(), await treasury.getAddress(), await registry.getAddress()],
    // Same ReentrancyGuard constructor note as ClawdHQCore/ClawdHQAgentExchange's fixtures.
    { unsafeAllow: ["constructor"] }
  )) as unknown as ClawdHQLaunchpad;

  const MockRouterFactory = await ethers.getContractFactory("MockUniswapV2Router");
  const mockRouter = (await MockRouterFactory.deploy()) as unknown as MockUniswapV2Router;

  for (const signer of [employer, agentOwner1, agentOwner2, other]) {
    await usdc.mint(await signer.getAddress(), USDC(1_000_000));
    await usdc.connect(signer).approve(await core.getAddress(), ethers.MaxUint256);
    await usdc.connect(signer).approve(await launchpad.getAddress(), ethers.MaxUint256);
  }

  return { admin, treasury, employer, agentOwner1, agentOwner2, other, usdc, core, launchpad, registry, mockRouter };
}

async function registerAgent(core: ClawdHQCore, owner: Signer, name = "agent-one") {
  const tx = await core
    .connect(owner)
    .registerAgent(name, "ipfs://uri", "https://endpoint.example", ethers.ZeroHash, true, true, true);
  await tx.wait();
  return core.agentIdByNameHash(ethers.keccak256(ethers.toUtf8Bytes(name)));
}

/** The fee this contract deducts from a raw buy amount before it reaches the curve. */
function buyFee(usdcAmount: bigint): bigint {
  return (usdcAmount * TRADE_FEE_BPS) / 10_000n;
}

describe("ClawdHQLaunchpad", () => {
  describe("Launchpad", () => {
    it("creates a 100% fair-launch launch with no creator pre-allocation, and locks transfers pre-graduation", async () => {
      const { core, launchpad, agentOwner1, other } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);

      await launchpad.connect(agentOwner1).createLaunch(agentId, "Agent Coin", "AGT", DAILY);
      const launch = await launchpad.launches(1);
      expect(launch.creator).to.equal(await agentOwner1.getAddress());

      const AgentToken = await ethers.getContractFactory("AgentToken");
      const token = AgentToken.attach(launch.token);
      // No pre-allocation: the creator holds nothing at launch, and the launchpad itself holds
      // the entire fixed supply, fully available on the curve.
      expect(await (token as any).balanceOf(await agentOwner1.getAddress())).to.equal(0n);
      expect(await (token as any).balanceOf(await launchpad.getAddress())).to.equal(TOKEN(1_000_000_000));

      // Pre-graduation peer-to-peer transfer is locked.
      await expect((token as any).connect(agentOwner1).transfer(await other.getAddress(), 1n)).to.be.revertedWithCustomError(
        token,
        "TransfersLocked"
      );
    });

    it("rejects a second launch for the same agent", async () => {
      const { core, launchpad, agentOwner1 } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await launchpad.connect(agentOwner1).createLaunch(agentId, "Agent Coin", "AGT", DAILY);
      await expect(launchpad.connect(agentOwner1).createLaunch(agentId, "Agent Coin 2", "AGT2", DAILY)).to.be.revertedWithCustomError(
        launchpad,
        "AlreadyLaunched"
      );
    });

    it("computes buy-side curve math correctly against the closed-form integral, net of the trade fee", async () => {
      const { core, launchpad, agentOwner1, employer } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await launchpad.connect(agentOwner1).createLaunch(agentId, "Agent Coin", "AGT", DAILY);

      const launch = await launchpad.launches(1);
      const basePrice = launch.bondingBasePrice; // 1000 (0.001 USDC, 6dec)
      const slope = launch.bondingSlope; // 1

      // Curve cost for exactly 100 whole tokens: basePrice*100 + slope*(100^2)/2.
      const curveCostFor100 = basePrice * 100n + (slope * 100n * 100n) / 2n;
      // Gross up so that, after the 2% fee is taken off the top, the curve receives exactly
      // curveCostFor100 — i.e. usdcAmount * 9800/10000 == curveCostFor100.
      const grossBudget = (curveCostFor100 * 10_000n) / 9_800n;
      const fee = buyFee(grossBudget);
      const netForCurve = grossBudget - fee;

      await launchpad.connect(employer).buyTokens(1, grossBudget, TOKEN(100));
      const after = await launchpad.launches(1);
      expect(after.tokensSold).to.equal(TOKEN(100));
      expect(after.usdcRaised).to.equal(netForCurve);
    });

    it("splits every buy's fee 50/50 between the creator and the buyback pool", async () => {
      const { core, launchpad, usdc, agentOwner1, employer } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await launchpad.connect(agentOwner1).createLaunch(agentId, "Agent Coin", "AGT", DAILY);

      const grossBudget = USDC(1_000);
      const fee = buyFee(grossBudget);
      const creatorShare = fee / 2n;
      const buybackShare = fee - creatorShare;

      const creatorBefore = await usdc.balanceOf(await agentOwner1.getAddress());
      await launchpad.connect(employer).buyTokens(1, grossBudget, 0n);

      expect(await usdc.balanceOf(await agentOwner1.getAddress())).to.equal(creatorBefore + creatorShare);
      expect((await launchpad.launches(1)).buybackPoolUsdc).to.equal(buybackShare);
    });

    it("enforces the anti-snipe cap during the initial window", async () => {
      const { core, launchpad, usdc, employer, agentOwner1 } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      // A flat (zero-slope) curve keeps the buy-side math a simple division, so the
      // exact whole-token amount that breaches the 5%-of-supply anti-snipe cap is easy
      // to target precisely.
      await launchpad.setBondingParams(USDC(1), 0, USDC(1_000_000_000));
      await launchpad.connect(agentOwner1).createLaunch(agentId, "Agent Coin", "AGT", DAILY);

      const maxPerWalletWhole = (1_000_000_000n * 500n) / 10_000n; // 5% of 1B supply, in whole tokens
      const overCapWhole = maxPerWalletWhole + 1n;
      const netRequired = USDC(1) * overCapWhole; // basePrice (1 USDC/token) * whole tokens, flat curve
      // Gross up well past the 2% fee (a generous margin, not an exact boundary — this test only
      // needs the post-fee amount to exceed the cap, not hit it exactly).
      const overBudget = (netRequired * 10_000n) / 9_800n + USDC(10);

      await usdc.mint(await employer.getAddress(), overBudget);
      await usdc.connect(employer).approve(await launchpad.getAddress(), overBudget);

      await expect(launchpad.connect(employer).buyTokens(1, overBudget, 0n)).to.be.revertedWithCustomError(
        launchpad,
        "AntiSnipeLimitExceeded"
      );
    });

    it("sells tokens back through the curve, splitting the 2% fee 50/50 between creator and buyback pool", async () => {
      const { core, launchpad, usdc, agentOwner1, employer } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await launchpad.connect(agentOwner1).createLaunch(agentId, "Agent Coin", "AGT", DAILY);

      const launch = await launchpad.launches(1);
      const grossBudget = USDC(1_000);
      await launchpad.connect(employer).buyTokens(1, grossBudget, 0n);
      const afterBuy = await launchpad.launches(1);
      const tokensBought = afterBuy.tokensSold;

      const AgentToken = await ethers.getContractFactory("AgentToken");
      const token = AgentToken.attach(launch.token);
      await (token as any).connect(employer).approve(await launchpad.getAddress(), tokensBought);

      const creatorBefore = await usdc.balanceOf(await agentOwner1.getAddress());
      const employerUsdcBefore = await usdc.balanceOf(await employer.getAddress());
      const buybackPoolBefore = afterBuy.buybackPoolUsdc;

      await launchpad.connect(employer).sellTokens(1, tokensBought, 0n);

      // Derived from the contract's own before/after state rather than assumed: the buy-side
      // quadratic solve rounds the token count down, so "selling back exactly what was bought"
      // isn't guaranteed to reverse to the *identical* gross integral the buy used (only true
      // for specially round numbers, like the dedicated buy-side curve-math test above uses).
      // usdcRaised's exact decrease tells us the real grossUsdcOut the contract actually used.
      const usdcRaisedAfterSell = (await launchpad.launches(1)).usdcRaised;
      const grossActual = afterBuy.usdcRaised - usdcRaisedAfterSell;
      const feeExpected = buyFee(grossActual);
      const creatorShareExpected = feeExpected / 2n;
      const buybackShareExpected = feeExpected - creatorShareExpected;

      expect(await usdc.balanceOf(await agentOwner1.getAddress())).to.equal(creatorBefore + creatorShareExpected);
      expect(await usdc.balanceOf(await employer.getAddress())).to.equal(employerUsdcBefore + grossActual - feeExpected);
      expect((await launchpad.launches(1)).tokensSold).to.equal(0n);
      expect((await launchpad.launches(1)).buybackPoolUsdc).to.equal(buybackPoolBefore + buybackShareExpected);
    });

    it("executeBuyback spends the accumulated pool to buy from the curve at the current price and burns the tokens, once due", async () => {
      const { core, launchpad, agentOwner1, employer } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await launchpad.connect(agentOwner1).createLaunch(agentId, "Agent Coin", "AGT", DAILY);

      await launchpad.connect(employer).buyTokens(1, USDC(10_000), 0n);
      const beforeBuyback = await launchpad.launches(1);
      const pool = beforeBuyback.buybackPoolUsdc;
      expect(pool).to.be.greaterThan(0n);

      const AgentToken = await ethers.getContractFactory("AgentToken");
      const token = AgentToken.attach(beforeBuyback.token);
      const burnedBefore = await (token as any).burnedSupply();

      await advanceTime(DAY);
      await launchpad.executeBuyback(1);

      const afterBuyback = await launchpad.launches(1);
      expect(afterBuyback.buybackPoolUsdc).to.equal(0n);
      expect(afterBuyback.usdcRaised).to.equal(beforeBuyback.usdcRaised + pool);
      expect(afterBuyback.tokensSold).to.be.greaterThan(beforeBuyback.tokensSold);
      const tokensBurned = afterBuyback.tokensSold - beforeBuyback.tokensSold;
      expect(await (token as any).burnedSupply()).to.equal(burnedBefore + tokensBurned);

      // Executing again immediately (same interval, pool now refilled) reverts until the *next*
      // window opens — nextBuybackAt advances from execution time, not the original schedule.
      await launchpad.connect(employer).buyTokens(1, USDC(1_000), 0n);
      await expect(launchpad.executeBuyback(1)).to.be.revertedWithCustomError(launchpad, "BuybackNotDue");
      await advanceTime(DAY);
      await expect(launchpad.executeBuyback(1)).to.not.be.reverted;
    });

    it("executeBuyback reverts before the creator's chosen interval has elapsed, even with a non-empty pool", async () => {
      const { core, launchpad, agentOwner1, employer } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await launchpad.connect(agentOwner1).createLaunch(agentId, "Agent Coin", "AGT", WEEKLY);
      await launchpad.connect(employer).buyTokens(1, USDC(10_000), 0n);
      expect((await launchpad.launches(1)).buybackPoolUsdc).to.be.greaterThan(0n);

      await expect(launchpad.executeBuyback(1)).to.be.revertedWithCustomError(launchpad, "BuybackNotDue");

      await advanceTime(6 * DAY); // short of a full week
      await expect(launchpad.executeBuyback(1)).to.be.revertedWithCustomError(launchpad, "BuybackNotDue");

      await advanceTime(2 * DAY); // now past a full week from launch
      await expect(launchpad.executeBuyback(1)).to.not.be.reverted;
    });

    it("executeBuyback reverts when the pool is empty, even once the interval has elapsed", async () => {
      const { core, launchpad, agentOwner1 } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await launchpad.connect(agentOwner1).createLaunch(agentId, "Agent Coin", "AGT", DAILY);

      await advanceTime(DAY);
      await expect(launchpad.executeBuyback(1)).to.be.revertedWithCustomError(launchpad, "NoBuybackPool");
    });

    it("each launch's buyback interval is fixed at creation and independent of other launches", async () => {
      const { core, launchpad, agentOwner1, agentOwner2, employer } = await deployFixture();
      const agentId1 = await registerAgent(core, agentOwner1, "agent-one");
      const agentId2 = await registerAgent(core, agentOwner2, "agent-two");
      await launchpad.connect(agentOwner1).createLaunch(agentId1, "Agent Coin", "AGT", MONTHLY);
      await launchpad.connect(agentOwner2).createLaunch(agentId2, "Agent Coin 2", "AGT2", QUARTERLY);

      const launch1 = await launchpad.launches(1);
      const launch2 = await launchpad.launches(2);
      expect(launch1.buybackInterval).to.equal(MONTHLY);
      expect(launch2.buybackInterval).to.equal(QUARTERLY);
      expect(launch1.nextBuybackAt).to.equal(launch1.createdAt + BigInt(30 * DAY));
      expect(launch2.nextBuybackAt).to.equal(launch2.createdAt + BigInt(90 * DAY));

      await launchpad.connect(employer).buyTokens(1, USDC(10_000), 0n);
      await launchpad.connect(employer).buyTokens(2, USDC(10_000), 0n);

      await advanceTime(30 * DAY + 1);
      await expect(launchpad.executeBuyback(1)).to.not.be.reverted; // monthly launch now due
      await expect(launchpad.executeBuyback(2)).to.be.revertedWithCustomError(launchpad, "BuybackNotDue"); // quarterly launch isn't
    });

    it("graduateLaunch reverts if no Uniswap V2 router is configured for this chain", async () => {
      const { core, launchpad, agentOwner1, employer } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await launchpad.setBondingParams(1, 0, USDC(1));
      await launchpad.connect(agentOwner1).createLaunch(agentId, "Agent Coin", "AGT", DAILY);
      await launchpad.connect(employer).buyTokens(1, USDC(2), 0n); // clears the tiny threshold post-fee

      await expect(launchpad.graduateLaunch(1)).to.be.revertedWithCustomError(launchpad, "DexNotConfigured");
    });

    it("graduates only once the threshold is met, migrates liquidity to the DEX, and unlocks transfers", async () => {
      const { core, launchpad, agentOwner1, employer, other, mockRouter, usdc } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await launchpad.setBondingParams(1, 0, USDC(1)); // flat price, tiny threshold so the test is cheap
      await launchpad.setUniswapV2Router(await mockRouter.getAddress());
      await launchpad.connect(agentOwner1).createLaunch(agentId, "Agent Coin", "AGT", DAILY);

      await expect(launchpad.graduateLaunch(1)).to.be.revertedWithCustomError(launchpad, "ThresholdNotMet");

      await launchpad.connect(employer).buyTokens(1, USDC(2), 0n); // 2 gross, ~1.96 net clears the 1 USDC threshold
      const beforeGraduate = await launchpad.launches(1);

      await launchpad.graduateLaunch(1);

      const launch = await launchpad.launches(1);
      expect(launch.graduated).to.equal(true);

      // The mock router pulled both legs of liquidity and minted its LP token straight to
      // BURN_ADDRESS — never back to this contract or the creator.
      const remainingTokens = launch.totalSupply - beforeGraduate.tokensSold;
      const burnAddress = await launchpad.BURN_ADDRESS();
      const lpMinted = await mockRouter.balanceOf(burnAddress);
      expect(lpMinted).to.equal(remainingTokens + beforeGraduate.usdcRaised);
      expect(await usdc.balanceOf(await mockRouter.getAddress())).to.equal(beforeGraduate.usdcRaised);

      const AgentToken = await ethers.getContractFactory("AgentToken");
      const token = AgentToken.attach(launch.token);
      const balance = await (token as any).balanceOf(await employer.getAddress());
      if (balance > 0n) {
        await expect((token as any).connect(employer).transfer(await other.getAddress(), balance)).to.not.be.reverted;
      }
    });
  });

  describe("Agent ownership check", () => {
    it("only the agent's Core-registered owner can create its launch", async () => {
      const { core, launchpad, agentOwner1, other } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await expect(launchpad.connect(other).createLaunch(agentId, "Agent Coin", "AGT", DAILY)).to.be.revertedWithCustomError(
        launchpad,
        "NotAgentOwner"
      );
    });
  });

  describe("Access control & pausability", () => {
    it("restricts admin-only setters to DEFAULT_ADMIN_ROLE", async () => {
      const { launchpad, other } = await deployFixture();
      await expect(launchpad.connect(other).setLaunchFee(USDC(1))).to.be.reverted;
      await expect(launchpad.connect(other).setBondingParams(1, 1, USDC(1))).to.be.reverted;
      await expect(launchpad.connect(other).setTreasury(await other.getAddress())).to.be.reverted;
      await expect(launchpad.connect(other).setAgentWalletRegistry(await other.getAddress())).to.be.reverted;
      await expect(launchpad.connect(other).setUniswapV2Router(await other.getAddress())).to.be.reverted;
      await expect(launchpad.connect(other).withdrawStuckTokens(ethers.ZeroAddress, 0, await other.getAddress())).to.be.reverted;
    });

    it("restricts pause/unpause to PAUSER_ROLE and blocks state-changing calls while paused", async () => {
      const { core, launchpad, admin, agentOwner1, other } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);

      await expect(launchpad.connect(other).pause()).to.be.reverted;
      await launchpad.connect(admin).pause();

      await expect(launchpad.connect(agentOwner1).createLaunch(agentId, "Agent Coin", "AGT", DAILY)).to.be.revertedWithCustomError(
        launchpad,
        "EnforcedPause"
      );

      await launchpad.connect(admin).unpause();
      await expect(launchpad.connect(agentOwner1).createLaunch(agentId, "Agent Coin", "AGT", DAILY)).to.not.be.reverted;
    });

    it("only DEFAULT_ADMIN_ROLE can authorize a UUPS upgrade", async () => {
      const { launchpad, other } = await deployFixture();
      const LaunchpadFactory = await ethers.getContractFactory("ClawdHQLaunchpad");
      await expect(
        upgrades.upgradeProxy(await launchpad.getAddress(), LaunchpadFactory.connect(other), { unsafeAllow: ["constructor"] })
      ).to.be.reverted;
    });
  });
});
