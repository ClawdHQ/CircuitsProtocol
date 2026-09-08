import upgradeCore from "./04-upgrade-core";
import upgradeLaunchpad from "./05-upgrade-launchpad";
import upgradeExchange from "./05c-upgrade-exchange";

async function main() {
  console.log("=== Upgrading all EVM contracts to latest implementations ===");
  await upgradeCore();
  await upgradeLaunchpad();
  await upgradeExchange();
  console.log("=== All contracts upgraded successfully! ===");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export default main;
