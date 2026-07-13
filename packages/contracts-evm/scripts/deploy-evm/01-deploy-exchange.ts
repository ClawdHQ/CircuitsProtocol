import { ethers, network, upgrades } from "hardhat";
import { readDeployment, updateDeployment } from "./lib/deployments";
import deployCore from "./00-deploy-core";

/// Deploys the UUPS proxy + implementation for ClawdHQAgentExchange, pointed at this
/// chain's already-deployed ClawdHQCore (deploying Core first if needed). Idempotent: if an
/// exchange deployment record already exists for this chain, it is reused rather than
/// redeployed.
async function main() {
  const chainId = network.config.chainId;
  if (!chainId) throw new Error(`Network ${network.name} has no chainId configured`);

  const existing = readDeployment(chainId);
  if (existing?.exchangeProxyAddress) {
    console.log(`[01] ClawdHQAgentExchange already deployed on ${network.name} at ${existing.exchangeProxyAddress}, skipping.`);
    return existing.exchangeProxyAddress;
  }

  const coreProxyAddress = existing?.proxyAddress ?? (await deployCore());
  const coreRecord = readDeployment(chainId);
  if (!coreRecord) throw new Error(`ClawdHQCore deployment record missing for chain ${chainId} after deploy`);

  const [deployer] = await ethers.getSigners();

  console.log(`[01] Deploying ClawdHQAgentExchange to ${network.name} (chainId ${chainId})...`);
  const ExchangeFactory = await ethers.getContractFactory("ClawdHQAgentExchange");
  const exchange = await upgrades.deployProxy(
    ExchangeFactory,
    [await deployer.getAddress(), coreProxyAddress, coreRecord.usdcAddress, coreRecord.treasury],
    // See ClawdHQAgentExchange.sol NatSpec: ReentrancyGuard's constructor is upgrade-safe
    // by design (ERC-7201 namespaced storage, no meaningful state to lose).
    { unsafeAllow: ["constructor"] }
  );
  await exchange.waitForDeployment();

  const exchangeProxyAddress = await exchange.getAddress();
  const exchangeImplementationAddress = await upgrades.erc1967.getImplementationAddress(exchangeProxyAddress);

  updateDeployment(chainId, {
    exchangeProxyAddress,
    exchangeImplementationAddress,
    exchangeDeployedAt: new Date().toISOString(),
  });

  console.log(`[01] ClawdHQAgentExchange proxy deployed at ${exchangeProxyAddress} (impl ${exchangeImplementationAddress})`);
  return exchangeProxyAddress;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export default main;
