import { ethers, network, upgrades } from "hardhat";
import { readDeployment, updateDeployment } from "./lib/deployments";
import { cctpNetworkByChainId } from "./lib/cctpNetworks";
import deployCore from "./00-deploy-core";

/// Deploys the UUPS proxy + implementation for ClawdHQCrossChainIdentity, pointed at this
/// chain's already-deployed ClawdHQCore (deploying Core first if needed) and at Circle's real
/// MessageTransmitterV2 for this chain. Idempotent: if a deployment record already exists for
/// this chain, it is reused rather than redeployed. Only valid on the 3 CCTP V2 testnet chains
/// this app supports — see lib/cctpNetworks.ts.
///
/// Deploying this alone does *not* let it talk to its siblings on the other 2 chains —
/// {peerContractByDomain} is empty by default. After this script has been run on all 3 chains,
/// run 02g-configure-cross-chain-identity-peers.ts on each of the 3 (in any order, any number of
/// times — both scripts are idempotent) to wire them together.
async function main() {
  const chainId = network.config.chainId;
  if (!chainId) throw new Error(`Network ${network.name} has no chainId configured`);

  const cctpNetwork = cctpNetworkByChainId(chainId);
  if (!cctpNetwork) {
    throw new Error(`Network ${network.name} (chainId ${chainId}) is not a supported CCTP network — see lib/cctpNetworks.ts`);
  }

  const existing = readDeployment(chainId);
  if (existing?.crossChainIdentityProxyAddress) {
    console.log(`[02f] ClawdHQCrossChainIdentity already deployed on ${network.name} at ${existing.crossChainIdentityProxyAddress}, skipping.`);
    return existing.crossChainIdentityProxyAddress;
  }

  const coreProxyAddress = existing?.proxyAddress ?? (await deployCore());

  const localDomainEnv = process.env[`${cctpNetwork.envPrefix}_CCTP_DOMAIN`];
  const messageTransmitterAddress = process.env[`${cctpNetwork.envPrefix}_CCTP_MESSAGE_TRANSMITTER_ADDRESS`];
  if (!localDomainEnv) throw new Error(`Missing ${cctpNetwork.envPrefix}_CCTP_DOMAIN in .env`);
  if (!messageTransmitterAddress) throw new Error(`Missing ${cctpNetwork.envPrefix}_CCTP_MESSAGE_TRANSMITTER_ADDRESS in .env`);
  const localDomain = Number(localDomainEnv);

  const [deployer] = await ethers.getSigners();

  console.log(`[02f] Deploying ClawdHQCrossChainIdentity to ${network.name} (chainId ${chainId}, CCTP domain ${localDomain})...`);
  const IdentityFactory = await ethers.getContractFactory("ClawdHQCrossChainIdentity");
  const identity = await upgrades.deployProxy(
    IdentityFactory,
    [await deployer.getAddress(), coreProxyAddress, localDomain, messageTransmitterAddress],
    { unsafeAllow: ["constructor"] }
  );
  await identity.waitForDeployment();

  const crossChainIdentityProxyAddress = await identity.getAddress();
  const crossChainIdentityImplementationAddress = await upgrades.erc1967.getImplementationAddress(crossChainIdentityProxyAddress);

  updateDeployment(chainId, {
    crossChainIdentityProxyAddress,
    crossChainIdentityImplementationAddress,
    crossChainIdentityDeployedAt: new Date().toISOString(),
  });

  console.log(`[02f] ClawdHQCrossChainIdentity proxy deployed at ${crossChainIdentityProxyAddress} (impl ${crossChainIdentityImplementationAddress})`);
  console.log(`[02f] Reminder: run 02g-configure-cross-chain-identity-peers.ts on this and the other CCTP chains once all 3 are deployed.`);
  return crossChainIdentityProxyAddress;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export default main;
