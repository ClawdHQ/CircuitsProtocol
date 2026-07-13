import { getContract, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { clawdHQNegotiationAbi } from "../abi/index.js";

export interface EvmNegotiationAdapterConfig {
  contractAddress: Address;
  publicClient: PublicClient;
  walletClient?: WalletClient;
}

interface UntypedContract {
  read: Record<string, (args?: readonly unknown[]) => Promise<unknown>>;
  write: Record<string, (args?: readonly unknown[]) => Promise<Hex>>;
}

export interface NegotiationSummary {
  client: Address;
  employerAgentId: string;
  counterpartyAgentId: string;
  taskHash: Hex;
  budget: bigint;
  deadlineDays: bigint;
  lastProposerIsClient: boolean;
  /** 0 = Proposed, 1 = Countered, 2 = Agreed, 3 = Committed, 4 = Withdrawn */
  status: number;
}

/** Talks to the `ClawdHQNegotiation` contract — fully on-chain Client/Provider offer/counter/
 * accept, a separate contract from `ClawdHQCore`'s job-hiring marketplace (see `EvmAdapter`).
 * {commit} still requires the Client to have approved Core (not this contract) for the agreed
 * USDC budget beforehand — Core pulls the funds directly, this contract never custodies them. */
export class EvmNegotiationAdapter {
  private readonly contract: UntypedContract;

  constructor(config: EvmNegotiationAdapterConfig) {
    this.contract = getContract({
      address: config.contractAddress,
      abi: clawdHQNegotiationAbi,
      client: { public: config.publicClient, wallet: config.walletClient },
    }) as unknown as UntypedContract;
  }

  async getTotalNegotiations(): Promise<bigint> {
    return (await this.contract.read.totalNegotiations([])) as bigint;
  }

  async getNegotiation(negotiationId: bigint): Promise<NegotiationSummary> {
    const n = (await this.contract.read.negotiations([negotiationId])) as unknown as readonly [
      Address, bigint, bigint, Hex, bigint, bigint, boolean, number,
    ];
    return {
      client: n[0],
      employerAgentId: n[1].toString(),
      counterpartyAgentId: n[2].toString(),
      taskHash: n[3],
      budget: n[4],
      deadlineDays: n[5],
      lastProposerIsClient: n[6],
      status: n[7],
    };
  }

  async proposeJob(args: {
    employerAgentId: bigint;
    counterpartyAgentId: bigint;
    taskHash: Hex;
    budget: bigint;
    deadlineDays: bigint;
  }): Promise<Hex> {
    return this.contract.write.proposeJob([
      args.employerAgentId,
      args.counterpartyAgentId,
      args.taskHash,
      args.budget,
      args.deadlineDays,
    ]) as Promise<Hex>;
  }

  /** `providerAgentId` matters only the first time the Provider side engages an open
   * negotiation (locks it in) — safe to pass on every call regardless, see the contract's own
   * doc comment. */
  async counterOffer(args: {
    negotiationId: bigint;
    providerAgentId: bigint;
    taskHash: Hex;
    budget: bigint;
    deadlineDays: bigint;
  }): Promise<Hex> {
    return this.contract.write.counterOffer([
      args.negotiationId,
      args.providerAgentId,
      args.taskHash,
      args.budget,
      args.deadlineDays,
    ]) as Promise<Hex>;
  }

  async acceptTerms(negotiationId: bigint): Promise<Hex> {
    return this.contract.write.acceptTerms([negotiationId]) as Promise<Hex>;
  }

  /** Client-only — requires a prior USDC approval on ClawdHQCore (not this contract) for the
   * agreed budget. */
  async commit(negotiationId: bigint): Promise<Hex> {
    return this.contract.write.commit([negotiationId]) as Promise<Hex>;
  }

  async withdraw(negotiationId: bigint): Promise<Hex> {
    return this.contract.write.withdraw([negotiationId]) as Promise<Hex>;
  }
}
