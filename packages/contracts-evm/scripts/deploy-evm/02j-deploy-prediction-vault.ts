import { ethers, network, upgrades } from "hardhat";
import { readDeployment, updateDeployment } from "./lib/deployments";
import deployCore from "./00-deploy-core";

/// Deploys the UUPS proxy + implementation for CircuitsPredictionVault.
async function main() {
  const chainId = network.config.chainId;
  if (!chainId) throw new Error(`Network ${network.name} has no chainId configured`);

  const existing = readDeployment(chainId);
  if (existing?.predictionVaultProxyAddress) {
    console.log(`[02j] CircuitsPredictionVault already deployed on ${network.name} at ${existing.predictionVaultProxyAddress}, skipping.`);
    return existing.predictionVaultProxyAddress;
  }

  const coreProxyAddress = existing?.proxyAddress ?? (await deployCore());
  const coreRecord = readDeployment(chainId);
  if (!coreRecord) throw new Error(`ClawdHQCore deployment record missing for chain ${chainId} after deploy`);

  const [deployer] = await ethers.getSigners();

  console.log(`[02j] Deploying CircuitsPredictionVault to ${network.name} (chainId ${chainId})...`);
  const VaultFactory = await ethers.getContractFactory("CircuitsPredictionVault");
  const vault = await upgrades.deployProxy(
    VaultFactory,
    [await deployer.getAddress(), coreRecord.usdcAddress, coreRecord.treasury],
    { unsafeAllow: ["constructor"] }
  );
  await vault.waitForDeployment();

  const predictionVaultProxyAddress = await vault.getAddress();
  const predictionVaultImplementationAddress = await upgrades.erc1967.getImplementationAddress(predictionVaultProxyAddress);

  updateDeployment(chainId, {
    predictionVaultProxyAddress,
    predictionVaultImplementationAddress,
    predictionVaultDeployedAt: new Date().toISOString(),
  });

  console.log(`[02j] CircuitsPredictionVault proxy deployed at ${predictionVaultProxyAddress} (impl ${predictionVaultImplementationAddress})`);
  return predictionVaultProxyAddress;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export default main;
