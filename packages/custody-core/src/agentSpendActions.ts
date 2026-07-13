import { createHash } from "node:crypto";
import { parseUnits, isAddress } from "viem";
import { SpendAction, type Chain } from "@clawdhq/custody-db";
import { getDecryptedAgentWallet } from "./agentWalletCustody.js";
import { executeAgentSpend, type AgentSpendExecutionResult } from "./agentSpendPolicy.js";
import { isEvmPrismaChain, viemChainFor, rpcUrlFor, usdcAddressFor, type EvmPrismaChain } from "./evmChainConfig.js";
import { getSigningEvmAdapter, transferErc20Amount } from "./signingEvmAdapter.js";
import { swapUsdcForWeth } from "./uniswapSwap.js";

/** Same digest convention as subscriptionRunJob.ts's sha256Hex — reimplemented here (not
 * imported) since that one isn't exported from this package's public surface. */
function sha256Hex(input: string): `0x${string}` {
  return `0x${createHash("sha256").update(input, "utf8").digest("hex")}`;
}

/** POST_JOB spend action: posts a job on ClawdHQCore, funded and signed by the agent's own
 * platform-custodied AgentWallet rather than a Subscription's wallet — the on-chain call is
 * otherwise identical to subscriptionRunJob.ts's EVM branch (same guessed-`totalJobs + 1` id
 * tradeoff documented there). EVM-only for now, matching Subscriptions' own current scope.
 * Goes through executeAgentSpend, so it's gated by the agent's AgentSpendPolicy and logged to
 * AgentSpendLog like every other autonomous spend — callers (a manual owner-triggered route now,
 * Phase 5's tick loop later) never call postJob directly. */
export async function postJobFromAgentWallet(
  chain: Chain,
  agentChainId: string,
  hiredAgentId: string,
  taskDescription: string,
  budgetUsdc: string,
  deadlineDays: number,
): Promise<AgentSpendExecutionResult> {
  if (!isEvmPrismaChain(chain)) throw new Error(`postJobFromAgentWallet isn't wired up for ${chain} yet — EVM only for now.`);
  const evmChain: EvmPrismaChain = chain;

  return executeAgentSpend(chain, agentChainId, SpendAction.POST_JOB, budgetUsdc, async () => {
    const wallet = await getDecryptedAgentWallet(evmChain, agentChainId);
    if (!wallet) throw new Error("No AgentWallet has been provisioned for this agent yet.");

    const adapter = getSigningEvmAdapter(evmChain, wallet.privateKey);
    const statsBefore = await adapter.getProtocolStats();
    const jobChainId = (statsBefore.totalJobs + 1n).toString();

    const taskHash = sha256Hex(taskDescription);
    const deadlineSeconds = BigInt(Math.floor(Date.now() / 1000) + deadlineDays * 86400);
    const budget = parseUnits(budgetUsdc, 6);

    const txHashOrRef = await adapter.postJob({
      employerAgentId: BigInt(agentChainId),
      hiredAgentId: BigInt(hiredAgentId),
      taskHash,
      budget,
      deadline: deadlineSeconds,
    });

    return { txHashOrRef, targetRef: jobChainId };
  });
}

/** X402_PAYMENT spend action: a direct USDC transfer from the agent's own AgentWallet to
 * `recipient`, funded and signed the same way postJobFromAgentWallet is. Scoped deliberately
 * narrower than the full x402 protocol: it doesn't negotiate a 402 response or verify a payment
 * requirement against a resource server first — the LLM-decided `recipient`/`amountUsdc` are
 * trusted only to the extent AgentSpendPolicy already bounds them (allowlisted action, capped
 * daily total), same trust model as postJobFromAgentWallet trusting an LLM-decided
 * hiredAgentId/budget. Extending this to a real negotiate-then-pay flow (fetch the resource,
 * read its 402 payment requirements, pay exactly what it asks) is a reasonable follow-up but a
 * materially bigger scope than "move funds through the already-gated spend path." EVM-only,
 * matching every other spend action in this codebase's current scope. */
export async function payFromAgentWallet(chain: Chain, agentChainId: string, recipient: string, amountUsdc: string, reason: string): Promise<AgentSpendExecutionResult> {
  if (!isEvmPrismaChain(chain)) throw new Error(`payFromAgentWallet isn't wired up for ${chain} yet — EVM only for now.`);
  const evmChain: EvmPrismaChain = chain;
  if (!isAddress(recipient)) throw new Error(`"${recipient}" isn't a valid ${chain} address.`);

  return executeAgentSpend(chain, agentChainId, SpendAction.X402_PAYMENT, amountUsdc, async () => {
    const wallet = await getDecryptedAgentWallet(evmChain, agentChainId);
    if (!wallet) throw new Error("No AgentWallet has been provisioned for this agent yet.");

    const amount = parseUnits(amountUsdc, 6);
    const result = await transferErc20Amount(wallet.privateKey, viemChainFor(evmChain), rpcUrlFor(evmChain), usdcAddressFor(evmChain), recipient as `0x${string}`, amount);

    return { txHashOrRef: result.txHashOrRef, targetRef: `${recipient} (${reason || "no reason given"})` };
  });
}

/** SWAP spend action: swaps the agent's own AgentWallet USDC for WETH via a real Uniswap V3
 * pool (uniswapSwap.ts) — the one spend action that actually moves value through a signed,
 * broadcast transaction built from a live third-party quote, rather than a flat platform fee.
 * That's exactly why it needed its own hardcoded action instead of becoming a "skill":
 * SkillInvocation (the http/mcp/clawdhq-agent kinds CALL_SKILL resolves) has no code path to an
 * AgentWallet's private key at all, by design — a skill's `priceUsdc` is a metering cost, never
 * the real value of whatever the call represents. Here, `amountUsdc` (the swap's own input
 * amount) IS what gets checked against the agent's dailyCapUsdc, so the cap means what it says
 * for this action, unlike a hypothetical "just wire a DEX as a skill" shortcut would have.
 * EVM-only, and further scoped to Base Sepolia / Ethereum Sepolia specifically — see
 * uniswapSwap.ts's top comment for why only those two. */
export async function swapAgentWalletUsdcForWeth(chain: Chain, agentChainId: string, amountUsdc: string): Promise<AgentSpendExecutionResult> {
  if (!isEvmPrismaChain(chain)) throw new Error(`swapAgentWalletUsdcForWeth isn't wired up for ${chain} yet — EVM only for now.`);
  const evmChain: EvmPrismaChain = chain;

  return executeAgentSpend(chain, agentChainId, SpendAction.SWAP, amountUsdc, async () => {
    const wallet = await getDecryptedAgentWallet(evmChain, agentChainId);
    if (!wallet) throw new Error("No AgentWallet has been provisioned for this agent yet.");

    const amountIn = parseUnits(amountUsdc, 6);
    const result = await swapUsdcForWeth(evmChain, wallet.privateKey, amountIn);

    return { txHashOrRef: result.txHashOrRef, targetRef: `${result.amountInUsdc} USDC -> ${result.amountOutWeth} WETH` };
  });
}
