import { ethers, network } from "hardhat";
import { readDeployment } from "./lib/deployments";
import { CCTP_NETWORKS, cctpNetworkByChainId } from "./lib/cctpNetworks";

/// Wires *this* chain's already-deployed ClawdHQCrossChainIdentity to trust the other 2 CCTP
/// chains' deployments, by calling `setPeer(theirDomain, theirAddress)` once per sibling.
/// Deployment records for all chains live side by side under packages/contracts-evm/deployments/
/// regardless of which network Hardhat is currently connected to, so this script can read the
/// other 2 chains' addresses without needing an RPC connection to them — only a submission
/// transaction on *this* chain is sent.
///
/// Idempotent and safe to re-run: skips any sibling whose deployment record doesn't exist yet
/// (e.g. run this on Base and Ethereum Sepolia first, then again after Arc Testnet comes
/// online — the first two runs just silently skip Arc). Run once per chain, i.e. 3 times total
/// (`--network baseSepolia`, `--network ethSepolia`, `--network arcTestnet`), to fully mesh all 3.
async function main() {
  const chainId = network.config.chainId;
  if (!chainId) throw new Error(`Network ${network.name} has no chainId configured`);

  const thisNetwork = cctpNetworkByChainId(chainId);
  if (!thisNetwork) {
    throw new Error(`Network ${network.name} (chainId ${chainId}) is not a supported CCTP network — see lib/cctpNetworks.ts`);
  }

  const ownRecord = readDeployment(chainId);
  if (!ownRecord?.crossChainIdentityProxyAddress) {
    throw new Error(`ClawdHQCrossChainIdentity is not deployed on ${network.name} yet — run 02f-deploy-cross-chain-identity.ts first.`);
  }

  const identity = await ethers.getContractAt("ClawdHQCrossChainIdentity", ownRecord.crossChainIdentityProxyAddress);

  const siblings = CCTP_NETWORKS.filter((n) => n.chainId !== chainId);
  for (const sibling of siblings) {
    const siblingRecord = readDeployment(sibling.chainId);
    if (!siblingRecord?.crossChainIdentityProxyAddress) {
      console.log(`[02g] Skipping ${sibling.network} (chainId ${sibling.chainId}) — not deployed yet.`);
      continue;
    }

    const siblingDomainEnv = process.env[`${sibling.envPrefix}_CCTP_DOMAIN`];
    if (!siblingDomainEnv) throw new Error(`Missing ${sibling.envPrefix}_CCTP_DOMAIN in .env`);
    const siblingDomain = Number(siblingDomainEnv);

    const currentPeer = await identity.peerContractByDomain(siblingDomain);
    const currentPeerAddress = ethers.getAddress(ethers.dataSlice(currentPeer, 12));
    if (currentPeerAddress.toLowerCase() === siblingRecord.crossChainIdentityProxyAddress.toLowerCase()) {
      console.log(`[02g] ${network.name} already trusts ${sibling.network} (domain ${siblingDomain}) at ${siblingRecord.crossChainIdentityProxyAddress}, skipping.`);
      continue;
    }

    console.log(`[02g] Setting peer: ${network.name} -> ${sibling.network} (domain ${siblingDomain}) = ${siblingRecord.crossChainIdentityProxyAddress}`);
    const tx = await identity.setPeer(siblingDomain, siblingRecord.crossChainIdentityProxyAddress);
    await tx.wait();
  }

  console.log(`[02g] Done configuring peers for ${network.name}.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export default main;
