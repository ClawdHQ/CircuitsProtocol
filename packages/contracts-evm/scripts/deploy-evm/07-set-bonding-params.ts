import { ethers, network } from "hardhat";
import { readDeployment } from "./lib/deployments";

/// Sets ClawdHQLaunchpad's v3 constant-product curve defaults for future launches —
/// `setBondingParams` sets `defaultInitialVirtualUsdcReserve`/`defaultGraduationThreshold`
/// atomically (no single-field setter exists), so this script always reads the contract's
/// *current* virtual reserve first and passes it straight through unchanged unless explicitly
/// overridden — a naive script that hardcoded a default would silently reset it even if an
/// earlier admin call already changed it.
///
/// Only affects launches created *after* this call: both `AgentLaunch.initialVirtualUsdcReserve`
/// and `graduationThreshold` are captured once at `createLaunch` time and are never
/// retroactively updated — every already-live launch on this chain keeps its own values. Use
/// {migrateLaunchVirtualLiquidity} (a separate admin call, no dedicated script — see
/// ClawdHQLaunchpad.sol's own doc comment on it) to bring a specific pre-v3 launch with zero
/// trading activity onto the new curve.
///
/// Env vars:
///   GRADUATION_THRESHOLD_USDC     — required. Decimal USDC (e.g. "900").
///   INITIAL_VIRTUAL_USDC_RESERVE  — optional override, decimal USDC (e.g. "4000"). Defaults to
///                                   the current on-chain value. FDV at zero tokens sold equals
///                                   this value exactly (see ClawdHQLaunchpad.sol's doc comment
///                                   on why — the totalSupply factor cancels).
async function main() {
  const chainId = network.config.chainId;
  if (!chainId) throw new Error(`Network ${network.name} has no chainId configured`);

  const deployment = readDeployment(chainId);
  if (!deployment?.launchpadProxyAddress) throw new Error(`Run 01b-deploy-launchpad.ts first for ${network.name}`);

  const thresholdEnv = process.env.GRADUATION_THRESHOLD_USDC;
  if (!thresholdEnv) throw new Error("GRADUATION_THRESHOLD_USDC is required (decimal USDC, e.g. \"900\")");
  const targetThreshold = ethers.parseUnits(thresholdEnv, 6);

  const launchpad = await ethers.getContractAt("ClawdHQLaunchpad", deployment.launchpadProxyAddress);

  const currentReserve = await launchpad.defaultInitialVirtualUsdcReserve();
  const currentThreshold = await launchpad.defaultGraduationThreshold();

  const targetReserve = process.env.INITIAL_VIRTUAL_USDC_RESERVE ? ethers.parseUnits(process.env.INITIAL_VIRTUAL_USDC_RESERVE, 6) : currentReserve;

  if (targetThreshold === currentThreshold && targetReserve === currentReserve) {
    console.log(`[07] Bonding params already initialVirtualUsdcReserve=${currentReserve} graduationThreshold=${currentThreshold} on ${network.name}, skipping.`);
    return;
  }

  console.log(
    `[07] Setting bonding params on ${network.name}: initialVirtualUsdcReserve ${currentReserve} -> ${targetReserve}, graduationThreshold ${currentThreshold} -> ${targetThreshold}...`
  );
  await (await launchpad.setBondingParams(targetReserve, targetThreshold)).wait();
  console.log(`[07] Done. Existing already-created launches are unaffected — only new launches use the new defaults.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export default main;
