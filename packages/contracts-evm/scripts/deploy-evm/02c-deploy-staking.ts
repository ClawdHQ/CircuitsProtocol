import { ethers, network, upgrades } from "hardhat";
import { readDeployment, updateDeployment } from "./lib/deployments";
import deployCore from "./00-deploy-core";

/// Deploys the UUPS proxy + implementation for ClawdHQStaking, pointed at this chain's
/// already-deployed ClawdHQCore (deploying Core first if needed). Idempotent: if a staking
/// deployment record already exists for this chain, it is reused rather than redeployed.
///
/// Deploying this contract alone does *not* turn staking on — ClawdHQCore.stakingContract
/// defaults to address(0) (off) and every tier's required bond defaults to 0 (no bond needed
/// even once configured). After this script, an admin still needs to:
///   1. `core.setStakingContract(stakingProxyAddress)` — opts Core's acceptJob/acceptOpenJob
///      into checking eligibility at all.
///   2. `staking.setAuthorizedSlasher(coreProxyAddress, true)` — lets a lost dispute actually
///      slash the agent's bond (see ClawdHQCore.sol's resolveDispute).
///   3. `staking.setRequiredBond(tier, amount)` per tier that should actually require one.
/// None of these are run automatically here — they're real economic decisions, not deploy
/// mechanics, and this script only wires the contracts together.
async function main() {
  const chainId = network.config.chainId;
  if (!chainId) throw new Error(`Network ${network.name} has no chainId configured`);

  const existing = readDeployment(chainId);
  if (existing?.stakingProxyAddress) {
    console.log(`[02c] ClawdHQStaking already deployed on ${network.name} at ${existing.stakingProxyAddress}, skipping.`);
    return existing.stakingProxyAddress;
  }

  const coreProxyAddress = existing?.proxyAddress ?? (await deployCore());
  const coreRecord = readDeployment(chainId);
  if (!coreRecord) throw new Error(`ClawdHQCore deployment record missing for chain ${chainId} after deploy`);

  const [deployer] = await ethers.getSigners();

  console.log(`[02c] Deploying ClawdHQStaking to ${network.name} (chainId ${chainId})...`);
  const StakingFactory = await ethers.getContractFactory("ClawdHQStaking");
  const staking = await upgrades.deployProxy(
    StakingFactory,
    [await deployer.getAddress(), coreProxyAddress, coreRecord.usdcAddress],
    // See ClawdHQStaking.sol NatSpec: ReentrancyGuard's constructor is upgrade-safe by design
    // (ERC-7201 namespaced storage, no meaningful state to lose).
    { unsafeAllow: ["constructor"] }
  );
  await staking.waitForDeployment();

  const stakingProxyAddress = await staking.getAddress();
  const stakingImplementationAddress = await upgrades.erc1967.getImplementationAddress(stakingProxyAddress);

  updateDeployment(chainId, {
    stakingProxyAddress,
    stakingImplementationAddress,
    stakingDeployedAt: new Date().toISOString(),
  });

  console.log(`[02c] ClawdHQStaking proxy deployed at ${stakingProxyAddress} (impl ${stakingImplementationAddress})`);
  console.log(`[02c] Reminder: staking is inert until an admin calls core.setStakingContract, staking.setAuthorizedSlasher, and staking.setRequiredBond — see this file's header comment.`);
  return stakingProxyAddress;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export default main;
