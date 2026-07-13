import { ethers, network, upgrades } from "hardhat";
import { readDeployment, updateDeployment } from "./lib/deployments";
import deployCore from "./00-deploy-core";

/// Deploys the UUPS proxy + implementation for ClawdHQLaunchpad, pointed at this chain's
/// already-deployed ClawdHQCore and AgentWalletRegistry (deploying Core, and transitively the
/// registry, first if needed — same dependency-chaining shape as 01-deploy-exchange.ts).
/// Idempotent: if a launchpad deployment record already exists for this chain, it is reused
/// rather than redeployed.
async function main() {
  const chainId = network.config.chainId;
  if (!chainId) throw new Error(`Network ${network.name} has no chainId configured`);

  const existing = readDeployment(chainId);
  if (existing?.launchpadProxyAddress) {
    console.log(`[01b] ClawdHQLaunchpad already deployed on ${network.name} at ${existing.launchpadProxyAddress}, skipping.`);
    return existing.launchpadProxyAddress;
  }

  const coreProxyAddress = existing?.proxyAddress ?? (await deployCore());
  const coreRecord = readDeployment(chainId);
  if (!coreRecord?.agentWalletRegistryAddress) {
    throw new Error(`AgentWalletRegistry deployment record missing for chain ${chainId} after deploying Core`);
  }

  const [deployer] = await ethers.getSigners();

  console.log(`[01b] Deploying ClawdHQLaunchpad to ${network.name} (chainId ${chainId})...`);
  const LaunchpadFactory = await ethers.getContractFactory("ClawdHQLaunchpad");
  const launchpad = await upgrades.deployProxy(
    LaunchpadFactory,
    [await deployer.getAddress(), coreProxyAddress, coreRecord.usdcAddress, coreRecord.treasury, coreRecord.agentWalletRegistryAddress],
    // Same ReentrancyGuard note as 00-deploy-core.ts/01-deploy-exchange.ts.
    { unsafeAllow: ["constructor"] }
  );
  await launchpad.waitForDeployment();

  const launchpadProxyAddress = await launchpad.getAddress();
  const launchpadImplementationAddress = await upgrades.erc1967.getImplementationAddress(launchpadProxyAddress);

  updateDeployment(chainId, {
    launchpadProxyAddress,
    launchpadImplementationAddress,
    launchpadDeployedAt: new Date().toISOString(),
  });

  console.log(`[01b] ClawdHQLaunchpad proxy deployed at ${launchpadProxyAddress} (impl ${launchpadImplementationAddress})`);
  return launchpadProxyAddress;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export default main;
