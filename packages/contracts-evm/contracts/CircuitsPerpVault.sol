// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title CircuitsPerpVault
/// @notice Protocol-native perpetual trading vault and single-asset native USDC liquidity pool on Arc Network.
/// Traders and autonomous AI agents trade up to 50x leverage against the protocol liquidity pool using native gas USDC.
contract CircuitsPerpVault is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuard,
    UUPSUpgradeable
{
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    bytes32 public constant VAULT_ROLE = keccak256("VAULT_ROLE");

    uint256 public constant BPS_DENOMINATOR = 10000;
    uint256 public constant MAX_LEVERAGE = 50;
    uint256 public constant MIN_LEVERAGE = 1;
    uint256 public constant POSITION_FEE_BPS = 5; // 0.05% open/close fee
    uint256 public constant MAINTENANCE_MARGIN_BPS = 100; // 1.0% maintenance margin
    uint256 public constant LIQUIDATION_REWARD_BPS = 500; // 5% of collateral to liquidator
    uint256 public constant MIN_COLLATERAL = 1e16; // 0.01 native USDC (18 decimals)

    struct Position {
        address trader;
        string symbol;
        bool isLong;
        uint256 collateralUsdc;
        uint256 sizeUsdc; // Notional size = collateral * leverage
        uint256 entryPrice; // 8 decimals (e.g. 1.84e8 for $1.84, 94250e8 for $94,250)
        uint256 leverage;
        uint256 openedAt;
        uint256 lastUpdatedBlock;
    }

    /// @dev Kept for storage layout compatibility with the initial deployment.
    address public usdc;
    address public treasury;

    // LP Liquidity Pool State
    uint256 public totalPoolLiquidity;
    uint256 public totalLpShares;
    mapping(address => uint256) public lpShares;

    // Market Mark Prices (8 decimals, e.g. BTC = 9425000000000)
    mapping(string => uint256) public marketPrices;
    mapping(string => bool) public supportedMarkets;
    string[] public allMarketSymbols;

    // Active Positions: positionKey => Position
    mapping(bytes32 => Position) public positions;
    mapping(address => bytes32[]) public traderPositionKeys;

    // Global Open Interest
    mapping(string => uint256) public longOpenInterest;
    mapping(string => uint256) public shortOpenInterest;

    // Events
    event LiquidityDeposited(address indexed provider, uint256 usdcAmount, uint256 sharesMinted);
    event LiquidityWithdrawn(address indexed provider, uint256 sharesBurned, uint256 usdcReturned);
    event PositionOpened(
        bytes32 indexed positionKey,
        address indexed trader,
        string symbol,
        bool isLong,
        uint256 collateralUsdc,
        uint256 sizeUsdc,
        uint256 entryPrice,
        uint256 leverage,
        uint256 feePaid
    );
    event PositionClosed(
        bytes32 indexed positionKey,
        address indexed trader,
        string symbol,
        bool isLong,
        uint256 closePrice,
        int256 realizedPnl,
        uint256 payoutUsdc,
        uint256 feePaid
    );
    event PositionLiquidated(
        bytes32 indexed positionKey,
        address indexed trader,
        address indexed liquidator,
        string symbol,
        bool isLong,
        uint256 liquidationPrice,
        uint256 liquidatorReward
    );
    event PriceUpdated(string indexed symbol, uint256 price8Decimals, uint256 timestamp);
    event MarketAdded(string indexed symbol);
    event TreasuryUpdated(address indexed newTreasury);

    // Custom Errors
    error InvalidLeverage();
    error CollateralTooSmall();
    error PositionAlreadyExists();
    error PositionNotFound();
    error UnsupportedMarket();
    error InvalidPrice();
    error SlippageExceeded();
    error InsufficientPoolLiquidity();
    error PositionNotLiquidatable();
    error ZeroAddress();
    error InsufficientShares();
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
        _grantRole(KEEPER_ROLE, admin);
        _grantRole(VAULT_ROLE, admin);

        treasury = _treasury == address(0) ? admin : _treasury;

        // Register default perp markets with initial reference prices (8 decimals)
        _addMarket("ARC-PERP", 184000000); // $1.84
        _addMarket("BTC-PERP", 9425000000000); // $94,250.00
        _addMarket("ETH-PERP", 341250000000); // $3,412.50
        _addMarket("SOL-PERP", 18840000000); // $188.40
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    // ─────────────────────────────────────────────────────────────────────────────
    // Liquidity Pool (LP) Management
    // ─────────────────────────────────────────────────────────────────────────────

    function depositLiquidity(uint256 usdcAmount) external payable nonReentrant whenNotPaused returns (uint256 sharesMinted) {
        if (msg.value > 0) {
            usdcAmount = msg.value;
        }
        if (usdcAmount == 0) revert CollateralTooSmall();

        if (totalLpShares == 0 || totalPoolLiquidity == 0) {
            sharesMinted = usdcAmount;
        } else {
            sharesMinted = (usdcAmount * totalLpShares) / totalPoolLiquidity;
        }

        lpShares[msg.sender] += sharesMinted;
        totalLpShares += sharesMinted;
        totalPoolLiquidity += usdcAmount;

        emit LiquidityDeposited(msg.sender, usdcAmount, sharesMinted);
    }

    function withdrawLiquidity(uint256 sharesToBurn) external nonReentrant returns (uint256 usdcReturned) {
        if (sharesToBurn == 0 || lpShares[msg.sender] < sharesToBurn) revert InsufficientShares();

        usdcReturned = (sharesToBurn * totalPoolLiquidity) / totalLpShares;
        if (usdcReturned > address(this).balance) revert InsufficientPoolLiquidity();

        lpShares[msg.sender] -= sharesToBurn;
        totalLpShares -= sharesToBurn;
        totalPoolLiquidity -= usdcReturned;

        (bool sent, ) = payable(msg.sender).call{value: usdcReturned}("");
        if (!sent) revert NativeTransferFailed();

        emit LiquidityWithdrawn(msg.sender, sharesToBurn, usdcReturned);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Trading: Open / Close / Liquidate Positions
    // ─────────────────────────────────────────────────────────────────────────────

    function openPosition(
        string calldata symbol,
        bool isLong,
        uint256 collateralUsdc,
        uint256 leverage,
        uint256 acceptablePrice,
        uint256 currentMarkPrice
    ) external payable nonReentrant whenNotPaused returns (bytes32 positionKey) {
        if (msg.value > 0) {
            collateralUsdc = msg.value;
        }
        return _openPositionInternal(msg.sender, symbol, isLong, collateralUsdc, leverage, acceptablePrice, currentMarkPrice);
    }

    function openPositionFor(
        address onBehalfOf,
        string calldata symbol,
        bool isLong,
        uint256 collateralUsdc,
        uint256 leverage,
        uint256 acceptablePrice,
        uint256 currentMarkPrice
    ) external payable onlyRole(VAULT_ROLE) nonReentrant whenNotPaused returns (bytes32 positionKey) {
        if (msg.value > 0) {
            collateralUsdc = msg.value;
        }
        return _openPositionInternal(onBehalfOf, symbol, isLong, collateralUsdc, leverage, acceptablePrice, currentMarkPrice);
    }

    function _openPositionInternal(
        address trader,
        string memory symbol,
        bool isLong,
        uint256 collateralUsdc,
        uint256 leverage,
        uint256 acceptablePrice,
        uint256 currentMarkPrice
    ) internal returns (bytes32 positionKey) {
        if (!supportedMarkets[symbol]) revert UnsupportedMarket();
        if (leverage < MIN_LEVERAGE || leverage > MAX_LEVERAGE) revert InvalidLeverage();
        if (collateralUsdc < MIN_COLLATERAL) revert CollateralTooSmall();

        // Update mark price if keeper/oracle provided fresh valid price
        uint256 mark = currentMarkPrice > 0 ? currentMarkPrice : marketPrices[symbol];
        if (mark == 0) revert InvalidPrice();

        if (hasRole(ORACLE_ROLE, msg.sender) && currentMarkPrice > 0) {
            marketPrices[symbol] = currentMarkPrice;
            mark = currentMarkPrice;
        }

        // Slippage check
        if (acceptablePrice > 0) {
            if (isLong && mark > acceptablePrice) revert SlippageExceeded();
            if (!isLong && mark < acceptablePrice) revert SlippageExceeded();
        }

        positionKey = getPositionKey(trader, symbol, isLong);
        if (positions[positionKey].openedAt != 0) revert PositionAlreadyExists();

        uint256 fee = (collateralUsdc * leverage * POSITION_FEE_BPS) / BPS_DENOMINATOR;
        uint256 netCollateral = collateralUsdc > fee ? collateralUsdc - fee : collateralUsdc;
        uint256 sizeUsdc = netCollateral * leverage;

        // Verify pool capacity
        if (totalPoolLiquidity > 0 && sizeUsdc > totalPoolLiquidity * 10) {
            revert InsufficientPoolLiquidity();
        }

        positions[positionKey] = Position({
            trader: trader,
            symbol: symbol,
            isLong: isLong,
            collateralUsdc: netCollateral,
            sizeUsdc: sizeUsdc,
            entryPrice: mark,
            leverage: leverage,
            openedAt: block.timestamp,
            lastUpdatedBlock: block.number
        });

        traderPositionKeys[trader].push(positionKey);

        if (isLong) {
            longOpenInterest[symbol] += sizeUsdc;
        } else {
            shortOpenInterest[symbol] += sizeUsdc;
        }

        if (fee > 0 && treasury != address(0)) {
            (bool sentFee, ) = payable(treasury).call{value: fee}("");
            if (!sentFee) revert NativeTransferFailed();
        }

        emit PositionOpened(
            positionKey,
            trader,
            symbol,
            isLong,
            netCollateral,
            sizeUsdc,
            mark,
            leverage,
            fee
        );
    }

    function closePosition(
        string calldata symbol,
        bool isLong,
        uint256 acceptablePrice,
        uint256 currentMarkPrice
    ) external nonReentrant returns (int256 realizedPnl, uint256 payoutUsdc) {
        return _closePositionInternal(msg.sender, msg.sender, symbol, isLong, acceptablePrice, currentMarkPrice);
    }

    function closePositionFor(
        address onBehalfOf,
        string calldata symbol,
        bool isLong,
        uint256 acceptablePrice,
        uint256 currentMarkPrice
    ) external onlyRole(VAULT_ROLE) nonReentrant returns (int256 realizedPnl, uint256 payoutUsdc) {
        // Payout is sent to msg.sender (the vault router) to credit the agent's balance
        return _closePositionInternal(onBehalfOf, msg.sender, symbol, isLong, acceptablePrice, currentMarkPrice);
    }

    function _closePositionInternal(
        address trader,
        address payoutRecipient,
        string memory symbol,
        bool isLong,
        uint256 acceptablePrice,
        uint256 currentMarkPrice
    ) internal returns (int256 realizedPnl, uint256 payoutUsdc) {
        bytes32 positionKey = getPositionKey(trader, symbol, isLong);
        Position storage pos = positions[positionKey];
        if (pos.openedAt == 0) revert PositionNotFound();

        uint256 mark = currentMarkPrice > 0 ? currentMarkPrice : marketPrices[symbol];
        if (mark == 0) revert InvalidPrice();

        if (hasRole(ORACLE_ROLE, msg.sender) && currentMarkPrice > 0) {
            marketPrices[symbol] = currentMarkPrice;
            mark = currentMarkPrice;
        }

        // Slippage check
        if (acceptablePrice > 0) {
            if (isLong && mark < acceptablePrice) revert SlippageExceeded();
            if (!isLong && mark > acceptablePrice) revert SlippageExceeded();
        }

        // Compute PnL
        realizedPnl = _computePnl(pos.sizeUsdc, pos.entryPrice, mark, pos.isLong);
        uint256 fee = (pos.sizeUsdc * POSITION_FEE_BPS) / BPS_DENOMINATOR;

        int256 netPayout = int256(pos.collateralUsdc) + realizedPnl - int256(fee);
        if (netPayout > 0) {
            payoutUsdc = uint256(netPayout);
        } else {
            payoutUsdc = 0;
        }

        if (pos.isLong) {
            longOpenInterest[symbol] = longOpenInterest[symbol] >= pos.sizeUsdc
                ? longOpenInterest[symbol] - pos.sizeUsdc
                : 0;
        } else {
            shortOpenInterest[symbol] = shortOpenInterest[symbol] >= pos.sizeUsdc
                ? shortOpenInterest[symbol] - pos.sizeUsdc
                : 0;
        }

        // Pool balance adjustment
        if (realizedPnl > 0) {
            uint256 profit = uint256(realizedPnl);
            if (totalPoolLiquidity >= profit) {
                totalPoolLiquidity -= profit;
            }
        } else if (realizedPnl < 0) {
            uint256 loss = uint256(-realizedPnl);
            totalPoolLiquidity += loss;
        }

        delete positions[positionKey];
        _removeTraderKey(trader, positionKey);

        if (payoutUsdc > 0) {
            (bool sentPayout, ) = payable(payoutRecipient).call{value: payoutUsdc}("");
            if (!sentPayout) revert NativeTransferFailed();
        }
        if (fee > 0 && treasury != address(0)) {
            (bool sentFee, ) = payable(treasury).call{value: fee}("");
            if (!sentFee) revert NativeTransferFailed();
        }

        emit PositionClosed(positionKey, trader, symbol, isLong, mark, realizedPnl, payoutUsdc, fee);
    }

    function liquidatePosition(
        address trader,
        string calldata symbol,
        bool isLong,
        uint256 currentMarkPrice
    ) external nonReentrant returns (uint256 liquidatorReward) {
        bytes32 positionKey = getPositionKey(trader, symbol, isLong);
        Position storage pos = positions[positionKey];
        if (pos.openedAt == 0) revert PositionNotFound();

        uint256 mark = currentMarkPrice > 0 ? currentMarkPrice : marketPrices[symbol];
        if (mark == 0) revert InvalidPrice();

        int256 pnl = _computePnl(pos.sizeUsdc, pos.entryPrice, mark, pos.isLong);
        uint256 maintenanceMargin = (pos.sizeUsdc * MAINTENANCE_MARGIN_BPS) / BPS_DENOMINATOR;

        // Position is liquidatable if remaining equity <= maintenance margin
        if (int256(pos.collateralUsdc) + pnl > int256(maintenanceMargin)) {
            revert PositionNotLiquidatable();
        }

        liquidatorReward = (pos.collateralUsdc * LIQUIDATION_REWARD_BPS) / BPS_DENOMINATOR;
        uint256 poolRetention = pos.collateralUsdc > liquidatorReward ? pos.collateralUsdc - liquidatorReward : 0;
        totalPoolLiquidity += poolRetention;

        if (pos.isLong) {
            longOpenInterest[symbol] = longOpenInterest[symbol] >= pos.sizeUsdc
                ? longOpenInterest[symbol] - pos.sizeUsdc
                : 0;
        } else {
            shortOpenInterest[symbol] = shortOpenInterest[symbol] >= pos.sizeUsdc
                ? shortOpenInterest[symbol] - pos.sizeUsdc
                : 0;
        }

        delete positions[positionKey];
        _removeTraderKey(trader, positionKey);

        if (liquidatorReward > 0) {
            (bool sentReward, ) = payable(msg.sender).call{value: liquidatorReward}("");
            if (!sentReward) revert NativeTransferFailed();
        }

        emit PositionLiquidated(positionKey, trader, msg.sender, symbol, isLong, mark, liquidatorReward);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Oracles & Market Admin
    // ─────────────────────────────────────────────────────────────────────────────

    function setPrice(string calldata symbol, uint256 price8Decimals) external onlyRole(ORACLE_ROLE) {
        if (!supportedMarkets[symbol]) revert UnsupportedMarket();
        if (price8Decimals == 0) revert InvalidPrice();
        marketPrices[symbol] = price8Decimals;
        emit PriceUpdated(symbol, price8Decimals, block.timestamp);
    }

    function addMarket(string calldata symbol, uint256 initialPrice8Decimals) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _addMarket(symbol, initialPrice8Decimals);
    }

    function _addMarket(string memory symbol, uint256 initialPrice) internal {
        if (!supportedMarkets[symbol]) {
            supportedMarkets[symbol] = true;
            marketPrices[symbol] = initialPrice;
            allMarketSymbols.push(symbol);
            emit MarketAdded(symbol);
            emit PriceUpdated(symbol, initialPrice, block.timestamp);
        }
    }

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

    function getPositionKey(address trader, string memory symbol, bool isLong) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(trader, symbol, isLong));
    }

    function getPosition(address trader, string calldata symbol, bool isLong) external view returns (Position memory) {
        return positions[getPositionKey(trader, symbol, isLong)];
    }

    function getTraderPositions(address trader) external view returns (Position[] memory) {
        bytes32[] storage keys = traderPositionKeys[trader];
        uint256 count = 0;
        for (uint256 i = 0; i < keys.length; i++) {
            if (positions[keys[i]].openedAt != 0) {
                count++;
            }
        }

        Position[] memory result = new Position[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i < keys.length; i++) {
            if (positions[keys[i]].openedAt != 0) {
                result[idx] = positions[keys[i]];
                idx++;
            }
        }
        return result;
    }

    function getUnrealizedPnl(
        address trader,
        string calldata symbol,
        bool isLong,
        uint256 currentMarkPrice
    ) external view returns (int256 pnlUsdc, uint256 markPrice) {
        Position storage pos = positions[getPositionKey(trader, symbol, isLong)];
        if (pos.openedAt == 0) return (0, 0);

        markPrice = currentMarkPrice > 0 ? currentMarkPrice : marketPrices[symbol];
        pnlUsdc = _computePnl(pos.sizeUsdc, pos.entryPrice, markPrice, pos.isLong);
    }

    function getLiquidationPrice(
        uint256 entryPrice,
        uint256 leverage,
        bool isLong
    ) public pure returns (uint256) {
        if (leverage == 0) return 0;
        uint256 maxDropBps = (BPS_DENOMINATOR / leverage) * 90 / 100; // 90% of collateral buffer
        if (isLong) {
            uint256 drop = (entryPrice * maxDropBps) / BPS_DENOMINATOR;
            return entryPrice > drop ? entryPrice - drop : 0;
        } else {
            uint256 rise = (entryPrice * maxDropBps) / BPS_DENOMINATOR;
            return entryPrice + rise;
        }
    }

    function allMarketsCount() external view returns (uint256) {
        return allMarketSymbols.length;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Internal Math Helpers
    // ─────────────────────────────────────────────────────────────────────────────

    function _computePnl(
        uint256 sizeUsdc,
        uint256 entryPrice,
        uint256 markPrice,
        bool isLong
    ) internal pure returns (int256) {
        if (entryPrice == 0) return 0;
        if (isLong) {
            int256 priceDiff = int256(markPrice) - int256(entryPrice);
            return (int256(sizeUsdc) * priceDiff) / int256(entryPrice);
        } else {
            int256 priceDiff = int256(entryPrice) - int256(markPrice);
            return (int256(sizeUsdc) * priceDiff) / int256(entryPrice);
        }
    }

    function _removeTraderKey(address trader, bytes32 keyToRemove) internal {
        bytes32[] storage keys = traderPositionKeys[trader];
        for (uint256 i = 0; i < keys.length; i++) {
            if (keys[i] == keyToRemove) {
                keys[i] = keys[keys.length - 1];
                keys.pop();
                break;
            }
        }
    }

    receive() external payable {}
    fallback() external payable {}
}
