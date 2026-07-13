import { ethers, network } from "hardhat";
import { readDeployment, updateDeployment } from "./lib/deployments";

/// Grants PAUSER_ROLE, VERIFIER_ROLE, and RESOLVER_ROLE to the deployer (idempotent —
/// `initialize()` already grants these to the `admin` address passed in, so this is a
/// no-op in the default single-deployer setup but lets a later run re-target a
/// different operator address via ROLE_RECIPIENT_ADDRESS without redeploying).
async function main() {
  const chainId = network.config.chainId;
  if (!chainId) throw new Error(`Network ${network.name} has no chainId configured`);

  const deployment = readDeployment(chainId);
  if (!deployment) throw new Error(`Run 00-deploy-core.ts first for ${network.name}`);

  const [deployer] = await ethers.getSigners();
  const recipient = process.env.ROLE_RECIPIENT_ADDRESS || (await deployer.getAddress());

  const core = await ethers.getContractAt("ClawdHQCore", deployment.proxyAddress);

  const roles = [
    { name: "PAUSER_ROLE", hash: await core.PAUSER_ROLE() },
    { name: "VERIFIER_ROLE", hash: await core.VERIFIER_ROLE() },
    { name: "RESOLVER_ROLE", hash: await core.RESOLVER_ROLE() },
    { name: "DEFAULT_ADMIN_ROLE", hash: await core.DEFAULT_ADMIN_ROLE() },
  ];

  for (const role of roles) {
    const already = await core.hasRole(role.hash, recipient);
    if (already) {
      console.log(`[01] ${recipient} already has ${role.name}, skipping.`);
      continue;
    }
    console.log(`[01] Granting ${role.name} to ${recipient}...`);
    const tx = await core.grantRole(role.hash, recipient);
    await tx.wait();
  }

  updateDeployment(chainId, { rolesGranted: true });
  console.log(`[01] Roles confirmed on ${network.name}.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export default main;
