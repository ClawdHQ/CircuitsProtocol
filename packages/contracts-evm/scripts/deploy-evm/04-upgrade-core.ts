import { ethers, network, upgrades } from "hardhat";
import { readDeployment, updateDeployment } from "./lib/deployments";

/// Upgrades the already-deployed ClawdHQCore proxy to whatever `contracts/ClawdHQCore.sol`
/// currently compiles to. Needed the first time a Core-touching satellite contract
/// (Staking/EvaluatorPool/Negotiation) is wired in on a given chain if that chain's Core proxy
/// predates the field/setter/hook that satellite depends on — `upgrades.upgradeProxy` handles
/// preserving all existing storage (agents, jobs, listings, etc.) untouched; only the
/// implementation's logic changes. OpenZeppelin's plugin validates storage-layout compatibility
/// before allowing the upgrade and refuses rather than corrupting state if it detects an unsafe
/// change.
///
/// Requires the same `agentWalletRegistryAddress` constructor arg as the original deploy (see
/// ClawdHQCore.sol: it's an immutable, baked into each implementation's own bytecode, not proxy
/// storage) — pulled from the existing deployment record, never re-prompted.
async function main() {
  const chainId = network.config.chainId;
  if (!chainId) throw new Error(`Network ${network.name} has no chainId configured`);

  const existing = readDeployment(chainId);
  if (!existing?.proxyAddress) throw new Error(`No ClawdHQCore deployment record found for chain ${chainId} — run 00-deploy-core.ts first.`);
  if (!existing.agentWalletRegistryAddress) throw new Error(`Deployment record for chain ${chainId} is missing agentWalletRegistryAddress.`);

  console.log(`[04] Upgrading ClawdHQCore proxy ${existing.proxyAddress} on ${network.name} (chainId ${chainId})...`);
  const CoreFactory = await ethers.getContractFactory("ClawdHQCore");
  await upgrades.upgradeProxy(existing.proxyAddress, CoreFactory, {
    unsafeAllow: ["constructor"],
    constructorArgs: [existing.agentWalletRegistryAddress],
  });

  const newImplementationAddress = await upgrades.erc1967.getImplementationAddress(existing.proxyAddress);
  updateDeployment(chainId, { implementationAddress: newImplementationAddress, verified: false });

  console.log(`[04] ClawdHQCore proxy ${existing.proxyAddress} now points at implementation ${newImplementationAddress}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export default main;
