import { randomUUID } from "node:crypto";
import { Blockchain, type CircleDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

// Circle Agent Wallets (https://developers.circle.com/agent-stack/agent-wallets) — the product
// name for using Developer-Controlled Wallets (the same underlying API/SDK as wallets.ts's
// owner-facing wallets) for an autonomous agent instead of a human owner. Unlike wallets.ts,
// every function here operates on a wallet this app did *not* create — an owner's own
// pre-existing Circle wallet, brought in via the Register Agent wizard's onboarding step — so
// there's no createWallets call anywhere in this file, only lookup/execute/poll against a
// walletId the owner supplied. Deliberately has zero knowledge of this app's own chain-naming
// conventions (EvmPrismaChain etc. live in custody-core) — callers translate.
//
// Every method/input-shape name below was read directly from the installed SDK's own shipped
// .d.ts (developer-controlled-wallets.d.ts's *client* interface specifically — not the raw
// generated API classes under clients/developer-controlled-wallets.d.ts, whose method names and
// argument shapes are different and do NOT match what CircleDeveloperControlledWalletsClient
// actually exposes; confirmed the hard way, via a real tsc error, not assumed from either file
// in isolation).

/** Circle blockchain identifiers this app can plausibly onboard a wallet for — the intersection
 * of what ClawdHQ's own EVM deployments cover and what Circle's Developer-Controlled Wallets
 * product actually lists (confirmed against the installed SDK's own Blockchain const: no BNB
 * Chain/BSC value exists there at all, so BSC_TESTNET can never be a CIRCLE-custodied
 * AgentWallet regardless of this app's own chain support elsewhere). */
export const AGENT_WALLET_BLOCKCHAINS = {
  ARC_TESTNET: Blockchain.ArcTestnet,
  BASE_SEPOLIA: Blockchain.BaseSepolia,
  ETH_SEPOLIA: Blockchain.EthSepolia,
} as const;

export type AgentWalletBlockchainKey = keyof typeof AGENT_WALLET_BLOCKCHAINS;

export class CircleAgentWalletError extends Error {}

export interface DeveloperWallet {
  id: string;
  address: string;
  blockchain: string;
  walletSetId: string;
  state: string;
}

/** Looks up a wallet the owner claims is theirs and validates it's actually usable for
 * onboarding: must exist, must be DEVELOPER-custody (never a User-Controlled/PIN-gated wallet —
 * this app couldn't sign for one of those even if it wanted to), and must be on one of
 * AGENT_WALLET_BLOCKCHAINS. Throws CircleAgentWalletError with a message safe to show the owner
 * directly rather than a raw Circle SDK error — callers (the onboarding API route) don't need to
 * translate. */
export async function getVerifiedDeveloperWallet(client: CircleDeveloperControlledWalletsClient, walletId: string): Promise<DeveloperWallet> {
  let response;
  try {
    response = await client.getWallet({ id: walletId });
  } catch (err) {
    throw new CircleAgentWalletError(`Circle rejected that wallet id — double check it and your API key/entity secret. (${err instanceof Error ? err.message : String(err)})`);
  }
  const wallet = response.data?.wallet;
  if (!wallet) throw new CircleAgentWalletError("Circle returned no wallet for that id.");
  if (wallet.custodyType !== "DEVELOPER") {
    throw new CircleAgentWalletError("That wallet is a User-Controlled (PIN-gated) Circle wallet, not a Developer-Controlled one — ClawdHQ can only sign for Developer-Controlled wallets.");
  }
  const supported = (Object.values(AGENT_WALLET_BLOCKCHAINS) as string[]).includes(wallet.blockchain);
  if (!supported) {
    throw new CircleAgentWalletError(`That wallet is on ${wallet.blockchain}, which ClawdHQ doesn't support for agent wallets yet (${Object.keys(AGENT_WALLET_BLOCKCHAINS).join(", ")} only).`);
  }
  return { id: wallet.id, address: wallet.address, blockchain: wallet.blockchain, walletSetId: wallet.walletSetId, state: wallet.state };
}

export interface ContractExecutionParams {
  walletId: string;
  contractAddress: string;
  /** Raw ABI-encoded calldata — callers already have a viem-encoded hex string (see
   * circleAgentSignerProvider.ts), so there's no reason to also support the
   * abiFunctionSignature/abiParameters alternative this endpoint offers. */
  callData: `0x${string}`;
  /** Native-token amount to send alongside the call, decimal string (payable functions only). */
  amount?: string;
}

/** Submits a contract-execution intent to Circle and waits for it to actually broadcast (not
 * just accepted) — waitForTxHash guarantees a populated txHash in the response or a rejected
 * promise on a terminal failure state (CANCELLED/DENIED/FAILED/STUCK), Circle's SDK handles the
 * polling itself. Deliberately stops at "broadcast," not "confirmed" — the same point a local
 * viem WalletClient.writeContract call returns at, so callers keep using their existing
 * publicClient.waitForTransactionReceipt for confirmation, unchanged regardless of custody
 * type. */
export async function executeAgentContractCall(client: CircleDeveloperControlledWalletsClient, params: ContractExecutionParams): Promise<{ txHash: string }> {
  const created = await client.createContractExecutionTransaction({
    idempotencyKey: randomUUID(),
    walletId: params.walletId,
    contractAddress: params.contractAddress,
    callData: params.callData,
    amount: params.amount,
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  const transactionId = created.data?.id;
  if (!transactionId) throw new CircleAgentWalletError("Circle Wallets: contract execution returned no transaction id");

  try {
    const result = await client.getTransaction({ id: transactionId, waitForTxHash: true });
    return { txHash: result.data.transaction.txHash };
  } catch (err) {
    throw new CircleAgentWalletError(err instanceof Error ? err.message : `Circle transaction ${transactionId} did not reach a broadcastable state`);
  }
}
