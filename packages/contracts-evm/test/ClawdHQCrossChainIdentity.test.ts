import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import type { ClawdHQCore, ClawdHQCrossChainIdentity, MockMessageTransmitterV2, MockUSDC } from "../typechain-types";

const DOMAIN_A = 6; // stands in for Base Sepolia
const DOMAIN_B = 0; // stands in for Ethereum Sepolia

function toBytes32(addr: string): string {
  return ethers.zeroPadValue(addr, 32);
}

async function deployFixture() {
  const [admin, treasury, ownerA, ownerB, other] = await ethers.getSigners();

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

  const TransmitterFactory = await ethers.getContractFactory("MockMessageTransmitterV2");
  const transmitter = (await TransmitterFactory.deploy()) as unknown as MockMessageTransmitterV2;

  const IdentityFactory = await ethers.getContractFactory("ClawdHQCrossChainIdentity");
  const identityA = (await upgrades.deployProxy(
    IdentityFactory,
    [await admin.getAddress(), await core.getAddress(), DOMAIN_A, await transmitter.getAddress()],
    { unsafeAllow: ["constructor"] }
  )) as unknown as ClawdHQCrossChainIdentity;
  const identityB = (await upgrades.deployProxy(
    IdentityFactory,
    [await admin.getAddress(), await core.getAddress(), DOMAIN_B, await transmitter.getAddress()],
    { unsafeAllow: ["constructor"] }
  )) as unknown as ClawdHQCrossChainIdentity;

  return { admin, treasury, ownerA, ownerB, other, usdc, core, transmitter, identityA, identityB };
}

async function registerAgent(core: ClawdHQCore, owner: import("ethers").Signer, name: string) {
  const tx = await core.connect(owner).registerAgent(name, "ipfs://uri", "https://endpoint.example", ethers.ZeroHash, true, true, true);
  await tx.wait();
  return core.agentIdByNameHash(ethers.keccak256(ethers.toUtf8Bytes(name)));
}

