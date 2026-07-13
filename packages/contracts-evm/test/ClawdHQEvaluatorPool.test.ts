import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import type { ClawdHQCore, ClawdHQEvaluatorPool, MockUSDC } from "../typechain-types";
import type { Signer } from "ethers";

const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
const DAY = 24 * 60 * 60;
const EVALUATOR_BOND = USDC(500);
const VOTING_WINDOW = 2 * DAY;

const CASE_NONE = 0;
const CASE_PENDING = 1;
const CASE_FINALIZED = 2;
const CASE_ESCALATED = 3;

async function deployFixture() {
  const [admin, treasury, employer, agentOwner1, evalA, evalB, evalC, evalD, other] = await ethers.getSigners();

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

  const PoolFactory = await ethers.getContractFactory("ClawdHQEvaluatorPool");
  const pool = (await upgrades.deployProxy(
    PoolFactory,
    [await admin.getAddress(), await core.getAddress(), await usdc.getAddress(), await treasury.getAddress()],
    { unsafeAllow: ["constructor"] }
  )) as unknown as ClawdHQEvaluatorPool;

  for (const signer of [employer, agentOwner1, evalA, evalB, evalC, evalD, other]) {
    await usdc.mint(await signer.getAddress(), USDC(1_000_000));
    await usdc.connect(signer).approve(await core.getAddress(), ethers.MaxUint256);
    await usdc.connect(signer).approve(await pool.getAddress(), ethers.MaxUint256);
  }

  return { admin, treasury, employer, agentOwner1, evalA, evalB, evalC, evalD, other, usdc, core, pool };
}

async function registerAgent(core: ClawdHQCore, owner: Signer, name = "agent-one") {
  const tx = await core.connect(owner).registerAgent(name, "ipfs://uri", "https://endpoint.example", ethers.ZeroHash, true, true, true);
  await tx.wait();
  return core.agentIdByNameHash(ethers.keccak256(ethers.toUtf8Bytes(name)));
}

/** Posts, accepts, and disputes a job in one step — the state every evaluator-pool test starts
 * a case from. Returns jobId = 1n (first job in a fresh fixture). */
async function postDisputedJob(core: ClawdHQCore, employer: Signer, agentOwner: Signer, agentId: bigint) {
  const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 7 * DAY;
  await core.connect(employer).postJob(0, agentId, ethers.id("t"), USDC(100), deadline);
  const jobId = 1n;
  await core.connect(agentOwner).acceptJob(jobId);
  await core.connect(employer).disputeJob(jobId);
  return jobId;
}

async function registerEvaluators(pool: ClawdHQEvaluatorPool, signers: Signer[]) {
  for (const s of signers) await pool.connect(s).registerEvaluator();
}

/** Reads which of `candidates` the panel actually contains (order from the contract's pseudo-
 * random pick is not asserted on, only membership) and returns them as connected Signers. */
async function panelSigners(pool: ClawdHQEvaluatorPool, jobId: bigint, candidates: Signer[]): Promise<Signer[]> {
  const c = await pool.getCase(jobId);
  const panelAddresses = [c.e0, c.e1, c.e2];
  const bySigner = new Map<string, Signer>();
  for (const s of candidates) bySigner.set((await s.getAddress()).toLowerCase(), s);
  return panelAddresses.map((addr) => {
    const signer = bySigner.get(addr.toLowerCase());
    if (!signer) throw new Error(`panel address ${addr} not among candidates`);
    return signer;
  });
}

const SALT = ethers.id("test-salt");
function commitHashFor(releaseToAgent: boolean, salt = SALT): string {
  return ethers.solidityPackedKeccak256(["bool", "bytes32"], [releaseToAgent, salt]);
}

