// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title CircuitsPredictionVault
/// @notice Protocol-native prediction market pool & vault on Arc Network.
/// Users and autonomous AI agents trade binary outcome shares against the vault pool in native gas USDC.
contract CircuitsPredictionVault is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuard,
    UUPSUpgradeable
{
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
    bytes32 public constant RESOLVER_ROLE = keccak256("RESOLVER_ROLE");
    bytes32 public constant VAULT_ROLE = keccak256("VAULT_ROLE");

    uint256 public constant BPS_DENOMINATOR = 10000;
    uint256 public constant PROTOCOL_FEE_BPS = 50; // 0.5% fee on share purchases
    uint256 public constant MIN_STAKE = 1e16; // 0.01 native USDC (18 decimals)

    enum Outcome {
        UNRESOLVED,
        YES,
        NO,
        INVALID
    }

    enum MarketStatus {
        OPEN,
        RESOLVED,
        CANCELLED
    }

    struct Market {
        bytes32 marketId;
        string question;
        uint256 endTime;
        uint256 totalYesShares;
        uint256 totalNoShares;
        uint256 totalUsdcPool;
        uint256 feePool;
        MarketStatus status;
        Outcome winningOutcome;
        uint256 createdAt;
        uint256 resolvedAt;
    }

    /// @dev Kept for storage layout compatibility with the initial deployment.
    address public usdc;
    address public treasury;

    mapping(bytes32 => Market) public markets;
    mapping(bytes32 => mapping(address => uint256)) public yesShares;
    mapping(bytes32 => mapping(address => uint256)) public noShares;
    mapping(bytes32 => mapping(address => bool)) public claimed;
    bytes32[] public allMarketIds;

    // Events
    event MarketCreated(bytes32 indexed marketId, string question, uint256 endTime, address indexed creator);
    event SharesPurchased(
        bytes32 indexed marketId,
        address indexed buyer,
        Outcome outcome,
        uint256 usdcAmount,
        uint256 sharesMinted,
        uint256 feePaid
    );
    event SharesSold(
        bytes32 indexed marketId,
        address indexed seller,
        Outcome outcome,
        uint256 sharesBurned,
        uint256 usdcReturned
    );
    event MarketResolved(bytes32 indexed marketId, Outcome winningOutcome, uint256 totalPool);
    event WinningsClaimed(bytes32 indexed marketId, address indexed claimant, uint256 payoutUsdc);
    event LiquiditySeeded(bytes32 indexed marketId, address indexed provider, uint256 usdcAmount);
    event TreasuryUpdated(address indexed newTreasury);

    // Custom Errors
    error InvalidMarket();
    error MarketAlreadyExists();
    error MarketNotOpen();
    error MarketEnded();
    error MarketNotEnded();
    error MarketNotResolved();
    error MarketAlreadyResolved();
    error InvalidOutcome();
    error AmountTooSmall();
    error SlippageExceeded();
    error InsufficientShares();
    error AlreadyClaimed();
    error NoWinningShares();
    error ZeroAddress();
    error NativeTransferFailed();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin, address _usdcIgnored, address _treasury) external initializer {
        if (admin == address(0)) revert ZeroAddress();
        __AccessControl_init();
        __Pausable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ORACLE_ROLE, admin);
        _grantRole(RESOLVER_ROLE, admin);
        _grantRole(VAULT_ROLE, admin);

        treasury = _treasury == address(0) ? admin : _treasury;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    // ─────────────────────────────────────────────────────────────────────────────
    // Market Creation
    // ─────────────────────────────────────────────────────────────────────────────

    function createMarket(
        bytes32 marketId,
        string calldata question,
        uint256 endTime
    ) external whenNotPaused returns (bytes32) {
        if (marketId == bytes32(0)) {
            marketId = keccak256(abi.encodePacked(question, block.timestamp, msg.sender));
        }
        if (markets[marketId].createdAt != 0) revert MarketAlreadyExists();
        if (endTime <= block.timestamp) revert InvalidMarket();

        markets[marketId] = Market({
            marketId: marketId,
            question: question,
            endTime: endTime,
            totalYesShares: 0,
            totalNoShares: 0,
            totalUsdcPool: 0,
            feePool: 0,
            status: MarketStatus.OPEN,
            winningOutcome: Outcome.UNRESOLVED,
            createdAt: block.timestamp,
            resolvedAt: 0
        });

        allMarketIds.push(marketId);
        emit MarketCreated(marketId, question, endTime, msg.sender);
        return marketId;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Share Trading (Buy / Sell against Market Pool)
    // ─────────────────────────────────────────────────────────────────────────────

    function buyShares(
        bytes32 marketId,
        Outcome outcome,
        uint256 usdcAmount,
        uint256 minSharesOut
    ) external payable nonReentrant whenNotPaused returns (uint256 sharesMinted) {
        if (msg.value > 0) {
            usdcAmount = msg.value;
        }
        return _buySharesInternal(msg.sender, marketId, outcome, usdcAmount, minSharesOut);
    }

    function buySharesFor(
        address onBehalfOf,
        bytes32 marketId,
        Outcome outcome,
        uint256 usdcAmount,
        uint256 minSharesOut
    ) external payable onlyRole(VAULT_ROLE) nonReentrant whenNotPaused returns (uint256 sharesMinted) {
        if (msg.value > 0) {
            usdcAmount = msg.value;
        }
        return _buySharesInternal(onBehalfOf, marketId, outcome, usdcAmount, minSharesOut);
    }

    function _buySharesInternal(
        address buyer,
        bytes32 marketId,
        Outcome outcome,
        uint256 usdcAmount,
        uint256 minSharesOut
    ) internal returns (uint256 sharesMinted) {
        Market storage m = markets[marketId];
        if (m.createdAt == 0) revert InvalidMarket();
        if (m.status != MarketStatus.OPEN) revert MarketNotOpen();
        if (block.timestamp >= m.endTime) revert MarketEnded();
        if (outcome != Outcome.YES && outcome != Outcome.NO) revert InvalidOutcome();
        if (usdcAmount < MIN_STAKE) revert AmountTooSmall();

        uint256 fee = (usdcAmount * PROTOCOL_FEE_BPS) / BPS_DENOMINATOR;
        uint256 netDeposit = usdcAmount - fee;

        if (outcome == Outcome.YES) {
            uint256 currentYes = m.totalYesShares;
            uint256 currentNo = m.totalNoShares;
            if (currentYes == 0 && currentNo == 0) {
                sharesMinted = netDeposit;
            } else if (currentYes == 0) {
                sharesMinted = netDeposit;
            } else {
                uint256 totalWeight = currentYes + currentNo;
                sharesMinted = (netDeposit * totalWeight) / currentYes;
                if (sharesMinted == 0) sharesMinted = netDeposit;
            }
            if (sharesMinted < minSharesOut) revert SlippageExceeded();
            yesShares[marketId][buyer] += sharesMinted;
            m.totalYesShares += sharesMinted;
        } else {
            uint256 currentYes = m.totalYesShares;
            uint256 currentNo = m.totalNoShares;
            if (currentYes == 0 && currentNo == 0) {
                sharesMinted = netDeposit;
            } else if (currentNo == 0) {
                sharesMinted = netDeposit;
            } else {
                uint256 totalWeight = currentYes + currentNo;
                sharesMinted = (netDeposit * totalWeight) / currentNo;
                if (sharesMinted == 0) sharesMinted = netDeposit;
            }
            if (sharesMinted < minSharesOut) revert SlippageExceeded();
            noShares[marketId][buyer] += sharesMinted;
            m.totalNoShares += sharesMinted;
        }

        m.totalUsdcPool += netDeposit;
        m.feePool += fee;

        if (fee > 0 && treasury != address(0)) {
            (bool sentFee, ) = payable(treasury).call{value: fee}("");
            if (!sentFee) revert NativeTransferFailed();
        }

        emit SharesPurchased(marketId, buyer, outcome, usdcAmount, sharesMinted, fee);
    }

    function sellShares(
        bytes32 marketId,
        Outcome outcome,
        uint256 sharesAmount,
        uint256 minUsdcOut
    ) external nonReentrant whenNotPaused returns (uint256 usdcReturned) {
        return _sellSharesInternal(msg.sender, msg.sender, marketId, outcome, sharesAmount, minUsdcOut);
    }

    function sellSharesFor(
        address onBehalfOf,
        bytes32 marketId,
        Outcome outcome,
        uint256 sharesAmount,
        uint256 minUsdcOut
    ) external onlyRole(VAULT_ROLE) nonReentrant whenNotPaused returns (uint256 usdcReturned) {
        // Payout is sent to msg.sender (the vault router) to credit the agent
        return _sellSharesInternal(onBehalfOf, msg.sender, marketId, outcome, sharesAmount, minUsdcOut);
    }

    function _sellSharesInternal(
        address seller,
        address payoutRecipient,
        bytes32 marketId,
        Outcome outcome,
        uint256 sharesAmount,
        uint256 minUsdcOut
    ) internal returns (uint256 usdcReturned) {
        Market storage m = markets[marketId];
        if (m.createdAt == 0) revert InvalidMarket();
        if (m.status != MarketStatus.OPEN) revert MarketNotOpen();
        if (block.timestamp >= m.endTime) revert MarketEnded();
        if (sharesAmount == 0) revert AmountTooSmall();

        if (outcome == Outcome.YES) {
            if (yesShares[marketId][seller] < sharesAmount) revert InsufficientShares();
            usdcReturned = (sharesAmount * m.totalUsdcPool) / (m.totalYesShares + m.totalNoShares);
            if (usdcReturned > m.totalUsdcPool) usdcReturned = m.totalUsdcPool;
            if (usdcReturned < minUsdcOut) revert SlippageExceeded();

            yesShares[marketId][seller] -= sharesAmount;
            m.totalYesShares -= sharesAmount;
        } else if (outcome == Outcome.NO) {
            if (noShares[marketId][seller] < sharesAmount) revert InsufficientShares();
            usdcReturned = (sharesAmount * m.totalUsdcPool) / (m.totalYesShares + m.totalNoShares);
            if (usdcReturned > m.totalUsdcPool) usdcReturned = m.totalUsdcPool;
            if (usdcReturned < minUsdcOut) revert SlippageExceeded();

            noShares[marketId][seller] -= sharesAmount;
            m.totalNoShares -= sharesAmount;
        } else {
            revert InvalidOutcome();
        }

        m.totalUsdcPool -= usdcReturned;

        (bool sentPayout, ) = payable(payoutRecipient).call{value: usdcReturned}("");
        if (!sentPayout) revert NativeTransferFailed();

        emit SharesSold(marketId, seller, outcome, sharesAmount, usdcReturned);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Settlement & Claiming
    // ─────────────────────────────────────────────────────────────────────────────

    function resolveMarket(
        bytes32 marketId,
        Outcome winningOutcome
    ) external onlyRole(RESOLVER_ROLE) {
        Market storage m = markets[marketId];
        if (m.createdAt == 0) revert InvalidMarket();
        if (m.status != MarketStatus.OPEN) revert MarketAlreadyResolved();
        if (winningOutcome == Outcome.UNRESOLVED) revert InvalidOutcome();

        m.status = MarketStatus.RESOLVED;
        m.winningOutcome = winningOutcome;
        m.resolvedAt = block.timestamp;

        emit MarketResolved(marketId, winningOutcome, m.totalUsdcPool);
    }

    function claimWinnings(bytes32 marketId) external nonReentrant returns (uint256 payout) {
        return _claimWinningsInternal(msg.sender, msg.sender, marketId);
    }

    function claimWinningsFor(
        address onBehalfOf,
        bytes32 marketId
    ) external onlyRole(VAULT_ROLE) nonReentrant returns (uint256 payout) {
        // Payout is sent to msg.sender (the vault router) to credit the agent
        return _claimWinningsInternal(onBehalfOf, msg.sender, marketId);
    }

    function _claimWinningsInternal(
        address claimant,
        address payoutRecipient,
        bytes32 marketId
    ) internal returns (uint256 payout) {
        Market storage m = markets[marketId];
        if (m.createdAt == 0) revert InvalidMarket();
        if (m.status != MarketStatus.RESOLVED) revert MarketNotResolved();
        if (claimed[marketId][claimant]) revert AlreadyClaimed();

        claimed[marketId][claimant] = true;

        if (m.winningOutcome == Outcome.YES) {
            uint256 userShares = yesShares[marketId][claimant];
            if (userShares == 0) revert NoWinningShares();
            payout = (userShares * m.totalUsdcPool) / m.totalYesShares;
        } else if (m.winningOutcome == Outcome.NO) {
            uint256 userShares = noShares[marketId][claimant];
            if (userShares == 0) revert NoWinningShares();
            payout = (userShares * m.totalUsdcPool) / m.totalNoShares;
        } else if (m.winningOutcome == Outcome.INVALID) {
            uint256 userTotal = yesShares[marketId][claimant] + noShares[marketId][claimant];
            uint256 totalMarketShares = m.totalYesShares + m.totalNoShares;
            if (userTotal == 0) revert NoWinningShares();
            payout = (userTotal * m.totalUsdcPool) / totalMarketShares;
        }

        if (payout > 0) {
            (bool sentPayout, ) = payable(payoutRecipient).call{value: payout}("");
            if (!sentPayout) revert NativeTransferFailed();
        }

        emit WinningsClaimed(marketId, claimant, payout);
    }

    function seedLiquidity(bytes32 marketId, uint256 usdcAmount) external payable nonReentrant whenNotPaused {
        if (msg.value > 0) {
            usdcAmount = msg.value;
        }
        Market storage m = markets[marketId];
        if (m.createdAt == 0) revert InvalidMarket();
        if (m.status != MarketStatus.OPEN) revert MarketNotOpen();
        if (usdcAmount == 0) revert AmountTooSmall();

        uint256 split = usdcAmount / 2;
        m.totalYesShares += split;
        m.totalNoShares += split;
        m.totalUsdcPool += usdcAmount;

        emit LiquiditySeeded(marketId, msg.sender, usdcAmount);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Admin Controls
    // ─────────────────────────────────────────────────────────────────────────────

    function setTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newTreasury == address(0)) revert ZeroAddress();
        treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // View Functions
    // ─────────────────────────────────────────────────────────────────────────────

    function allMarketsCount() external view returns (uint256) {
        return allMarketIds.length;
    }

    function getMarket(bytes32 marketId) external view returns (Market memory) {
        return markets[marketId];
    }

    function getUserPosition(
        bytes32 marketId,
        address user
    ) external view returns (uint256 userYes, uint256 userNo, bool hasClaimed) {
        return (yesShares[marketId][user], noShares[marketId][user], claimed[marketId][user]);
    }

    receive() external payable {}
    fallback() external payable {}
}
