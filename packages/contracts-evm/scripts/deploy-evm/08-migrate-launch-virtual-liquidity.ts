import { ethers, network } from "hardhat";
import { readDeployment } from "./lib/deployments";

/// One-off admin migration for a launch created before the v3 constant-product curve existed
/// (`AgentLaunch.initialVirtualUsdcReserve == 0`) onto it — see
/// ClawdHQLaunchpad.sol's `migrateLaunchVirtualLiquidity` doc comment for why this is only ever
/// safe for a launch with zero real trading activity. Idempotent: skips if the launch already
/// has a nonzero virtual reserve (already migrated, or created after this upgrade).
///
/// Env vars:
///   MIGRATE_LAUNCH_ID             — required. The on-chain launchId to migrate (e.g. "1").
///   MIGRATE_VIRTUAL_USDC_RESERVE  — required. Decimal USDC (e.g. "4000") — the same figure
///                                   `setBondingParams`/`initialize()` use for new launches,
///                                   unless there's a specific reason to give this one launch a
///                                   different starting FDV.
async function main() {
  const chainId = network.config.chainId;
  if (!chainId) throw new Error(`Network ${network.name} has no chainId configured`);

  const deployment = readDeployment(chainId);
  if (!deployment?.launchpadProxyAddress) throw new Error(`Run 01b-deploy-launchpad.ts first for ${network.name}`);

  const launchIdEnv = process.env.MIGRATE_LAUNCH_ID;
  if (!launchIdEnv) throw new Error("MIGRATE_LAUNCH_ID is required (e.g. \"1\")");
  const launchId = BigInt(launchIdEnv);

  const reserveEnv = process.env.MIGRATE_VIRTUAL_USDC_RESERVE;
  if (!reserveEnv) throw new Error("MIGRATE_VIRTUAL_USDC_RESERVE is required (decimal USDC, e.g. \"4000\")");
  const targetReserve = ethers.parseUnits(reserveEnv, 6);

  const launchpad = await ethers.getContractAt("ClawdHQLaunchpad", deployment.launchpadProxyAddress);

  const launch = await launchpad.launches(launchId);
  if (launch.initialVirtualUsdcReserve !== 0n) {
    console.log(`[08] Launch ${launchId} already has initialVirtualUsdcReserve=${launch.initialVirtualUsdcReserve} on ${network.name}, skipping.`);
    return;
  }
  if (launch.tokensSold !== 0n) {
    throw new Error(`Launch ${launchId} has tokensSold=${launch.tokensSold} — migrateLaunchVirtualLiquidity only allows a launch with zero trading activity.`);
  }

  console.log(`[08] Migrating launch ${launchId} (${launch.name}) on ${network.name} to initialVirtualUsdcReserve=${targetReserve}...`);
  await (await launchpad.migrateLaunchVirtualLiquidity(launchId, targetReserve)).wait();
  console.log(`[08] Done.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export default main;
