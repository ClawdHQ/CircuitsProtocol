import { ethers, network } from "hardhat";
import { readDeployment, updateDeployment } from "./lib/deployments";

/// Deploys Xero Protocol — the Uniswap V2 fork built specifically because Arc Testnet (and
/// Base/Eth Sepolia's own testnets generally) has no verified official Uniswap V2 deployment
/// ClawdHQLaunchpad.graduateLaunch could otherwise point at (see ClawdHQLaunchpad.sol's
/// `uniswapV2Router` doc comment). Plain constructor deploys, not UUPS proxies — same as
/// AgentWalletRegistry — since neither XeroFactory nor XeroRouter hold any upgradeable state
/// worth the added complexity. Idempotent via the shared deployments/{chainId}.json record,
/// same as every other script in this directory.
///
/// This script only deploys Xero — it does NOT wire it into ClawdHQLaunchpad. That's a
/// separate, deliberate step: run 06-configure-fees-and-router.ts afterward with
/// `UNISWAP_V2_ROUTER_ADDRESS=<xeroRouterAddress printed below>` (that script already reads
/// this env var generically; no code change was needed there for Xero specifically).
///
/// Env vars:
///   XERO_FEE_TO_SETTER_ADDRESS — optional, defaults to the deploying account. The address
///                                allowed to later turn on Xero's protocol fee via
///                                XeroFactory.setFeeTo (left unset/disabled at deploy).
async function main() {
  const chainId = network.config.chainId;
  if (!chainId) throw new Error(`Network ${network.name} has no chainId configured`);

  const existing = readDeployment(chainId);
  if (existing?.xeroRouterAddress) {
    console.log(`[02i] Xero Protocol already deployed on ${network.name} (router ${existing.xeroRouterAddress}), skipping.`);
    return { xeroFactoryAddress: existing.xeroFactoryAddress!, xeroRouterAddress: existing.xeroRouterAddress };
  }

  const [deployer] = await ethers.getSigners();
  const feeToSetter = process.env.XERO_FEE_TO_SETTER_ADDRESS || (await deployer.getAddress());

  console.log(`[02i] Deploying Xero Protocol to ${network.name} (chainId ${chainId})...`);

  const XeroFactoryFactory = await ethers.getContractFactory("XeroFactory");
  const xeroFactory = await XeroFactoryFactory.deploy(feeToSetter);
  await xeroFactory.waitForDeployment();
  const xeroFactoryAddress = await xeroFactory.getAddress();
  console.log(`[02i] XeroFactory deployed at ${xeroFactoryAddress} (feeToSetter ${feeToSetter}, feeTo left unset/disabled)`);

  const XeroRouterFactory = await ethers.getContractFactory("XeroRouter");
  const xeroRouter = await XeroRouterFactory.deploy(xeroFactoryAddress);
  await xeroRouter.waitForDeployment();
  const xeroRouterAddress = await xeroRouter.getAddress();
  console.log(`[02i] XeroRouter deployed at ${xeroRouterAddress}`);

  if (!existing) {
    throw new Error(
      `No deployment record exists yet for chain ${chainId} — run 00-deploy-core.ts (or any deploy script) at least once first, so this can be recorded alongside it.`
    );
  }

  updateDeployment(chainId, {
    xeroFactoryAddress,
    xeroRouterAddress,
    xeroDeployedAt: new Date().toISOString(),
  });

  console.log(
    `[02i] Done. To wire graduation to Xero, run: UNISWAP_V2_ROUTER_ADDRESS=${xeroRouterAddress} hardhat run scripts/deploy-evm/06-configure-fees-and-router.ts --network ${network.name}`
  );
  return { xeroFactoryAddress, xeroRouterAddress };
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export default main;
