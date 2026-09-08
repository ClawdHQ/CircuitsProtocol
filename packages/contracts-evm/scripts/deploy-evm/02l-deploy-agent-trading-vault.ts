import { ethers, network, upgrades } from "hardhat";
import { readDeployment, updateDeployment } from "./lib/deployments";
import deployCore from "./00-deploy-core";

/// Deploys the UUPS proxy + implementation for CircuitsAgentTradingVault.
async function main() {
  const chainId = network.config.chainId;
  if (!chainId) throw new Error(`Network ${network.name} has no chainId configured`);

  const existing = readDeployment(chainId);
  if (existing?.agentTradingVaultProxyAddress) {
    console.log(`[02l] CircuitsAgentTradingVault already deployed on ${network.name} at ${existing.agentTradingVaultProxyAddress}, skipping.`);
    return existing.agentTradingVaultProxyAddress;
  }

  const coreProxyAddress = existing?.proxyAddress ?? (await deployCore());
  const coreRecord = readDeployment(chainId);
  if (!coreRecord) throw new Error(`ClawdHQCore deployment record missing for chain ${chainId} after deploy`);

  const [deployer] = await ethers.getSigners();

  console.log(`[02l] Deploying CircuitsAgentTradingVault to ${network.name} (chainId ${chainId})...`);
  const VaultFactory = await ethers.getContractFactory("CircuitsAgentTradingVault");
  const vault = await upgrades.deployProxy(
    VaultFactory,
    [await deployer.getAddress(), coreProxyAddress, coreRecord.treasury],
    { unsafeAllow: ["constructor"] }
  );
  await vault.waitForDeployment();

  const agentTradingVaultProxyAddress = await vault.getAddress();
  const agentTradingVaultImplementationAddress = await upgrades.erc1967.getImplementationAddress(agentTradingVaultProxyAddress);

  // Approve perp and prediction venues if already deployed
  if (existing?.perpVaultProxyAddress) {
    console.log(`[02l] Approving CircuitsPerpVault (${existing.perpVaultProxyAddress}) as venue...`);
    const tx = await vault.setApprovedVenue(existing.perpVaultProxyAddress, true);
    await tx.wait();
  }
  if (existing?.predictionVaultProxyAddress) {
    console.log(`[02l] Approving CircuitsPredictionVault (${existing.predictionVaultProxyAddress}) as venue...`);
    const tx = await vault.setApprovedVenue(existing.predictionVaultProxyAddress, true);
    await tx.wait();
  }
  if (existing?.launchpadProxyAddress) {
    console.log(`[02l] Approving ClawdHQLaunchpad (${existing.launchpadProxyAddress}) as venue...`);
    const tx = await vault.setApprovedVenue(existing.launchpadProxyAddress, true);
    await tx.wait();
  }

  updateDeployment(chainId, {
    agentTradingVaultProxyAddress,
    agentTradingVaultImplementationAddress,
    agentTradingVaultDeployedAt: new Date().toISOString(),
  });

  console.log(`[02l] CircuitsAgentTradingVault proxy deployed at ${agentTradingVaultProxyAddress} (impl ${agentTradingVaultImplementationAddress})`);
  return agentTradingVaultProxyAddress;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export default main;
