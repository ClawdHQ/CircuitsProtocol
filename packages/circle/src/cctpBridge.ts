import { Connection } from "@solana/web3.js";
import { generatePrivateKey } from "viem/accounts";
import { BaseSepolia, EthereumSepolia, SolanaDevnet, ArcTestnet } from "@circle-fin/bridge-kit/chains";
import { CCTPV2BridgingProvider } from "@circle-fin/provider-cctp-v2";
import { createViemAdapterFromPrivateKey } from "@circle-fin/adapter-viem-v2";
import { createSolanaAdapterFromPrivateKey } from "@circle-fin/adapter-solana";

// Same Circle-official CCTP v2 SDK stack as apps/web/src/lib/server/degen/cctp.ts (native
// burn-and-mint, not a wrapped-asset bridge) — this module is Arc's counterpart: it moves USDC
// *into* Arc Testnet from wherever an agent/subscription/owner already holds it, rather than
// routing between Degen's trading venues. Kept as its own module (not folded into degen/cctp.ts)
// because the two have different chain sets and no caller needs both at once — see this
// package's own README-equivalent (package.json description) for why it lives in
// @clawdhq/circle rather than apps/web/src/lib/server.
//
// Arc is deliberately a *destination-only* chain here: @circle-fin/bridge-kit's own ArcTestnet
// chain definition declares `cctp.forwarderSupported: { source: false, destination: true }` —
// Circle's SDK does not support routing a forwarder-mediated burn *from* Arc today, only *to*
// it. That matches every real use case this app has (funding an Arc-side agent wallet or
// subscription from USDC earned/held elsewhere), so it's not a limitation in practice.
//
// BSC_TESTNET and SUI_TESTNET are excluded the same way degen/cctp.ts excludes them: BSC has no
// chain definition in the SDK at all (Circle does not issue CCTP-bridgeable USDC on BNB Chain),
// and Sui is CCTP V1-only while Arc is V2-only — Circle's V1 and V2 message formats aren't
// interoperable through this SDK, so a direct Sui-to-Arc route isn't offered here. Bridging Sui
// USDC into Arc today would require an extra hop through a V1/V2-compatible intermediate chain,
// which is out of scope for this module.
export type CctpSourceChain = "BASE_SEPOLIA" | "ETH_SEPOLIA" | "SOLANA_DEVNET";
export type CctpDestinationChain = CctpSourceChain | "ARC_TESTNET";

const SOURCE_CHAIN_DEFINITION = {
  BASE_SEPOLIA: BaseSepolia,
  ETH_SEPOLIA: EthereumSepolia,
  SOLANA_DEVNET: SolanaDevnet,
} as const satisfies Record<CctpSourceChain, unknown>;

const DESTINATION_CHAIN_DEFINITION = {
  ...SOURCE_CHAIN_DEFINITION,
  ARC_TESTNET: ArcTestnet,
} as const satisfies Record<CctpDestinationChain, unknown>;

export function isCctpSourceChain(chain: string): chain is CctpSourceChain {
  return chain in SOURCE_CHAIN_DEFINITION;
}

export function isCctpDestinationChain(chain: string): chain is CctpDestinationChain {
  return chain in DESTINATION_CHAIN_DEFINITION;
}

