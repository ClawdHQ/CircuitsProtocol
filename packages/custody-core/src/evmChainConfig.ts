import { http, type Transport } from "viem";
import { bscTestnet, baseSepolia, sepolia, arcTestnet, type Chain as ViemChain } from "viem/chains";
import { httpWithRateLimitRetry } from "@clawdhq/sdk";

// Portable subset of apps/web/src/lib/chains.ts's EVM chain metadata — reads process.env
// directly (like apps/indexer/src/config.ts already does) instead of going through apps/web's
// Next.js-specific zod-validated `env.ts`, so this package has no dependency on that app at all.
// Keep the env var *names* in sync with apps/web/src/lib/chains.ts by hand; this is the same
// "duplicated on purpose, different consumer" tradeoff already made for the Chain enum in
// every *-db package.

export type EvmPrismaChain = "BSC_TESTNET" | "BASE_SEPOLIA" | "ETH_SEPOLIA" | "ARC_TESTNET";

export const EVM_PRISMA_CHAINS: readonly EvmPrismaChain[] = ["BSC_TESTNET", "BASE_SEPOLIA", "ETH_SEPOLIA", "ARC_TESTNET"];

export function isEvmPrismaChain(value: string): value is EvmPrismaChain {
  return (EVM_PRISMA_CHAINS as readonly string[]).includes(value);
}

const VIEM_CHAIN: Record<EvmPrismaChain, ViemChain> = {
  BSC_TESTNET: bscTestnet,
  BASE_SEPOLIA: baseSepolia,
  ETH_SEPOLIA: sepolia,
  ARC_TESTNET: arcTestnet,
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — see .env.example`);
  return value;
}

/** `NEXT_PUBLIC_${chain}_RPC_URL` is meant to be freely repointable — apps/web/.env.local
 * overrides it at a local Hardhat node for local dev (see loadEnv.ts). But every server-side
 * custodied signer (Degen, Subscriptions, the x402 facilitator) builds its viem WalletClient
 * straight from a private key with no external wallet involved, and viem bakes `chain.id` into
 * the raw transaction it signs — so once the RPC URL points somewhere whose real chain id
 * differs from the canonical testnet's (e.g. Hardhat's 31337 vs BSC Testnet's 97), broadcasting
 * fails with "invalid chainId" even though the RPC call itself succeeded. A plain read (viem's
 * `readContract`/`eth_call`) never hits this — the chain id isn't part of the call — which is
 * why this only ever surfaces on a real signed broadcast. `NEXT_PUBLIC_${chain}_CHAIN_ID` is an
 * optional override, same convention as the RPC_URL/CONTRACT_ADDRESS/USDC_ADDRESS vars, so local
 * dev can declare the RPC override's real chain id without touching real-deployment behavior
 * (where the var is simply absent and the canonical id is used as before).
 */
export function viemChainFor(chain: EvmPrismaChain): ViemChain {
  const canonical = VIEM_CHAIN[chain];
  const override = process.env[`NEXT_PUBLIC_${chain}_CHAIN_ID`];
  if (!override) return canonical;
  const id = Number(override);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`NEXT_PUBLIC_${chain}_CHAIN_ID="${override}" is not a valid chain id`);
  return id === canonical.id ? canonical : { ...canonical, id };
}

export function rpcUrlFor(chain: EvmPrismaChain): string {
  return requireEnv(`NEXT_PUBLIC_${chain}_RPC_URL`);
}

/** httpWithRateLimitRetry only for Arc (whose public RPC enforces a hard 1req/s limit signaled
 * via JSON-RPC code -32011 that viem's own built-in retry doesn't cover — see
 * rateLimitRetryTransport.ts), plain http() everywhere else — same conditional apps/web's
 * wagmi.ts and evmExchangeReaders.ts already apply, centralized here since every custody-core
 * signer/public-client construction needs the identical branch. */
export function rpcTransportFor(chain: EvmPrismaChain): Transport {
  const url = rpcUrlFor(chain);
  return chain === "ARC_TESTNET" ? httpWithRateLimitRetry(url) : http(url);
}

export function contractAddressFor(chain: EvmPrismaChain): `0x${string}` {
  return requireEnv(`NEXT_PUBLIC_${chain}_CONTRACT_ADDRESS`) as `0x${string}`;
}

/** ClawdHQLaunchpad's address — a separate contract from ClawdHQCore's `contractAddressFor`
 * (split out because Core has no bytecode headroom left for the bonding-curve launchpad). */
export function launchpadAddressFor(chain: EvmPrismaChain): `0x${string}` {
  return requireEnv(`NEXT_PUBLIC_${chain}_LAUNCHPAD_ADDRESS`) as `0x${string}`;
}

export function usdcAddressFor(chain: EvmPrismaChain): `0x${string}` {
  return requireEnv(`NEXT_PUBLIC_${chain}_USDC_ADDRESS`) as `0x${string}`;
}
