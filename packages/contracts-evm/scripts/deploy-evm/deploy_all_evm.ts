import deployCore from "./00-deploy-core";
import grantRoles from "./01-grant-roles";
import configureParams from "./02-configure-params";
import verify from "./03-verify";

/// Master orchestrator — runs all four deploy steps in order for whichever network
/// `--network` was passed on the CLI. Each step is independently idempotent, so this
/// script is safe to re-run after a partial failure.
async function main() {
  await deployCore();
  await grantRoles();
  await configureParams();
  await verify();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
