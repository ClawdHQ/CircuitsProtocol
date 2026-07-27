import { loadAllEvmChainConfigs, loadSolanaChainConfig, loadSuiChainConfig } from "./config.js";
import { runEvmListener } from "./listeners/evm.js";
import { runSolanaListener } from "./listeners/solana.js";
import { runSuiListener } from "./listeners/sui.js";
import { runCrossChainIdentityRelayer } from "./relayers/crossChainIdentity.js";

async function main() {
  const evmConfigs = loadAllEvmChainConfigs();
  const solanaConfig = loadSolanaChainConfig();
  const suiConfig = loadSuiChainConfig();

  const listeners: Promise<never | void>[] = [];
  const started: string[] = [];

  for (const config of evmConfigs) {
    listeners.push(runEvmListener(config));
    started.push(config.chain);
  }
  if (solanaConfig) {
    listeners.push(runSolanaListener(solanaConfig));
    started.push("solana");
  }
  if (suiConfig) {
    listeners.push(runSuiListener(suiConfig));
    started.push("sui");
  }

  if (listeners.length === 0) {
    console.error(
      "[indexer] No chain is fully configured. Need, per chain: EVM — {PREFIX}_RPC_URL, {PREFIX}_CONTRACT_ADDRESS, " +
        "{PREFIX}_EXCHANGE_ADDRESS; Solana — SOLANA_DEVNET_RPC_URL, SOLANA_DEVNET_PROGRAM_ID, SOLANA_DEVNET_USDC_MINT; " +
        "Sui — SUI_TESTNET_RPC_URL, SUI_TESTNET_PACKAGE_ID, SUI_TESTNET_REGISTRY_OBJECT_ID, SUI_TESTNET_USDC_TYPE. Nothing to index."
    );
    process.exitCode = 1;
    return;
  }

  // Not counted in `started`/the check above — this relayer is additive to whichever EVM chains
  // are configured, not a chain of its own, and silently no-ops (logs once, resolves) rather
  // than looping if RELAYER_PRIVATE_KEY/CIRCLE_IRIS_API_URL aren't set.
  listeners.push(runCrossChainIdentityRelayer(evmConfigs));

  console.log(`[indexer] starting listeners for: ${started.join(", ")}`);

  // Each chain's listener runs forever; if one throws (e.g. RPC outage), let the process
  // crash loudly rather than silently indexing a subset of chains — restart is expected to
  // be handled by the process supervisor (systemd/pm2/Docker), matching how apps/web itself
  // has no built-in retry-forever logic for a dead RPC either.
  await Promise.all(listeners);
}

main().catch((error) => {
  console.error("[indexer] fatal error", error);
  process.exitCode = 1;
});
