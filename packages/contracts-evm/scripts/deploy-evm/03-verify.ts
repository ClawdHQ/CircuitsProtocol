import { network, run } from "hardhat";
import { readDeployment, updateDeployment } from "./lib/deployments";

/// Verifies the implementation contract on the relevant block explorer (BscScan,
/// BaseScan, or Etherscan, depending on network). Idempotent — skips if already
/// marked verified in the deployment record, and tolerates "already verified"
/// responses from the explorer itself.
async function main() {
  const chainId = network.config.chainId;
  if (!chainId) throw new Error(`Network ${network.name} has no chainId configured`);

  const deployment = readDeployment(chainId);
  if (!deployment) throw new Error(`Run 00-deploy-core.ts first for ${network.name}`);

  if (deployment.verified) {
    console.log(`[03] ${network.name} implementation already marked verified, skipping.`);
    return;
  }

  // Arcscan's Etherscan-API compatibility is unconfirmed (no customChains entry configured in
  // hardhat.config.ts yet) — treat verification there as best-effort rather than a hard failure
  // that blocks the rest of the deploy pipeline.
  if (network.name === "arcTestnet" && !process.env.ARCSCAN_API_URL) {
    console.log(`[03] Skipping verification on ${network.name}: Arcscan API compatibility not yet confirmed. Verify manually at https://testnet.arcscan.app if needed.`);
    return;
  }

  if (!deployment.agentWalletRegistryAddress) {
    throw new Error(`AgentWalletRegistry address missing from deployment record for chain ${chainId} — redeploy Core first.`);
  }

  console.log(`[03] Verifying implementation ${deployment.implementationAddress} on ${network.name}...`);
  try {
    await run("verify:verify", {
      address: deployment.implementationAddress,
      // ClawdHQCore's constructor now takes the AgentWalletRegistry address as an immutable
      // argument (see ClawdHQCore.sol's doc comment) — must match exactly or the explorer's
      // bytecode-match check fails.
      constructorArguments: [deployment.agentWalletRegistryAddress],
    });
    updateDeployment(chainId, { verified: true });
    console.log(`[03] Verified.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("already verified")) {
      console.log(`[03] Already verified on the explorer.`);
      updateDeployment(chainId, { verified: true });
    } else {
      throw error;
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export default main;