function solanaConnection(): Connection {
  return new Connection(process.env.CCTP_SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");
}

/** Mirrors degen/cctp.ts's buildWalletContext — branches directly on chain rather than through
 * a lookup, for the same reason documented there (TypeScript can't correlate a map-indexed
 * lookup's adapter type back to a still-general chain union across a function boundary). */
async function buildWalletContext(chain: CctpDestinationChain, privateKey: string) {
  if (chain === "SOLANA_DEVNET") {
    const adapter = createSolanaAdapterFromPrivateKey({
      privateKey,
      connection: solanaConnection(),
      capabilities: { addressContext: "developer-controlled" },
    });
    return { adapter, chain: SolanaDevnet, address: await adapter.getAddress(SolanaDevnet) };
  }
  const adapter = createViemAdapterFromPrivateKey({ privateKey, capabilities: { addressContext: "developer-controlled" } });
  const definition = DESTINATION_CHAIN_DEFINITION[chain];
  return { adapter, chain: definition, address: await adapter.getAddress(definition) };
}

export interface BridgeResult {
  state: "pending" | "success" | "error";
  sourceAddress: string;
  destinationAddress: string;
  amount: string;
}

async function runBridge(
  sourceChain: CctpSourceChain,
  sourcePrivateKey: string,
  destination: Awaited<ReturnType<typeof buildWalletContext>> & { recipientAddress?: string },
  amountUsdc: string,
): Promise<BridgeResult> {
  const provider = new CCTPV2BridgingProvider();
  const canForward = provider.supportsRoute(SOURCE_CHAIN_DEFINITION[sourceChain], ArcTestnet, "USDC", true);
  if (!canForward) {
    throw new Error(`CCTP forwarder route from ${sourceChain} to ARC_TESTNET is not supported`);
  }

  const source = await buildWalletContext(sourceChain, sourcePrivateKey);
  const result = await provider.bridge({
    source,
    destination: { ...destination, useForwarder: true },
    amount: amountUsdc,
    token: "USDC",
    config: { transferSpeed: "FAST" },
  });

  return {
    state: result.state,
    sourceAddress: source.address,
    destinationAddress: destination.recipientAddress ?? destination.address,
    amount: result.amount,
  };
}

export interface BridgeToArcInput {
  sourceChain: CctpSourceChain;
  /** Decrypted private key of the custodied wallet paying for the burn — transient, never
   * logged or persisted by this module. Caller owns decrypt/zeroize lifecycle (same contract
   * as degen/cctp.ts's routeUsdc). */
  sourcePrivateKey: string;
  /** Decrypted private key of the custodied Arc-side destination wallet (an agent wallet or
   * subscription wallet — see packages/custody-core). */
  destinationPrivateKey: string;
  /** Decimal string, e.g. "50.00" — matches the SDK's own amount type. */
  amountUsdc: string;
}

/** Bridges USDC from a custodied wallet on Base Sepolia, Ethereum Sepolia, or Solana Devnet into
 * a *custodied* wallet on Arc Testnet (one this app holds a private key for — an agent wallet or
 * subscription wallet, see packages/custody-core) via CCTP v2's burn-and-mint. Use this — not a
 * hand-rolled TokenMessenger call — for the same reason degen/cctp.ts does: Circle's SDK gets
 * the chain-specific derived-account/PDA construction right, hand-rolling it doesn't. */
export async function bridgeToArc(input: BridgeToArcInput): Promise<BridgeResult> {
  const destination = await buildWalletContext("ARC_TESTNET", input.destinationPrivateKey);
  return runBridge(input.sourceChain, input.sourcePrivateKey, destination, input.amountUsdc);
}

export interface BridgeToArcRecipientInput {
  sourceChain: CctpSourceChain;
  sourcePrivateKey: string;
  /** Any Arc Testnet address — does *not* need to be one this app holds a key for. Covers
   * bridging into a Circle Wallet (packages/circle/src/wallets.ts) or any externally-connected
   * address, where this app never has (and Circle never exposes) a private key at all. */
  recipientAddress: string;
  amountUsdc: string;
}

/** Same bridge as `bridgeToArc`, but for an arbitrary Arc recipient address this app has no
 * private key for. Works because `DestinationWalletContext.recipientAddress` (per the SDK's own
 * type doc) sends minted funds to that address while the wallet-context address is only used
 * "for transaction signing and authorization" — and under `useForwarder: true`, that signing
 * step is Circle's relayer's job, not this throwaway adapter's, confirmed by
 * `forwarderSupported.destination` requiring no gas/signature from the destination side. A
 * fresh, one-off, immediately-discarded key satisfies the SDK's type requirement for "some
 * adapter" without ever being funded, reused, or persisted. */
export async function bridgeToArcRecipient(input: BridgeToArcRecipientInput): Promise<BridgeResult> {
  const throwawayKey = generatePrivateKey();
  const destination = await buildWalletContext("ARC_TESTNET", throwawayKey);
  return runBridge(input.sourceChain, input.sourcePrivateKey, { ...destination, recipientAddress: input.recipientAddress }, input.amountUsdc);
}
