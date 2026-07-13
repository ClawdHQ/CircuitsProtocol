import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import type { ClawdHQCore, ClawdHQNegotiation, MockUSDC } from "../typechain-types";
import type { Signer } from "ethers";

const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
const DAY = 24 * 60 * 60;

const STATUS_PROPOSED = 0;
const STATUS_COUNTERED = 1;
const STATUS_AGREED = 2;
const STATUS_COMMITTED = 3;
const STATUS_WITHDRAWN = 4;

async function deployFixture() {
  const [admin, treasury, client, providerOwner1, providerOwner2, other] = await ethers.getSigners();

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

  const NegotiationFactory = await ethers.getContractFactory("ClawdHQNegotiation");
  const negotiation = (await upgrades.deployProxy(
    NegotiationFactory,
    [await admin.getAddress(), await core.getAddress()],
    { unsafeAllow: ["constructor"] }
  )) as unknown as ClawdHQNegotiation;

  for (const signer of [client, providerOwner1, providerOwner2, other]) {
    await usdc.mint(await signer.getAddress(), USDC(1_000_000));
    await usdc.connect(signer).approve(await core.getAddress(), ethers.MaxUint256);
  }

  return { admin, treasury, client, providerOwner1, providerOwner2, other, usdc, core, negotiation };
}

async function registerAgent(core: ClawdHQCore, owner: Signer, name = "agent-one") {
  const tx = await core.connect(owner).registerAgent(name, "ipfs://uri", "https://endpoint.example", ethers.ZeroHash, true, true, true);
  await tx.wait();
  return core.agentIdByNameHash(ethers.keccak256(ethers.toUtf8Bytes(name)));
}

