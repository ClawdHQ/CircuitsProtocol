export type { ChainId } from "@clawdhq/clawmem";

export type EvmChainId = "bsc" | "base" | "eth" | "arc";

export interface AgentSummary {
  agentId: string;
  owner: string;
  name: string;
  agentUri: string;
  endpoint: string;
  /// sha256 of the registration-time `description` — the plaintext itself isn't readable
  /// on-chain; look it up against an off-chain cache keyed by this hash (see apps/web's
  /// /api/marketplace/agent-descriptions, same pattern as JobSummary.taskHash below).
  metadataHash: string;
  active: boolean;
  tier: number;
  jobsCompleted: number;
  reputationBps: number;
  usdcRevenue: bigint;
  lastJobAt: bigint; // unix seconds, 0 if never
  supportsX402: boolean;
  supportsA2A: boolean;
  supportsMcp: boolean;
}

export interface JobSummary {
  jobId: string;
  employer: string;
  hiredAgentId: string;
  /// keccak256 of the task's IPFS CID string per the contract's own doc comment — in practice
  /// (no IPFS pinning is wired up yet) a sha256 of the raw task description text instead. Not
  /// itself readable; look it up against an off-chain description cache keyed by this hash
  /// (see apps/web/src/app/api/marketplace/task-descriptions and packages/agent-runtime).
  taskHash: string;
  budget: bigint;
  status: number;
  deadline: bigint;
}

export interface LaunchSummary {
  launchId: string;
  agentId: string;
  creator: string;
  name: string;
  symbol: string;
  tokensSold: bigint;
  usdcRaised: bigint;
  graduationThreshold: bigint;
  graduated: boolean;
  active: boolean;
  bondingBasePrice: bigint;
  bondingSlope: bigint;
}

export interface ProtocolStats {
  totalAgents: bigint;
  activeAgents: bigint;
  totalJobs: bigint;
  totalVolume: bigint;
  totalLaunches: bigint;
  graduatedLaunches: bigint;
}

// Agent ownership exchange (NFT-style marketplace) — distinct from the job marketplace
// above. `mode`/`status` are left as raw on-chain enum numbers (0-indexed, matching each
// chain's contract) rather than string literals, consistent with `JobSummary.status` and
// `AgentSummary.tier` elsewhere in this file; UI layers own the label mapping.
export interface ListingSummary {
  listingId: string;
  agentId: string;
  seller: string;
  mode: number; // 0 = Open, 1 = Auction
  status: number; // 0 = Active, 1 = Sold, 2 = Cancelled, 3 = Expired
  fairValueSnapshotUsdc: bigint;
  reservePriceUsdc: bigint;
  endTime: bigint; // 0 for Open listings
  highestBidId: string; // "0" if none yet (Auction only)
}

export interface BidSummary {
  bidId: string;
  listingId: string;
  bidder: string;
  amountUsdc: bigint;
  active: boolean;
}

// Protocol governance — identity and voting weight are both per on-chain agent, not per
// wallet (see ClawdHQGovernor.sol). `category`/`state` are raw on-chain enum numbers, same
// "UI layer owns the label mapping" convention as ListingSummary above.
export interface ProposalSummary {
  proposalId: string;
  proposer: string;
  proposerAgentId: string;
  category: number; // 0=Parameters,1=Treasury,2=Upgrade,3=Skill,4=Other
  title: string;
  description: string;
  startTime: bigint;
  endTime: bigint;
  quorumRequired: bigint; // absolute USDC-bond-weighted-vote target (6dp), not a percentage
  votesFor: bigint;
  votesAgainst: bigint;
  canceled: boolean;
  executed: boolean;
  state: number; // 0 Active / 1 Succeeded / 2 Defeated / 3 QuorumNotMet / 4 Canceled / 5 Executed
}
