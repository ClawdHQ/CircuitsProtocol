import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import type { ClawdHQCore, ClawdHQGovernor, ClawdHQStaking, MockUSDC } from "../typechain-types";
import type { Signer } from "ethers";

const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
const DAY = 24 * 60 * 60;
const CATEGORY_PARAMETERS = 0;
const CATEGORY_TREASURY = 1;

enum ProposalState {
  Active,
  Succeeded,
  Defeated,
  QuorumNotMet,
  Canceled,
  Executed,
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

  const StakingFactory = await ethers.getContractFactory("ClawdHQStaking");
  const staking = (await upgrades.deployProxy(
    StakingFactory,
    [await admin.getAddress(), await core.getAddress(), await usdc.getAddress()],
    { unsafeAllow: ["constructor"] }
  )) as unknown as ClawdHQStaking;

  const GovernorFactory = await ethers.getContractFactory("ClawdHQGovernor");
  const governor = (await upgrades.deployProxy(GovernorFactory, [
    await admin.getAddress(),
    await core.getAddress(),
    await staking.getAddress(),
  ])) as unknown as ClawdHQGovernor;

  for (const signer of [employer, agentOwner1, agentOwner2, other]) {
    await usdc.mint(await signer.getAddress(), USDC(1_000_000));
    await usdc.connect(signer).approve(await core.getAddress(), ethers.MaxUint256);
    await usdc.connect(signer).approve(await staking.getAddress(), ethers.MaxUint256);
  }

  return { admin, treasury, employer, agentOwner1, agentOwner2, other, usdc, core, staking, governor };
}

async function registerAgent(core: ClawdHQCore, owner: Signer, name = "agent-one") {
  const tx = await core
    .connect(owner)
    .registerAgent(name, "ipfs://uri", "https://endpoint.example", ethers.ZeroHash, true, true, true);
  await tx.wait();
  return core.agentIdByNameHash(ethers.keccak256(ethers.toUtf8Bytes(name)));
}

/** Runs one full job lifecycle (post -> accept -> submit -> confirm) to bump `agentId`'s
 * on-chain `jobsCompleted` by exactly one — the only way to legitimately earn that counter,
 * used here to satisfy ClawdHQGovernor's propose/vote eligibility gates. */
async function completeOneJob(core: ClawdHQCore, employer: Signer, agentOwner: Signer, agentId: bigint) {
  const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 7 * DAY;
  const tx = await core.connect(employer).postJob(0, agentId, ethers.id(`task-${Date.now()}-${Math.random()}`), USDC(10), deadline);
  const receipt = await tx.wait();
  const jobId = (await core.queryFilter(core.filters.JobPosted(), receipt!.blockNumber, receipt!.blockNumber))[0].args.jobId;

  await core.connect(agentOwner).acceptJob(jobId);
  await core.connect(agentOwner).submitDeliverable(jobId, ethers.id("deliverable"));
  await core.connect(employer).confirmDelivery(jobId, 5);
}

async function completeJobs(core: ClawdHQCore, employer: Signer, agentOwner: Signer, agentId: bigint, count: number) {
  for (let i = 0; i < count; i++) await completeOneJob(core, employer, agentOwner, agentId);
}

