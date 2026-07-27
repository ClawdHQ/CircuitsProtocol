import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { viemChainFor, type EvmPrismaChain } from "@clawdhq/custody-core";
import { prisma, CrossChainRelayStatus } from "@clawdhq/marketplace-db";
import { CIRCLE_IRIS_API_URL, RELAYER_PRIVATE_KEY, RELAYER_POLL_INTERVAL_MS, type EvmChainIndexerConfig } from "../config.js";

/// Relays ClawdHQCrossChainIdentity's `registerLink` messages the rest of the way: Circle's CCTP
/// requires someone to fetch an attestation from Iris and submit it on the destination chain —
/// nothing does that automatically. listeners/evm.ts inserts a PENDING CrossChainRelay row the
/// moment it sees a `LinkRegistered` event (see recordPendingRelay below); runCrossChainIdentityRelayer
/// then polls Iris for each pending row until its attestation(s) are ready and submits
/// MessageTransmitterV2.receiveMessage on every destination chain Iris says the transaction
/// targeted. This is the one piece of the cross-chain-identity subsystem this codebase has never
/// done anything like before (see ClawdHQCrossChainIdentity.sol's own doc comment) — correctness
/// beyond "the code runs" depends on a live testnet smoke test, not just this file compiling.

const MESSAGE_TRANSMITTER_ABI = parseAbi(["function receiveMessage(bytes message, bytes attestation) external returns (bool)"]);

/// Gives up (marks FAILED) after this many non-benign failures for the same transaction, so a
/// genuinely broken case (e.g. a misconfigured peer, a chain with no gas funds) doesn't retry
/// forever — surfaced via `lastError` for manual investigation rather than silently stuck.
const MAX_ATTEMPTS = 20;

interface IrisDecodedMessage {
  sourceDomain: string;
  destinationDomain: string;
}

interface IrisMessageEntry {
  message: `0x${string}`;
  attestation: string;
  status: "complete" | "pending_confirmations";
  decodedMessage: IrisDecodedMessage;
}

interface IrisMessagesResponse {
  messages: IrisMessageEntry[];
}

/// Same "deliberately duplicated enum, kept in sync by hand" tradeoff already made throughout
/// this codebase's *-db packages — see listeners/evm.ts's toCustodyChain for the sibling
/// (marketplace-db -> custody-core) cast this mirrors.
function toCustodyChain(chain: EvmChainIndexerConfig["prismaChain"]): EvmPrismaChain {
  return chain as unknown as EvmPrismaChain;
}

async function fetchIrisMessages(sourceDomain: number, txHash: string): Promise<IrisMessagesResponse | undefined> {
  const url = `${CIRCLE_IRIS_API_URL}/v2/messages/${sourceDomain}?transactionHash=${txHash}`;
  const response = await fetch(url);
  if (response.status === 404) return undefined; // Iris hasn't indexed this transaction yet — normal, retry next cycle
  if (!response.ok) throw new Error(`Iris API ${response.status}: ${await response.text()}`);
  return (await response.json()) as IrisMessagesResponse;
}

/// Records a pending relay the moment the indexer sees a `LinkRegistered` event — called from
/// listeners/evm.ts's processBatch, once per (chain, txHash), regardless of how many peer chains
/// that transaction's `registerLink` call actually messaged (Iris's response for one
/// transaction hash already returns every message it produced in a single call — see
/// processPendingRelays below, which is why this only tracks at transaction granularity).
/// Idempotent: upserting an already-recorded (chain, txHash) is a harmless no-op, safe for a
/// reprocessed batch after a restart.
export async function recordPendingRelay(sourceChain: EvmChainIndexerConfig["prismaChain"], sourceTxHash: string): Promise<void> {
  await prisma.crossChainRelay.upsert({
    where: { sourceChain_sourceTxHash: { sourceChain, sourceTxHash } },
    create: { sourceChain, sourceTxHash },
    update: {},
  });
}

