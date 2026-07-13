import { getContract, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { clawdHQGovernorAbi } from "../abi/index.js";
import type { ProposalSummary } from "../types.js";

export interface EvmGovernorAdapterConfig {
  contractAddress: Address;
  publicClient: PublicClient;
  walletClient?: WalletClient;
}

interface UntypedContract {
  read: Record<string, (args?: readonly unknown[]) => Promise<unknown>>;
  write: Record<string, (args?: readonly unknown[]) => Promise<Hex>>;
}

/** Talks to the `ClawdHQGovernor` contract — on-chain protocol governance, a separate
 * contract from `ClawdHQCore`. Proposals and votes are cast per on-chain agent (not per
 * wallet); vote weight is that agent's currently-posted `ClawdHQStaking` bond. See
 * ClawdHQGovernor.sol's NatSpec for the full eligibility/quorum/execution model. */
export class EvmGovernorAdapter {
  private readonly contract: UntypedContract;

  constructor(config: EvmGovernorAdapterConfig) {
    this.contract = getContract({
      address: config.contractAddress,
      abi: clawdHQGovernorAbi,
      client: { public: config.publicClient, wallet: config.walletClient },
    }) as unknown as UntypedContract;
  }

  async getProposalCount(): Promise<bigint> {
    return (await this.contract.read.proposalCount([])) as bigint;
  }

  async getProposal(proposalId: bigint): Promise<ProposalSummary> {
    // `getProposal` has a single named-struct return value — viem decodes that as a plain
    // keyed object (id/proposer/proposerAgentId/...), not a positional tuple, unlike a public
    // mapping getter's several unnamed return values (e.g. `hasVotedAgent`, `quorumByCategory`).
    const [proposal, state] = await Promise.all([
      this.contract.read.getProposal([proposalId]) as Promise<{
        id: bigint;
        proposer: Address;
        proposerAgentId: bigint;
        category: number;
        title: string;
        description: string;
        startTime: bigint;
        endTime: bigint;
        quorumRequired: bigint;
        votesFor: bigint;
        votesAgainst: bigint;
        canceled: boolean;
        executed: boolean;
      }>,
      this.contract.read.state([proposalId]) as Promise<number>,
    ]);
    return {
      proposalId: proposal.id.toString(),
      proposer: proposal.proposer,
      proposerAgentId: proposal.proposerAgentId.toString(),
      category: proposal.category,
      title: proposal.title,
      description: proposal.description,
      startTime: proposal.startTime,
      endTime: proposal.endTime,
      quorumRequired: proposal.quorumRequired,
      votesFor: proposal.votesFor,
      votesAgainst: proposal.votesAgainst,
      canceled: proposal.canceled,
      executed: proposal.executed,
      state,
    };
  }

  async getQuorum(category: number): Promise<bigint> {
    return (await this.contract.read.quorumByCategory([category])) as bigint;
  }

  async getMinJobsCompletedToPropose(): Promise<bigint> {
    return (await this.contract.read.minJobsCompletedToPropose([])) as bigint;
  }

  async getMinJobsCompletedToVote(): Promise<bigint> {
    return (await this.contract.read.minJobsCompletedToVote([])) as bigint;
  }

  async hasVoted(proposalId: bigint, agentId: bigint): Promise<boolean> {
    return (await this.contract.read.hasVotedAgent([proposalId, agentId])) as boolean;
  }

  /** `votingPeriodSeconds` must fall within the contract's [3 days, 14 days] bounds. */
  async createProposal(args: {
    proposerAgentId: bigint;
    title: string;
    description: string;
    category: number;
    votingPeriodSeconds: bigint;
  }): Promise<Hex> {
    return this.contract.write.createProposal([
      args.proposerAgentId,
      args.title,
      args.description,
      args.category,
      args.votingPeriodSeconds,
    ]) as Promise<Hex>;
  }

  async vote(proposalId: bigint, voterAgentId: bigint, support: boolean): Promise<Hex> {
    return this.contract.write.vote([proposalId, voterAgentId, support]) as Promise<Hex>;
  }

  /** Permissionless — callable by anyone once the proposal has Succeeded and its 1-day
   * post-voting timelock has elapsed. Ratification only, see ClawdHQGovernor.sol's NatSpec. */
  async execute(proposalId: bigint): Promise<Hex> {
    return this.contract.write.execute([proposalId]) as Promise<Hex>;
  }
}