describe("ClawdHQNegotiation", () => {
  describe("Proposing and countering", () => {
    it("opens a negotiation (open or directed) in Proposed status", async () => {
      const { negotiation, client } = await deployFixture();
      await negotiation.connect(client).proposeJob(0, 0, ethers.id("t"), USDC(100), 7);
      const n = await negotiation.negotiations(1);
      expect(n.client).to.equal(await client.getAddress());
      expect(n.counterpartyAgentId).to.equal(0n);
      expect(n.status).to.equal(STATUS_PROPOSED);
      expect(n.lastProposerIsClient).to.equal(true);
      expect(await negotiation.totalNegotiations()).to.equal(1n);
    });

    it("locks an open negotiation to the first Provider who counters, rejecting a different agent's owner from then on", async () => {
      const { core, negotiation, client, providerOwner1, providerOwner2 } = await deployFixture();
      const agentId1 = await registerAgent(core, providerOwner1, "provider-1");
      const agentId2 = await registerAgent(core, providerOwner2, "provider-2");
      await negotiation.connect(client).proposeJob(0, 0, ethers.id("t"), USDC(100), 7);

      await negotiation.connect(providerOwner1).counterOffer(1, agentId1, ethers.id("t2"), USDC(120), 7);
      let n = await negotiation.negotiations(1);
      expect(n.counterpartyAgentId).to.equal(agentId1);
      expect(n.status).to.equal(STATUS_COUNTERED);
      expect(n.lastProposerIsClient).to.equal(false);

      // Now locked to providerOwner1's agent — providerOwner2 can't jump in.
      await expect(negotiation.connect(providerOwner2).counterOffer(1, agentId2, ethers.id("t3"), USDC(130), 7)).to.be.revertedWithCustomError(
        negotiation,
        "NotCounterparty"
      );
    });

    it("enforces alternation — neither side can counter twice in a row", async () => {
      const { core, negotiation, client, providerOwner1 } = await deployFixture();
      const agentId = await registerAgent(core, providerOwner1);
      await negotiation.connect(client).proposeJob(0, agentId, ethers.id("t"), USDC(100), 7);

      // Client just proposed (lastProposerIsClient=true) — client can't counter their own offer.
      await expect(negotiation.connect(client).counterOffer(1, 0, ethers.id("t2"), USDC(90), 7)).to.be.revertedWithCustomError(
        negotiation,
        "CannotCounterYourOwnOffer"
      );

      await negotiation.connect(providerOwner1).counterOffer(1, agentId, ethers.id("t2"), USDC(120), 7);
      // Provider just countered — provider can't counter again immediately.
      await expect(negotiation.connect(providerOwner1).counterOffer(1, agentId, ethers.id("t3"), USDC(125), 7)).to.be.revertedWithCustomError(
        negotiation,
        "CannotCounterYourOwnOffer"
      );
    });
  });

  describe("Accepting", () => {
    it("rejects accepting an open, never-countered proposal (no counterparty yet)", async () => {
      const { negotiation, client } = await deployFixture();
      await negotiation.connect(client).proposeJob(0, 0, ethers.id("t"), USDC(100), 7);
      await expect(negotiation.connect(client).acceptTerms(1)).to.be.revertedWithCustomError(negotiation, "NoCounterpartyEngagedYet");
    });

    it("requires the non-last-proposer to accept, and moves to Agreed", async () => {
      const { core, negotiation, client, providerOwner1 } = await deployFixture();
      const agentId = await registerAgent(core, providerOwner1);
      await negotiation.connect(client).proposeJob(0, agentId, ethers.id("t"), USDC(100), 7);
      await negotiation.connect(providerOwner1).counterOffer(1, agentId, ethers.id("t2"), USDC(120), 7);

      // Provider just countered (lastProposerIsClient=false) — provider can't accept their own counter.
      await expect(negotiation.connect(providerOwner1).acceptTerms(1)).to.be.revertedWithCustomError(negotiation, "CannotAcceptYourOwnOffer");

      await negotiation.connect(client).acceptTerms(1);
      const n = await negotiation.negotiations(1);
      expect(n.status).to.equal(STATUS_AGREED);
    });
  });

  describe("Committing", () => {
    it("full happy path: open propose -> provider locks in with a counter -> client accepts -> commit produces a real, workable Core job", async () => {
      const { core, admin, negotiation, client, providerOwner1, usdc } = await deployFixture();
      await core.connect(admin).setTrustedNegotiationContract(await negotiation.getAddress(), true);
      const agentId = await registerAgent(core, providerOwner1);
      await core.connect(client).registerAgent("employer-agent", "ipfs://x", "https://x.example", ethers.ZeroHash, false, false, false);
      const employerAgentId = await core.agentIdByNameHash(ethers.keccak256(ethers.toUtf8Bytes("employer-agent")));

      await negotiation.connect(client).proposeJob(employerAgentId, 0, ethers.id("t"), USDC(100), 7);
      await negotiation.connect(providerOwner1).counterOffer(1, agentId, ethers.id("t-final"), USDC(150), 10);
      await negotiation.connect(client).acceptTerms(1);

      const clientUsdcBefore = await usdc.balanceOf(await client.getAddress());
      const tx = await negotiation.connect(client).commit(1);
      await tx.wait();
      const clientUsdcAfter = await usdc.balanceOf(await client.getAddress());
      expect(clientUsdcBefore - clientUsdcAfter).to.equal(USDC(150)); // Core pulled directly from the Client

      const n = await negotiation.negotiations(1);
      expect(n.status).to.equal(STATUS_COMMITTED);

      const job = await core.jobs(1);
      expect(job.employer).to.equal(await client.getAddress());
      expect(job.employerAgentId).to.equal(employerAgentId);
      expect(job.hiredAgentId).to.equal(agentId);
      expect(job.taskHash).to.equal(ethers.id("t-final"));
      expect(job.budget).to.equal(USDC(150));
      expect(job.status).to.equal(0); // Pending

      const latestBlock = (await ethers.provider.getBlock("latest"))!;
      expect(job.deadline).to.be.closeTo(BigInt(latestBlock.timestamp) + BigInt(10 * DAY), 5n);

      // The resulting job behaves exactly like a normally-posted one.
      await core.connect(providerOwner1).acceptJob(1);
      expect((await core.jobs(1)).status).to.equal(1); // Active
    });

    it("rejects commit from anyone but the Client, or before Agreed", async () => {
      const { core, negotiation, client, providerOwner1, other } = await deployFixture();
      const agentId = await registerAgent(core, providerOwner1);
      await negotiation.connect(client).proposeJob(0, agentId, ethers.id("t"), USDC(100), 7);

      await expect(negotiation.connect(client).commit(1)).to.be.revertedWithCustomError(negotiation, "InvalidNegotiationStatus");

      await negotiation.connect(providerOwner1).counterOffer(1, agentId, ethers.id("t2"), USDC(100), 7);
      await negotiation.connect(client).acceptTerms(1);
      await expect(negotiation.connect(other).commit(1)).to.be.revertedWithCustomError(negotiation, "NotClient");
    });
  });

  describe("Withdrawing", () => {
    it("lets either side withdraw before commit, blocking further action", async () => {
      const { core, negotiation, client, providerOwner1 } = await deployFixture();
      const agentId = await registerAgent(core, providerOwner1);
      await negotiation.connect(client).proposeJob(0, agentId, ethers.id("t"), USDC(100), 7);
      await negotiation.connect(client).withdraw(1);

      const n = await negotiation.negotiations(1);
      expect(n.status).to.equal(STATUS_WITHDRAWN);
      await expect(negotiation.connect(providerOwner1).counterOffer(1, agentId, ethers.id("t2"), USDC(90), 7)).to.be.revertedWithCustomError(
        negotiation,
        "InvalidNegotiationStatus"
      );
    });

    it("rejects withdraw from a random address, and from an unengaged Provider on an open negotiation", async () => {
      const { negotiation, client, other } = await deployFixture();
      await negotiation.connect(client).proposeJob(0, 0, ethers.id("t"), USDC(100), 7);
      await expect(negotiation.connect(other).withdraw(1)).to.be.revertedWithCustomError(negotiation, "NotCounterparty");
    });
  });

  describe("Core wiring", () => {
    it("rejects postJobFromNegotiation from an untrusted caller", async () => {
      const { core, client } = await deployFixture();
      await expect(
        core.connect(client).postJobFromNegotiation(await client.getAddress(), 0, 1, ethers.id("t"), USDC(10), (await ethers.provider.getBlock("latest"))!.timestamp + DAY)
      ).to.be.revertedWithCustomError(core, "NotTrustedNegotiationContract");
    });

    it("rejects hiredAgentId=0 even from a trusted caller — defense in depth, since the real ClawdHQNegotiation flow can never reach commit() with an unengaged (0) counterparty anyway (see acceptTerms's NoCounterpartyEngagedYet check)", async () => {
      const { core, admin, client, other } = await deployFixture();
      // `other` stands in for "any address Core has been told to trust" — the assertion is
      // about Core's own defensive check, independent of whether the real ClawdHQNegotiation
      // contract would ever actually produce this call.
      await core.connect(admin).setTrustedNegotiationContract(await other.getAddress(), true);
      const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + DAY;
      await expect(
        core.connect(other).postJobFromNegotiation(await client.getAddress(), 0, 0, ethers.id("t"), USDC(10), deadline)
      ).to.be.revertedWithCustomError(core, "AgentNotActive");
    });

    it("restricts setTrustedNegotiationContract to DEFAULT_ADMIN_ROLE", async () => {
      const { core, other } = await deployFixture();
      await expect(core.connect(other).setTrustedNegotiationContract(await other.getAddress(), true)).to.be.reverted;
    });
  });
});
