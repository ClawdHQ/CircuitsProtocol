import { ethers, network, upgrades } from "hardhat";
import { readDeployment, writeDeployment } from "./lib/deployments";

/// Deploys AgentWalletRegistry.sol (if not already deployed) followed by the UUPS proxy +
/// implementation for ClawdHQCore with zero fees (testnet defaults), pointed at that
/// registry via its immutable constructor argument (see ClawdHQCore.sol's doc comment on
/// why it's a constructor arg rather than a regular admin-settable variable). Idempotent: if
/// a deployment record already exists for this chain, it is reused rather than redeployed.
///
/// The registry's `registrar` is initially the deployer — a placeholder, same "rotate the
/// real signer in later" shape as X402Facilitator's constructor (see
/// scripts/local-dev/deploy-and-seed.ts's equivalent comment). Rotate it to
/// packages/custody-core/src/registrarCustody.ts's provisioned wallet via
/// `AgentWalletRegistry.setRegistrar` before relying on the indexer's automatic
/// wallet-provisioning to work on this network (see apps/indexer/scripts/rotate-local-registrar.ts
/// for the local-devnet equivalent of this step).
async function main() {
  const chainId = network.config.chainId;
  if (!chainId) throw new Error(`Network ${network.name} has no chainId configured`);

  const existing = readDeployment(chainId);
  if (existing?.proxyAddress) {
    console.log(`[00] ClawdHQCore already deployed on ${network.name} at ${existing.proxyAddress}, skipping.`);
    return existing.proxyAddress;
  }

  const [deployer] = await ethers.getSigners();
  const usdcAddress = process.env[`${networkEnvPrefix()}_USDC_ADDRESS`];
  const treasury = process.env.TREASURY_ADDRESS || (await deployer.getAddress());

  if (!usdcAddress) {
    throw new Error(`Missing ${networkEnvPrefix()}_USDC_ADDRESS in .env`);
  }

  let agentWalletRegistryAddress = existing?.agentWalletRegistryAddress;
  if (!agentWalletRegistryAddress) {
    console.log(`[00] Deploying AgentWalletRegistry to ${network.name}...`);
    const RegistryFactory = await ethers.getContractFactory("AgentWalletRegistry");
    const registry = await RegistryFactory.deploy(await deployer.getAddress(), await deployer.getAddress());
    await registry.waitForDeployment();
    agentWalletRegistryAddress = await registry.getAddress();
    console.log(`[00] AgentWalletRegistry deployed at ${agentWalletRegistryAddress}`);
  } else {
    console.log(`[00] AgentWalletRegistry already deployed on ${network.name} at ${agentWalletRegistryAddress}, skipping.`);
  }

  console.log(`[00] Deploying ClawdHQCore to ${network.name} (chainId ${chainId})...`);
  const CoreFactory = await ethers.getContractFactory("ClawdHQCore");
  const core = await upgrades.deployProxy(
    CoreFactory,
    [await deployer.getAddress(), usdcAddress, treasury],
    // See ClawdHQCore.sol NatSpec: ReentrancyGuard's constructor is upgrade-safe by
    // design (ERC-7201 namespaced storage, no meaningful state to lose).
    { unsafeAllow: ["constructor"], constructorArgs: [agentWalletRegistryAddress] }
  );
  await core.waitForDeployment();

  const proxyAddress = await core.getAddress();
  const implementationAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);

  writeDeployment(chainId, {
    chainId,
    network: network.name,
    proxyAddress,
    implementationAddress,
    usdcAddress,
    treasury,
    deployer: await deployer.getAddress(),
    rolesGranted: false,
    bondingParamsSet: false,
    verified: false,
    deployedAt: new Date().toISOString(),
    agentWalletRegistryAddress,
  });

  console.log(`[00] ClawdHQCore proxy deployed at ${proxyAddress} (impl ${implementationAddress})`);
  return proxyAddress;
}

function networkEnvPrefix(): string {
  const map: Record<string, string> = {
    bscTestnet: "NEXT_PUBLIC_BSC_TESTNET",
    baseSepolia: "NEXT_PUBLIC_BASE_SEPOLIA",
    ethSepolia: "NEXT_PUBLIC_ETH_SEPOLIA",
    arcTestnet: "NEXT_PUBLIC_ARC_TESTNET",
  };
  const prefix = map[network.name];
  if (!prefix) throw new Error(`Unknown network ${network.name}`);
  return prefix;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export default main;
