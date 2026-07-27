import "./loadEnv.js";
import type { EvmChainId } from "@clawdhq/sdk";
import { Chain } from "@clawdhq/marketplace-db";

export interface EvmChainIndexerConfig {
  chain: EvmChainId;
  prismaChain: Chain;
  rpcUrl: string;
  coreAddress: `0x${string}`;
  exchangeAddress: `0x${string}`;
  launchpadAddress: `0x${string}`;
  /** AgentWalletRegistry.sol's address — undefined if not yet deployed on this chain, in
   * which case the indexer skips agent-wallet provisioning entirely for it (see
   * listeners/evm.ts's provisionAgentWalletOnChain). */
  agentWalletRegistryAddress: `0x${string}` | undefined;
  fromBlock: bigint;
  /** ClawdHQCrossChainIdentity.sol's address on this chain — undefined until deployed, in
   * which case the indexer skips both watching for LinkRegistered events and relaying on this
   * chain (see relayers/crossChainIdentity.ts). Unlike every other address above, this contract
   * has a genuinely different deployment per chain, not one shared address. */
  crossChainIdentityAddress: `0x${string}` | undefined;
  /** This chain's Circle CCTP V2 domain id — undefined unless both this and
   * cctpMessageTransmitterAddress are configured (see loadEvmChainConfig). */
  cctpDomain: number | undefined;
  /** Circle's MessageTransmitterV2 contract — same address as TokenMessengerV2's sibling
   * contract on every CCTP V2 testnet chain (see .env.example), deployed by Circle itself, not
   * by this project. */
  cctpMessageTransmitterAddress: `0x${string}` | undefined;
  /** ClawdHQGovernor.sol's address — undefined until deployed, in which case the indexer skips
   * watching for governance events entirely (see listeners/evm.ts's processBatch). */
  governorAddress: `0x${string}` | undefined;
}

const ENV_PREFIX: Record<EvmChainId, string> = {
  bsc: "BSC_TESTNET",
  base: "BASE_SEPOLIA",
  eth: "ETH_SEPOLIA",
  arc: "ARC_TESTNET",
};

const PRISMA_CHAIN: Record<EvmChainId, Chain> = {
  bsc: Chain.BSC_TESTNET,
  base: Chain.BASE_SEPOLIA,
  eth: Chain.ETH_SEPOLIA,
  arc: Chain.ARC_TESTNET,
};

/** Reads one EVM chain's indexer config from its `{PREFIX}_RPC_URL` / `{PREFIX}_CONTRACT_ADDRESS`
 * / `{PREFIX}_EXCHANGE_ADDRESS` / `{PREFIX}_DEPLOYMENT_BLOCK` env vars. Returns undefined —
 * rather than throwing — if the chain isn't fully configured, so the indexer can run against
 * whichever subset of chains is actually deployed, matching the SDK's own "all adapters
 * optional" convention (see RoutingEngineConfig). */
export function loadEvmChainConfig(chain: EvmChainId): EvmChainIndexerConfig | undefined {
  const prefix = ENV_PREFIX[chain];
  const rpcUrl = process.env[`${prefix}_RPC_URL`];
  const coreAddress = process.env[`${prefix}_CONTRACT_ADDRESS`];
  const exchangeAddress = process.env[`${prefix}_EXCHANGE_ADDRESS`];
  // Falls back to apps/web's own NEXT_PUBLIC_-prefixed var (same shared root .env) so this
  // doesn't need a second copy of an address that's already configured for the browser.
  const launchpadAddress = process.env[`${prefix}_LAUNCHPAD_ADDRESS`] ?? process.env[`NEXT_PUBLIC_${prefix}_LAUNCHPAD_ADDRESS`];
  if (!rpcUrl || !coreAddress || !exchangeAddress || !launchpadAddress) return undefined;

  const fromBlockEnv = process.env[`${prefix}_DEPLOYMENT_BLOCK`];
  const agentWalletRegistryAddress = process.env[`${prefix}_AGENT_WALLET_REGISTRY_ADDRESS`];
  const crossChainIdentityAddress = process.env[`${prefix}_CROSS_CHAIN_IDENTITY_ADDRESS`];
  const cctpDomainEnv = process.env[`${prefix}_CCTP_DOMAIN`];
  const cctpMessageTransmitterAddress = process.env[`${prefix}_CCTP_MESSAGE_TRANSMITTER_ADDRESS`];
  const governorAddress = process.env[`${prefix}_GOVERNOR_ADDRESS`];
  return {
    chain,
    prismaChain: PRISMA_CHAIN[chain],
    rpcUrl,
    coreAddress: coreAddress as `0x${string}`,
    exchangeAddress: exchangeAddress as `0x${string}`,
    launchpadAddress: launchpadAddress as `0x${string}`,
    agentWalletRegistryAddress: agentWalletRegistryAddress ? (agentWalletRegistryAddress as `0x${string}`) : undefined,
    fromBlock: fromBlockEnv ? BigInt(fromBlockEnv) : 0n,
    crossChainIdentityAddress: crossChainIdentityAddress ? (crossChainIdentityAddress as `0x${string}`) : undefined,
    cctpDomain: cctpDomainEnv ? Number(cctpDomainEnv) : undefined,
    cctpMessageTransmitterAddress: cctpMessageTransmitterAddress ? (cctpMessageTransmitterAddress as `0x${string}`) : undefined,
    governorAddress: governorAddress ? (governorAddress as `0x${string}`) : undefined,
  };
}

