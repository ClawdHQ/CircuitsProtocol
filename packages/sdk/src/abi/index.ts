import type { Abi } from "viem";
import clawdHQCoreAbiJson from "./clawdhq-core.abi.json" with { type: "json" };
import clawdHQAgentExchangeAbiJson from "./clawdhq-agent-exchange.abi.json" with { type: "json" };
import clawdHQLaunchpadAbiJson from "./clawdhq-launchpad.abi.json" with { type: "json" };
import clawdHQStakingAbiJson from "./clawdhq-staking.abi.json" with { type: "json" };
import clawdHQEvaluatorPoolAbiJson from "./clawdhq-evaluator-pool.abi.json" with { type: "json" };
import clawdHQNegotiationAbiJson from "./clawdhq-negotiation.abi.json" with { type: "json" };
import clawdHQCrossChainIdentityAbiJson from "./clawdhq-cross-chain-identity.abi.json" with { type: "json" };
import clawdHQGovernorAbiJson from "./clawdhq-governor.abi.json" with { type: "json" };

/** Raw ABIs, exported for consumers that need to decode/watch events directly (e.g. the
 * indexer) rather than call through the adapter classes. */
export const clawdHQCoreAbi = clawdHQCoreAbiJson as Abi;
export const clawdHQAgentExchangeAbi = clawdHQAgentExchangeAbiJson as Abi;
export const clawdHQLaunchpadAbi = clawdHQLaunchpadAbiJson as Abi;
export const clawdHQStakingAbi = clawdHQStakingAbiJson as Abi;
export const clawdHQEvaluatorPoolAbi = clawdHQEvaluatorPoolAbiJson as Abi;
export const clawdHQNegotiationAbi = clawdHQNegotiationAbiJson as Abi;
export const clawdHQCrossChainIdentityAbi = clawdHQCrossChainIdentityAbiJson as Abi;
export const clawdHQGovernorAbi = clawdHQGovernorAbiJson as Abi;
