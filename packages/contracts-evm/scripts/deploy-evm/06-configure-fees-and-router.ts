import { ethers, network } from "hardhat";
import { readDeployment } from "./lib/deployments";

/// Sets the spam-prevention registration/launch fees and (where a verified DEX exists)
/// ClawdHQLaunchpad's Uniswap V2 router — the admin-config half of the fee/tokenomics rewrite
/// that 05-upgrade-launchpad.ts's code change makes possible. Idempotent — skips any write whose
/// on-chain value already matches. Env vars, each optional (unset/empty means "leave unset" for
/// the router, "leave at 0 / free" for the fees):
///   REGISTRATION_FEE_USDC        — ClawdHQCore.registrationFee, decimal USDC (e.g. "5")
///   LAUNCH_FEE_USDC              — ClawdHQLaunchpad.launchFee, decimal USDC (e.g. "10")
///   UNISWAP_V2_ROUTER_ADDRESS    — only set on a chain with a verified official Uniswap V2
///                                  deployment (Ethereum Sepolia as of this writing — see
///                                  ClawdHQLaunchpad.sol's uniswapV2Router doc comment); leave
///                                  unset on chains without one rather than pointing graduation
///                                  at an unverified contract.
async function main() {
  const chainId = network.config.chainId;
  if (!chainId) throw new Error(`Network ${network.name} has no chainId configured`);

  const deployment = readDeployment(chainId);
  if (!deployment?.proxyAddress) throw new Error(`Run 00-deploy-core.ts first for ${network.name}`);
  if (!deployment.launchpadProxyAddress) throw new Error(`Run 01b-deploy-launchpad.ts first for ${network.name}`);

  const core = await ethers.getContractAt("ClawdHQCore", deployment.proxyAddress);
  const launchpad = await ethers.getContractAt("ClawdHQLaunchpad", deployment.launchpadProxyAddress);

  if (process.env.REGISTRATION_FEE_USDC) {
    const fee = ethers.parseUnits(process.env.REGISTRATION_FEE_USDC, 6);
    const current = await core.registrationFee();
    if (current === fee) {
      console.log(`[06] registrationFee already ${fee} on ${network.name}, skipping.`);
    } else {
      console.log(`[06] Setting registrationFee=${fee} on ${network.name}...`);
      await (await core.setRegistrationFee(fee)).wait();
    }
  }

  if (process.env.LAUNCH_FEE_USDC) {
    const fee = ethers.parseUnits(process.env.LAUNCH_FEE_USDC, 6);
    const current = await launchpad.launchFee();
    if (current === fee) {
      console.log(`[06] launchFee already ${fee} on ${network.name}, skipping.`);
    } else {
      console.log(`[06] Setting launchFee=${fee} on ${network.name}...`);
      await (await launchpad.setLaunchFee(fee)).wait();
    }
  }

  if (process.env.UNISWAP_V2_ROUTER_ADDRESS) {
    const router = process.env.UNISWAP_V2_ROUTER_ADDRESS;
    const current = await launchpad.uniswapV2Router();
    if (current.toLowerCase() === router.toLowerCase()) {
      console.log(`[06] uniswapV2Router already ${router} on ${network.name}, skipping.`);
    } else {
      console.log(`[06] Setting uniswapV2Router=${router} on ${network.name}...`);
      await (await launchpad.setUniswapV2Router(router)).wait();
    }
  } else {
    console.log(`[06] UNISWAP_V2_ROUTER_ADDRESS not set for ${network.name} — leaving graduation disabled on this chain.`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export default main;
