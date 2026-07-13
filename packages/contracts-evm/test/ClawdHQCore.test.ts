import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import type { ClawdHQCore, MockUSDC } from "../typechain-types";
import type { Signer } from "ethers";

const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
const TOKEN = (n: number) => ethers.parseUnits(n.toString(), 18);
const DAY = 24 * 60 * 60;

async function deployFixture() {
  const [admin, treasury, employer, agentOwner1, agentOwner2, other] = await ethers.getSigners();

  const MockUSDCFactory = await ethers.getContractFactory("MockUSDC");
  const usdc = (await MockUSDCFactory.deploy()) as unknown as MockUSDC;

  // AgentWalletRegistry.sol is deployed first — ClawdHQCore's `_agentWalletRegistry` is an
  // immutable constructor argument (see ClawdHQCore.sol's doc comment on why: no bytecode
  // headroom left for a regular admin-settable storage variable). `admin` stands in as a
  // placeholder registrar here since these tests never provision an agent wallet — every
  // payout falls back to `owner`, unchanged from pre-registry behavior.
  const RegistryFactory = await ethers.getContractFactory("AgentWalletRegistry");
  const registry = await RegistryFactory.deploy(await admin.getAddress(), await admin.getAddress());
  await registry.waitForDeployment();

  const CoreFactory = await ethers.getContractFactory("ClawdHQCore");
  const core = (await upgrades.deployProxy(
    CoreFactory,
    [await admin.getAddress(), await usdc.getAddress(), await treasury.getAddress()],
    // ReentrancyGuard's constructor only zero-initializes its own namespaced storage
    // slot (ERC-7201 style) — harmless to skip via the proxy, see ClawdHQCore.sol notes.
    { unsafeAllow: ["constructor"], constructorArgs: [await registry.getAddress()] }
  )) as unknown as ClawdHQCore;

  for (const signer of [employer, agentOwner1, agentOwner2, other]) {
    await usdc.mint(await signer.getAddress(), USDC(1_000_000));
    await usdc.connect(signer).approve(await core.getAddress(), ethers.MaxUint256);
  }

  return { admin, treasury, employer, agentOwner1, agentOwner2, other, usdc, core, registry };
}

async function registerAgent(core: ClawdHQCore, owner: Signer, name = "agent-one") {
  const tx = await core
    .connect(owner)
    .registerAgent(name, "ipfs://uri", "https://endpoint.example", ethers.ZeroHash, true, true, true);
  await tx.wait();
  return core.agentIdByNameHash(ethers.keccak256(ethers.toUtf8Bytes(name)));
}

