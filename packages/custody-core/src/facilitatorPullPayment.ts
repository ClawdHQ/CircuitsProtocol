import { createWalletClient, createPublicClient, http, parseAbi, parseUnits, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { prisma, PaymentPullStatus, Prisma } from "@clawdhq/custody-db";
import { getDecryptedFacilitatorWallet } from "./facilitatorCustody.js";
import { viemChainFor, rpcUrlFor, type EvmPrismaChain } from "./evmChainConfig.js";

const FACILITATOR_ABI = parseAbi(["function pullPayment(address payer, address recipient, uint256 amount, bytes32 idempotencyKey) external"]);

function facilitatorContractAddressFor(chain: EvmPrismaChain): `0x${string}` {
  const value = process.env[`NEXT_PUBLIC_${chain}_FACILITATOR_ADDRESS`];
  if (!value) throw new Error(`NEXT_PUBLIC_${chain}_FACILITATOR_ADDRESS is not set — see .env.example`);
  return value as `0x${string}`;
}

/** Thrown by pullPayment for every rejection reason (kill switch, velocity cap, no wallet
 * provisioned, on-chain failure) — callers should treat this as "payment did not go through,"
 * with `.message` safe to surface to whoever's waiting on the call. */
export class PaymentRejection extends Error {}

// Velocity cap: bounds how much a single payer can be pulled from through this facilitator in a
// rolling 24h window, mirroring degen/riskEngine.ts's daily-loss-then-kill-switch shape. A
// compromised facilitator key (or a bug upstream of this function) can still authorize pulls up
// to whatever allowance a payer happens to have outstanding — this bounds how much of that
// exposure can be realized in a single day, it doesn't eliminate it (only real per-call
// signatures, which MockUSDC can't support, would).
const PER_PAYER_DAILY_CAP_USDC = new Prisma.Decimal(50);

async function todaysPulledAmount(payerAddress: string): Promise<Prisma.Decimal> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const pulls = await prisma.paymentPull.findMany({
    where: { payerAddress, status: PaymentPullStatus.SUCCEEDED, createdAt: { gte: startOfDay } },
    select: { amountUsdc: true },
  });
  return pulls.reduce((sum, p) => sum.plus(p.amountUsdc), new Prisma.Decimal(0));
}

export interface PullPaymentResult {
  txHashOrRef: string;
}

/** Pulls `amountUsdc` from `payerAddress` to `recipientAddress` via X402Facilitator.pullPayment,
 * provided `payerAddress` has already granted that contract a sufficient ERC20 allowance.
 * Idempotent on `idempotencyKey`: a repeated call with the same key returns the original
 * recorded result (or re-throws the original failure) rather than attempting a second pull —
 * mirrored on-chain too (the contract's own idempotency-key check is the actual double-pull
 * guard; this is the audit ledger and the faster short-circuit). */
export async function pullPayment(
  chain: EvmPrismaChain,
  payerAddress: string,
  recipientAddress: string,
  amountUsdc: string,
  idempotencyKey: string,
): Promise<PullPaymentResult> {
  const existing = await prisma.paymentPull.findUnique({ where: { idempotencyKey } });
  if (existing) {
    if (existing.status === PaymentPullStatus.SUCCEEDED) return { txHashOrRef: existing.txHashOrRef ?? "" };
    throw new PaymentRejection(existing.error ?? "This payment was already attempted and failed.");
  }

  const wallet = await getDecryptedFacilitatorWallet(chain);
  if (!wallet) throw new PaymentRejection("No facilitator wallet has been provisioned for this chain yet.");
  if (wallet.status !== "ACTIVE") throw new PaymentRejection("The x402 facilitator is currently paused.");

  const amount = new Prisma.Decimal(amountUsdc);
  const pulledToday = await todaysPulledAmount(payerAddress);
  if (pulledToday.plus(amount).gt(PER_PAYER_DAILY_CAP_USDC)) {
    throw new PaymentRejection(`This would exceed the per-payer daily cap (${PER_PAYER_DAILY_CAP_USDC.toString()} USDC) through this facilitator.`);
  }

  const account = privateKeyToAccount(wallet.privateKey as `0x${string}`);
  const viemChain = viemChainFor(chain);
  const transport = http(rpcUrlFor(chain));
  const walletClient = createWalletClient({ account, chain: viemChain, transport });
  const publicClient = createPublicClient({ chain: viemChain, transport });

  // The contract's idempotencyKey is bytes32; callers pass an arbitrary string (e.g. a UUID) —
  // hashing it is just a fixed-width encoding here, not a content-integrity check the way a
  // task/deliverable hash is elsewhere in this codebase.
  const idempotencyKeyBytes32 = keccak256(toBytes(idempotencyKey));
  const amountRaw = parseUnits(amountUsdc, 6);

  try {
    const txHash = await walletClient.writeContract({
      address: facilitatorContractAddressFor(chain),
      abi: FACILITATOR_ABI,
      functionName: "pullPayment",
      args: [payerAddress as `0x${string}`, recipientAddress as `0x${string}`, amountRaw, idempotencyKeyBytes32],
      account,
      chain: viemChain,
    });
    // Unlike the subscription pipeline's fire-and-forget postJob, a payment needs to be known
    // *confirmed* successful before the caller retries the paid HTTP call with proof of it —
    // there's no multi-step state machine here to fall back on if it silently reverted.
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") throw new Error("pullPayment transaction reverted");

    await prisma.paymentPull.create({
      data: { chain, payerAddress, recipientAddress, amountUsdc: amount, idempotencyKey, status: PaymentPullStatus.SUCCEEDED, txHashOrRef: txHash },
    });
    return { txHashOrRef: txHash };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.paymentPull
      .create({ data: { chain, payerAddress, recipientAddress, amountUsdc: amount, idempotencyKey, status: PaymentPullStatus.FAILED, error: message } })
      .catch(() => {}); // best-effort ledger write — don't mask the real failure below if this also fails
    throw new PaymentRejection(message);
  }
}
