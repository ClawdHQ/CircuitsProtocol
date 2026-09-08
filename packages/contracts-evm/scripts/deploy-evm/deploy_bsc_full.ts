import { ethers, network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";
import { readDeployment, updateDeployment } from "./lib/deployments";

import deployCore from "./00-deploy-core";
import deployExchange from "./01-deploy-exchange";
import deployLaunchpad from "./01b-deploy-launchpad";
import grantRoles from "./01-grant-roles";
import deployStaking from "./02c-deploy-staking";
import deployEvaluatorPool from "./02d-deploy-evaluator-pool";
import deployNegotiation from "./02e-deploy-negotiation";
import deployGovernor from "./02h-deploy-governor";
import deployXero from "./02i-deploy-xero";
import configureFeesAndRouter from "./06-configure-fees-and-router";
import setBondingParams from "./07-set-bonding-params";
import deployPredictionVault from "./02j-deploy-prediction-vault";
import deployPerpVault from "./02k-deploy-perp-vault";
import deployAgentTradingVault from "./02l-deploy-agent-trading-vault";

/**
 * Master orchestrator for full Binance Smart Chain (BSC) Testnet deployment.
 * Track A: Binance Agent OS Mini Hackathon.
 *
 * Sequence:
 *   1. MockUSDC (6 decimals) — testnet ERC-20 token + mint 1M to deployer
 *   2. AgentWalletRegistry & ClawdHQCore proxy
 *   3. ClawdHQAgentExchange proxy
 *   4. ClawdHQLaunchpad proxy
 *   5. Grant roles (PAUSER, VERIFIER, RESOLVER, ADMIN)
 *   6. ClawdHQStaking proxy
 *   7. ClawdHQEvaluatorPool proxy
 *   8. ClawdHQNegotiation proxy
 *   9. ClawdHQGovernor proxy
 *  10. Xero Protocol (XeroFactory & XeroRouter DEX)
 *  11. Wire Xero router into Launchpad
 *  12. Set Launchpad bonding curve defaults
 *  13. Connect core authorizations (staking, slashers, evaluator pool, negotiation)
 *  14. Deploy Circuits prediction, perp, and agent trading vaults
 */
async function retryTx<T>(fn: () => Promise<T>, label: string, retries = 3): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      if (i === retries - 1) throw err;
      console.warn(`[Retry] ${label} failed with ${err.message || err}, retrying in 3s... (attempt ${i + 2}/${retries})`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

async function main() {
  const chainId = network.config.chainId;
  if (chainId !== 97) {
    throw new Error(`deploy_bsc_full must run on bscTestnet (chainId 97), got ${chainId} (${network.name})`);
  }

  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  const balance = await ethers.provider.getBalance(deployerAddress);
  console.log("===============================================================================");
  console.log("             CIRCUITS PROTOCOL — BSC TESTNET DEPLOYMENT (CHAIN ID 97)          ");
  console.log("===============================================================================");
  console.log(`Deployer: ${deployerAddress}`);
  console.log(`Balance:  ${ethers.formatEther(balance)} tBNB`);
  console.log(`Block:    ${await ethers.provider.getBlockNumber()}`);
  console.log("===============================================================================\n");

  if (balance === 0n) {
    throw new Error(`Deployer ${deployerAddress} has zero tBNB balance on BSC Testnet`);
  }

  // --------------------------------------------------------------------------
  // Step 1: Deploy or resolve MockUSDC (6 decimals)
  // --------------------------------------------------------------------------
  let usdcAddress = process.env.NEXT_PUBLIC_BSC_TESTNET_USDC_ADDRESS;
  const existingRecord = readDeployment(97);
  if (existingRecord?.usdcAddress) {
    usdcAddress = existingRecord.usdcAddress;
    console.log(`[USDC] Reusing existing MockUSDC from deployment record: ${usdcAddress}`);
  } else if (!usdcAddress || usdcAddress.trim() === "" || usdcAddress === "0x0000000000000000000000000000000000000000") {
    console.log("[USDC] Deploying MockUSDC (6 decimals) on BSC Testnet...");
    const MockUSDCFactory = await ethers.getContractFactory("MockUSDC");
    const mockUsdc = await MockUSDCFactory.deploy();
    await mockUsdc.waitForDeployment();
    usdcAddress = await mockUsdc.getAddress();
    console.log(`[USDC] MockUSDC deployed at ${usdcAddress}`);

    console.log(`[USDC] Minting 1,000,000 MockUSDC to deployer ${deployerAddress}...`);
    const mintTx = await mockUsdc.mint(deployerAddress, ethers.parseUnits("1000000", 6));
    await mintTx.wait();
    console.log("[USDC] Mint confirmed.");
  } else {
    console.log(`[USDC] Using configured MockUSDC address: ${usdcAddress}`);
  }

  process.env.NEXT_PUBLIC_BSC_TESTNET_USDC_ADDRESS = usdcAddress;
  process.env.BSC_TESTNET_USDC_ADDRESS = usdcAddress;

  // --------------------------------------------------------------------------
  // Step 2: Deploy ClawdHQCore (+ AgentWalletRegistry)
  // --------------------------------------------------------------------------
  console.log("\n--- [Step 2] Deploying Core & AgentWalletRegistry ---");
  const coreAddress = await deployCore();

  // --------------------------------------------------------------------------
  // Step 3: Deploy ClawdHQAgentExchange
  // --------------------------------------------------------------------------
  console.log("\n--- [Step 3] Deploying ClawdHQAgentExchange ---");
  const exchangeAddress = await deployExchange();

  // --------------------------------------------------------------------------
  // Step 4: Deploy ClawdHQLaunchpad
  // --------------------------------------------------------------------------
  console.log("\n--- [Step 4] Deploying ClawdHQLaunchpad ---");
  const launchpadAddress = await deployLaunchpad();

  // --------------------------------------------------------------------------
  // Step 5: Grant Roles
  // --------------------------------------------------------------------------
  console.log("\n--- [Step 5] Granting Roles ---");
  await grantRoles();

  // --------------------------------------------------------------------------
  // Step 6: Deploy ClawdHQStaking
  // --------------------------------------------------------------------------
  console.log("\n--- [Step 6] Deploying ClawdHQStaking ---");
  const stakingAddress = await deployStaking();

  // --------------------------------------------------------------------------
  // Step 7: Deploy ClawdHQEvaluatorPool
  // --------------------------------------------------------------------------
  console.log("\n--- [Step 7] Deploying ClawdHQEvaluatorPool ---");
  const evaluatorPoolAddress = await deployEvaluatorPool();

  // --------------------------------------------------------------------------
  // Step 8: Deploy ClawdHQNegotiation
  // --------------------------------------------------------------------------
  console.log("\n--- [Step 8] Deploying ClawdHQNegotiation ---");
  const negotiationAddress = await deployNegotiation();

  // --------------------------------------------------------------------------
  // Step 9: Deploy ClawdHQGovernor
  // --------------------------------------------------------------------------
  console.log("\n--- [Step 9] Deploying ClawdHQGovernor ---");
  const governorAddress = await deployGovernor();

  // --------------------------------------------------------------------------
  // Step 10: Deploy Xero Protocol (Uniswap V2 fork)
  // --------------------------------------------------------------------------
  console.log("\n--- [Step 10] Deploying Xero Protocol ---");
  const { xeroFactoryAddress, xeroRouterAddress } = await deployXero();

  // --------------------------------------------------------------------------
  // Step 11: Configure Fees and Wire Xero Router to Launchpad
  // --------------------------------------------------------------------------
  console.log("\n--- [Step 11] Wiring Xero Router to Launchpad ---");
  process.env.UNISWAP_V2_ROUTER_ADDRESS = xeroRouterAddress;
  await configureFeesAndRouter();

  // --------------------------------------------------------------------------
  // Step 12: Set Launchpad Bonding Curve Params
  // --------------------------------------------------------------------------
  console.log("\n--- [Step 12] Setting Launchpad Bonding Curve Defaults ---");
  process.env.GRADUATION_THRESHOLD_USDC = "19000";
  process.env.INITIAL_VIRTUAL_USDC_RESERVE = "4000";
  await setBondingParams();

  // --------------------------------------------------------------------------
  // Step 13: Wire Core Authorizations
  // --------------------------------------------------------------------------
  console.log("\n--- [Step 13] Connecting Core Authorizations ---");
  const core = await ethers.getContractAt("ClawdHQCore", coreAddress);
  const staking = await ethers.getContractAt("ClawdHQStaking", stakingAddress);

  await retryTx(async () => {
    const currentStaking = await core.stakingContract();
    if (currentStaking.toLowerCase() !== stakingAddress.toLowerCase()) {
      console.log(`[Wiring] Setting core.stakingContract -> ${stakingAddress}...`);
      await (await core.setStakingContract(stakingAddress)).wait();
    }
  }, "Set Staking Contract");

  await retryTx(async () => {
    const isSlasher = await staking.authorizedSlashers(coreAddress);
    if (!isSlasher) {
      console.log(`[Wiring] Authorizing core as slasher on staking contract...`);
      await (await staking.setAuthorizedSlasher(coreAddress, true)).wait();
    }
  }, "Set Authorized Slasher");

  await retryTx(async () => {
    const currentEvaluatorPool = await core.evaluatorPoolContract();
    if (currentEvaluatorPool.toLowerCase() !== evaluatorPoolAddress.toLowerCase()) {
      console.log(`[Wiring] Setting core.evaluatorPoolContract -> ${evaluatorPoolAddress}...`);
      await (await core.setEvaluatorPoolContract(evaluatorPoolAddress)).wait();
    }
  }, "Set Evaluator Pool Contract");

  await retryTx(async () => {
    const isNegotiationTrusted = await core.trustedNegotiationContracts(negotiationAddress);
    if (!isNegotiationTrusted) {
      console.log(`[Wiring] Setting core trustedNegotiationContracts(${negotiationAddress}) -> true...`);
      await (await core.setTrustedNegotiationContract(negotiationAddress, true)).wait();
    }
  }, "Set Trusted Negotiation Contract");

  // --------------------------------------------------------------------------
  // Step 14: Deploy Circuits Degen Suite (Prediction, Perp, AgentTradingVault)
  // --------------------------------------------------------------------------
  console.log("\n--- [Step 14] Deploying Circuits Degen Suite ---");
  const predictionVaultAddress = await retryTx(() => deployPredictionVault(), "Deploy Prediction Vault");
  const perpVaultAddress = await retryTx(() => deployPerpVault(), "Deploy Perp Vault");
  const agentTradingVaultAddress = await retryTx(() => deployAgentTradingVault(), "Deploy Agent Trading Vault");

  // --------------------------------------------------------------------------
  // Step 15: Read Final Record & Print Deployment Summary
  // --------------------------------------------------------------------------
  const finalRecord = readDeployment(97);
  console.log("\n===============================================================================");
  console.log("             BSC TESTNET DEPLOYMENT COMPLETE! ADDRESS SUMMARY                  ");
  console.log("===============================================================================");
  console.log(`MockUSDC (6 decimals):           ${finalRecord?.usdcAddress}`);
  console.log(`AgentWalletRegistry:             ${finalRecord?.agentWalletRegistryAddress}`);
  console.log(`ClawdHQCore Proxy:               ${finalRecord?.proxyAddress}`);
  console.log(`ClawdHQCore Impl:                ${finalRecord?.implementationAddress}`);
  console.log(`ClawdHQAgentExchange Proxy:      ${finalRecord?.exchangeProxyAddress}`);
  console.log(`ClawdHQLaunchpad Proxy:          ${finalRecord?.launchpadProxyAddress}`);
  console.log(`ClawdHQStaking Proxy:            ${finalRecord?.stakingProxyAddress}`);
  console.log(`ClawdHQEvaluatorPool Proxy:      ${finalRecord?.evaluatorPoolProxyAddress}`);
  console.log(`ClawdHQNegotiation Proxy:        ${finalRecord?.negotiationProxyAddress}`);
  console.log(`ClawdHQGovernor Proxy:           ${finalRecord?.governorProxyAddress}`);
  console.log(`XeroFactory:                     ${finalRecord?.xeroFactoryAddress}`);
  console.log(`XeroRouter:                      ${finalRecord?.xeroRouterAddress}`);
  console.log(`CircuitsPredictionVault Proxy:   ${finalRecord?.predictionVaultProxyAddress}`);
  console.log(`CircuitsPerpVault Proxy:         ${finalRecord?.perpVaultProxyAddress}`);
  console.log(`CircuitsAgentTradingVault Proxy: ${finalRecord?.agentTradingVaultProxyAddress}`);
  console.log("===============================================================================\n");
}

main().catch((err) => {
  console.error("BSC Deployment failed:", err);
  process.exit(1);
});
