/// The 3 CCTP V2 testnet chains this app's cross-chain identity subsystem spans — Circle
/// doesn't issue CCTP USDC on BSC Testnet, and Solana's CCTP integration is program-based, not
/// EVM, so both are out of scope for ClawdHQCrossChainIdentity. Shared by
/// 02f-deploy-cross-chain-identity.ts (deploys one instance per chain) and
/// 02g-configure-cross-chain-identity-peers.ts (wires each instance to trust the other two).
export interface CCTPNetwork {
  network: string; // matches hardhat.config.ts's networks key
  chainId: number;
  /** Prefix for this chain's *_CCTP_DOMAIN / *_CCTP_MESSAGE_TRANSMITTER_ADDRESS env vars (see .env.example). */
  envPrefix: string;
}

export const CCTP_NETWORKS: CCTPNetwork[] = [
  { network: "baseSepolia", chainId: 84532, envPrefix: "BASE_SEPOLIA" },
  { network: "ethSepolia", chainId: 11155111, envPrefix: "ETH_SEPOLIA" },
  { network: "arcTestnet", chainId: 5042002, envPrefix: "ARC_TESTNET" },
];

export function cctpNetworkByChainId(chainId: number): CCTPNetwork | undefined {
  return CCTP_NETWORKS.find((n) => n.chainId === chainId);
}
