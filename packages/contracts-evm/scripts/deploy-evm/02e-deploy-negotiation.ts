import { ethers, network, upgrades } from "hardhat";
import { readDeployment, updateDeployment } from "./lib/deployments";
import deployCore from "./00-deploy-core";

/// Deploys the UUPS proxy + implementation for ClawdHQNegotiation, pointed at this chain's
/// already-deployed ClawdHQCore (deploying Core first if needed). Idempotent: if a negotiation
/// deployment record already exists for this chain, it is reused rather than redeployed.
///
/// Deploying this contract alone does *not* let it create real jobs — Core's
/// `trustedNegotiationContracts` is empty by default (postJobFromNegotiation always reverts
/// until an admin explicitly authorizes this deployment):
///   1. `core.setTrustedNegotiationContract(negotiationProxyAddress, true)`.
async function main() {
  const chainId = network.config.chainId;
  if (!chainId) throw new Error(`Network ${network.name} has no chainId configured`);

  const existing = readDeployment(chainId);
  if (existing?.negotiationProxyAddress) {
    console.log(`[02e] ClawdHQNegotiation already deployed on ${network.name} at ${existing.negotiationProxyAddress}, skipping.`);
    return existing.negotiationProxyAddress;
  }

  const coreProxyAddress = existing?.proxyAddress ?? (await deployCore());

  const [deployer] = await ethers.getSigners();

  console.log(`[02e] Deploying ClawdHQNegotiation to ${network.name} (chainId ${chainId})...`);
  const NegotiationFactory = await ethers.getContractFactory("ClawdHQNegotiation");
  const negotiation = await upgrades.deployProxy(
    NegotiationFactory,
    [await deployer.getAddress(), coreProxyAddress],
    { unsafeAllow: ["constructor"] }
  );
  await negotiation.waitForDeployment();

  const negotiationProxyAddress = await negotiation.getAddress();
  const negotiationImplementationAddress = await upgrades.erc1967.getImplementationAddress(negotiationProxyAddress);

  updateDeployment(chainId, {
    negotiationProxyAddress,
    negotiationImplementationAddress,
    negotiationDeployedAt: new Date().toISOString(),
  });

  console.log(`[02e] ClawdHQNegotiation proxy deployed at ${negotiationProxyAddress} (impl ${negotiationImplementationAddress})`);
  console.log(`[02e] Reminder: call core.setTrustedNegotiationContract(negotiationProxyAddress, true) to actually enable it.`);
  return negotiationProxyAddress;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export default main;
