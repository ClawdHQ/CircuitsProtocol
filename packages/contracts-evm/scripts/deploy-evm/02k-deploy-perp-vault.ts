import { ethers, network, upgrades } from "hardhat";
import { readDeployment, updateDeployment } from "./lib/deployments";
import deployCore from "./00-deploy-core";

/// Deploys the UUPS proxy + implementation for CircuitsPerpVault.
async function main() {
  const chainId = network.config.chainId;
  if (!chainId) throw new Error(`Network ${network.name} has no chainId configured`);

  const existing = readDeployment(chainId);
  if (existing?.perpVaultProxyAddress) {
    console.log(`[02k] CircuitsPerpVault already deployed on ${network.name} at ${existing.perpVaultProxyAddress}, skipping.`);
    return existing.perpVaultProxyAddress;
  }

  const coreProxyAddress = existing?.proxyAddress ?? (await deployCore());
  const coreRecord = readDeployment(chainId);
  if (!coreRecord) throw new Error(`ClawdHQCore deployment record missing for chain ${chainId} after deploy`);

  const [deployer] = await ethers.getSigners();

  console.log(`[02k] Deploying CircuitsPerpVault to ${network.name} (chainId ${chainId})...`);
  const VaultFactory = await ethers.getContractFactory("CircuitsPerpVault");
  const vault = await upgrades.deployProxy(
    VaultFactory,
    [await deployer.getAddress(), coreRecord.usdcAddress, coreRecord.treasury],
    { unsafeAllow: ["constructor"] }
  );
  await vault.waitForDeployment();

  const perpVaultProxyAddress = await vault.getAddress();
  const perpVaultImplementationAddress = await upgrades.erc1967.getImplementationAddress(perpVaultProxyAddress);

  updateDeployment(chainId, {
    perpVaultProxyAddress,
    perpVaultImplementationAddress,
    perpVaultDeployedAt: new Date().toISOString(),
  });

  console.log(`[02k] CircuitsPerpVault proxy deployed at ${perpVaultProxyAddress} (impl ${perpVaultImplementationAddress})`);
  return perpVaultProxyAddress;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export default main;
