import "../src/loadEnv.js";
import { createPublicClient, http } from "viem";
import { prisma as marketplacePrisma } from "@clawdhq/marketplace-db";
import { httpWithRateLimitRetry } from "@clawdhq/sdk";
import { loadAllEvmChainConfigs, type EvmChainIndexerConfig } from "../src/config.js";
import { provisionAgentWalletOnChain } from "../src/listeners/evm.js";

// One-off backfill for agent-wallet provisioning, same shape and reasoning as
// backfill-agents.ts: provisionAgentWalletOnChain only ever runs reactively, off a *live*
// AgentRegistered event seen by processBatch's block-range polling — an agent registered before
// the indexer's cursor first caught up (or during any gap in its uptime) never gets a wallet,
// silently and permanently, since the indexer never looks backward. Confirmed this had never
// run at all on this deployment: zero RegistrarWallet rows and zero AgentWallet rows existed for
// any chain before this script's first run. provisionAgentWalletOnChain itself is idempotent
// (checks the on-chain registry first, no-ops if already set), so this is safe to re-run —
// httpWithRateLimitRetry (see wagmi.ts's doc comment) is what actually makes Arc's reads and
// writes reliable here, not manual pacing/outer-retry, which proved unnecessary once the
// transport itself correctly retries Arc's -32011 rate-limit error.
async function backfillChain(config: EvmChainIndexerConfig): Promise<void> {
  const publicClient = createPublicClient({
    transport: config.chain === "arc" ? httpWithRateLimitRetry(config.rpcUrl) : http(config.rpcUrl),
  });

  const agents = await marketplacePrisma.agent.findMany({
    where: { chain: config.prismaChain },
    select: { agentChainId: true },
  });
  console.log(`[backfill-agent-wallets:${config.chain}] ${agents.length} agent(s) to check`);

  for (const { agentChainId } of agents) {
    await provisionAgentWalletOnChain(publicClient, config, BigInt(agentChainId));
    console.log(`[backfill-agent-wallets:${config.chain}] checked/provisioned agent ${agentChainId}`);
  }
}

async function main(): Promise<void> {
  const configs = loadAllEvmChainConfigs();
  for (const config of configs) {
    await backfillChain(config);
  }
  console.log("[backfill-agent-wallets] done");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfill-agent-wallets] failed:", err);
    process.exit(1);
  });