/// Submits one message+attestation pair to its destination chain's MessageTransmitterV2.
/// Returns true if delivered — including "was already delivered by an earlier, partially
/// successful attempt at this same transaction's other message(s)": CCTP's own on-chain nonce
/// tracking is what actually guarantees a message can never be processed twice (that guarantee
/// does not depend on anything in this file); a repeat `receiveMessage` call for an
/// already-processed message simply reverts on-chain. The string match below is a best-effort
/// optimization so a harmless repeat-revert doesn't burn a retry/log noise on the *common* case
/// — if the exact revert wording differs from what's matched here, the only consequence is this
/// row's `status` eventually reads FAILED after {MAX_ATTEMPTS} even though delivery genuinely
/// succeeded (cosmetic bookkeeping only, not a fund-safety or correctness issue; verifiable
/// directly against the destination chain or Iris during the manual testnet smoke test this
/// subsystem still needs — see ClawdHQCrossChainIdentity.sol's doc comment).
async function submitReceiveMessage(
  destinationConfig: EvmChainIndexerConfig,
  account: PrivateKeyAccount,
  message: `0x${string}`,
  attestation: `0x${string}`
): Promise<boolean> {
  const transmitterAddress = destinationConfig.cctpMessageTransmitterAddress;
  if (!transmitterAddress) return false;

  const viemChain = viemChainFor(toCustodyChain(destinationConfig.prismaChain));
  const publicClient = createPublicClient({ chain: viemChain, transport: http(destinationConfig.rpcUrl) });
  const walletClient = createWalletClient({ account, chain: viemChain, transport: http(destinationConfig.rpcUrl) });

  try {
    const hash = await walletClient.writeContract({
      address: transmitterAddress,
      abi: MESSAGE_TRANSMITTER_ABI,
      functionName: "receiveMessage",
      args: [message, attestation as `0x${string}`],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    return true;
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    if (/nonce already used|already processed|used nonce|already.{0,20}(processed|used|relayed|received)|duplicate|replay/i.test(messageText)) {
      return true; // benign — delivered by an earlier attempt at another message in the same transaction
    }
    console.error(`[relayer:crossChainIdentity] receiveMessage failed on chain ${destinationConfig.chain}:`, messageText);
    return false;
  }
}

/// One pass over every PENDING relay: asks Iris whether each source transaction's attestation(s)
/// are ready, and if so submits `receiveMessage` on each message's destination chain. A relay
/// only moves to COMPLETE once every message Iris returns for that transaction has been
/// relayed; otherwise it's left PENDING for the next cycle (or FAILED past {MAX_ATTEMPTS}).
export async function processPendingRelays(configs: EvmChainIndexerConfig[]): Promise<void> {
  if (!CIRCLE_IRIS_API_URL || !RELAYER_PRIVATE_KEY) return;

  const configByDomain = new Map(configs.filter((c): c is EvmChainIndexerConfig & { cctpDomain: number } => c.cctpDomain !== undefined).map((c) => [c.cctpDomain, c]));
  const configByChain = new Map(configs.map((c) => [c.prismaChain, c]));
  const account = privateKeyToAccount(RELAYER_PRIVATE_KEY);

  const pending = await prisma.crossChainRelay.findMany({ where: { status: CrossChainRelayStatus.PENDING } });

  for (const relay of pending) {
    const sourceConfig = configByChain.get(relay.sourceChain);
    if (sourceConfig?.cctpDomain === undefined) continue; // this chain's CCTP config was removed/never set

    try {
      const response = await fetchIrisMessages(sourceConfig.cctpDomain, relay.sourceTxHash);
      if (!response || response.messages.length === 0) continue; // not indexed by Iris yet
      if (response.messages.some((m) => m.status !== "complete")) continue; // still waiting on at least one attestation

      let allDelivered = true;
      for (const entry of response.messages) {
        const destinationConfig = configByDomain.get(Number(entry.decodedMessage.destinationDomain));
        if (!destinationConfig) {
          console.error(
            `[relayer:crossChainIdentity] no configured chain for destination domain ${entry.decodedMessage.destinationDomain} (source tx ${relay.sourceTxHash})`
          );
          allDelivered = false;
          continue;
        }
        const delivered = await submitReceiveMessage(destinationConfig, account, entry.message, entry.attestation as `0x${string}`);
        if (!delivered) allDelivered = false;
      }

      const nextAttempts = relay.attempts + 1;
      await prisma.crossChainRelay.update({
        where: { id: relay.id },
        data: allDelivered
          ? { status: CrossChainRelayStatus.COMPLETE }
          : { attempts: nextAttempts, status: nextAttempts >= MAX_ATTEMPTS ? CrossChainRelayStatus.FAILED : CrossChainRelayStatus.PENDING },
      });
      if (allDelivered) {
        console.log(`[relayer:crossChainIdentity] relayed ${response.messages.length} message(s) for ${relay.sourceChain} tx ${relay.sourceTxHash}`);
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      console.error(`[relayer:crossChainIdentity] error processing ${relay.sourceChain} tx ${relay.sourceTxHash}:`, messageText);
      const nextAttempts = relay.attempts + 1;
      await prisma.crossChainRelay.update({
        where: { id: relay.id },
        data: { attempts: nextAttempts, lastError: messageText, status: nextAttempts >= MAX_ATTEMPTS ? CrossChainRelayStatus.FAILED : CrossChainRelayStatus.PENDING },
      });
    }
  }
}

/// Runs forever, calling processPendingRelays on an interval. Returns (rather than looping)
/// without doing anything if the relayer isn't configured — matches main.ts's "skip whatever
/// isn't configured" convention for Solana/Sui.
export async function runCrossChainIdentityRelayer(configs: EvmChainIndexerConfig[]): Promise<void> {
  if (!CIRCLE_IRIS_API_URL || !RELAYER_PRIVATE_KEY) {
    console.log("[relayer:crossChainIdentity] RELAYER_PRIVATE_KEY or CIRCLE_IRIS_API_URL not set — relayer disabled.");
    return;
  }

  console.log("[relayer:crossChainIdentity] starting");
  for (;;) {
    await processPendingRelays(configs);
    await new Promise((resolve) => setTimeout(resolve, RELAYER_POLL_INTERVAL_MS));
  }
}
