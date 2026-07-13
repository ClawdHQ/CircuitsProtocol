import { getContract, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { clawdHQStakingAbi } from "../abi/index.js";
import { ensureErc20Allowance } from "./erc20.js";

export interface EvmStakingAdapterConfig {
  contractAddress: Address;
  publicClient: PublicClient;
  walletClient?: WalletClient;
}

interface UntypedContract {
  read: Record<string, (args?: readonly unknown[]) => Promise<unknown>>;
  write: Record<string, (args?: readonly unknown[]) => Promise<Hex>>;
}

/** Talks to the `ClawdHQStaking` contract — agent reliability bonds, a separate contract from
 * `ClawdHQCore`'s job-hiring marketplace (see `EvmAdapter`). Core's `acceptJob`/`acceptOpenJob`
 * only enforce a bond requirement once an admin has both set a non-zero `stakingContract` on
 * Core and called {setRequiredBond} here for that agent's tier — until then every read here
 * still works, it just never blocks a job accept. */
export class EvmStakingAdapter {
  private readonly contract: UntypedContract;
  private readonly contractAddress: Address;
  private readonly publicClient: PublicClient;
  private readonly walletClient?: WalletClient;
  private usdcAddress: Address | undefined;

  constructor(config: EvmStakingAdapterConfig) {
    this.contractAddress = config.contractAddress;
    this.publicClient = config.publicClient;
    this.walletClient = config.walletClient;
    this.contract = getContract({
      address: config.contractAddress,
      abi: clawdHQStakingAbi,
      client: { public: config.publicClient, wallet: config.walletClient },
    }) as unknown as UntypedContract;
  }

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
    if (!address) throw new Error("EvmStakingAdapter: no connected wallet account to send this transaction from.");
    return address;
  }

  async getBond(agentId: bigint): Promise<bigint> {
    return (await this.contract.read.bondOf([agentId])) as bigint;
  }

  async getRequiredBond(tier: number): Promise<bigint> {
    return (await this.contract.read.requiredBondByTier([tier])) as bigint;
  }

  async isEligible(agentId: bigint, tier: number): Promise<boolean> {
    return (await this.contract.read.isEligible([agentId, tier])) as boolean;
  }

  async postBond(agentId: bigint, amount: bigint): Promise<Hex> {
    await this.ensureUsdcAllowance(this.getSenderAddress(), amount);
    return this.contract.write.postBond([agentId, amount]) as Promise<Hex>;
  }

  async withdrawBond(agentId: bigint, amount: bigint): Promise<Hex> {
    return this.contract.write.withdrawBond([agentId, amount]) as Promise<Hex>;
  }
}
