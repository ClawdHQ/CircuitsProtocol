import "../src/loadEnv.js";
import { createPublicClient, http } from "viem";
import { clawdHQCoreAbi } from "@clawdhq/sdk";
import { loadAllEvmChainConfigs, type EvmChainIndexerConfig } from "../src/config.js";
import { syncAgent } from "../src/listeners/evm.js";

// One-off backfill for the Agent table added in marketplace-db's 20260716200000_add_agent
// migration. The indexer's event-log cursor is already past every existing agent's
// AgentRegistered block, so processBatch will never see those events again — this script seeds
// every agent that was already registered before the Agent table existed, by walking
// totalAgents() directly rather than replaying history. Idempotent (syncAgent upserts), safe to
// re-run.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A single call's own retryCount/retryDelay isn't enough on its own — observed in practice on
// Arc Testnet's 1-request/second limiter, back-to-back calls (e.g. totalAgents() immediately
// followed by agents(1)) can still collide and exhaust every retry. This wraps each call in its
// own outer retry loop with a fixed pause, independent of whatever the transport-level retry
// does — this script is one-off and idempotent, so trading time for certainty is free.
async function withRateLimitRetry<T>(fn: () => Promise<T>, label: string, isArc: boolean): Promise<T> {
  const attempts = isArc ? 10 : 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === attempts) throw err;
      console.log(`[backfill-agents] ${label} failed (attempt ${attempt}/${attempts}), retrying in 2s: ${err instanceof Error ? err.message : err}`);
      await sleep(2_000);
    }
  }
  throw new Error("unreachable");
}

async function backfillChain(config: EvmChainIndexerConfig): Promise<void> {
  // Arc Testnet's public RPC caps at 1 request/second — this script runs once, off the request
  // path, so pacing sequential reads a beat apart to reliably clear that window costs nothing.
  const isArc = config.chain === "arc";
  const publicClient = createPublicClient({
    transport: isArc ? http(config.rpcUrl, { retryCount: 5, retryDelay: 1_000 }) : http(config.rpcUrl),
  });

  const totalAgents = await withRateLimitRetry(
    () => publicClient.readContract({ address: config.coreAddress, abi: clawdHQCoreAbi, functionName: "totalAgents" }) as Promise<bigint>,
    `${config.chain}:totalAgents`,
    isArc,
  );

  console.log(`[backfill-agents:${config.chain}] totalAgents=${totalAgents}`);

  for (let id = 1n; id <= totalAgents; id++) {
    if (isArc) await sleep(1_200);
    await withRateLimitRetry(() => syncAgent(publicClient, config, id), `${config.chain}:agent(${id})`, isArc);
    console.log(`[backfill-agents:${config.chain}] synced agent ${id}/${totalAgents}`);
  }
}

async function main(): Promise<void> {
  const configs = loadAllEvmChainConfigs();
  for (const config of configs) {
    await backfillChain(config);
  }
  console.log("[backfill-agents] done");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfill-agents] failed:", err);
    process.exit(1);
  });
