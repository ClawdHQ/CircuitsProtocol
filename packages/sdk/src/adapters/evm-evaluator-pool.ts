import { getContract, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { clawdHQEvaluatorPoolAbi } from "../abi/index.js";
import { ensureErc20Allowance } from "./erc20.js";

export interface EvmEvaluatorPoolAdapterConfig {
  contractAddress: Address;
  publicClient: PublicClient;
  walletClient?: WalletClient;
}

interface UntypedContract {
  read: Record<string, (args?: readonly unknown[]) => Promise<unknown>>;
  write: Record<string, (args?: readonly unknown[]) => Promise<Hex>>;
}

export interface EvaluatorCase {
  feePayer: Address;
  feePaid: bigint;
  evaluators: [Address, Address, Address];
  releaseVotes: number;
  refundVotes: number;
  deadline: bigint;
  /** 0 = None, 1 = Pending, 2 = Finalized, 3 = Escalated */
  status: number;
}

/** Talks to the `ClawdHQEvaluatorPool` contract — the permissionless staked evaluator
 * marketplace, a separate contract from `ClawdHQCore`'s job-hiring marketplace (see
 * `EvmAdapter`). Registering requires a prior USDC allowance for `EVALUATOR_BOND`, handled the
 * same lazy-resolve-then-approve way every other write here that moves USDC already does. */
export class EvmEvaluatorPoolAdapter {
  private readonly contract: UntypedContract;
  private readonly contractAddress: Address;
  private readonly publicClient: PublicClient;
  private readonly walletClient?: WalletClient;
  private usdcAddress: Address | undefined;

  constructor(config: EvmEvaluatorPoolAdapterConfig) {
    this.contractAddress = config.contractAddress;
    this.publicClient = config.publicClient;
    this.walletClient = config.walletClient;
    this.contract = getContract({
      address: config.contractAddress,
      abi: clawdHQEvaluatorPoolAbi,
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
    if (!address) throw new Error("EvmEvaluatorPoolAdapter: no connected wallet account to send this transaction from.");
    return address;
  }

  async isActiveEvaluator(address: Address): Promise<boolean> {
    return (await this.contract.read.isActiveEvaluator([address])) as boolean;
  }

  /** The flat bond every evaluator must post to register — a contract constant, not
   * admin-settable, so no separate setter/event exists for it. */
  async getRequiredEvaluatorBond(): Promise<bigint> {
    return (await this.contract.read.EVALUATOR_BOND([])) as bigint;
  }

  async getEvaluatorBond(address: Address): Promise<bigint> {
    return (await this.contract.read.evaluatorBond([address])) as bigint;
  }

  async getActiveEvaluatorCount(): Promise<bigint> {
    return (await this.contract.read.activeEvaluatorCount([])) as bigint;
  }

  async getEvaluationRequestFee(): Promise<bigint> {
    return (await this.contract.read.evaluationRequestFee([])) as bigint;
  }

  async getCase(jobId: bigint): Promise<EvaluatorCase> {
    const c = (await this.contract.read.getCase([jobId])) as unknown as readonly [
      Address, bigint, Address, Address, Address, number, number, bigint, number,
    ];
    return {
      feePayer: c[0],
      feePaid: c[1],
      evaluators: [c[2], c[3], c[4]],
      releaseVotes: c[5],
      refundVotes: c[6],
      deadline: c[7],
      status: c[8],
    };
  }

  async registerEvaluator(bondAmount: bigint): Promise<Hex> {
    await this.ensureUsdcAllowance(this.getSenderAddress(), bondAmount);
    return this.contract.write.registerEvaluator([]) as Promise<Hex>;
  }

  async unregisterEvaluator(): Promise<Hex> {
    return this.contract.write.unregisterEvaluator([]) as Promise<Hex>;
  }

  async requestEvaluation(jobId: bigint, feeAmount: bigint): Promise<Hex> {
    await this.ensureUsdcAllowance(this.getSenderAddress(), feeAmount);
    return this.contract.write.requestEvaluation([jobId]) as Promise<Hex>;
  }

  async commitVote(jobId: bigint, commitHash: Hex): Promise<Hex> {
    return this.contract.write.commitVote([jobId, commitHash]) as Promise<Hex>;
  }

  async revealVote(jobId: bigint, releaseToAgent: boolean, salt: Hex): Promise<Hex> {
    return this.contract.write.revealVote([jobId, releaseToAgent, salt]) as Promise<Hex>;
  }

  /** Permissionless — callable by anyone once a 2-of-3 majority has revealed, or the voting
   * window has closed. */
  async finalize(jobId: bigint): Promise<Hex> {
    return this.contract.write.finalize([jobId]) as Promise<Hex>;
  }
}
