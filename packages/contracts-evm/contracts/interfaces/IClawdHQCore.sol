// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal external interface into ClawdHQCore, scoped to exactly what
/// ClawdHQAgentExchange needs. Deliberately does not import the full ClawdHQCore contract —
/// that keeps the two contracts' compilation units decoupled, which matters because Core is
/// already at the EIP-170 24576-byte size limit with no headroom to spare.
/// @dev `agents(uint256)` intentionally declares only the leading two of AgentCard's 18
/// return values (agentId, owner). ABI-decoding a typed external call only reads as many
/// leading values as the interface declares — verified empirically against the real
/// contract — so this is a safe, minimal read of a public struct-mapping getter without
/// needing to mirror its entire shape here.
interface IClawdHQCore {
    function agents(uint256 agentId) external view returns (uint256, address owner);
    function agentWalletRegistry() external view returns (address);
    function agentExchangeApproval(uint256 agentId) external view returns (address exchange);
    function transferAgentOwnershipFromExchange(uint256 agentId, address newOwner) external;

    /// @dev Same "leading fields only" trick as `agents()` above — Job's actual struct has more
    /// trailing fields (createdAt, deadline, startedAt, completedAt, deliverableHash, rating);
    /// ClawdHQEvaluatorPool only ever needs these seven.
    function jobs(uint256 jobId) external view returns (
        uint256 jobId_,
        address employer,
        uint256 employerAgentId,
        uint256 hiredAgentId,
        bytes32 taskHash,
        uint256 budget,
        uint8 status
    );

    /// @dev Called by ClawdHQEvaluatorPool once its evaluator panel reaches a 2-of-3 majority
    /// on a disputed job — the permissionless-evaluator-marketplace counterpart to
    /// `resolveDispute`'s RESOLVER_ROLE admin path. Restricted on Core's side to whichever
    /// address `evaluatorPoolContract` currently points at (see ClawdHQCore.sol).
    function resolveDisputeFromEvaluatorPool(uint256 jobId, bool releaseToAgent) external;

    /// @dev Called by ClawdHQNegotiation once a Client/Provider negotiation reaches `Agreed` —
    /// the on-chain-negotiation counterpart to `postJob`. Restricted on Core's side to whichever
    /// addresses `trustedNegotiationContracts` currently allows (see ClawdHQCore.sol). `employer`
    /// is the original Client, not the negotiation contract itself — Core pulls USDC directly
    /// from that address, so the negotiation contract never custodies job funds.
    function postJobFromNegotiation(
        address employer,
        uint256 employerAgentId,
        uint256 hiredAgentId,
        bytes32 taskHash,
        uint256 budget,
        uint256 deadline
    ) external returns (uint256 jobId);
}