export function loadAllEvmChainConfigs(): EvmChainIndexerConfig[] {
  return (["bsc", "base", "eth", "arc"] as const)
    .map(loadEvmChainConfig)
    .filter((config): config is EvmChainIndexerConfig => config !== undefined);
}

export interface SolanaIndexerConfig {
  prismaChain: Chain;
  rpcUrl: string;
  programId: string;
  usdcMint: string;
  treasuryAddress?: string;
}

/** Same "return undefined if not fully configured" convention as the EVM loader — lets the
 * indexer run against whichever subset of chains is actually deployed. Deliberately reads the
 * bare `SOLANA_DEVNET_*` vars, not the `NEXT_PUBLIC_*` ones apps/web uses: the indexer is a
 * plain Node process (no bundling/exposure concerns), and keeping the two separate lets it
 * point at a different, heavier-traffic-tolerant RPC endpoint than the one shipped to browsers. */
export function loadSolanaChainConfig(): SolanaIndexerConfig | undefined {
  const rpcUrl = process.env.SOLANA_DEVNET_RPC_URL;
  const programId = process.env.SOLANA_DEVNET_PROGRAM_ID;
  const usdcMint = process.env.SOLANA_DEVNET_USDC_MINT;
  if (!rpcUrl || !programId || !usdcMint) return undefined;

  return {
    prismaChain: Chain.SOLANA_DEVNET,
    rpcUrl,
    programId,
    usdcMint,
    treasuryAddress: process.env.SOLANA_DEVNET_TREASURY_ADDRESS || undefined,
  };
}

export interface SuiIndexerConfig {
  prismaChain: Chain;
  rpcUrl: string;
  packageId: string;
  protocolStateId: string;
  usdcCoinType: string;
}

export function loadSuiChainConfig(): SuiIndexerConfig | undefined {
  const rpcUrl = process.env.SUI_TESTNET_RPC_URL;
  const packageId = process.env.SUI_TESTNET_PACKAGE_ID;
  const protocolStateId = process.env.SUI_TESTNET_REGISTRY_OBJECT_ID;
  const usdcCoinType = process.env.SUI_TESTNET_USDC_TYPE;
  if (!rpcUrl || !packageId || !protocolStateId || !usdcCoinType) return undefined;

  return { prismaChain: Chain.SUI_TESTNET, rpcUrl, packageId, protocolStateId, usdcCoinType };
}

export const POLL_INTERVAL_MS = Number(process.env.INDEXER_POLL_INTERVAL_MS ?? 5_000);
/** Some RPC providers cap how large a block range a single getLogs call may cover. */
export const LOG_BATCH_BLOCKS = BigInt(process.env.INDEXER_LOG_BATCH_BLOCKS ?? 2_000);

/** Circle's public attestation service — a plain REST API, no key required (see
 * .env.example's Circle section). Undefined disables the cross-chain-identity relayer entirely
 * (see relayers/crossChainIdentity.ts and main.ts). */
export const CIRCLE_IRIS_API_URL = process.env.CIRCLE_IRIS_API_URL;
/** Testnet-only EOA key that pays destination-chain gas to submit CCTP's permissionless
 * `receiveMessage` call — deliberately a bare key like EVM_DEPLOYER_PRIVATE_KEY, not a
 * KMS-wrapped custody-core key: relaying never custodies user funds, it only pays its own gas
 * for a call anyone is allowed to make. Undefined disables the relayer. */
export const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY as `0x${string}` | undefined;
/** How often the relayer re-polls Iris for pending relays — deliberately slower than
 * POLL_INTERVAL_MS above: CCTP V2 standard-finality attestations can take minutes, so polling
 * Iris every few seconds would just waste calls against mostly-unchanged state. */
export const RELAYER_POLL_INTERVAL_MS = Number(process.env.RELAYER_POLL_INTERVAL_MS ?? 30_000);