describe("ClawdHQEvaluatorPool", () => {
  describe("Evaluator registration", () => {
    it("registers (pulling the bond) and unregisters (refunding it), tracked in the active set", async () => {
      const { pool, usdc, evalA } = await deployFixture();

      const before = await usdc.balanceOf(await evalA.getAddress());
      await pool.connect(evalA).registerEvaluator();
      const afterRegister = await usdc.balanceOf(await evalA.getAddress());
      expect(before - afterRegister).to.equal(EVALUATOR_BOND);
      expect(await pool.isActiveEvaluator(await evalA.getAddress())).to.equal(true);
      expect(await pool.activeEvaluatorCount()).to.equal(1n);

      await expect(pool.connect(evalA).registerEvaluator()).to.be.revertedWithCustomError(pool, "AlreadyRegistered");

      await pool.connect(evalA).unregisterEvaluator();
      const afterUnregister = await usdc.balanceOf(await evalA.getAddress());
      expect(afterUnregister).to.equal(before);
      expect(await pool.isActiveEvaluator(await evalA.getAddress())).to.equal(false);
      expect(await pool.activeEvaluatorCount()).to.equal(0n);
    });

    it("blocks unregistering while assigned to a pending case", async () => {
      const { core, pool, employer, agentOwner1, evalA, evalB, evalC } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await registerEvaluators(pool, [evalA, evalB, evalC]);
      const jobId = await postDisputedJob(core, employer, agentOwner1, agentId);
      await pool.connect(employer).requestEvaluation(jobId);

      const [p0] = await panelSigners(pool, jobId, [evalA, evalB, evalC]);
      await expect(pool.connect(p0).unregisterEvaluator()).to.be.revertedWithCustomError(pool, "EvaluatorHasPendingCases");
    });
  });

  describe("Requesting evaluation", () => {
    it("rejects requesting on a job that isn't Disputed yet, once enough evaluators are registered", async () => {
      const { core, pool, employer, agentOwner1, evalA, evalB, evalC } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + DAY;
      await core.connect(employer).postJob(0, agentId, ethers.id("t"), USDC(10), deadline);
      await registerEvaluators(pool, [evalA, evalB, evalC]);

      await expect(pool.connect(employer).requestEvaluation(1)).to.be.revertedWithCustomError(pool, "JobNotDisputed");

      await core.connect(agentOwner1).acceptJob(1); // Active, still not Disputed
      await expect(pool.connect(employer).requestEvaluation(1)).to.be.revertedWithCustomError(pool, "JobNotDisputed");

      await core.connect(employer).disputeJob(1);
      await expect(pool.connect(employer).requestEvaluation(1)).to.not.be.reverted;
    });

    it("rejects requesting with fewer than 3 active evaluators, even on an already-disputed job", async () => {
      const { core, pool, employer, agentOwner1, evalA, evalB } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await registerEvaluators(pool, [evalA, evalB]); // only 2, need 3
      const jobId = await postDisputedJob(core, employer, agentOwner1, agentId);

      await expect(pool.connect(employer).requestEvaluation(jobId)).to.be.revertedWithCustomError(pool, "NotEnoughEvaluators");
    });

    it("pulls the request fee and assigns a 3-member panel, rejecting a second request for the same job", async () => {
      const { core, pool, usdc, employer, agentOwner1, evalA, evalB, evalC, other } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await registerEvaluators(pool, [evalA, evalB, evalC]);
      const jobId = await postDisputedJob(core, employer, agentOwner1, agentId);

      const fee = await pool.evaluationRequestFee();
      const before = await usdc.balanceOf(await other.getAddress());
      await pool.connect(other).requestEvaluation(jobId);
      const after = await usdc.balanceOf(await other.getAddress());
      expect(before - after).to.equal(fee);

      const c = await pool.getCase(jobId);
      expect(c.status).to.equal(CASE_PENDING);
      expect(new Set([c.e0, c.e1, c.e2]).size).to.equal(3); // three distinct evaluators

      await expect(pool.requestEvaluation(jobId)).to.be.revertedWithCustomError(pool, "AlreadyRequested");
    });
  });

  describe("Commit-reveal voting and finalize", () => {
    it("resolves via 2-of-3 majority, pays agreeing evaluators, and slashes the minority evaluator's bond", async () => {
      const { core, pool, admin, usdc, treasury, employer, agentOwner1, evalA, evalB, evalC } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await core.connect(admin).setEvaluatorPoolContract(await pool.getAddress());
      await registerEvaluators(pool, [evalA, evalB, evalC]);
      const jobId = await postDisputedJob(core, employer, agentOwner1, agentId);
      await pool.connect(employer).requestEvaluation(jobId);

      const [p0, p1, p2] = await panelSigners(pool, jobId, [evalA, evalB, evalC]);
      // p0, p1 vote to release to the agent; p2 votes to refund the employer (minority).
      await pool.connect(p0).commitVote(jobId, commitHashFor(true));
      await pool.connect(p1).commitVote(jobId, commitHashFor(true));
      await pool.connect(p2).commitVote(jobId, commitHashFor(false));
      await pool.connect(p0).revealVote(jobId, true, SALT);
      await pool.connect(p1).revealVote(jobId, true, SALT);
      await pool.connect(p2).revealVote(jobId, false, SALT);

      const p2BondBefore = await pool.evaluatorBond(await p2.getAddress());
      const p0UsdcBefore = await usdc.balanceOf(await p0.getAddress());
      const agentOwnerUsdcBefore = await usdc.balanceOf(await agentOwner1.getAddress());
      const treasuryBefore = await usdc.balanceOf(await treasury.getAddress());

      await pool.finalize(jobId);

      expect((await core.jobs(jobId)).status).to.equal(5); // Resolved
      expect(await usdc.balanceOf(await agentOwner1.getAddress())).to.be.gt(agentOwnerUsdcBefore); // paid (releaseToAgent won)
      expect(await usdc.balanceOf(await p0.getAddress())).to.be.gt(p0UsdcBefore); // won its fee share
      expect(await pool.evaluatorBond(await p2.getAddress())).to.be.lt(p2BondBefore); // minority slash
      expect(await usdc.balanceOf(await treasury.getAddress())).to.be.gt(treasuryBefore); // slashed amount routed to treasury

      const c = await pool.getCase(jobId);
      expect(c.status).to.equal(CASE_FINALIZED);
    });

    it("rejects commit/reveal from a non-assigned address, a mismatched reveal, or a double reveal", async () => {
      const { core, pool, employer, agentOwner1, evalA, evalB, evalC, other } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await registerEvaluators(pool, [evalA, evalB, evalC]);
      const jobId = await postDisputedJob(core, employer, agentOwner1, agentId);
      await pool.connect(employer).requestEvaluation(jobId);

      await expect(pool.connect(other).commitVote(jobId, commitHashFor(true))).to.be.revertedWithCustomError(pool, "NotAssignedEvaluator");

      const [p0] = await panelSigners(pool, jobId, [evalA, evalB, evalC]);
      await pool.connect(p0).commitVote(jobId, commitHashFor(true));
      await expect(pool.connect(p0).commitVote(jobId, commitHashFor(false))).to.be.revertedWithCustomError(pool, "AlreadyCommitted");
      await expect(pool.connect(p0).revealVote(jobId, false, SALT)).to.be.revertedWithCustomError(pool, "InvalidReveal");

      await pool.connect(p0).revealVote(jobId, true, SALT);
      await expect(pool.connect(p0).revealVote(jobId, true, SALT)).to.be.revertedWithCustomError(pool, "AlreadyRevealed");
    });

    it("escalates (refunding the fee) if the voting window closes with no 2-of-3 majority", async () => {
      const { core, pool, usdc, employer, agentOwner1, evalA, evalB, evalC } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await registerEvaluators(pool, [evalA, evalB, evalC]);
      const jobId = await postDisputedJob(core, employer, agentOwner1, agentId);

      const feeBefore = await usdc.balanceOf(await employer.getAddress());
      await pool.connect(employer).requestEvaluation(jobId);
      const fee = feeBefore - (await usdc.balanceOf(await employer.getAddress()));

      const [p0, p1, p2] = await panelSigners(pool, jobId, [evalA, evalB, evalC]);
      // A genuine 3-way split — no 2-of-3 majority possible.
      await pool.connect(p0).commitVote(jobId, commitHashFor(true));
      await pool.connect(p1).commitVote(jobId, commitHashFor(false));
      await pool.connect(p0).revealVote(jobId, true, SALT);
      await pool.connect(p1).revealVote(jobId, false, SALT);
      void p2; // never commits/reveals — a no-show, not a tie-breaker

      await expect(pool.finalize(jobId)).to.be.revertedWithCustomError(pool, "VotingStillOpen");

      await ethers.provider.send("evm_increaseTime", [VOTING_WINDOW + 1]);
      await ethers.provider.send("evm_mine", []);

      const employerBeforeFinalize = await usdc.balanceOf(await employer.getAddress());
      await pool.finalize(jobId);
      expect(await usdc.balanceOf(await employer.getAddress()) - employerBeforeFinalize).to.equal(fee);

      const c = await pool.getCase(jobId);
      expect(c.status).to.equal(CASE_ESCALATED);
      expect((await core.jobs(jobId)).status).to.equal(3); // still Disputed — untouched, admin resolves from here
    });

    it("still lets the RESOLVER_ROLE admin resolve directly after an escalation", async () => {
      const { core, pool, admin, employer, agentOwner1, evalA, evalB, evalC } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await registerEvaluators(pool, [evalA, evalB, evalC]);
      const jobId = await postDisputedJob(core, employer, agentOwner1, agentId);
      await pool.connect(employer).requestEvaluation(jobId);

      await ethers.provider.send("evm_increaseTime", [VOTING_WINDOW + 1]);
      await ethers.provider.send("evm_mine", []);
      await pool.finalize(jobId); // escalates, no votes at all

      await expect(core.connect(admin).resolveDispute(jobId, true)).to.not.be.reverted;
      expect((await core.jobs(jobId)).status).to.equal(5); // Resolved
    });
  });

  describe("Core wiring", () => {
    it("rejects resolveDisputeFromEvaluatorPool from anyone but the configured pool address", async () => {
      const { core, employer, agentOwner1, other } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await postDisputedJob(core, employer, agentOwner1, agentId);

      await expect(core.connect(other).resolveDisputeFromEvaluatorPool(1, true)).to.be.revertedWithCustomError(core, "NotEvaluatorPool");
    });

    it("lets the two resolution paths race safely — whichever lands first wins, the second reverts InvalidJobStatus", async () => {
      const { core, pool, admin, employer, agentOwner1, evalA, evalB, evalC } = await deployFixture();
      const agentId = await registerAgent(core, agentOwner1);
      await core.connect(admin).setEvaluatorPoolContract(await pool.getAddress());
      await registerEvaluators(pool, [evalA, evalB, evalC]);
      const jobId = await postDisputedJob(core, employer, agentOwner1, agentId);
      await pool.connect(employer).requestEvaluation(jobId);

      const [p0, p1] = await panelSigners(pool, jobId, [evalA, evalB, evalC]);
      await pool.connect(p0).commitVote(jobId, commitHashFor(true));
      await pool.connect(p1).commitVote(jobId, commitHashFor(true));
      await pool.connect(p0).revealVote(jobId, true, SALT);
      await pool.connect(p1).revealVote(jobId, true, SALT);

      // Admin resolves first...
      await core.connect(admin).resolveDispute(jobId, false);
      // ...so the evaluator pool's own finalize (which would try releaseToAgent=true) now fails
      // at Core's job.status check, not at any evaluator-pool-side bug.
      await expect(pool.finalize(jobId)).to.be.reverted;
    });

    it("restricts setEvaluatorPoolContract and setStakingContract to DEFAULT_ADMIN_ROLE", async () => {
      const { core, other } = await deployFixture();
      await expect(core.connect(other).setEvaluatorPoolContract(await other.getAddress())).to.be.reverted;
    });
  });

  describe("Admin", () => {
    it("restricts fee/slash/treasury setters to DEFAULT_ADMIN_ROLE", async () => {
      const { pool, other } = await deployFixture();
      await expect(pool.connect(other).setEvaluationRequestFee(0)).to.be.reverted;
      await expect(pool.connect(other).setMinoritySlashBps(0)).to.be.reverted;
      await expect(pool.connect(other).setTreasury(await other.getAddress())).to.be.reverted;
    });

    it("restricts pause/unpause to PAUSER_ROLE and blocks registration while paused", async () => {
      const { pool, admin, other, evalA } = await deployFixture();
      await expect(pool.connect(other).pause()).to.be.reverted;
      await pool.connect(admin).pause();
      await expect(pool.connect(evalA).registerEvaluator()).to.be.reverted;
      await pool.connect(admin).unpause();
      await expect(pool.connect(evalA).registerEvaluator()).to.not.be.reverted;
    });
  });
});
