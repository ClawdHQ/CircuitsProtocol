import { randomUUID } from "node:crypto";
import { formatUnits } from "viem";
import { SpendAction, Prisma, type Chain } from "@clawdhq/custody-db";
import { pullPayment } from "./facilitatorPullPayment.js";
import { getAgentWalletAddress } from "./agentWalletCustody.js";
import { executeAgentSpend } from "./agentSpendPolicy.js";
import { fetchGuarded } from "./guardedFetch.js";
import { parseX402Body, encodePaymentHeader, type PaymentRequirements } from "./x402Wire.js";
import { isEvmPrismaChain, type EvmPrismaChain } from "./evmChainConfig.js";

const CALL_TIMEOUT_MS = 20_000;

export interface ResolveKnowledgeContributionResult {
  contentUrl: string | null;
  contentBody: string | null;
}

function pickRequirement(accepts: PaymentRequirements[], role: "owner" | "protocol"): PaymentRequirements {
  const match = accepts.find((r) => r.resource.endsWith(`:${role}`));
  if (!match) throw new Error(`Knowledge resolve endpoint's 402 challenge is missing its "${role}" payment requirement.`);
  return match;
}

/** Pays one leg (owner's 50% share, or the protocol's 50% fee) via a real facilitator pull and
 * encodes the X-PAYMENT proof header for it — see pullPayment's own doc comment for why this
 * needs only the payer's address, not their private key (the facilitator wallet signs, through an
 * already-granted allowance). */
async function payRequirement(chain: EvmPrismaChain, payerAddress: string, requirement: PaymentRequirements): Promise<{ header: string; txHashOrRef: string }> {
  const idempotencyKey = randomUUID();
  const amountUsdc = formatUnits(BigInt(requirement.maxAmountRequired), 6);
  const { txHashOrRef } = await pullPayment(chain, payerAddress, requirement.payTo, amountUsdc, idempotencyKey);
  const header = encodePaymentHeader(requirement, { chain, payer: payerAddress, recipient: requirement.payTo, amount: requirement.maxAmountRequired, idempotencyKey, txHashOrRef });
  return { header, txHashOrRef };
}

/** Pays for and fetches one KnowledgeContribution's real content — the runtime-side counterpart
 * to knowledgeX402.ts's server-side challenge/verify, mirroring a2aClient.ts's callAgentViaA2a
 * 402-then-retry dance but for two simultaneous payment legs (owner's 50% share, protocol's 50%
 * fee) instead of one. No intermediate treasury wallet: pullPayment's recipient is just an
 * address, so both legs land at their final destination directly — see KnowledgeUsage's own
 * schema doc comment (custody-db). Gated by executeAgentSpend under SpendAction.USE_KNOWLEDGE, the
 * same budget-cap/audit-log pipeline every other autonomous spend in this codebase goes through.
 *
 * The two legs are paid in parallel; if one succeeds and the other fails, executeAgentSpend still
 * records the whole attempt as FAILED (so it doesn't silently look like a normal successful use)
 * but the succeeded leg's funds have already moved — the same bounded, accepted residual risk
 * pullPayment's own per-payer daily cap exists to limit, not eliminate. */
export async function resolveKnowledgeContribution(chain: Chain, consumerAgentChainId: string, contributionId: string): Promise<ResolveKnowledgeContributionResult> {
  if (!isEvmPrismaChain(chain)) throw new Error(`resolveKnowledgeContribution isn't wired up for ${chain} yet — EVM only for now.`);
  const evmChain: EvmPrismaChain = chain;

  const baseUrl = process.env.HOSTED_RUNTIME_APP_BASE_URL;
  if (!baseUrl) throw new Error("HOSTED_RUNTIME_APP_BASE_URL isn't configured — required to reach the knowledge resolve endpoint.");
  // `chain` is required on the URL, not inferred server-side: the payment challenge (USDC/
  // facilitator addresses) is chain-specific, and this is the payer's own chain — the one its
  // AgentWallet and pullPayment allowance actually live on. If the contribution's owner is itself
  // an AGENT profile (only reachable on the one chain its own AgentWallet lives on), the resolve
  // route rejects a mismatched chain with a clear error rather than guessing which one to use.
  const resolveUrl = `${baseUrl.replace(/\/$/, "")}/api/knowledge/contributions/${contributionId}/resolve?chain=${evmChain}`;

  const payerAddress = await getAgentWalletAddress(evmChain, consumerAgentChainId);
  if (!payerAddress) throw new Error("No AgentWallet has been provisioned for this agent yet.");

  const first = await fetchGuarded(resolveUrl, { method: "GET", timeoutMs: CALL_TIMEOUT_MS, throwOnError: false });
  if (first.status !== 402) throw new Error(`Expected a 402 payment challenge from the knowledge resolve endpoint, got HTTP ${first.status}.`);

  const accepts = parseX402Body(first.data);
  if (!accepts) throw new Error("Knowledge resolve endpoint returned a 402 with no recognizable payment requirements.");

  const ownerRequirement = pickRequirement(accepts, "owner");
  const protocolRequirement = pickRequirement(accepts, "protocol");
  const totalUsdc = new Prisma.Decimal(formatUnits(BigInt(ownerRequirement.maxAmountRequired), 6)).plus(formatUnits(BigInt(protocolRequirement.maxAmountRequired), 6)).toString();

  let capturedContent: ResolveKnowledgeContributionResult | undefined;

  const spend = await executeAgentSpend(chain, consumerAgentChainId, SpendAction.USE_KNOWLEDGE, totalUsdc, async () => {
    const [ownerPaid, protocolPaid] = await Promise.all([
      payRequirement(evmChain, payerAddress, ownerRequirement),
      payRequirement(evmChain, payerAddress, protocolRequirement),
    ]);

    const retry = await fetchGuarded(resolveUrl, {
      method: "GET",
      timeoutMs: CALL_TIMEOUT_MS,
      throwOnError: false,
      headers: { "X-PAYMENT-OWNER": ownerPaid.header, "X-PAYMENT-PROTOCOL": protocolPaid.header },
    });
    if (retry.status !== 200) throw new Error(`Payment succeeded, but the knowledge resolve endpoint returned HTTP ${retry.status} on retry.`);

    capturedContent = retry.data as ResolveKnowledgeContributionResult;
    return { txHashOrRef: ownerPaid.txHashOrRef, targetRef: contributionId };
  });

  void spend;
  if (!capturedContent) throw new Error("Knowledge resolve endpoint returned no readable content after payment.");
  return capturedContent;
}
