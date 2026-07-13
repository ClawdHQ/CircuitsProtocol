import { getContract, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { clawdHQLaunchpadAbi } from "../abi/index.js";
import type { LaunchSummary } from "../types.js";
import { ensureErc20Allowance } from "./erc20.js";

export interface EvmLaunchpadAdapterConfig {
  contractAddress: Address;
  publicClient: PublicClient;
  walletClient?: WalletClient;
}

interface UntypedContract {
  read: Record<string, (args?: readonly unknown[]) => Promise<unknown>>;
  write: Record<string, (args?: readonly unknown[]) => Promise<Hex>>;
}

/** Talks to the `ClawdHQLaunchpad` contract — the bonding-curve agent-token launchpad, a
 * separate contract from `ClawdHQCore`'s agent registry/job marketplace (see `EvmAdapter`),
 * split out because Core has no bytecode headroom left. `createLaunch` checks agent ownership
 * against Core directly on-chain (via `IClawdHQCore`), so no ownership check is needed here. */
export class EvmLaunchpadAdapter {
  private readonly contract: UntypedContract;
  private readonly contractAddress: Address;
  private readonly publicClient: PublicClient;
  private readonly walletClient?: WalletClient;
  private usdcAddress: Address | undefined;

  constructor(config: EvmLaunchpadAdapterConfig) {
    this.contractAddress = config.contractAddress;
    this.publicClient = config.publicClient;
    this.walletClient = config.walletClient;
    this.contract = getContract({
      address: config.contractAddress,
      abi: clawdHQLaunchpadAbi,
      client: { public: config.publicClient, wallet: config.walletClient },
    }) as unknown as UntypedContract;
  }

  /** Every launch/buy pulls USDC via `safeTransferFrom`, which requires a prior ERC20
   * `approve`. Callers don't need to think about allowances separately — each write method
   * below calls this first. Lazily resolves the USDC contract address from
   * `ClawdHQLaunchpad.usdc()` rather than requiring callers to pass it. */
  private async ensureUsdcAllowance(owner: Address, amount: bigint): Promise<void> {
    if (amount === 0n) return;
    if (!this.usdcAddress) {
      this.usdcAddress = (await this.contract.read.usdc([])) as Address;
    }
    await ensureErc20Allowance(
      { public: this.publicClient, wallet: this.walletClient },
      this.usdcAddress,
      owner,
      this.contractAddress,
      amount
    );
  }

  private getSenderAddress(): Address {
    const address = this.walletClient?.account?.address;
    if (!address) throw new Error("EvmLaunchpadAdapter: no connected wallet account to send this transaction from.");
    return address;
  }

  async getLaunch(launchId: bigint): Promise<LaunchSummary> {
    const launch = (await this.contract.read.launches([launchId])) as unknown as readonly [
      bigint, bigint, Address, string, string, Address, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, boolean, boolean, number,
    ];
    return {
      launchId: launch[0].toString(),
      agentId: launch[1].toString(),
      creator: launch[5],
      name: launch[3],
      symbol: launch[4],
      tokensSold: launch[8],
      usdcRaised: launch[7],
      graduationThreshold: launch[9],
      graduated: launch[15],
      active: launch[16],
      bondingBasePrice: launch[10],
      bondingSlope: launch[11],
    };
  }

  async getCurrentPrice(launchId: bigint): Promise<bigint> {
    return (await this.contract.read.getCurrentPrice([launchId])) as bigint;
  }

  async createLaunch(args: { agentId: bigint; name: string; symbol: string; creatorAllocBps: number }): Promise<Hex> {
    const launchFee = (await this.contract.read.launchFee([])) as bigint;
    await this.ensureUsdcAllowance(this.getSenderAddress(), launchFee);
    return this.contract.write.createLaunch([
      args.agentId,
      args.name,
      args.symbol,
      args.creatorAllocBps,
    ]) as Promise<Hex>;
  }

  async buyTokens(launchId: bigint, usdcAmount: bigint, minTokensOut: bigint): Promise<Hex> {
    await this.ensureUsdcAllowance(this.getSenderAddress(), usdcAmount);
    return this.contract.write.buyTokens([launchId, usdcAmount, minTokensOut]) as Promise<Hex>;
  }

  async sellTokens(launchId: bigint, tokenAmount: bigint, minUsdcOut: bigint): Promise<Hex> {
    return this.contract.write.sellTokens([launchId, tokenAmount, minUsdcOut]) as Promise<Hex>;
  }

  async graduateLaunch(launchId: bigint): Promise<Hex> {
    return this.contract.write.graduateLaunch([launchId]) as Promise<Hex>;
  }
}
