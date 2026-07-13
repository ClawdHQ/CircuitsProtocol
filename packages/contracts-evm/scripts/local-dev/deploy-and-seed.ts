import { ethers, network, upgrades } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";

/// Spins up a fully working local devnet: MockUSDC + ClawdHQCore + ClawdHQAgentExchange,
/// with a couple of registered agents and one listing of each mode already seeded. Meant to
/// be run against a persistent `hardhat node` (i.e. `--network localhost`), not the
/// ephemeral in-process network — this is local-only dev/demo tooling, separate from
/// scripts/deploy-evm's real testnet deployment scripts.
async function main() {
  if (network.name !== "localhost" && network.name !== "hardhat") {
    throw new Error(`local-dev/deploy-and-seed.ts is for local development only, refusing to run on "${network.name}"`);
  }

  const [admin, treasury, agentOwner1, agentOwner2, bidder1, bidder2] = await ethers.getSigners();
  const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);

  // Captured before any deploy/seed transaction, not after (a prior version of this script
  // captured it near the very end, right before writing local-devnet.json — meaning the
  // indexer's cold-start scan, which begins at this recorded block, silently missed every
  // event this script itself emits, including the two agents it registers below: their
  // AgentRegistered events landed well before that later block, so apps/indexer's
  // provisionAgentWalletOnChain trigger never saw them. Only surfaced because every earlier
  // verification pass in this codebase happened to register its own test agents *after*
  // running this script, never relying on cold-start pickup of the seeded ones).
  const startBlock = await ethers.provider.getBlockNumber();

  console.log("Deploying MockUSDC...");
  const MockUSDCFactory = await ethers.getContractFactory("MockUSDC");
  const usdc = await MockUSDCFactory.deploy();
  await usdc.waitForDeployment();

  // `admin` is a placeholder registrar signer — the real one is whatever address
  // packages/custody-core/src/registrarCustody.ts provisions at app runtime (it doesn't exist
  // yet at deploy time), rotated in via setRegistrar once that wallet is provisioned (see
  // rotate-local-registrar.ts in apps/indexer/scripts), same "placeholder now, rotate later"
  // shape as X402Facilitator's constructor below — keeping this script free of any
  // custody-db/custody-core dependency.
  console.log("Deploying AgentWalletRegistry...");
  const RegistryFactory = await ethers.getContractFactory("AgentWalletRegistry");
  const registry = await RegistryFactory.deploy(await admin.getAddress(), await admin.getAddress());
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();

  console.log("Deploying ClawdHQCore...");
  const CoreFactory = await ethers.getContractFactory("ClawdHQCore");
  const core = await upgrades.deployProxy(
    CoreFactory,
    [await admin.getAddress(), await usdc.getAddress(), await treasury.getAddress()],
    // ClawdHQCore's `_agentWalletRegistry` is an immutable constructor argument (see its own
    // doc comment on why: no bytecode headroom left for a regular admin-settable variable).
    { unsafeAllow: ["constructor"], constructorArgs: [registryAddress] }
  );
  await core.waitForDeployment();

  console.log("Deploying ClawdHQAgentExchange...");
  const ExchangeFactory = await ethers.getContractFactory("ClawdHQAgentExchange");
  const exchange = await upgrades.deployProxy(
    ExchangeFactory,
    [await admin.getAddress(), await core.getAddress(), await usdc.getAddress(), await treasury.getAddress()],
    { unsafeAllow: ["constructor"] }
  );
  await exchange.waitForDeployment();

  // Split out of ClawdHQCore into its own contract — see ClawdHQLaunchpad.sol's doc comment.
  console.log("Deploying ClawdHQLaunchpad...");
  const LaunchpadFactory = await ethers.getContractFactory("ClawdHQLaunchpad");
  const launchpad = await upgrades.deployProxy(
    LaunchpadFactory,
    [await admin.getAddress(), await core.getAddress(), await usdc.getAddress(), await treasury.getAddress(), registryAddress],
    { unsafeAllow: ["constructor"] }
  );
  await launchpad.waitForDeployment();

  // `admin` is a placeholder facilitator signer — the real one is whatever address
  // packages/custody-core/src/facilitatorCustody.ts provisions at app runtime (it doesn't exist
  // yet at deploy time), rotated in via setFacilitator once that wallet is provisioned, keeping
  // this script free of any custody-db/custody-core dependency.
  console.log("Deploying X402Facilitator...");
  const FacilitatorFactory = await ethers.getContractFactory("X402Facilitator");
  const facilitator = await FacilitatorFactory.deploy(await admin.getAddress(), await usdc.getAddress(), await admin.getAddress());
  await facilitator.waitForDeployment();

  const coreAddress = await core.getAddress();
  const exchangeAddress = await exchange.getAddress();
  const launchpadAddress = await launchpad.getAddress();
  const usdcAddress = await usdc.getAddress();
  const facilitatorAddress = await facilitator.getAddress();

  console.log("Funding + approving test accounts...");
  for (const signer of [agentOwner1, agentOwner2, bidder1, bidder2]) {
    await (await usdc.mint(await signer.getAddress(), USDC(1_000_000))).wait();
    await (await usdc.connect(signer).approve(coreAddress, ethers.MaxUint256)).wait();
    await (await usdc.connect(signer).approve(exchangeAddress, ethers.MaxUint256)).wait();
    await (await usdc.connect(signer).approve(launchpadAddress, ethers.MaxUint256)).wait();
  }

  console.log("Registering agents...");
  await (
    await core
      .connect(agentOwner1)
      .registerAgent("alpha-trader", "ipfs://alpha", "https://alpha.example", ethers.ZeroHash, true, true, true)
  ).wait();
  await (
    await core
      .connect(agentOwner2)
      .registerAgent("code-audit-pro", "ipfs://audit", "https://audit.example", ethers.ZeroHash, true, false, true)
  ).wait();
  const agent1Id = 1n;
  const agent2Id = 2n;

  console.log("Listing agent #1 in Open mode with two bids...");
  await (await core.connect(agentOwner1).approveAgentExchange(agent1Id, exchangeAddress)).wait();
  await (await exchange.connect(agentOwner1).createListing(agent1Id, 0, USDC(500), 0, 0)).wait();
  await (await exchange.connect(bidder1).placeBid(1, USDC(350))).wait();
  await (await exchange.connect(bidder2).placeBid(1, USDC(600))).wait();

  console.log("Listing agent #2 in Auction mode with one bid...");
  const latestBlock = await ethers.provider.getBlock("latest");
  const auctionEndTime = latestBlock!.timestamp + 3 * 24 * 60 * 60;
  await (await core.connect(agentOwner2).approveAgentExchange(agent2Id, exchangeAddress)).wait();
  await (await exchange.connect(agentOwner2).createListing(agent2Id, 1, USDC(800), USDC(400), auctionEndTime)).wait();
  await (await exchange.connect(bidder1).placeBid(2, USDC(450))).wait();

  const record = {
    network: network.name,
    rpcUrl: "http://127.0.0.1:8545",
    usdcAddress,
    coreAddress,
    exchangeAddress,
    launchpadAddress,
    registryAddress,
    facilitatorAddress,
    deploymentBlock: startBlock,
    accounts: {
      admin: await admin.getAddress(),
      treasury: await treasury.getAddress(),
      agentOwner1: await agentOwner1.getAddress(),
      agentOwner2: await agentOwner2.getAddress(),
      bidder1: await bidder1.getAddress(),
      bidder2: await bidder2.getAddress(),
    },
    seededAgentIds: [agent1Id.toString(), agent2Id.toString()],
    seededListingIds: ["1", "2"],
  };

  const outPath = path.resolve(__dirname, "local-devnet.json");
  fs.writeFileSync(outPath, JSON.stringify(record, null, 2) + "\n");

  console.log("\nLocal devnet ready:");
  console.log(JSON.stringify(record, null, 2));
  console.log(`\nWritten to ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
