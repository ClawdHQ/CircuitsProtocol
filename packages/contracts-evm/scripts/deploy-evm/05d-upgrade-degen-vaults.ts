import { ethers, network, upgrades } from "hardhat";
import { readDeployment, updateDeployment } from "./lib/deployments";

/// Upgrades CircuitsPerpVault, CircuitsPredictionVault, CircuitsAgentTradingVault,
/// and ClawdHQLaunchpad on Arc Testnet to their latest implementations.
async function main() {
  const chainId = network.config.chainId;
  if (!chainId) throw new Error(`Network ${network.name} has no chainId configured`);

  const existing = readDeployment(chainId);
  if (!existing) {
    throw new Error(`[05d] No existing deployment found for chainId ${chainId}`);
  }

  const [deployer] = await ethers.getSigners();
  console.log(`[05d] Running upgrades on ${network.name} (chainId ${chainId}) from deployer ${deployer.address}...`);

  // 1. Upgrade ClawdHQLaunchpad
  if (existing.launchpadProxyAddress) {
    console.log(`[05d] Upgrading ClawdHQLaunchpad proxy at ${existing.launchpadProxyAddress}...`);
    const LaunchpadFactory = await ethers.getContractFactory("ClawdHQLaunchpad");
    await upgrades.upgradeProxy(existing.launchpadProxyAddress, LaunchpadFactory, {
      unsafeAllow: ["constructor"],
    });
    const newImpl = await upgrades.erc1967.getImplementationAddress(existing.launchpadProxyAddress);
    updateDeployment(chainId, { launchpadImplementationAddress: newImpl });
    console.log(`[05d] ClawdHQLaunchpad upgraded -> new implementation: ${newImpl}`);
  }

  // 2. Upgrade CircuitsPerpVault
  if (existing.perpVaultProxyAddress) {
    console.log(`[05d] Upgrading CircuitsPerpVault proxy at ${existing.perpVaultProxyAddress}...`);
    const PerpFactory = await ethers.getContractFactory("CircuitsPerpVault");
    await upgrades.upgradeProxy(existing.perpVaultProxyAddress, PerpFactory, {
      unsafeAllow: ["constructor"],
    });
    const newImpl = await upgrades.erc1967.getImplementationAddress(existing.perpVaultProxyAddress);
    updateDeployment(chainId, { perpVaultImplementationAddress: newImpl });
    console.log(`[05d] CircuitsPerpVault upgraded -> new implementation: ${newImpl}`);
  }

  // 3. Upgrade CircuitsPredictionVault
  if (existing.predictionVaultProxyAddress) {
    console.log(`[05d] Upgrading CircuitsPredictionVault proxy at ${existing.predictionVaultProxyAddress}...`);
    const PredFactory = await ethers.getContractFactory("CircuitsPredictionVault");
    await upgrades.upgradeProxy(existing.predictionVaultProxyAddress, PredFactory, {
      unsafeAllow: ["constructor"],
    });
    const newImpl = await upgrades.erc1967.getImplementationAddress(existing.predictionVaultProxyAddress);
    updateDeployment(chainId, { predictionVaultImplementationAddress: newImpl });
    console.log(`[05d] CircuitsPredictionVault upgraded -> new implementation: ${newImpl}`);
  }

  // 4. Upgrade CircuitsAgentTradingVault
  if (existing.agentTradingVaultProxyAddress) {
    console.log(`[05d] Upgrading CircuitsAgentTradingVault proxy at ${existing.agentTradingVaultProxyAddress}...`);
    const TradingVaultFactory = await ethers.getContractFactory("CircuitsAgentTradingVault");
    await upgrades.upgradeProxy(existing.agentTradingVaultProxyAddress, TradingVaultFactory, {
      unsafeAllow: ["constructor"],
    });
    const newImpl = await upgrades.erc1967.getImplementationAddress(existing.agentTradingVaultProxyAddress);
    updateDeployment(chainId, { agentTradingVaultImplementationAddress: newImpl });
    console.log(`[05d] CircuitsAgentTradingVault upgraded -> new implementation: ${newImpl}`);
  }

  // 5. Wire VAULT_ROLE and Venue Approvals
  if (existing.agentTradingVaultProxyAddress) {
    const tradingVaultAddress = existing.agentTradingVaultProxyAddress;

    if (existing.perpVaultProxyAddress) {
      console.log(`[05d] Granting VAULT_ROLE on CircuitsPerpVault to ${tradingVaultAddress}...`);
      const PerpFactory = await ethers.getContractFactory("CircuitsPerpVault");
      const perp = PerpFactory.attach(existing.perpVaultProxyAddress) as any;
      const VAULT_ROLE = await perp.VAULT_ROLE();
      const tx = await perp.grantRole(VAULT_ROLE, tradingVaultAddress);
      await tx.wait();
    }

    if (existing.predictionVaultProxyAddress) {
      console.log(`[05d] Granting VAULT_ROLE on CircuitsPredictionVault to ${tradingVaultAddress}...`);
      const PredFactory = await ethers.getContractFactory("CircuitsPredictionVault");
      const pred = PredFactory.attach(existing.predictionVaultProxyAddress) as any;
      const VAULT_ROLE = await pred.VAULT_ROLE();
      const tx = await pred.grantRole(VAULT_ROLE, tradingVaultAddress);
      await tx.wait();
    }

    console.log(`[05d] Ensuring venues are approved on CircuitsAgentTradingVault...`);
    const TradingVaultFactory = await ethers.getContractFactory("CircuitsAgentTradingVault");
    const vault = TradingVaultFactory.attach(tradingVaultAddress) as any;

    if (existing.perpVaultProxyAddress) {
      const tx = await vault.setApprovedVenue(existing.perpVaultProxyAddress, true);
      await tx.wait();
    }
    if (existing.predictionVaultProxyAddress) {
      const tx = await vault.setApprovedVenue(existing.predictionVaultProxyAddress, true);
      await tx.wait();
    }
    if (existing.launchpadProxyAddress) {
      const tx = await vault.setApprovedVenue(existing.launchpadProxyAddress, true);
      await tx.wait();
    }
  }

  console.log(`[05d] All Arc Testnet Degen contracts upgraded & configured successfully!`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export default main;
