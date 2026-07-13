import { createPublicClient, createWalletClient, http, parseAbi, type WalletClient, type Chain as ViemChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EvmAdapter, EvmLaunchpadAdapter } from "@clawdhq/sdk";
import { viemChainFor, rpcUrlFor, contractAddressFor, launchpadAddressFor, type EvmPrismaChain } from "./evmChainConfig.js";

// Write-capable EVM client construction for every feature that signs with a server-custodied
// key (never the user's own browser wallet) — shared by Degen, Subscriptions, and the x402
// facilitator. Deliberately separate from any "read-only" adapter construction: this is the one
// place allowed to hold a walletClient built from a raw private key.

export function getSigningEvmAdapter(chain: EvmPrismaChain, privateKey: string): EvmAdapter {
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const viemChain = viemChainFor(chain);
  const transport = http(rpcUrlFor(chain));
  const publicClient = createPublicClient({ chain: viemChain, transport });
  const walletClient: WalletClient = createWalletClient({ account, chain: viemChain, transport });

  return new EvmAdapter({ contractAddress: contractAddressFor(chain), publicClient, walletClient });
}

/** Same signer, pointed at ClawdHQLaunchpad instead of Core — used by Degen's CLAWDHQ_LAUNCH
 * venue (buyTokens/sellTokens/getCurrentPrice all moved off Core post-split). */
export function getSigningEvmLaunchpadAdapter(chain: EvmPrismaChain, privateKey: string): EvmLaunchpadAdapter {
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const viemChain = viemChainFor(chain);
  const transport = http(rpcUrlFor(chain));
  const publicClient = createPublicClient({ chain: viemChain, transport });
  const walletClient: WalletClient = createWalletClient({ account, chain: viemChain, transport });

  return new EvmLaunchpadAdapter({ contractAddress: launchpadAddressFor(chain), publicClient, walletClient });
}

const ERC20_ABI = parseAbi(["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"]);

export interface Erc20WithdrawResult {
  txHashOrRef: string;
  amount: string;
  asset: string;
}

/** Sweeps a custodied EVM wallet's entire USDC balance to `to`. Callers are responsible for
 * resolving `to` themselves from a verified on-chain/session source, never from unchecked
 * request input. */
export async function withdrawErc20Balance(privateKey: string, viemChain: ViemChain, rpcUrl: string, usdcAddress: `0x${string}`, to: `0x${string}`): Promise<Erc20WithdrawResult> {
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: viemChain, transport });
  const walletClient = createWalletClient({ account, chain: viemChain, transport });

  const balance = await publicClient.readContract({ address: usdcAddress, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });
  if (balance === 0n) return { txHashOrRef: "", amount: "0", asset: "USDC" };

  const txHash = await walletClient.writeContract({ address: usdcAddress, abi: ERC20_ABI, functionName: "transfer", args: [to, balance], account, chain: viemChain });
  return { txHashOrRef: txHash, amount: balance.toString(), asset: "USDC" };
}

/** Transfers a specific USDC amount (not the whole balance — see withdrawErc20Balance for a
 * full sweep) from a custodied EVM wallet to `to`. Used for LLM-credit top-ups, where the
 * agent's AgentWallet should keep whatever balance isn't being earmarked for LLM credits, unlike
 * a claim which sweeps everything. Throws (rather than silently no-op like withdrawErc20Balance
 * does at zero balance) if the wallet can't cover `amount` — a top-up request for more than the
 * agent actually has is a caller error worth surfacing, not a silent partial transfer. */
export async function transferErc20Amount(
  privateKey: string,
  viemChain: ViemChain,
  rpcUrl: string,
  usdcAddress: `0x${string}`,
  to: `0x${string}`,
  amount: bigint,
): Promise<Erc20WithdrawResult> {
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: viemChain, transport });
  const walletClient = createWalletClient({ account, chain: viemChain, transport });

  const balance = await publicClient.readContract({ address: usdcAddress, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });
  if (balance < amount) throw new Error(`Wallet balance (${balance.toString()}) is below the requested transfer amount (${amount.toString()}).`);

  const txHash = await walletClient.writeContract({ address: usdcAddress, abi: ERC20_ABI, functionName: "transfer", args: [to, amount], account, chain: viemChain });
  return { txHashOrRef: txHash, amount: amount.toString(), asset: "USDC" };
}

/** Live USDC balance for a custodied EVM address. */
export async function readUsdcBalance(address: `0x${string}`, viemChain: ViemChain, rpcUrl: string, usdcAddress: `0x${string}`): Promise<bigint> {
  const publicClient = createPublicClient({ chain: viemChain, transport: http(rpcUrl) });
  return publicClient.readContract({ address: usdcAddress, abi: ERC20_ABI, functionName: "balanceOf", args: [address] });
}
