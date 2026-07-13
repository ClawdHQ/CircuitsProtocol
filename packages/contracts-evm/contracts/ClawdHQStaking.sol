// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IClawdHQCore} from "./interfaces/IClawdHQCore.sol";

/// @title ClawdHQStaking
/// @notice Agent reliability bonds — the collateral gap identified comparing the AIP
/// Marketplace to Virtuals Protocol's ACP. An agent posts a fixed USDC bond to become
/// job-acceptance-eligible (see ClawdHQCore.sol's {_acceptJob}); losing a dispute slashes the
/// *entire* bond to the wronged employer — "all-or-nothing", the simpler of two models
/// considered, chosen for auditability over nuance. Split into its own UUPS proxy for the same
/// reason the exchange and launchpad already are: ClawdHQCore has limited bytecode headroom and
/// this is a self-contained concern with no reason to live inside it.
/// @dev Reads agent ownership from ClawdHQCore via {IClawdHQCore-agents} rather than holding
/// its own copy — Core remains the sole source of truth for agent identity. Required-bond
/// amounts are keyed by tier as a raw `uint8` (ClawdHQCore.AgentTier's underlying values),
/// matching IClawdHQCore's established "no shared enum import" convention.
contract ClawdHQStaking is Initializable, AccessControlUpgradeable, PausableUpgradeable, UUPSUpgradeable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============================================================ Roles ===

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    // ======================================================== Storage =====

    IClawdHQCore public core;
    IERC20 public usdc;

    mapping(uint256 => uint256) public bondOf; // agentId => USDC (6dp) currently bonded
    mapping(uint8 => uint256) public requiredBondByTier; // AgentTier (raw uint8) => required bond
    /// @notice Contracts allowed to call {slash} — ClawdHQCore's own dispute-resolution paths
    /// and, once deployed, ClawdHQEvaluatorPool. Admin-managed; empty by default.
    mapping(address => bool) public authorizedSlashers;

    // ========================================================= Events =====

    event BondPosted(uint256 indexed agentId, uint256 amount, uint256 newTotal);
    event BondWithdrawn(uint256 indexed agentId, uint256 amount, uint256 newTotal);
    event Slashed(uint256 indexed agentId, address indexed recipient, uint256 amount);
    event RequiredBondUpdated(uint8 tier, uint256 amount);
    event SlasherUpdated(address indexed slasher, bool authorized);

    // ========================================================= Errors =====

    error NotAgentOwner();
    error ZeroAmount();
    error InsufficientBondBalance();
    error NotAuthorizedSlasher();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin, address coreAddress, address usdcAddress) external initializer {
        __AccessControl_init();
        __Pausable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);

        core = IClawdHQCore(coreAddress);
        usdc = IERC20(usdcAddress);
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    // ========================================================== Bonding ===

    function postBond(uint256 agentId, uint256 amount) external whenNotPaused nonReentrant {
        (, address owner) = core.agents(agentId);
        if (owner != msg.sender) revert NotAgentOwner();
        if (amount == 0) revert ZeroAmount();

        usdc.safeTransferFrom(msg.sender, address(this), amount);
        bondOf[agentId] += amount;

        emit BondPosted(agentId, amount, bondOf[agentId]);
    }

    /// @notice No "has open jobs" check — impractical to query from outside Core (there is no
    /// per-agent open-job index). Eligibility is enforced only at job-accept time, same as
    /// every other agent-state check in this codebase (e.g. `active`); withdrawing below the
    /// required bond simply makes the agent ineligible for its *next* acceptJob/acceptOpenJob
    /// call, it does not retroactively touch jobs already Active.
    function withdrawBond(uint256 agentId, uint256 amount) external whenNotPaused nonReentrant {
        (, address owner) = core.agents(agentId);
        if (owner != msg.sender) revert NotAgentOwner();
        if (amount == 0 || amount > bondOf[agentId]) revert InsufficientBondBalance();

        bondOf[agentId] -= amount;
        usdc.safeTransfer(msg.sender, amount);

        emit BondWithdrawn(agentId, amount, bondOf[agentId]);
    }

    /// @notice Whether `agentId` currently holds enough bond to be job-eligible. A tier with no
    /// configured required bond (every tier, by default) always returns true — staking is
    /// opt-in per tier until an admin calls {setRequiredBond}, so introducing this contract
    /// never retroactively locks out existing agents.
    function isEligible(uint256 agentId, uint8 tier) external view returns (bool) {
        return bondOf[agentId] >= requiredBondByTier[tier];
    }

    /// @notice Slashes an agent's *entire* bond to `recipient`. Called by an authorized slasher
    /// (ClawdHQCore's `resolveDispute`, or ClawdHQEvaluatorPool once deployed) when a dispute
    /// resolves against the agent. Returns 0 (not a revert) if the agent has no bond posted —
    /// callers that need this to be best-effort (see ClawdHQCore's try/catch around it) get a
    /// clean no-op rather than needing to handle a revert.
    function slash(uint256 agentId, address recipient) external nonReentrant returns (uint256 amount) {
        if (!authorizedSlashers[msg.sender]) revert NotAuthorizedSlasher();

        amount = bondOf[agentId];
        if (amount == 0) return 0;
        bondOf[agentId] = 0;
        usdc.safeTransfer(recipient, amount);

        emit Slashed(agentId, recipient, amount);
    }

    // ============================================================== Admin =

    function setRequiredBond(uint8 tier, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        requiredBondByTier[tier] = amount;
        emit RequiredBondUpdated(tier, amount);
    }

    function setAuthorizedSlasher(address slasher, bool authorized) external onlyRole(DEFAULT_ADMIN_ROLE) {
        authorizedSlashers[slasher] = authorized;
        emit SlasherUpdated(slasher, authorized);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /// @notice Rescues ERC-20 tokens accidentally sent directly to this contract. Cannot be
    /// used to drain bonded funds since those are tracked separately via {bondOf} — callers
    /// should verify off-chain that `amount` does not exceed the contract's "unaccounted"
    /// balance before calling.
    function withdrawStuckTokens(address token, uint256 amount, address to) external onlyRole(DEFAULT_ADMIN_ROLE) {
        IERC20(token).safeTransfer(to, amount);
    }
}
