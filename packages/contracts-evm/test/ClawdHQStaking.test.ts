import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import type { ClawdHQCore, ClawdHQStaking, MockUSDC } from "../typechain-types";
import type { Signer } from "ethers";

const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
const DAY = 24 * 60 * 60;
const TIER_BASIC = 0;
const TIER_VERIFIED = 1;

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

  const StakingFactory = await ethers.getContractFactory("ClawdHQStaking");
  const staking = (await upgrades.deployProxy(
    StakingFactory,
    [await admin.getAddress(), await core.getAddress(), await usdc.getAddress()],
    { unsafeAllow: ["constructor"] }
  )) as unknown as ClawdHQStaking;

  for (const signer of [employer, agentOwner1, agentOwner2, other]) {
    await usdc.mint(await signer.getAddress(), USDC(1_000_000));
    await usdc.connect(signer).approve(await core.getAddress(), ethers.MaxUint256);
    await usdc.connect(signer).approve(await staking.getAddress(), ethers.MaxUint256);
  }

  return { admin, treasury, employer, agentOwner1, agentOwner2, other, usdc, core, staking };
}

async function registerAgent(core: ClawdHQCore, owner: Signer, name = "agent-one") {
  const tx = await core
    .connect(owner)
    .registerAgent(name, "ipfs://uri", "https://endpoint.example", ethers.ZeroHash, true, true, true);
  await tx.wait();
  return core.agentIdByNameHash(ethers.keccak256(ethers.toUtf8Bytes(name)));
}

