import { ethers, network } from "hardhat";
import { readDeployment, updateDeployment } from "./lib/deployments";
import deployLaunchpad from "./01b-deploy-launchpad";

/// Confirms the USDC address baked in at Core's `initialize()` matches the configured
/// per-network address, and sets bonding-curve defaults for new launches on ClawdHQLaunchpad
/// (deploying it, and transitively Core, first if needed). Idempotent — skips the on-chain
/// write if the values already match.
async function main() {
  const chainId = network.config.chainId;
  if (!chainId) throw new Error(`Network ${network.name} has no chainId configured`);

  const deployment = readDeployment(chainId);
  if (!deployment) throw new Error(`Run 00-deploy-core.ts first for ${network.name}`);

  const core = await ethers.getContractAt("ClawdHQCore", deployment.proxyAddress);

  const onChainUsdc = await core.usdc();
  if (onChainUsdc.toLowerCase() !== deployment.usdcAddress.toLowerCase()) {
    throw new Error(
      `USDC address mismatch on ${network.name}: on-chain=${onChainUsdc}, expected=${deployment.usdcAddress}. ` +
        `The proxy's USDC address is immutable post-initialize; redeploy if this needs to change.`
    );
  }
  console.log(`[02] USDC address confirmed: ${onChainUsdc}`);

  const launchpadProxyAddress = deployment.launchpadProxyAddress ?? (await deployLaunchpad());
  const launchpad = await ethers.getContractAt("ClawdHQLaunchpad", launchpadProxyAddress);

  const basePrice = BigInt(process.env.BONDING_BASE_PRICE || "1000"); // 0.001 USDC per whole token
  const slope = BigInt(process.env.BONDING_SLOPE || "1"); // +0.000001 USDC per whole token sold
  const graduationThreshold = ethers.parseUnits(process.env.GRADUATION_THRESHOLD_USDC || "69000", 6);

  const [currentBase, currentSlope, currentThreshold] = await Promise.all([
    launchpad.defaultBondingBasePrice(),
    launchpad.defaultBondingSlope(),
    launchpad.defaultGraduationThreshold(),
  ]);

  if (currentBase === basePrice && currentSlope === slope && currentThreshold === graduationThreshold) {
    console.log(`[02] Bonding params already up to date on ${network.name}, skipping.`);
  } else {
    console.log(`[02] Setting bonding params on ${network.name}: basePrice=${basePrice}, slope=${slope}, threshold=${graduationThreshold}`);
    const tx = await launchpad.setBondingParams(basePrice, slope, graduationThreshold);
    await tx.wait();
  }

  updateDeployment(chainId, { bondingParamsSet: true });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export default main;