describe("ClawdHQCore", () => {
  describe("Agent registry", () => {
    it("registers an agent and enforces name uniqueness", async () => {
      const { core, agentOwner1, agentOwner2 } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1, "unique-agent");
      expect(agentId).to.equal(1n);

      const agent = await core.agents(agentId);
      expect(agent.owner).to.equal(await agentOwner1.getAddress());
      expect(agent.active).to.equal(true);
      expect(await core.totalAgents()).to.equal(1n);
      expect(await core.activeAgents()).to.equal(1n);

      await expect(
        core.connect(agentOwner2).registerAgent("unique-agent", "ipfs://x", "https://x", ethers.ZeroHash, false, false, false)
      ).to.be.revertedWithCustomError(core, "NameTaken");
    });

    it("rejects empty or overlong names", async () => {
      const { core, agentOwner1 } = await deployFixture();
      await expect(
        core.connect(agentOwner1).registerAgent("", "ipfs://x", "https://x", ethers.ZeroHash, false, false, false)
      ).to.be.revertedWithCustomError(core, "InvalidNameLength");

      const longName = "a".repeat(65);
      await expect(
        core.connect(agentOwner1).registerAgent(longName, "ipfs://x", "https://x", ethers.ZeroHash, false, false, false)
      ).to.be.revertedWithCustomError(core, "InvalidNameLength");
    });

    it("only the owner can update metadata or active status", async () => {
      const { core, agentOwner1, other } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);

      await expect(
        core.connect(other).updateAgentMetadata(agentId, "ipfs://new", "https://new", ethers.ZeroHash, false, false, false)
      ).to.be.revertedWithCustomError(core, "NotAgentOwner");

      await core.connect(agentOwner1).setAgentActive(agentId, false);
      expect((await core.agents(agentId)).active).to.equal(false);
      expect(await core.activeAgents()).to.equal(0n);
    });

    it("transfers ownership and updates the owner index", async () => {
      const { core, agentOwner1, agentOwner2 } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);

      await core.connect(agentOwner1).transferAgentOwnership(agentId, await agentOwner2.getAddress());

      expect((await core.agents(agentId)).owner).to.equal(await agentOwner2.getAddress());
      expect(await core.getAgentsByOwner(await agentOwner1.getAddress())).to.deep.equal([]);
      expect(await core.getAgentsByOwner(await agentOwner2.getAddress())).to.deep.equal([agentId]);
    });

    it("restricts setAgentTier to VERIFIER_ROLE", async () => {
      const { core, admin, agentOwner1, other } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);

      await expect(core.connect(other).setAgentTier(agentId, 2)).to.be.reverted;
      await core.connect(admin).setAgentTier(agentId, 2);
      expect((await core.agents(agentId)).tier).to.equal(2);
    });
  });

  describe("Job marketplace", () => {
    it("runs the full happy path and updates agent stats + reputation", async () => {
      const { core, usdc, employer, agentOwner1, treasury } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 7 * DAY;

      await core.connect(employer).postJob(0, agentId, ethers.id("task-cid"), USDC(100), deadline);
      const jobId = 1n;
      expect(await usdc.balanceOf(await core.getAddress())).to.equal(USDC(100));

      await core.connect(agentOwner1).acceptJob(jobId);
      await core.connect(agentOwner1).submitDeliverable(jobId, ethers.id("deliverable-cid"));

      const before = await usdc.balanceOf(await agentOwner1.getAddress());
      await core.connect(employer).confirmDelivery(jobId, 5);
      const after = await usdc.balanceOf(await agentOwner1.getAddress());

      expect(after - before).to.equal(USDC(100));
      expect(await usdc.balanceOf(await treasury.getAddress())).to.equal(0n); // protocolFeeBps is 0 by default

      const agent = await core.agents(agentId);
      expect(agent.jobsCompleted).to.equal(1n);
      expect(agent.usdcRevenue).to.equal(USDC(100));
      expect(agent.reputationBps).to.equal(10_000); // single 5-star rating => 5*2000

      const job = await core.jobs(jobId);
      expect(job.status).to.equal(2); // Completed
    });

    it("rejects posting a job against an inactive or unknown agent", async () => {
      const { core, employer, agentOwner1 } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await core.connect(agentOwner1).setAgentActive(agentId, false);

      const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + DAY;
      await expect(core.connect(employer).postJob(0, agentId, ethers.id("t"), USDC(10), deadline)).to.be.revertedWithCustomError(
        core,
        "AgentNotActive"
      );
      await expect(core.connect(employer).postJob(0, 999, ethers.id("t"), USDC(10), deadline)).to.be.revertedWithCustomError(
        core,
        "AgentNotActive"
      );
    });

    it("posts an open job (hiredAgentId 0) that any active agent can claim via acceptOpenJob", async () => {
      const { core, usdc, employer, agentOwner1 } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + DAY;

      await core.connect(employer).postJob(0, 0, ethers.id("open-task"), USDC(20), deadline);
      const jobId = 1n;
      expect((await core.jobs(jobId)).hiredAgentId).to.equal(0n);
      expect(await usdc.balanceOf(await core.getAddress())).to.equal(USDC(20));

      await core.connect(agentOwner1).acceptOpenJob(jobId, agentId);
      const job = await core.jobs(jobId);
      expect(job.hiredAgentId).to.equal(agentId);
      expect(job.status).to.equal(1); // Active

      await core.connect(agentOwner1).submitDeliverable(jobId, ethers.id("deliverable"));
      await expect(core.connect(employer).confirmDelivery(jobId, 5)).to.not.be.reverted;
    });

    it("rejects claiming an open job a second time, claiming with an inactive agent, or using the wrong accept path", async () => {
      const { core, employer, agentOwner1, agentOwner2 } = await deployFixture();
      const agentId1 = await registerAgent(core, agentOwner1, "open-claimer-1");
      const agentId2 = await registerAgent(core, agentOwner2, "open-claimer-2");
      await core.connect(agentOwner2).setAgentActive(agentId2, false);
      const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + DAY;

      // directed acceptJob on an open job (no directed hire to accept)
      await core.connect(employer).postJob(0, 0, ethers.id("t1"), USDC(10), deadline);
      await expect(core.connect(agentOwner1).acceptJob(1)).to.be.revertedWithCustomError(core, "InvalidJobStatus");

      // acceptOpenJob with an inactive agent
      await expect(core.connect(agentOwner2).acceptOpenJob(1, agentId2)).to.be.revertedWithCustomError(core, "AgentNotActive");

      // first claim wins
      await core.connect(agentOwner1).acceptOpenJob(1, agentId1);
      // second claim attempt on the now-directed job fails (hiredAgentId != 0)
      await expect(core.connect(agentOwner2).acceptOpenJob(1, agentId1)).to.be.revertedWithCustomError(core, "InvalidJobStatus");

      // acceptOpenJob on a job that was always directed
      await core.connect(employer).postJob(0, agentId1, ethers.id("t2"), USDC(10), deadline);
      await expect(core.connect(agentOwner1).acceptOpenJob(2, agentId1)).to.be.revertedWithCustomError(core, "InvalidJobStatus");
    });

    it("refunds the employer on cancelJob while still Pending", async () => {
      const { core, usdc, employer, agentOwner1 } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + DAY;
      await core.connect(employer).postJob(0, agentId, ethers.id("t"), USDC(50), deadline);

      const before = await usdc.balanceOf(await employer.getAddress());
      await core.connect(employer).cancelJob(1);
      const after = await usdc.balanceOf(await employer.getAddress());

      expect(after - before).to.equal(USDC(50));
      expect((await core.jobs(1)).status).to.equal(4); // Cancelled
    });

    it("supports disputeJob -> resolveDispute in both directions", async () => {
      const { core, usdc, admin, employer, agentOwner1, agentOwner2 } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + DAY;

      // Resolve toward the agent.
      await core.connect(employer).postJob(0, agentId, ethers.id("t1"), USDC(20), deadline);
      await core.connect(agentOwner1).acceptJob(1);
      await core.connect(employer).disputeJob(1);
      await expect(core.connect(agentOwner2).resolveDispute(1, true)).to.be.reverted;

      const agentBalBefore = await usdc.balanceOf(await agentOwner1.getAddress());
      await core.connect(admin).resolveDispute(1, true);
      expect(await usdc.balanceOf(await agentOwner1.getAddress())).to.equal(agentBalBefore + USDC(20));
      expect((await core.jobs(1)).status).to.equal(5); // Resolved

      // Resolve toward the employer (refund).
      await core.connect(employer).postJob(0, agentId, ethers.id("t2"), USDC(30), deadline);
      await core.connect(agentOwner1).acceptJob(2);
      await core.connect(agentOwner1).disputeJob(2);

      const employerBalBefore = await usdc.balanceOf(await employer.getAddress());
      await core.connect(admin).resolveDispute(2, false);
      expect(await usdc.balanceOf(await employer.getAddress())).to.equal(employerBalBefore + USDC(30));
      expect((await core.agents(agentId)).jobsFailed).to.equal(1n);
    });

    it("allows autoReleaseExpired only after the deadline and with a submitted deliverable", async () => {
      const { core, usdc, employer, agentOwner1 } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + DAY;
      await core.connect(employer).postJob(0, agentId, ethers.id("t"), USDC(40), deadline);
      await core.connect(agentOwner1).acceptJob(1);

      await expect(core.autoReleaseExpired(1)).to.be.revertedWithCustomError(core, "DeadlineNotPassed");

      await ethers.provider.send("evm_increaseTime", [DAY + 1]);
      await ethers.provider.send("evm_mine", []);

      await expect(core.autoReleaseExpired(1)).to.be.revertedWithCustomError(core, "NoDeliverableSubmitted");

      await core.connect(agentOwner1).submitDeliverable(1, ethers.id("d"));
      const before = await usdc.balanceOf(await agentOwner1.getAddress());
      await core.autoReleaseExpired(1);
      expect(await usdc.balanceOf(await agentOwner1.getAddress())).to.equal(before + USDC(40));
    });
  });

  describe("Access control & pausability", () => {
    it("restricts admin-only setters to DEFAULT_ADMIN_ROLE", async () => {
      const { core, other } = await deployFixture();
      await expect(core.connect(other).setProtocolFeeBps(100)).to.be.reverted;
      await expect(core.connect(other).setRegistrationFee(USDC(1))).to.be.reverted;
      await expect(core.connect(other).setTreasury(await other.getAddress())).to.be.reverted;
      await expect(core.connect(other).withdrawStuckTokens(ethers.ZeroAddress, 0, await other.getAddress())).to.be.reverted;
    });

    it("restricts pause/unpause to PAUSER_ROLE and blocks state-changing calls while paused", async () => {
      const { core, admin, employer, agentOwner1, other } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);

      await expect(core.connect(other).pause()).to.be.reverted;
      await core.connect(admin).pause();

      const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + DAY;
      await expect(core.connect(employer).postJob(0, agentId, ethers.id("t"), USDC(10), deadline)).to.be.revertedWithCustomError(
        core,
        "EnforcedPause"
      );

      await core.connect(admin).unpause();
      await expect(core.connect(employer).postJob(0, agentId, ethers.id("t"), USDC(10), deadline)).to.not.be.reverted;
    });

    it("only DEFAULT_ADMIN_ROLE can authorize a UUPS upgrade", async () => {
      const { core, registry, other } = await deployFixture();
      const CoreFactory = await ethers.getContractFactory("ClawdHQCore");
      await expect(
        upgrades.upgradeProxy(await core.getAddress(), CoreFactory.connect(other), {
          unsafeAllow: ["constructor"],
          constructorArgs: [await registry.getAddress()],
        })
      ).to.be.reverted;
    });
  });
});