describe("ClawdHQStaking", () => {
  describe("Bonding", () => {
    it("posts and accumulates a bond, only for the agent's real Core-registered owner", async () => {
      const { core, staking, agentOwner1, other } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);

      await expect(staking.connect(other).postBond(agentId, USDC(100))).to.be.revertedWithCustomError(staking, "NotAgentOwner");

      await staking.connect(agentOwner1).postBond(agentId, USDC(100));
      await staking.connect(agentOwner1).postBond(agentId, USDC(50));
      expect(await staking.bondOf(agentId)).to.equal(USDC(150));
      expect(await staking.usdc()).to.equal(await core.usdc());
    });

    it("withdraws down to (but not below) zero, only for the owner", async () => {
      const { core, staking, agentOwner1, other } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await staking.connect(agentOwner1).postBond(agentId, USDC(100));

      await expect(staking.connect(other).withdrawBond(agentId, USDC(10))).to.be.revertedWithCustomError(staking, "NotAgentOwner");
      await expect(staking.connect(agentOwner1).withdrawBond(agentId, USDC(101))).to.be.revertedWithCustomError(staking, "InsufficientBondBalance");

      const before = await (await ethers.getContractAt("MockUSDC", await staking.usdc())).balanceOf(await agentOwner1.getAddress());
      await staking.connect(agentOwner1).withdrawBond(agentId, USDC(40));
      const after = await (await ethers.getContractAt("MockUSDC", await staking.usdc())).balanceOf(await agentOwner1.getAddress());

      expect(await staking.bondOf(agentId)).to.equal(USDC(60));
      expect(after - before).to.equal(USDC(40));
    });

    it("isEligible: unconfigured tiers always pass; a configured tier requires enough bond", async () => {
      const { core, staking, admin, agentOwner1, agentOwner2 } = await deployFixture();
      const agentId1 = await registerAgent(core, agentOwner1, "agent-a");
      const agentId2 = await registerAgent(core, agentOwner2, "agent-b");

      expect(await staking.isEligible(agentId1, TIER_BASIC)).to.equal(true); // no required bond set yet

      await staking.connect(admin).setRequiredBond(TIER_BASIC, USDC(200));
      expect(await staking.isEligible(agentId1, TIER_BASIC)).to.equal(false);
      expect(await staking.isEligible(agentId2, TIER_VERIFIED)).to.equal(true); // different tier, still unconfigured

      await staking.connect(agentOwner1).postBond(agentId1, USDC(200));
      expect(await staking.isEligible(agentId1, TIER_BASIC)).to.equal(true);
    });

    it("restricts setRequiredBond to DEFAULT_ADMIN_ROLE", async () => {
      const { staking, other } = await deployFixture();
      await expect(staking.connect(other).setRequiredBond(TIER_BASIC, USDC(100))).to.be.reverted;
    });
  });

  describe("Slashing", () => {
    it("restricts slash to authorized slashers, zeroes the bond, and pays the recipient in full", async () => {
      const { core, staking, admin, agentOwner1, employer, other } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await staking.connect(agentOwner1).postBond(agentId, USDC(300));

      await expect(staking.connect(other).slash(agentId, await employer.getAddress())).to.be.revertedWithCustomError(staking, "NotAuthorizedSlasher");

      await staking.connect(admin).setAuthorizedSlasher(await other.getAddress(), true);

      const before = await (await ethers.getContractAt("MockUSDC", await staking.usdc())).balanceOf(await employer.getAddress());
      await staking.connect(other).slash(agentId, await employer.getAddress());
      const after = await (await ethers.getContractAt("MockUSDC", await staking.usdc())).balanceOf(await employer.getAddress());

      expect(await staking.bondOf(agentId)).to.equal(0n);
      expect(after - before).to.equal(USDC(300));
    });

    it("slash on a zero bond returns 0 without reverting (best-effort callers, e.g. Core, rely on this)", async () => {
      const { staking, admin, employer, other } = await deployFixture();
      await staking.connect(admin).setAuthorizedSlasher(await other.getAddress(), true);
      const returned = await staking.connect(other).slash.staticCall(999, await employer.getAddress());
      expect(returned).to.equal(0n);
    });

    it("restricts setAuthorizedSlasher to DEFAULT_ADMIN_ROLE", async () => {
      const { staking, other } = await deployFixture();
      await expect(staking.connect(other).setAuthorizedSlasher(await other.getAddress(), true)).to.be.reverted;
    });
  });

  describe("Integration with ClawdHQCore", () => {
    it("blocks acceptJob/acceptOpenJob with InsufficientBond once Core is wired to a configured Staking contract", async () => {
      const { core, staking, admin, employer, agentOwner1 } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 7 * DAY;

      await core.connect(admin).setStakingContract(await staking.getAddress());
      await staking.connect(admin).setRequiredBond(TIER_BASIC, USDC(500)); // AgentTier.Basic == 0, this agent's default tier

      await core.connect(employer).postJob(0, agentId, ethers.id("t"), USDC(10), deadline);
      await expect(core.connect(agentOwner1).acceptJob(1)).to.be.revertedWithCustomError(core, "InsufficientBond");

      await staking.connect(agentOwner1).postBond(agentId, USDC(500));
      await expect(core.connect(agentOwner1).acceptJob(1)).to.not.be.reverted;
    });

    it("does not block accept when stakingContract is unset (the default) even with zero bond", async () => {
      const { core, employer, agentOwner1 } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + DAY;

      await core.connect(employer).postJob(0, agentId, ethers.id("t"), USDC(10), deadline);
      await expect(core.connect(agentOwner1).acceptJob(1)).to.not.be.reverted;
    });

    it("slashes the losing agent's bond to the employer on resolveDispute(releaseToAgent=false), once authorized", async () => {
      const { core, staking, admin, employer, agentOwner1 } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + DAY;

      await core.connect(admin).setStakingContract(await staking.getAddress());
      await staking.connect(admin).setAuthorizedSlasher(await core.getAddress(), true);
      await staking.connect(agentOwner1).postBond(agentId, USDC(400));

      await core.connect(employer).postJob(0, agentId, ethers.id("t"), USDC(10), deadline);
      await core.connect(agentOwner1).acceptJob(1);
      await core.connect(employer).disputeJob(1);

      const before = await (await ethers.getContractAt("MockUSDC", await staking.usdc())).balanceOf(await employer.getAddress());
      await core.connect(admin).resolveDispute(1, false); // employer wins
      const after = await (await ethers.getContractAt("MockUSDC", await staking.usdc())).balanceOf(await employer.getAddress());

      expect(await staking.bondOf(agentId)).to.equal(0n);
      // Employer gets both the escrow refund (10 USDC, checked implicitly by the tx not reverting)
      // and the slashed bond (400 USDC) — this assertion isolates the slash's own contribution
      // by only checking the incremental balance change attributable to it is at least the bond.
      expect(after - before).to.be.gte(USDC(400));
    });

    it("resolveDispute still succeeds if Core isn't authorized as a slasher yet (best-effort, never blocks resolution)", async () => {
      const { core, staking, admin, employer, agentOwner1 } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + DAY;

      await core.connect(admin).setStakingContract(await staking.getAddress());
      // Deliberately NOT calling staking.setAuthorizedSlasher(core, true) here.
      await staking.connect(agentOwner1).postBond(agentId, USDC(400));

      await core.connect(employer).postJob(0, agentId, ethers.id("t"), USDC(10), deadline);
      await core.connect(agentOwner1).acceptJob(1);
      await core.connect(employer).disputeJob(1);

      await expect(core.connect(admin).resolveDispute(1, false)).to.not.be.reverted;
      expect(await staking.bondOf(agentId)).to.equal(USDC(400)); // untouched — the slash call reverted internally and was swallowed
    });
  });
});