describe("ClawdHQGovernor", () => {
  describe("Proposing", () => {
    it("rejects a proposal from an agent below the jobsCompleted threshold", async () => {
      const { core, governor, agentOwner1 } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);

      await expect(
        governor.connect(agentOwner1).createProposal(agentId, "Title", "Description", CATEGORY_PARAMETERS, 3 * DAY)
      ).to.be.revertedWithCustomError(governor, "NotEligibleToPropose");
    });

    it("rejects a proposal from someone who isn't the agent's owner", async () => {
      const { core, employer, governor, agentOwner1 } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await completeJobs(core, employer, agentOwner1, agentId, 10);

      await expect(
        governor.connect(employer).createProposal(agentId, "Title", "Description", CATEGORY_PARAMETERS, 3 * DAY)
      ).to.be.revertedWithCustomError(governor, "NotAgentOwner");
    });

    it("accepts a proposal once the agent has enough jobsCompleted, using the category's default quorum", async () => {
      const { core, employer, governor, agentOwner1 } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await completeJobs(core, employer, agentOwner1, agentId, 10);

      const tx = await governor.connect(agentOwner1).createProposal(agentId, "Raise SLA window", "Because reasons", CATEGORY_PARAMETERS, 7 * DAY);
      await expect(tx).to.emit(governor, "ProposalCreated");

      const proposal = await governor.getProposal(1);
      expect(proposal.proposer).to.equal(await agentOwner1.getAddress());
      expect(proposal.proposerAgentId).to.equal(agentId);
      expect(proposal.quorumRequired).to.equal(await governor.quorumByCategory(CATEGORY_PARAMETERS));
      expect(await governor.state(1)).to.equal(ProposalState.Active);
    });

    it("rejects an out-of-range voting period, invalid category, and oversized title/description", async () => {
      const { core, employer, governor, agentOwner1 } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await completeJobs(core, employer, agentOwner1, agentId, 10);

      await expect(
        governor.connect(agentOwner1).createProposal(agentId, "T", "D", CATEGORY_PARAMETERS, 1 * DAY)
      ).to.be.revertedWithCustomError(governor, "InvalidVotingPeriod");
      await expect(
        governor.connect(agentOwner1).createProposal(agentId, "T", "D", 99, 3 * DAY)
      ).to.be.revertedWithCustomError(governor, "InvalidCategory");
      await expect(
        governor.connect(agentOwner1).createProposal(agentId, "T".repeat(200), "D", CATEGORY_PARAMETERS, 3 * DAY)
      ).to.be.revertedWithCustomError(governor, "TitleInvalidLength");
      await expect(
        governor.connect(agentOwner1).createProposal(agentId, "T", "", CATEGORY_PARAMETERS, 3 * DAY)
      ).to.be.revertedWithCustomError(governor, "DescriptionInvalidLength");
    });
  });

  describe("Voting", () => {
    async function proposalFixture() {
      const fixture = await deployFixture();
      const { core, employer, governor, agentOwner1 } = fixture;
      const proposerAgentId = await registerAgent(core, agentOwner1, "proposer-agent");
      await completeJobs(core, employer, agentOwner1, proposerAgentId, 10);
      await governor.connect(agentOwner1).createProposal(proposerAgentId, "Title", "Description", CATEGORY_PARAMETERS, 3 * DAY);
      return { ...fixture, proposerAgentId, proposalId: 1n };
    }

    it("weights a vote by the voter agent's posted USDC bond, requires jobsCompleted, and blocks double-voting", async () => {
      const { core, employer, staking, governor, agentOwner2, proposalId } = await proposalFixture();
      const voterAgentId = await registerAgent(core, agentOwner2, "voter-agent");

      await expect(governor.connect(agentOwner2).vote(proposalId, voterAgentId, true)).to.be.revertedWithCustomError(governor, "NotEligibleToVote");

      await completeJobs(core, employer, agentOwner2, voterAgentId, 1);
      await expect(governor.connect(agentOwner2).vote(proposalId, voterAgentId, true)).to.be.revertedWithCustomError(governor, "NoVotingWeight");

      await staking.connect(agentOwner2).postBond(voterAgentId, USDC(1_000));
      await expect(governor.connect(agentOwner2).vote(proposalId, voterAgentId, true))
        .to.emit(governor, "VoteCast")
        .withArgs(proposalId, voterAgentId, await agentOwner2.getAddress(), true, USDC(1_000));

      const proposal = await governor.getProposal(proposalId);
      expect(proposal.votesFor).to.equal(USDC(1_000));

      await expect(governor.connect(agentOwner2).vote(proposalId, voterAgentId, true)).to.be.revertedWithCustomError(governor, "AlreadyVoted");
    });

    it("rejects voting from a non-owner of the voting agent", async () => {
      const { core, employer, staking, governor, agentOwner2, other, proposalId } = await proposalFixture();
      const voterAgentId = await registerAgent(core, agentOwner2, "voter-agent");
      await completeJobs(core, employer, agentOwner2, voterAgentId, 1);
      await staking.connect(agentOwner2).postBond(voterAgentId, USDC(500));

      await expect(governor.connect(other).vote(proposalId, voterAgentId, true)).to.be.revertedWithCustomError(governor, "NotAgentOwner");
    });

    it("rejects voting once the proposal's voting window has ended", async () => {
      const { core, employer, staking, governor, agentOwner2, proposalId } = await proposalFixture();
      const voterAgentId = await registerAgent(core, agentOwner2, "voter-agent");
      await completeJobs(core, employer, agentOwner2, voterAgentId, 1);
      await staking.connect(agentOwner2).postBond(voterAgentId, USDC(500));

      await ethers.provider.send("evm_increaseTime", [3 * DAY + 1]);
      await ethers.provider.send("evm_mine", []);

      await expect(governor.connect(agentOwner2).vote(proposalId, voterAgentId, true)).to.be.revertedWithCustomError(governor, "ProposalNotActive");
    });

    it("blocks the bond-cycling Sybil pattern (register N agents, cycle one bond) via the jobsCompleted-to-vote gate", async () => {
      const { core, staking, governor, agentOwner2, proposalId } = await proposalFixture();

      // Register several fresh agents and try to vote each with the same freshly-posted bond,
      // without ever having completed a real job — every one of these must fail, capping the
      // Sybil's effective voting power at zero regardless of how many agentIds it registers.
      for (let i = 0; i < 3; i++) {
        const sybilAgentId = await registerAgent(core, agentOwner2, `sybil-${i}`);
        await staking.connect(agentOwner2).postBond(sybilAgentId, USDC(1_000));
        await expect(governor.connect(agentOwner2).vote(proposalId, sybilAgentId, true)).to.be.revertedWithCustomError(governor, "NotEligibleToVote");
        await staking.connect(agentOwner2).withdrawBond(sybilAgentId, USDC(1_000));
      }

      const proposal = await governor.getProposal(proposalId);
      expect(proposal.votesFor).to.equal(0n);
    });
  });

  describe("Quorum & state transitions", () => {
    it("moves from Active to Defeated/Succeeded/QuorumNotMet after the voting window closes", async () => {
      const { core, employer, staking, governor, agentOwner1, agentOwner2 } = await deployFixture();
      const proposerAgentId = await registerAgent(core, agentOwner1, "proposer-agent");
      await completeJobs(core, employer, agentOwner1, proposerAgentId, 10);
      await governor.connect(agentOwner1).createProposal(proposerAgentId, "Title", "Description", CATEGORY_PARAMETERS, 3 * DAY);

      const voterAgentId = await registerAgent(core, agentOwner2, "voter-agent");
      await completeJobs(core, employer, agentOwner2, voterAgentId, 1);
      await staking.connect(agentOwner2).postBond(voterAgentId, USDC(1_000)); // below the 5,000 USDC default quorum
      await governor.connect(agentOwner2).vote(1, voterAgentId, true);

      expect(await governor.state(1)).to.equal(ProposalState.Active);

      await ethers.provider.send("evm_increaseTime", [3 * DAY + 1]);
      await ethers.provider.send("evm_mine", []);

      expect(await governor.state(1)).to.equal(ProposalState.QuorumNotMet);
    });

    it("reaches Succeeded once quorum is met and votesFor outweighs votesAgainst", async () => {
      const { core, employer, staking, governor, admin, agentOwner1, agentOwner2 } = await deployFixture();
      await governor.connect(admin).setQuorum(CATEGORY_PARAMETERS, USDC(1_000)); // lower quorum for a fast test

      const proposerAgentId = await registerAgent(core, agentOwner1, "proposer-agent");
      await completeJobs(core, employer, agentOwner1, proposerAgentId, 10);
      await governor.connect(agentOwner1).createProposal(proposerAgentId, "Title", "Description", CATEGORY_PARAMETERS, 3 * DAY);

      const voterAgentId = await registerAgent(core, agentOwner2, "voter-agent");
      await completeJobs(core, employer, agentOwner2, voterAgentId, 1);
      await staking.connect(agentOwner2).postBond(voterAgentId, USDC(1_000));
      await governor.connect(agentOwner2).vote(1, voterAgentId, true);

      await ethers.provider.send("evm_increaseTime", [3 * DAY + 1]);
      await ethers.provider.send("evm_mine", []);

      expect(await governor.state(1)).to.equal(ProposalState.Succeeded);
    });
  });

  describe("Execution & guardian veto", () => {
    async function succeededProposalFixture() {
      const fixture = await deployFixture();
      const { core, employer, staking, governor, admin, agentOwner1, agentOwner2 } = fixture;
      await governor.connect(admin).setQuorum(CATEGORY_PARAMETERS, USDC(1_000));

      const proposerAgentId = await registerAgent(core, agentOwner1, "proposer-agent");
      await completeJobs(core, employer, agentOwner1, proposerAgentId, 10);
      await governor.connect(agentOwner1).createProposal(proposerAgentId, "Title", "Description", CATEGORY_PARAMETERS, 3 * DAY);

      const voterAgentId = await registerAgent(core, agentOwner2, "voter-agent");
      await completeJobs(core, employer, agentOwner2, voterAgentId, 1);
      await staking.connect(agentOwner2).postBond(voterAgentId, USDC(1_000));
      await governor.connect(agentOwner2).vote(1, voterAgentId, true);

      return { ...fixture, proposalId: 1n };
    }

    it("blocks execute before the voting window even closes, and before the 1-day timelock elapses", async () => {
      const { governor, other, proposalId } = await succeededProposalFixture();

      await expect(governor.connect(other).execute(proposalId)).to.be.revertedWithCustomError(governor, "ProposalNotSucceeded");

      await ethers.provider.send("evm_increaseTime", [3 * DAY + 1]);
      await ethers.provider.send("evm_mine", []);
      expect(await governor.state(proposalId)).to.equal(ProposalState.Succeeded);

      await expect(governor.connect(other).execute(proposalId)).to.be.revertedWithCustomError(governor, "ExecutionTimelockNotElapsed");
    });

    it("executes permissionlessly once Succeeded and the timelock has elapsed, and blocks double-execution", async () => {
      const { governor, other, proposalId } = await succeededProposalFixture();

      await ethers.provider.send("evm_increaseTime", [3 * DAY + 1 * DAY + 1]);
      await ethers.provider.send("evm_mine", []);

      await expect(governor.connect(other).execute(proposalId)).to.emit(governor, "ProposalExecuted").withArgs(proposalId);
      expect(await governor.state(proposalId)).to.equal(ProposalState.Executed);

      await expect(governor.connect(other).execute(proposalId)).to.be.revertedWithCustomError(governor, "ProposalAlreadyExecuted");
    });

    it("lets a GUARDIAN_ROLE holder cancel a proposal, blocking further votes and execution", async () => {
      const { core, employer, governor, admin, agentOwner1, agentOwner2, other } = await deployFixture();
      const proposerAgentId = await registerAgent(core, agentOwner1, "proposer-agent");
      await completeJobs(core, employer, agentOwner1, proposerAgentId, 10);
      await governor.connect(agentOwner1).createProposal(proposerAgentId, "Title", "Description", CATEGORY_PARAMETERS, 3 * DAY);

      await expect(governor.connect(other).cancel(1)).to.be.reverted; // not a guardian

      await expect(governor.connect(admin).cancel(1)).to.emit(governor, "ProposalCanceled").withArgs(1);
      expect(await governor.state(1)).to.equal(ProposalState.Canceled);

      const voterAgentId = await registerAgent(core, agentOwner2, "voter-agent");
      await completeJobs(core, employer, agentOwner2, voterAgentId, 1);
      await expect(governor.connect(agentOwner2).vote(1, voterAgentId, true)).to.be.revertedWithCustomError(governor, "ProposalNotActive");

      await ethers.provider.send("evm_increaseTime", [3 * DAY + 1 * DAY + 1]);
      await ethers.provider.send("evm_mine", []);
      await expect(governor.connect(other).execute(1)).to.be.revertedWithCustomError(governor, "ProposalAlreadyCanceled");
    });
  });

  describe("Admin", () => {
    it("restricts setQuorum/setMinJobsCompletedToPropose/setMinJobsCompletedToVote to DEFAULT_ADMIN_ROLE", async () => {
      const { governor, other } = await deployFixture();
      await expect(governor.connect(other).setQuorum(CATEGORY_TREASURY, USDC(1))).to.be.reverted;
      await expect(governor.connect(other).setMinJobsCompletedToPropose(0)).to.be.reverted;
      await expect(governor.connect(other).setMinJobsCompletedToVote(0)).to.be.reverted;
    });

    it("lets an admin retune quorum and eligibility thresholds per category", async () => {
      const { governor, admin } = await deployFixture();
      await expect(governor.connect(admin).setQuorum(CATEGORY_TREASURY, USDC(9_999)))
        .to.emit(governor, "QuorumUpdated")
        .withArgs(CATEGORY_TREASURY, USDC(9_999));
      expect(await governor.quorumByCategory(CATEGORY_TREASURY)).to.equal(USDC(9_999));

      await governor.connect(admin).setMinJobsCompletedToPropose(0);
      expect(await governor.minJobsCompletedToPropose()).to.equal(0n);
    });

    it("restricts pause/unpause to PAUSER_ROLE and blocks proposing/voting while paused", async () => {
      const { core, employer, governor, admin, other, agentOwner1 } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await completeJobs(core, employer, agentOwner1, agentId, 10);

      await expect(governor.connect(other).pause()).to.be.reverted;
      await governor.connect(admin).pause();

      await expect(
        governor.connect(agentOwner1).createProposal(agentId, "T", "D", CATEGORY_PARAMETERS, 3 * DAY)
      ).to.be.revertedWithCustomError(governor, "EnforcedPause");

      await governor.connect(admin).unpause();
      await expect(governor.connect(agentOwner1).createProposal(agentId, "T", "D", CATEGORY_PARAMETERS, 3 * DAY)).to.not.be.reverted;
    });
  });
});
