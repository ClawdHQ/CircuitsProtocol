// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal external interface into ClawdHQStaking, scoped to exactly what
/// ClawdHQGovernor needs: reading an agent's currently-posted USDC reliability bond, used
/// directly as that agent's governance voting weight.
interface IClawdHQStakingForGovernor {
    function bondOf(uint256 agentId) external view returns (uint256);
}
