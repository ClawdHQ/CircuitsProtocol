import { ethers, network, upgrades } from "hardhat";
import { readDeployment, updateDeployment } from "./lib/deployments";

/// Upgrades the already-deployed ClawdHQLaunchpad proxy to whatever `contracts/ClawdHQLaunchpad.sol`
/// currently compiles to — same shape as 04-upgrade-core.ts. `upgrades.upgradeProxy` preserves all
/// existing storage (every launch's own state) untouched; only the implementation's logic changes.
/// OpenZeppelin's plugin validates storage-layout compatibility first and refuses rather than
/// corrupting state if it detects an unsafe change — this upgrade only appends new struct/storage
/// fields (never reorders or retypes an existing one), so it's expected to pass that check cleanly.
///
/// No constructor args needed (unlike Core) — ClawdHQLaunchpad's constructor takes none.
async function main() {
  const chainId = network.config.chainId;
  if (!chainId) throw new Error(`Network ${network.name} has no chainId configured`);

  const existing = readDeployment(chainId);
  if (!existing?.launchpadProxyAddress) throw new Error(`No ClawdHQLaunchpad deployment record found for chain ${chainId} — run 01b-deploy-launchpad.ts first.`);

  console.log(`[05] Upgrading ClawdHQLaunchpad proxy ${existing.launchpadProxyAddress} on ${network.name} (chainId ${chainId})...`);
  const LaunchpadFactory = await ethers.getContractFactory("ClawdHQLaunchpad");
  await upgrades.upgradeProxy(existing.launchpadProxyAddress, LaunchpadFactory, { unsafeAllow: ["constructor"] });

  const newImplementationAddress = await upgrades.erc1967.getImplementationAddress(existing.launchpadProxyAddress);
  updateDeployment(chainId, { launchpadImplementationAddress: newImplementationAddress });

  console.log(`[05] ClawdHQLaunchpad proxy ${existing.launchpadProxyAddress} now points at implementation ${newImplementationAddress}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export default main;
