import { ethers, network, upgrades } from "hardhat";
import { readDeployment, updateDeployment } from "./lib/deployments";
import deployCore from "./00-deploy-core";

/// Deploys the UUPS proxy + implementation for ClawdHQEvaluatorPool, pointed at this chain's
/// already-deployed ClawdHQCore (deploying Core first if needed). Idempotent: if an evaluator
/// pool deployment record already exists for this chain, it is reused rather than redeployed.
///
/// Deploying this contract alone does *not* turn the evaluator-pool dispute path on — Core's
/// `evaluatorPoolContract` defaults to address(0) (resolveDisputeFromEvaluatorPool always
/// reverts until then). After this script, an admin still needs to:
///   1. `core.setEvaluatorPoolContract(evaluatorPoolProxyAddress)`.
/// Everything else (evaluationRequestFee, minoritySlashBps) already has sane testnet defaults
/// set in `initialize()` — see ClawdHQEvaluatorPool.sol.
async function main() {
  const chainId = network.config.chainId;
  if (!chainId) throw new Error(`Network ${network.name} has no chainId configured`);

  const existing = readDeployment(chainId);
  if (existing?.evaluatorPoolProxyAddress) {
    console.log(`[02d] ClawdHQEvaluatorPool already deployed on ${network.name} at ${existing.evaluatorPoolProxyAddress}, skipping.`);
    return existing.evaluatorPoolProxyAddress;
  }

  const coreProxyAddress = existing?.proxyAddress ?? (await deployCore());
  const coreRecord = readDeployment(chainId);
  if (!coreRecord) throw new Error(`ClawdHQCore deployment record missing for chain ${chainId} after deploy`);

  const [deployer] = await ethers.getSigners();

  console.log(`[02d] Deploying ClawdHQEvaluatorPool to ${network.name} (chainId ${chainId})...`);
  const EvaluatorPoolFactory = await ethers.getContractFactory("ClawdHQEvaluatorPool");
  const evaluatorPool = await upgrades.deployProxy(
    EvaluatorPoolFactory,
    [await deployer.getAddress(), coreProxyAddress, coreRecord.usdcAddress, coreRecord.treasury],
    { unsafeAllow: ["constructor"] }
  );
  await evaluatorPool.waitForDeployment();

  const evaluatorPoolProxyAddress = await evaluatorPool.getAddress();
  const evaluatorPoolImplementationAddress = await upgrades.erc1967.getImplementationAddress(evaluatorPoolProxyAddress);

  updateDeployment(chainId, {
    evaluatorPoolProxyAddress,
    evaluatorPoolImplementationAddress,
    evaluatorPoolDeployedAt: new Date().toISOString(),
  });

  console.log(`[02d] ClawdHQEvaluatorPool proxy deployed at ${evaluatorPoolProxyAddress} (impl ${evaluatorPoolImplementationAddress})`);
  console.log(`[02d] Reminder: call core.setEvaluatorPoolContract(evaluatorPoolProxyAddress) to actually enable this dispute path.`);
  return evaluatorPoolProxyAddress;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export default main;
