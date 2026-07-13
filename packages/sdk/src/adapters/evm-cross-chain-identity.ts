import { getContract, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { clawdHQCrossChainIdentityAbi } from "../abi/index.js";

export interface EvmCrossChainIdentityAdapterConfig {
  contractAddress: Address;
  publicClient: PublicClient;
  walletClient?: WalletClient;
}

interface UntypedContract {
  read: Record<string, (args?: readonly unknown[]) => Promise<unknown>>;
  write: Record<string, (args?: readonly unknown[]) => Promise<Hex>>;
}

/** Talks to one chain's `ClawdHQCrossChainIdentity` deployment — a *different* contract
 * instance per chain (unlike every other adapter in this SDK, which points at one shared
 * contract), linking "this agent here" to "that agent on another chain" for the same owner, via
 * Circle CCTP. A UI that wants the full cross-chain picture for one agent constructs one adapter
 * per configured chain (see `useLinkedIdentities` in apps/web) and queries each independently —
 * this adapter itself only ever knows its own chain's view of a given `globalId`. */
export class EvmCrossChainIdentityAdapter {
  private readonly contract: UntypedContract;

  constructor(config: EvmCrossChainIdentityAdapterConfig) {
    this.contract = getContract({
      address: config.contractAddress,
      abi: clawdHQCrossChainIdentityAbi,
      client: { public: config.publicClient, wallet: config.walletClient },
    }) as unknown as UntypedContract;
  }

  async getLocalDomain(): Promise<number> {
    return Number((await this.contract.read.localDomain([])) as bigint | number);
  }

  /** `0x00...00` (bytes32 zero) if `localAgentId` has never been registered on this chain. */
  async getGlobalIdForLocalAgent(localAgentId: bigint): Promise<Hex> {
    return (await this.contract.read.globalIdOfLocalAgent([localAgentId])) as Hex;
  }

  /** The zero address if `globalId` is unknown to this chain's contract (never registered here
   * and never received via an attested CCTP message from a peer). */
  async getOwnerOfGlobalId(globalId: Hex): Promise<Address> {
    return (await this.contract.read.ownerOfGlobalId([globalId])) as Address;
  }

  /** `0` if `globalId` is known on this chain (an owner is recorded) but no local agent has been
   * claimed under it yet via {claimLocalAgent} — distinct from the globalId being entirely
   * unknown, which callers should check via {getOwnerOfGlobalId} first. */
  async getLocalAgentIdForGlobalId(globalId: Hex): Promise<bigint> {
    return (await this.contract.read.localAgentIdOfGlobalId([globalId])) as bigint;
  }

  /** Originates (or idempotently re-broadcasts) a global identity for `localAgentId`, owned by
   * the connected wallet, and relays it to every peer chain this deployment has configured via
   * `setPeer`. Requires the off-chain relayer (or anyone) to later submit the attestation on
   * each destination chain before {getOwnerOfGlobalId} resolves there — this call only confirms
   * the *send*, not delivery. */
  async registerLink(localAgentId: bigint): Promise<Hex> {
    return this.contract.write.registerLink([localAgentId]) as Promise<Hex>;
  }

  /** Attaches `localAgentId` on *this* chain to a `globalId` already established elsewhere.
   * Requires the connected wallet to both own `localAgentId` here and match the address the
   * global identity was originated under (see the contract's own trust-model doc comment). */
  async claimLocalAgent(globalId: Hex, localAgentId: bigint): Promise<Hex> {
    return this.contract.write.claimLocalAgent([globalId, localAgentId]) as Promise<Hex>;
  }
}
