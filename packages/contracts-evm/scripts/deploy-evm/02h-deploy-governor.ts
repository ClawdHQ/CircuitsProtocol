import { ethers, network, upgrades } from "hardhat";
import { readDeployment, updateDeployment } from "./lib/deployments";
import deployStaking from "./02c-deploy-staking";

/// Deploys the UUPS proxy + implementation for ClawdHQGovernor, pointed at this chain's
/// already-deployed ClawdHQCore and ClawdHQStaking (deploying Staking — and transitively Core,
/// via 02c's own idempotent logic — first if either is missing). Idempotent: if a governor
/// deployment record already exists for this chain, it is reused rather than redeployed.
///
/// Unlike Staking, Governor needs no extra manual post-deploy wiring to be usable — its
/// `initialize` seeds every proposal category with a working default quorum (see
/// ClawdHQGovernor.sol's NatSpec) since the whole point of this contract is to be immediately
/// testable, not to gate a real economic decision the way Staking's required-bond amounts do.
async function main() {
  const chainId = network.config.chainId;
  if (!chainId) throw new Error(`Network ${network.name} has no chainId configured`);

  const existing = readDeployment(chainId);
  if (existing?.governorProxyAddress) {
    console.log(`[02h] ClawdHQGovernor already deployed on ${network.name} at ${existing.governorProxyAddress}, skipping.`);
    return existing.governorProxyAddress;
  }

  const stakingProxyAddress = existing?.stakingProxyAddress ?? (await deployStaking());
  const coreRecord = readDeployment(chainId);
  if (!coreRecord?.proxyAddress) throw new Error(`ClawdHQCore deployment record missing for chain ${chainId} after deploy`);

  const [deployer] = await ethers.getSigners();

  console.log(`[02h] Deploying ClawdHQGovernor to ${network.name} (chainId ${chainId})...`);
  const GovernorFactory = await ethers.getContractFactory("ClawdHQGovernor");
  const governor = await upgrades.deployProxy(GovernorFactory, [await deployer.getAddress(), coreRecord.proxyAddress, stakingProxyAddress]);
  await governor.waitForDeployment();

  const governorProxyAddress = await governor.getAddress();
  const governorImplementationAddress = await upgrades.erc1967.getImplementationAddress(governorProxyAddress);

  updateDeployment(chainId, {
    governorProxyAddress,
    governorImplementationAddress,
    governorDeployedAt: new Date().toISOString(),
  });

  console.log(`[02h] ClawdHQGovernor proxy deployed at ${governorProxyAddress} (impl ${governorImplementationAddress})`);
  return governorProxyAddress;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export default main;
