import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import type { ClawdHQCore, ClawdHQLaunchpad, MockUSDC } from "../typechain-types";
import type { Signer } from "ethers";

const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
const TOKEN = (n: number) => ethers.parseUnits(n.toString(), 18);

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

  for (const signer of [employer, agentOwner1, agentOwner2, other]) {
    await usdc.mint(await signer.getAddress(), USDC(1_000_000));
    await usdc.connect(signer).approve(await core.getAddress(), ethers.MaxUint256);
    await usdc.connect(signer).approve(await launchpad.getAddress(), ethers.MaxUint256);
  }

  return { admin, treasury, employer, agentOwner1, agentOwner2, other, usdc, core, launchpad, registry };
}

async function registerAgent(core: ClawdHQCore, owner: Signer, name = "agent-one") {
  const tx = await core
    .connect(owner)
    .registerAgent(name, "ipfs://uri", "https://endpoint.example", ethers.ZeroHash, true, true, true);
  await tx.wait();
  return core.agentIdByNameHash(ethers.keccak256(ethers.toUtf8Bytes(name)));
}

describe("ClawdHQLaunchpad", () => {
  describe("Launchpad", () => {
    it("creates a launch, mints the creator allocation, and locks transfers pre-graduation", async () => {
      const { core, launchpad, agentOwner1, other } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);

      await launchpad.connect(agentOwner1).createLaunch(agentId, "Agent Coin", "AGT", 1_000); // 10%
      const launch = await launchpad.launches(1);
      expect(launch.creator).to.equal(await agentOwner1.getAddress());

      const AgentToken = await ethers.getContractFactory("AgentToken");
      const token = AgentToken.attach(launch.token);
      const expectedCreatorAmount = (TOKEN(1_000_000_000) * 1_000n) / 10_000n;
      expect(await (token as any).balanceOf(await agentOwner1.getAddress())).to.equal(expectedCreatorAmount);

      // Pre-graduation peer-to-peer transfer is locked.
      await expect((token as any).connect(agentOwner1).transfer(await other.getAddress(), 1n)).to.be.revertedWithCustomError(
        token,
        "TransfersLocked"
      );
    });

    it("rejects a second launch for the same agent", async () => {
      const { core, launchpad, agentOwner1 } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await launchpad.connect(agentOwner1).createLaunch(agentId, "Agent Coin", "AGT", 0);
      await expect(launchpad.connect(agentOwner1).createLaunch(agentId, "Agent Coin 2", "AGT2", 0)).to.be.revertedWithCustomError(
        launchpad,
        "AlreadyLaunched"
      );
    });

    it("computes buy-side curve math correctly against the closed-form integral", async () => {
      const { core, launchpad, agentOwner1, employer } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await launchpad.connect(agentOwner1).createLaunch(agentId, "Agent Coin", "AGT", 0);

      const launch = await launchpad.launches(1);
      const basePrice = launch.bondingBasePrice; // 1000 (0.001 USDC, 6dec)
      const slope = launch.bondingSlope; // 1

      // Buying with a budget such that exactly 100 whole tokens are purchased:
      // cost = basePrice*100 + slope*(100^2)/2 = 1000*100 + 1*5000 = 105000 (0.105 USDC * 1e... already 6dec units)
      const budget = basePrice * 100n + (slope * 100n * 100n) / 2n;

      await launchpad.connect(employer).buyTokens(1, budget, TOKEN(100));
      const after = await launchpad.launches(1);
      expect(after.tokensSold).to.equal(TOKEN(100));
      expect(after.usdcRaised).to.equal(budget);
    });

    it("enforces the anti-snipe cap during the initial window", async () => {
      const { core, launchpad, usdc, employer, agentOwner1 } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      // A flat (zero-slope) curve keeps the buy-side math a simple division, so the
      // exact whole-token amount that breaches the 5%-of-supply anti-snipe cap is easy
      // to target precisely.
      await launchpad.setBondingParams(USDC(1), 0, USDC(1_000_000_000));
      await launchpad.connect(agentOwner1).createLaunch(agentId, "Agent Coin", "AGT", 0);

      const maxPerWalletWhole = (1_000_000_000n * 500n) / 10_000n; // 5% of 1B supply, in whole tokens
      const overCapWhole = maxPerWalletWhole + 1n;
      const overBudget = USDC(1) * overCapWhole; // basePrice (1 USDC/token) * whole tokens, flat curve

      await usdc.mint(await employer.getAddress(), overBudget);
      await usdc.connect(employer).approve(await launchpad.getAddress(), overBudget);

      await expect(launchpad.connect(employer).buyTokens(1, overBudget, 0n)).to.be.revertedWithCustomError(
        launchpad,
        "AntiSnipeLimitExceeded"
      );
    });

    it("sells tokens back through the curve with the 2% fee applied", async () => {
      const { core, launchpad, usdc, treasury, agentOwner1, employer } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await launchpad.connect(agentOwner1).createLaunch(agentId, "Agent Coin", "AGT", 0);

      const launch = await launchpad.launches(1);
      const budget = launch.bondingBasePrice * 100n + (launch.bondingSlope * 100n * 100n) / 2n;
      await launchpad.connect(employer).buyTokens(1, budget, TOKEN(100));

      const AgentToken = await ethers.getContractFactory("AgentToken");
      const token = AgentToken.attach(launch.token);
      await (token as any).connect(employer).approve(await launchpad.getAddress(), TOKEN(100));

      const treasuryBefore = await usdc.balanceOf(await treasury.getAddress());
      const employerUsdcBefore = await usdc.balanceOf(await employer.getAddress());

      await launchpad.connect(employer).sellTokens(1, TOKEN(100), 0n);

      const grossExpected = budget; // selling back exactly what was bought returns the same gross integral
      const feeExpected = (grossExpected * 200n) / 10_000n;
      expect(await usdc.balanceOf(await treasury.getAddress())).to.equal(treasuryBefore + feeExpected);
      expect(await usdc.balanceOf(await employer.getAddress())).to.equal(employerUsdcBefore + grossExpected - feeExpected);
      expect((await launchpad.launches(1)).tokensSold).to.equal(0n);
    });

    it("graduates only once the threshold is met and unlocks transfers", async () => {
      const { core, launchpad, agentOwner1, employer, other } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await launchpad.setBondingParams(1, 0, USDC(1)); // flat price, tiny threshold so the test is cheap
      await launchpad.connect(agentOwner1).createLaunch(agentId, "Agent Coin", "AGT", 0);

      await expect(launchpad.graduateLaunch(1)).to.be.revertedWithCustomError(launchpad, "ThresholdNotMet");

      await launchpad.connect(employer).buyTokens(1, USDC(1), 0n);
      await launchpad.graduateLaunch(1);

      const launch = await launchpad.launches(1);
      expect(launch.graduated).to.equal(true);

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
      await expect(launchpad.connect(other).createLaunch(agentId, "Agent Coin", "AGT", 0)).to.be.revertedWithCustomError(
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
      await expect(launchpad.connect(other).withdrawStuckTokens(ethers.ZeroAddress, 0, await other.getAddress())).to.be.reverted;
    });

    it("restricts pause/unpause to PAUSER_ROLE and blocks state-changing calls while paused", async () => {
      const { core, launchpad, admin, agentOwner1, other } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);

      await expect(launchpad.connect(other).pause()).to.be.reverted;
      await launchpad.connect(admin).pause();

      await expect(launchpad.connect(agentOwner1).createLaunch(agentId, "Agent Coin", "AGT", 0)).to.be.revertedWithCustomError(
        launchpad,
        "EnforcedPause"
      );

      await launchpad.connect(admin).unpause();
      await expect(launchpad.connect(agentOwner1).createLaunch(agentId, "Agent Coin", "AGT", 0)).to.not.be.reverted;
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
