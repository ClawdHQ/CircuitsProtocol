import "../src/loadEnv.js";
import { loadSuiChainConfig } from "../src/config.js";
import { runSuiListener } from "../src/listeners/sui.js";

// Temporary, throwaway verification runner: brings up only the Sui listener, bypassing
// main.ts's Promise.all(listeners) over every configured chain — useful when EVM/Solana's
// local devnets are down and shouldn't crash a Sui-only verification pass.

const config = loadSuiChainConfig();
if (!config) throw new Error("Sui isn't fully configured — see main.ts's error message for the required env vars.");

runSuiListener(config).catch((error) => {
  console.error("[indexer:sui] fatal error", error);
  process.exitCode = 1;
});
