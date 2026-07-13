// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal external interface into ClawdHQCore, scoped to exactly what
/// ClawdHQGovernor needs. Same "deliberately not the full contract" convention as
/// ClawdHQStaking.sol's IClawdHQCore — keeps compilation units decoupled since Core has no
/// bytecode headroom left.
/// @dev `agents(uint256)` declares the 15 leading fields of AgentCard's 18-field struct, through
/// `jobsCompleted` — the same "ABI-decoding a typed external call only reads as many leading
/// values as the interface declares" trick ClawdHQStaking.sol already relies on (verified
/// empirically against the real contract), extended one field further than Staking's own
/// 2-field version since the Governor also needs `jobsCompleted` for its propose/vote
/// eligibility gates.
interface IClawdHQCoreForGovernor {
    function agents(uint256 agentId) external view returns (
        uint256 agentId_,
        address owner,
        string memory name,
        string memory agentURI,
        string memory endpoint,
        bytes32 metadataHash,
        bool supportsX402,
        bool supportsA2A,
        bool supportsMCP,
        bool active,
        uint8 tier,
        uint64 createdAt,
        uint64 updatedAt,
        uint64 lastJobAt,
        uint32 jobsCompleted
    );
}
