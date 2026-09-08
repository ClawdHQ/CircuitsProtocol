// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IClawdHQCoreLookup {
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
        uint32 jobsCompleted,
        uint32 jobsFailed,
        uint128 usdcRevenue,
        uint16 reputationBps
    );
}

/// @title CircuitsAgentTradingVault
/// @notice On-Chain Isolated Trading Collateral & Margin Vault on Arc Network.
/// On Arc Network, USDC is the native gas currency (18 decimals).
/// Provides dedicated, capital-bounded margin accounts per agent for decentralized perps, predictions,
/// and memecoin execution without requiring off-chain wallet provisioning or touching the Agent Operating Treasury.
contract CircuitsAgentTradingVault is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuard,
    UUPSUpgradeable
{
    bytes32 public constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");

    IClawdHQCoreLookup public coreContract;
    address public treasury;

    // Per-Agent Isolated Collateral Margin Balance (18 decimals native USDC)
    mapping(uint256 => uint256) public agentCollateral;
    // Per-Agent Realized Trading Volume
    mapping(uint256 => uint256) public agentTradingVolume;

    // Approved venue addresses on Arc (e.g. CircuitsPerpVault, CircuitsPredictionVault, ClawdHQLaunchpad)
    mapping(address => bool) public approvedVenues;

    // Events
    event CollateralDeposited(uint256 indexed agentId, address indexed depositor, uint256 amountUsdc, uint256 newBalance);
    event CollateralWithdrawn(uint256 indexed agentId, address indexed owner, uint256 amountUsdc, uint256 remainingBalance);
    event VenueApprovalSet(address indexed venue, bool approved);
    event CoreContractUpdated(address indexed newCoreContract);
    event TradeExecuted(
        uint256 indexed agentId,
        address indexed venue,
        uint256 spendAmountUsdc,
        bool success,
        bytes returnData
    );

    // Errors
    error ZeroAmount();
    error ZeroAddress();
    error NotAgentOwner();
    error InsufficientCollateral();
    error VenueNotApproved();
    error ExecutionFailed();
    error NativeTransferFailed();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address admin,
        address _coreContract,
        address _treasury
    ) external initializer {
        if (admin == address(0)) revert ZeroAddress();
        __AccessControl_init();
        __Pausable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(EXECUTOR_ROLE, admin);

        coreContract = IClawdHQCoreLookup(_coreContract);
        treasury = _treasury == address(0) ? admin : _treasury;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    // ─────────────────────────────────────────────────────────────────────────────
    // Native USDC Collateral Deposits & Owner Withdrawals
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice Anyone (human owner, creator, or backer) can deposit native USDC collateral into an agent's trading account.
    /// @param agentId The on-chain ID of the agent in ClawdHQCore
    function depositCollateral(uint256 agentId) external payable nonReentrant whenNotPaused {
        if (msg.value == 0) revert ZeroAmount();

        agentCollateral[agentId] += msg.value;
        emit CollateralDeposited(agentId, msg.sender, msg.value, agentCollateral[agentId]);
    }

    /// @notice Only the verified on-chain owner of the agent can withdraw native USDC trading collateral or accumulated profits.
    /// @param agentId The on-chain ID of the agent
    /// @param amountUsdc The amount of native USDC to withdraw (18 decimals)
    function withdrawCollateral(uint256 agentId, uint256 amountUsdc) external nonReentrant whenNotPaused {
        if (amountUsdc == 0) revert ZeroAmount();
        if (agentCollateral[agentId] < amountUsdc) revert InsufficientCollateral();

        address owner = _getAgentOwner(agentId);
        if (msg.sender != owner) revert NotAgentOwner();

        agentCollateral[agentId] -= amountUsdc;

        (bool sent, ) = owner.call{value: amountUsdc}("");
        if (!sent) revert NativeTransferFailed();

        emit CollateralWithdrawn(agentId, owner, amountUsdc, agentCollateral[agentId]);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Autonomous Execution (Drawing strictly from Agent Native Collateral)
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice Authorized trading runtime or agent key executes an on-chain trade using the agent's native collateral.
    /// @param agentId The on-chain ID of the agent
    /// @param venue The approved Arc venue contract (e.g. CircuitsPerpVault, CircuitsPredictionVault)
    /// @param callData The encoded function calldata to execute on the venue
    /// @param maxSpendUsdc The maximum native USDC to allocate to this trade (sent via msg.value if > 0)
    function executeTrade(
        uint256 agentId,
        address venue,
        bytes calldata callData,
        uint256 maxSpendUsdc
    ) external nonReentrant whenNotPaused returns (bytes memory returnData) {
        if (!hasRole(EXECUTOR_ROLE, msg.sender) && msg.sender != _getAgentOwner(agentId)) {
            revert NotAgentOwner();
        }
        if (!approvedVenues[venue]) revert VenueNotApproved();

        if (maxSpendUsdc > 0) {
            if (agentCollateral[agentId] < maxSpendUsdc) revert InsufficientCollateral();
            agentCollateral[agentId] -= maxSpendUsdc;
        }

        uint256 balanceBefore = address(this).balance;
        (bool success, bytes memory result) = venue.call{value: maxSpendUsdc}(callData);
        if (!success) {
            // Refund the allocated spend on failure
            if (maxSpendUsdc > 0) {
                agentCollateral[agentId] += maxSpendUsdc;
            }
            revert ExecutionFailed();
        }

        uint256 balanceAfter = address(this).balance;

        // If the trade returned funds (e.g. closing a perp or taking profit), credit them back to agent collateral
        if (balanceAfter > balanceBefore) {
            uint256 profit = balanceAfter - balanceBefore;
            agentCollateral[agentId] += profit;
        } else if (maxSpendUsdc > 0) {
            uint256 actualSpent = balanceBefore - balanceAfter;
            if (actualSpent < maxSpendUsdc) {
                // Refund unspent portion of the allocated maxSpend
                uint256 refund = maxSpendUsdc - actualSpent;
                agentCollateral[agentId] += refund;
            }
            agentTradingVolume[agentId] += actualSpent;
        }

        emit TradeExecuted(agentId, venue, maxSpendUsdc, success, result);
        return result;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // View Functions
    // ─────────────────────────────────────────────────────────────────────────────

    function getAgentMarginBalance(uint256 agentId) external view returns (uint256) {
        return agentCollateral[agentId];
    }

    function getAgentTradingDetails(uint256 agentId) external view returns (
        uint256 marginBalanceUsdc,
        uint256 lifetimeVolumeUsdc,
        address ownerAddress
    ) {
        return (
            agentCollateral[agentId],
            agentTradingVolume[agentId],
            _getAgentOwner(agentId)
        );
    }

    function _getAgentOwner(uint256 agentId) internal view returns (address) {
        if (address(coreContract) == address(0)) return address(0);
        try coreContract.agents(agentId) returns (
            uint256,
            address owner,
            string memory,
            string memory,
            string memory,
            bytes32,
            bool,
            bool,
            bool,
            bool,
            uint8,
            uint64,
            uint64,
            uint64,
            uint32,
            uint32,
            uint128,
            uint16
        ) {
            return owner;
        } catch {
            return address(0);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Admin Configuration
    // ─────────────────────────────────────────────────────────────────────────────

    function setApprovedVenue(address venue, bool approved) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (venue == address(0)) revert ZeroAddress();
        approvedVenues[venue] = approved;
        emit VenueApprovalSet(venue, approved);
    }

    function setCoreContract(address _coreContract) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_coreContract == address(0)) revert ZeroAddress();
        coreContract = IClawdHQCoreLookup(_coreContract);
        emit CoreContractUpdated(_coreContract);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    receive() external payable {}
    fallback() external payable {}
}