describe("ClawdHQCrossChainIdentity", () => {
  describe("registerLink", () => {
    it("computes a globalId, records it locally, and broadcasts to every configured peer", async () => {
      const { core, identityA, identityB, ownerA } = await deployFixture();
      const agentIdA = await registerAgent(core, ownerA, "agent-a");

      await (await identityA.setPeer(DOMAIN_B, await identityB.getAddress())).wait();

      const tx = await identityA.connect(ownerA).registerLink(agentIdA);
      const receipt = await tx.wait();

      const expectedGlobalId = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["uint32", "uint256", "address"], [DOMAIN_A, agentIdA, await ownerA.getAddress()])
      );

      expect(await identityA.ownerOfGlobalId(expectedGlobalId)).to.equal(await ownerA.getAddress());
      expect(await identityA.localAgentIdOfGlobalId(expectedGlobalId)).to.equal(agentIdA);
      expect(await identityA.globalIdOfLocalAgent(agentIdA)).to.equal(expectedGlobalId);

      const sentEvent = receipt!.logs
        .map((log) => {
          try {
            return identityA.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((parsed) => parsed?.name === "LinkRegistered");
      expect(sentEvent).to.not.be.undefined;
    });

    it("rejects registering a link for an agent the caller does not own", async () => {
      const { core, identityA, ownerA, other } = await deployFixture();
      const agentIdA = await registerAgent(core, ownerA, "agent-a");
      await expect(identityA.connect(other).registerLink(agentIdA)).to.be.revertedWithCustomError(identityA, "NotAgentOwner");
    });

    it("skips sending to a peer domain that was configured then unset (address(0))", async () => {
      const { core, identityA, identityB, ownerA } = await deployFixture();
      const agentIdA = await registerAgent(core, ownerA, "agent-a");
      await identityA.setPeer(DOMAIN_B, await identityB.getAddress());
      await identityA.setPeer(DOMAIN_B, ethers.ZeroAddress);

      // Does not revert even though the only configured peer is now unset — registerLink still
      // records the link locally, it just has nowhere to broadcast.
      await expect(identityA.connect(ownerA).registerLink(agentIdA)).to.not.be.reverted;
    });

    it("is idempotent — calling it again for the same agent recomputes the identical globalId", async () => {
      const { core, identityA, ownerA } = await deployFixture();
      const agentIdA = await registerAgent(core, ownerA, "agent-a");
      await identityA.connect(ownerA).registerLink(agentIdA);
      const globalId1 = await identityA.globalIdOfLocalAgent(agentIdA);
      await identityA.connect(ownerA).registerLink(agentIdA);
      const globalId2 = await identityA.globalIdOfLocalAgent(agentIdA);
      expect(globalId1).to.equal(globalId2);
    });
  });

  describe("Cross-chain receive (via MockMessageTransmitterV2.relayFinalized)", () => {
    it("full round trip: register on chain A, relay, claim on chain B", async () => {
      const { core, identityA, identityB, transmitter, ownerA } = await deployFixture();
      const agentIdA = await registerAgent(core, ownerA, "agent-a");
      const agentIdB = await registerAgent(core, ownerA, "agent-a-on-b"); // same owner, different local agent, standing in for "chain B"

      await identityA.setPeer(DOMAIN_B, await identityB.getAddress());
      await identityB.setPeer(DOMAIN_A, await identityA.getAddress());

      const globalId = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["uint32", "uint256", "address"], [DOMAIN_A, agentIdA, await ownerA.getAddress()])
      );
      const messageBody = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "uint32", "uint256", "address"],
        [globalId, DOMAIN_A, agentIdA, await ownerA.getAddress()]
      );

      await identityA.connect(ownerA).registerLink(agentIdA);

      // Simulates: relayer fetched Circle's attestation and submitted it on chain B.
      await transmitter.relayFinalized(await identityB.getAddress(), DOMAIN_A, toBytes32(await identityA.getAddress()), messageBody);

      expect(await identityB.ownerOfGlobalId(globalId)).to.equal(await ownerA.getAddress());
      expect(await identityB.localAgentIdOfGlobalId(globalId)).to.equal(0n); // attested, but not yet claimed on B

      await identityB.connect(ownerA).claimLocalAgent(globalId, agentIdB);
      expect(await identityB.localAgentIdOfGlobalId(globalId)).to.equal(agentIdB);
      expect(await identityB.globalIdOfLocalAgent(agentIdB)).to.equal(globalId);
    });

    it("rejects handleReceiveFinalizedMessage called by anyone other than the configured messageTransmitter", async () => {
      const { identityB, ownerA } = await deployFixture();
      const fakeBody = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "uint32", "uint256", "address"],
        [ethers.ZeroHash, DOMAIN_A, 1, await ownerA.getAddress()]
      );
      await expect(
        identityB.connect(ownerA).handleReceiveFinalizedMessage(DOMAIN_A, toBytes32(await ownerA.getAddress()), 2000, fakeBody)
      ).to.be.revertedWithCustomError(identityB, "NotMessageTransmitter");
    });

    it("rejects a relayed message whose sender is not the configured peer for that domain", async () => {
      const { identityA, identityB, transmitter, ownerA, other } = await deployFixture();
      await identityB.setPeer(DOMAIN_A, await identityA.getAddress());

      const fakeBody = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "uint32", "uint256", "address"],
        [ethers.ZeroHash, DOMAIN_A, 1, await ownerA.getAddress()]
      );
      // `other` stands in for "not identityA" — the attested sender does not match peerContractByDomain[DOMAIN_A].
      await expect(
        transmitter.relayFinalized(await identityB.getAddress(), DOMAIN_A, toBytes32(await other.getAddress()), fakeBody)
      ).to.be.revertedWithCustomError(identityB, "UntrustedSender");
    });

    it("rejects a relayed message from an unconfigured (never-set) peer domain", async () => {
      const { identityA, identityB, transmitter, ownerA } = await deployFixture();
      // identityB never called setPeer for DOMAIN_A — peerContractByDomain[DOMAIN_A] is still bytes32(0).
      const fakeBody = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "uint32", "uint256", "address"],
        [ethers.ZeroHash, DOMAIN_A, 1, await ownerA.getAddress()]
      );
      await expect(
        transmitter.relayFinalized(await identityB.getAddress(), DOMAIN_A, toBytes32(await identityA.getAddress()), fakeBody)
      ).to.be.revertedWithCustomError(identityB, "UntrustedSender");
    });

    it("always reverts on handleReceiveUnfinalizedMessage, regardless of caller or content", async () => {
      const { identityB, transmitter, ownerA } = await deployFixture();
      const fakeBody = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "uint32", "uint256", "address"],
        [ethers.ZeroHash, DOMAIN_A, 1, await ownerA.getAddress()]
      );
      await expect(
        transmitter.relayUnfinalized(await identityB.getAddress(), DOMAIN_A, toBytes32(await ownerA.getAddress()), fakeBody)
      ).to.be.revertedWithCustomError(identityB, "UnfinalizedMessagesNotSupported");
    });
  });

  describe("claimLocalAgent", () => {
    it("rejects claiming against a globalId that has never been established", async () => {
      const { core, identityB, ownerA } = await deployFixture();
      const agentIdB = await registerAgent(core, ownerA, "agent-b");
      await expect(identityB.connect(ownerA).claimLocalAgent(ethers.id("nonexistent"), agentIdB)).to.be.revertedWithCustomError(
        identityB,
        "GlobalIdNotFound"
      );
    });

    it("rejects claiming from someone other than the attested owner", async () => {
      const { core, identityA, ownerA, other } = await deployFixture();
      const agentIdA = await registerAgent(core, ownerA, "agent-a");
      await identityA.connect(ownerA).registerLink(agentIdA);
      const globalId = await identityA.globalIdOfLocalAgent(agentIdA);

      const otherAgentId = await registerAgent(core, other, "agent-other");
      await expect(identityA.connect(other).claimLocalAgent(globalId, otherAgentId)).to.be.revertedWithCustomError(identityA, "OwnerMismatch");
    });

    it("rejects claiming a local agent the caller does not own, even if they are the attested owner elsewhere", async () => {
      const { core, identityA, ownerA, other } = await deployFixture();
      const agentIdA = await registerAgent(core, ownerA, "agent-a");
      await identityA.connect(ownerA).registerLink(agentIdA);
      const globalId = await identityA.globalIdOfLocalAgent(agentIdA);

      const otherAgentId = await registerAgent(core, other, "agent-other");
      await expect(identityA.connect(ownerA).claimLocalAgent(globalId, otherAgentId)).to.be.revertedWithCustomError(identityA, "NotAgentOwner");
    });
  });

  describe("Admin", () => {
    it("restricts setPeer to DEFAULT_ADMIN_ROLE", async () => {
      const { identityA, other } = await deployFixture();
      await expect(identityA.connect(other).setPeer(DOMAIN_B, await other.getAddress())).to.be.reverted;
    });

    it("restricts pause/unpause to PAUSER_ROLE and blocks registerLink while paused", async () => {
      const { core, identityA, admin, ownerA, other } = await deployFixture();
      const agentIdA = await registerAgent(core, ownerA, "agent-a");
      await expect(identityA.connect(other).pause()).to.be.reverted;

      await identityA.connect(admin).pause();
      await expect(identityA.connect(ownerA).registerLink(agentIdA)).to.be.revertedWithCustomError(identityA, "EnforcedPause");

      await identityA.connect(admin).unpause();
      await expect(identityA.connect(ownerA).registerLink(agentIdA)).to.not.be.reverted;
    });
  });
});
