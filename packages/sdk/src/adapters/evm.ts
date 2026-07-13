import { getContract, parseEventLogs, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { clawdHQCoreAbi, clawdHQLaunchpadAbi } from "../abi/index.js";
import type { AgentSummary, JobSummary, ProtocolStats } from "../types.js";
import { ensureErc20Allowance } from "./erc20.js";

export interface EvmAdapterConfig {
  contractAddress: Address;
  publicClient: PublicClient;
  walletClient?: WalletClient;
  /** Optional: ClawdHQLaunchpad's address (a separate contract post-split — see
   * EvmLaunchpadAdapter for launch reads/writes). When set, {getProtocolStats} folds in its
   * `totalLaunches`/`graduatedLaunches` counters so every caller of this method keeps getting
   * the same combined shape it always has; omitted, those two fields read as 0. */
  launchpadAddress?: Address;
}

interface UntypedContract {
  read: Record<string, (args?: readonly unknown[]) => Promise<unknown>>;
  write: Record<string, (args?: readonly unknown[]) => Promise<Hex>>;
}

/** Talks to the unified `ClawdHQCore` contract deployed identically on BSC/Base/ETH testnets —
 * agent registry and the USDC-escrow job marketplace. The bonding-curve launchpad lives in its
 * own contract/adapter (EvmLaunchpadAdapter) — split out because Core has no bytecode headroom
 * left (see ClawdHQCore.sol's own doc comment). */
export class EvmAdapter {
  private readonly contract: UntypedContract;
  private readonly launchpadContract?: UntypedContract;
  private readonly contractAddress: Address;
  private readonly publicClient: PublicClient;
  private readonly walletClient?: WalletClient;
  private usdcAddress: Address | undefined;

  constructor(config: EvmAdapterConfig) {
    this.contractAddress = config.contractAddress;
    this.publicClient = config.publicClient;
    this.walletClient = config.walletClient;
    this.contract = getContract({
      address: config.contractAddress,
      abi: clawdHQCoreAbi,
      client: { public: config.publicClient, wallet: config.walletClient },
    }) as unknown as UntypedContract;
    if (config.launchpadAddress) {
      this.launchpadContract = getContract({
        address: config.launchpadAddress,
        abi: clawdHQLaunchpadAbi,
        client: { public: config.publicClient },
      }) as unknown as UntypedContract;
    }
  }

  /** Every job/launch/registration fee on this contract pulls USDC via `safeTransferFrom`,
   * which requires a prior ERC20 `approve`. Callers don't need to think about allowances
   * separately — each write method below calls this first. Lazily resolves the USDC
   * contract address from `ClawdHQCore.usdc()` rather than requiring callers to pass it. */
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

  async getAgent(agentId: bigint): Promise<AgentSummary> {
    const card = (await this.contract.read.agents([agentId])) as unknown as readonly [
      bigint, Address, string, string, string, Hex, boolean, boolean, boolean, boolean, number, bigint, bigint, bigint, number, number, bigint, number,
    ];
    return {
      agentId: card[0].toString(),
      owner: card[1],
      name: card[2],
      agentUri: card[3],
      endpoint: card[4],
      metadataHash: card[5],
      active: card[9],
      tier: card[10],
      jobsCompleted: card[14],
      reputationBps: card[17],
      usdcRevenue: card[16],
      lastJobAt: card[13],
      supportsX402: card[6],
      supportsA2A: card[7],
      supportsMcp: card[8],
    };
  }

  async getAgentsByOwner(owner: Address): Promise<bigint[]> {
    return (await this.contract.read.getAgentsByOwner([owner])) as bigint[];
  }

  async getJob(jobId: bigint): Promise<JobSummary> {
    const job = (await this.contract.read.jobs([jobId])) as unknown as readonly [
      bigint, Address, bigint, bigint, Hex, bigint, number, bigint, bigint, bigint, bigint, Hex, number,
    ];
    return {
      jobId: job[0].toString(),
      employer: job[1],
      hiredAgentId: job[3].toString(),
      taskHash: job[4],
      budget: job[5],
      status: job[6],
      deadline: job[8],
    };
  }

  async getProtocolStats(): Promise<ProtocolStats> {
    const [totalAgents, activeAgents, totalJobs, totalVolume, launchStats] = await Promise.all([
      this.contract.read.totalAgents([]),
      this.contract.read.activeAgents([]),
      this.contract.read.totalJobs([]),
      this.contract.read.totalVolume([]),
      this.launchpadContract
        ? Promise.all([this.launchpadContract.read.totalLaunches([]), this.launchpadContract.read.graduatedLaunches([])])
        : Promise.resolve([0n, 0n] as const),
    ]);
    return {
      totalAgents: totalAgents as bigint,
      activeAgents: activeAgents as bigint,
      totalJobs: totalJobs as bigint,
      totalVolume: totalVolume as bigint,
      totalLaunches: launchStats[0] as bigint,
      graduatedLaunches: launchStats[1] as bigint,
    };
  }

  private getSenderAddress(): Address {
    const address = this.walletClient?.account?.address;
    if (!address) throw new Error("EvmAdapter: no connected wallet account to send this transaction from.");
    return address;
  }

  async registerAgent(args: {
    name: string;
    agentUri: string;
    endpoint: string;
    metadataHash: Hex;
    supportsX402: boolean;
    supportsA2A: boolean;
    supportsMcp: boolean;
  }): Promise<Hex> {
    const registrationFee = (await this.contract.read.registrationFee([])) as bigint;
    await this.ensureUsdcAllowance(this.getSenderAddress(), registrationFee);
    return this.contract.write.registerAgent([
      args.name,
      args.agentUri,
      args.endpoint,
      args.metadataHash,
      args.supportsX402,
      args.supportsA2A,
      args.supportsMcp,
    ]) as Promise<Hex>;
  }

  /** Owner-gated (ClawdHQCore's `onlyAgentOwner` modifier) update of an already-registered
   * agent's metadata — the same fields {registerAgent} sets initially. Used by the hosted
   * runtime's two-step registration: register with a placeholder `endpoint` (the real one isn't
   * known until {waitForAgentRegistration} resolves the assigned agentId), then call this to
   * point `endpoint` at the agent's ClawdHQ-managed proxy URL. */
  async updateAgentMetadata(args: {
    agentId: bigint;
    agentUri: string;
    endpoint: string;
    metadataHash: Hex;
    supportsX402: boolean;
    supportsA2A: boolean;
    supportsMcp: boolean;
  }): Promise<Hex> {
    return this.contract.write.updateAgentMetadata([
      args.agentId,
      args.agentUri,
      args.endpoint,
      args.metadataHash,
      args.supportsX402,
      args.supportsA2A,
      args.supportsMcp,
    ]) as Promise<Hex>;
  }

  /** Waits for any transaction from this adapter to confirm — e.g. an {updateAgentMetadata}
   * call, where the caller only needs confirmation, not a decoded event. */
  async waitForTransaction(txHash: Hex): Promise<void> {
    await this.publicClient.waitForTransactionReceipt({ hash: txHash });
  }

  /** Waits for a {registerAgent} transaction to confirm and decodes the `AgentRegistered` event
   * to recover the on-chain agentId — `registerAgent` itself only returns a tx hash, since the
   * id doesn't exist until the transaction actually lands. Needed anywhere a caller must act on
   * the new agent immediately after registering (e.g. persisting its persona, or a hosted-runtime
   * agent's follow-up {updateAgentMetadata} call to point its `endpoint` at the assigned id). */
  async waitForAgentRegistration(txHash: Hex): Promise<bigint> {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    const [event] = parseEventLogs({ abi: clawdHQCoreAbi, eventName: "AgentRegistered", logs: receipt.logs });
    if (!event) throw new Error("AgentRegistered event not found in the registration transaction receipt");
    return (event.args as { agentId: bigint }).agentId;
  }

  async postJob(args: {
    employerAgentId: bigint;
    hiredAgentId: bigint;
    taskHash: Hex;
    budget: bigint;
    deadline: bigint;
  }): Promise<Hex> {
    await this.ensureUsdcAllowance(this.getSenderAddress(), args.budget);
    return this.contract.write.postJob([
      args.employerAgentId,
      args.hiredAgentId,
      args.taskHash,
      args.budget,
      args.deadline,
    ]) as Promise<Hex>;
  }

  /** Directed-hire jobs only (job.hiredAgentId != 0, set at postJob time) — the pre-selected
   * agent's owner is the only one authorized. For an open job (hiredAgentId == 0), use
   * {acceptOpenJob} instead. */
  async acceptJob(jobId: bigint): Promise<Hex> {
    return this.contract.write.acceptJob([jobId]) as Promise<Hex>;
  }

  /** Claims an open job on behalf of `claimingAgentId` — first caller to successfully claim
   * wins. `claimingAgentId` must belong to the connected wallet and be active. */
  async acceptOpenJob(jobId: bigint, claimingAgentId: bigint): Promise<Hex> {
    return this.contract.write.acceptOpenJob([jobId, claimingAgentId]) as Promise<Hex>;
  }

  async submitDeliverable(jobId: bigint, deliverableHash: Hex): Promise<Hex> {
    return this.contract.write.submitDeliverable([jobId, deliverableHash]) as Promise<Hex>;
  }

  async confirmDelivery(jobId: bigint, rating: number): Promise<Hex> {
    return this.contract.write.confirmDelivery([jobId, rating]) as Promise<Hex>;
  }

  async cancelJob(jobId: bigint): Promise<Hex> {
    return this.contract.write.cancelJob([jobId]) as Promise<Hex>;
  }

  async disputeJob(jobId: bigint): Promise<Hex> {
    return this.contract.write.disputeJob([jobId]) as Promise<Hex>;
  }

  /** Transfers an agent's ownership directly, peer-to-peer, outside the exchange. This also
   * clears any standing exchange approval on Core (see {approveAgentExchange}), so it acts
   * as an implicit delist. */
  async transferAgentOwnership(agentId: bigint, newOwner: Address): Promise<Hex> {
    return this.contract.write.transferAgentOwnership([agentId, newOwner]) as Promise<Hex>;
  }

  /** Approves `exchange` (a `ClawdHQAgentExchange` contract address) to execute a one-time
   * ownership transfer of `agentId` if a listing there sells. Pass `zeroAddress` to revoke
   * without transferring. Required before {EvmAgentExchangeAdapter.createListing}. */
  async approveAgentExchange(agentId: bigint, exchange: Address): Promise<Hex> {
    return this.contract.write.approveAgentExchange([agentId, exchange]) as Promise<Hex>;
  }

  async getAgentExchangeApproval(agentId: bigint): Promise<Address> {
    return (await this.contract.read.agentExchangeApproval([agentId])) as Address;
  }
}
