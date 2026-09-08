import { ethers, network, upgrades } from "hardhat";
import { readDeployment, updateDeployment } from "./lib/deployments";

/// Upgrades the already-deployed ClawdHQAgentExchange proxy to whatever `contracts/ClawdHQAgentExchange.sol`
/// currently compiles to.
async function main() {
  const chainId = network.config.chainId;
  if (!chainId) throw new Error(`Network ${network.name} has no chainId configured`);

  const existing = readDeployment(chainId);
  if (!existing?.exchangeProxyAddress) throw new Error(`No ClawdHQAgentExchange deployment record found for chain ${chainId} — run 01-deploy-exchange.ts first.`);

  console.log(`[05c] Upgrading ClawdHQAgentExchange proxy ${existing.exchangeProxyAddress} on ${network.name} (chainId ${chainId})...`);
  const ExchangeFactory = await ethers.getContractFactory("ClawdHQAgentExchange");
  await upgrades.upgradeProxy(existing.exchangeProxyAddress, ExchangeFactory, { unsafeAllow: ["constructor"] });

  const newImplementationAddress = await upgrades.erc1967.getImplementationAddress(existing.exchangeProxyAddress);
  updateDeployment(chainId, { exchangeImplementationAddress: newImplementationAddress });

  console.log(`[05c] ClawdHQAgentExchange proxy ${existing.exchangeProxyAddress} now points at implementation ${newImplementationAddress}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export default main;
