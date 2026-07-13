// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {AgentToken} from "./tokens/AgentToken.sol";
import {IClawdHQCore} from "./interfaces/IClawdHQCore.sol";

/// @dev Same minimal-interface pattern as IClawdHQCore.sol — declares only what this contract
/// needs from AgentWalletRegistry.sol, matching its auto-generated public-mapping getter.
interface IAgentWalletRegistry {
    function agentWallet(uint256 agentId) external view returns (address);
}

/// @title ClawdHQLaunchpad
/// @notice Bonding-curve agent-token launchpad — split out of ClawdHQCore (which owns agent
/// identity and the job marketplace) into its own UUPS proxy, same reasoning that already put
/// the ownership exchange and the x402 facilitator in their own contracts: ClawdHQCore sits at
/// Solidity's EIP-170 24576-byte deployed-bytecode limit with no headroom for more logic. All
/// USDC amounts use USDC's native 6 decimals; all AgentToken amounts use the standard 18
/// decimals. Bonding-curve math operates on whole-token counts (i.e. `tokensSold / 1e18`) to
/// keep the quadratic buy-side solve numerically small and exact; see {_tokensOutForBuy} and
/// {_usdcOutForSell}.
/// @dev Reads agent ownership from ClawdHQCore via {IClawdHQCore-agents} rather than holding
/// its own copy — Core remains the sole source of truth for who owns an agent.
contract ClawdHQLaunchpad is Initializable, AccessControlUpgradeable, PausableUpgradeable, UUPSUpgradeable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============================================================ Roles ===

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    // ============================================================ Types ===

    struct AgentLaunch {
        uint256 launchId;
        uint256 agentId;
        address token;
        string name;
        string symbol;
        address creator;
        uint256 totalSupply; // fixed 1_000_000_000e18
        uint256 usdcRaised; // current USDC reserve held against this launch
        uint256 tokensSold; // 18-decimal token units sold via the curve
        uint256 graduationThreshold; // USDC, 6 decimals
        uint256 bondingBasePrice; // USDC (6dec) per whole token at tokensSold = 0
        uint256 bondingSlope; // USDC (6dec) increase per whole token sold
        uint64 createdAt;
        uint64 graduatedAt;
        uint64 antiSnipeUntil;
        bool graduated;
        bool active;
        uint16 creatorAllocBps;
    }

    // ===================================================== Constants =====

    uint256 public constant TOTAL_AGENT_TOKEN_SUPPLY = 1_000_000_000e18;
    uint256 public constant MAX_CREATOR_ALLOC_BPS = 2_000; // 20%
    uint256 public constant SELL_FEE_BPS = 200; // 2%
    uint256 public constant ANTI_SNIPE_WINDOW = 10 minutes;
    uint256 public constant ANTI_SNIPE_MAX_BPS = 500; // 5% of total supply per wallet
    uint256 public constant TOKEN_DECIMALS_FACTOR = 1e18;

    // ======================================================== Storage =====

    IClawdHQCore public core;
    IERC20 public usdc;
    address public treasury;
    address public agentWalletRegistry;

    uint256 public launchFee; // USDC, 6 decimals
    uint256 public defaultBondingBasePrice;
    uint256 public defaultBondingSlope;
    uint256 public defaultGraduationThreshold;

    uint256 public totalLaunches;
    uint256 public graduatedLaunches;

    uint256 private _nextLaunchId;

    mapping(uint256 => AgentLaunch) public launches;
    mapping(uint256 => uint256) public launchIdByAgentId;
    mapping(uint256 => mapping(address => uint256)) public launchBuyerPurchased; // anti-snipe tracking

    // ========================================================= Events =====

    event LaunchCreated(uint256 indexed launchId, uint256 indexed agentId, address indexed token, string name, string symbol);
    event TokensPurchased(uint256 indexed launchId, address indexed buyer, uint256 usdcIn, uint256 tokensOut);
    event TokensSold(uint256 indexed launchId, address indexed seller, uint256 tokensIn, uint256 usdcOut);
    event LaunchGraduated(uint256 indexed launchId, uint256 indexed agentId, address indexed token, uint256 usdcRaised, uint256 tokensSold);

    event LaunchFeeUpdated(uint256 launchFee);
    event BondingParamsUpdated(uint256 basePrice, uint256 slope, uint256 graduationThreshold);
    event TreasuryUpdated(address treasury);
    event AgentWalletRegistryUpdated(address agentWalletRegistry);

    // ========================================================= Errors =====

    error NotAgentOwner();
    error ZeroAmount();
    error ExcessiveCreatorAlloc();
    error AlreadyLaunched();
    error LaunchNotActive();
    error AntiSnipeLimitExceeded();
    error ThresholdNotMet();
    error AlreadyGraduated();
    error SlippageExceeded();
    error InsufficientTokensSold();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address admin,
        address coreAddress,
        address usdcAddress,
        address treasury_,
        address agentWalletRegistry_
    ) external initializer {
        __AccessControl_init();
        __Pausable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);

        core = IClawdHQCore(coreAddress);
        usdc = IERC20(usdcAddress);
        treasury = treasury_;
        agentWalletRegistry = agentWalletRegistry_;

        launchFee = 0; // testnet default, matches Core's convention
        defaultBondingBasePrice = 1_000; // 0.001 USDC per whole token at zero supply
        defaultBondingSlope = 1; // +0.000001 USDC per whole token sold
        defaultGraduationThreshold = 69_000e6; // 69,000 USDC

        _nextLaunchId = 1;
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    /// @dev Payout destination for an agent's launchpad creator allocation: its
    /// AgentWalletRegistry-registered wallet, or its Core-registered owner if this agent's
    /// wallet hasn't been provisioned there yet. Mirrors ClawdHQCore's own `_payoutAddress`
    /// (used there for job payouts) exactly, reading ownership via {IClawdHQCore-agents}
    /// instead of a local mapping since agent identity lives on Core, not here.
    function _payoutAddress(uint256 agentId, address ownerFallback) private view returns (address) {
        address wallet = IAgentWalletRegistry(agentWalletRegistry).agentWallet(agentId);
        return wallet != address(0) ? wallet : ownerFallback;
    }

    // ============================================================ Launchpad

    function createLaunch(
        uint256 agentId,
        string calldata name,
        string calldata symbol,
        uint16 creatorAllocBps
    ) external whenNotPaused nonReentrant returns (uint256 launchId, address token) {
        (, address ownerAddr) = core.agents(agentId);
        if (ownerAddr != msg.sender) revert NotAgentOwner();
        if (launchIdByAgentId[agentId] != 0) revert AlreadyLaunched();
        if (creatorAllocBps > MAX_CREATOR_ALLOC_BPS) revert ExcessiveCreatorAlloc();

        if (launchFee > 0) {
            usdc.safeTransferFrom(msg.sender, treasury, launchFee);
        }

        AgentToken deployed = new AgentToken(name, symbol, TOTAL_AGENT_TOKEN_SUPPLY, address(this));
        token = address(deployed);

        launchId = _nextLaunchId++;
        launches[launchId] = AgentLaunch({
            launchId: launchId,
            agentId: agentId,
            token: token,
            name: name,
            symbol: symbol,
            creator: msg.sender,
            totalSupply: TOTAL_AGENT_TOKEN_SUPPLY,
            usdcRaised: 0,
            tokensSold: 0,
            graduationThreshold: defaultGraduationThreshold,
            bondingBasePrice: defaultBondingBasePrice,
            bondingSlope: defaultBondingSlope,
            createdAt: uint64(block.timestamp),
            graduatedAt: 0,
            antiSnipeUntil: uint64(block.timestamp + ANTI_SNIPE_WINDOW),
            graduated: false,
            active: true,
            creatorAllocBps: creatorAllocBps
        });
        launchIdByAgentId[agentId] = launchId;
        totalLaunches++;

        if (creatorAllocBps > 0) {
            uint256 creatorAmount = (TOTAL_AGENT_TOKEN_SUPPLY * creatorAllocBps) / 10_000;
            // The agent's earnings, not necessarily the caller's directly.
            deployed.transfer(_payoutAddress(agentId, ownerAddr), creatorAmount);
        }

        emit LaunchCreated(launchId, agentId, token, name, symbol);
    }

    function buyTokens(uint256 launchId, uint256 usdcAmount, uint256 minTokensOut) external whenNotPaused nonReentrant {
        AgentLaunch storage launch = launches[launchId];
        if (!launch.active || launch.graduated) revert LaunchNotActive();
        if (usdcAmount == 0) revert ZeroAmount();

        uint256 tokensOut = _tokensOutForBuy(launch, usdcAmount);
        if (tokensOut < minTokensOut) revert SlippageExceeded();

        if (block.timestamp < launch.antiSnipeUntil) {
            uint256 maxPerWallet = (launch.totalSupply * ANTI_SNIPE_MAX_BPS) / 10_000;
            uint256 newTotal = launchBuyerPurchased[launchId][msg.sender] + tokensOut;
            if (newTotal > maxPerWallet) revert AntiSnipeLimitExceeded();
            launchBuyerPurchased[launchId][msg.sender] = newTotal;
        }

        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);
        AgentToken(launch.token).transfer(msg.sender, tokensOut);

        launch.tokensSold += tokensOut;
        launch.usdcRaised += usdcAmount;

        emit TokensPurchased(launchId, msg.sender, usdcAmount, tokensOut);
    }

    function sellTokens(uint256 launchId, uint256 tokenAmount, uint256 minUsdcOut) external whenNotPaused nonReentrant {
        AgentLaunch storage launch = launches[launchId];
        if (!launch.active || launch.graduated) revert LaunchNotActive();
        if (tokenAmount == 0 || tokenAmount % TOKEN_DECIMALS_FACTOR != 0) revert ZeroAmount();
        if (tokenAmount > launch.tokensSold) revert InsufficientTokensSold();

        (uint256 grossUsdcOut, uint256 netUsdcOut) = _usdcOutForSell(launch, tokenAmount);
        if (netUsdcOut < minUsdcOut) revert SlippageExceeded();

        AgentToken(launch.token).transferFrom(msg.sender, address(this), tokenAmount);

        launch.tokensSold -= tokenAmount;
        launch.usdcRaised -= grossUsdcOut;

        uint256 fee = grossUsdcOut - netUsdcOut;
        usdc.safeTransfer(msg.sender, netUsdcOut);
        if (fee > 0) {
            usdc.safeTransfer(treasury, fee);
        }

        emit TokensSold(launchId, msg.sender, tokenAmount, netUsdcOut);
    }

    function graduateLaunch(uint256 launchId) external nonReentrant {
        AgentLaunch storage launch = launches[launchId];
        if (launch.graduated) revert AlreadyGraduated();
        if (launch.usdcRaised < launch.graduationThreshold) revert ThresholdNotMet();

        launch.graduated = true;
        launch.active = false;
        launch.graduatedAt = uint64(block.timestamp);
        graduatedLaunches++;

        AgentToken(launch.token).graduateToken(launch.creator);

        emit LaunchGraduated(launchId, launch.agentId, launch.token, launch.usdcRaised, launch.tokensSold);
    }

    function getCurrentPrice(uint256 launchId) external view returns (uint256 priceUsdcPerWholeToken) {
        AgentLaunch storage launch = launches[launchId];
        uint256 tokensSoldWhole = launch.tokensSold / TOKEN_DECIMALS_FACTOR;
        return launch.bondingBasePrice + launch.bondingSlope * tokensSoldWhole;
    }

    /// @dev Solves the quadratic integral of the linear bonding curve
    /// `price(x) = basePrice + slope * x` (x = whole tokens sold) for the number of whole
    /// tokens `delta` purchasable with `usdcAmount`:
    ///   usdcAmount = basePrice*delta + slope*(2*soldWhole*delta + delta^2)/2
    /// Rearranged into standard form `(slope/2)*delta^2 + (basePrice + slope*soldWhole)*delta - usdcAmount = 0`
    /// and solved via the quadratic formula using integer sqrt.
    function _tokensOutForBuy(AgentLaunch storage launch, uint256 usdcAmount) private view returns (uint256 tokensOut) {
        uint256 soldWhole = launch.tokensSold / TOKEN_DECIMALS_FACTOR;
        uint256 slope = launch.bondingSlope;

        if (slope == 0) {
            uint256 flatDeltaWhole = usdcAmount / launch.bondingBasePrice;
            return flatDeltaWhole * TOKEN_DECIMALS_FACTOR;
        }

        uint256 b = launch.bondingBasePrice + slope * soldWhole;
        uint256 discriminant = b * b + 2 * slope * usdcAmount;
        uint256 sqrtDiscriminant = Math.sqrt(discriminant);
        uint256 deltaWhole = (sqrtDiscriminant - b) / slope;

        return deltaWhole * TOKEN_DECIMALS_FACTOR;
    }

    /// @dev Direct evaluation of the same integral for a known token amount being sold,
    /// from `soldWhole - delta` to `soldWhole`. Returns both the gross curve value and the
    /// net amount after the protocol's `SELL_FEE_BPS` sell fee.
    function _usdcOutForSell(AgentLaunch storage launch, uint256 tokenAmount) private view returns (uint256 grossUsdcOut, uint256 netUsdcOut) {
        uint256 soldWhole = launch.tokensSold / TOKEN_DECIMALS_FACTOR;
        uint256 deltaWhole = tokenAmount / TOKEN_DECIMALS_FACTOR;

        grossUsdcOut = launch.bondingBasePrice * deltaWhole + (launch.bondingSlope * (2 * soldWhole * deltaWhole - deltaWhole * deltaWhole)) / 2;
        uint256 fee = (grossUsdcOut * SELL_FEE_BPS) / 10_000;
        netUsdcOut = grossUsdcOut - fee;
    }

    // ============================================================== Admin =

    function setLaunchFee(uint256 newFee) external onlyRole(DEFAULT_ADMIN_ROLE) {
        launchFee = newFee;
        emit LaunchFeeUpdated(newFee);
    }

    function setBondingParams(uint256 basePrice, uint256 slope, uint256 graduationThreshold) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(basePrice > 0, "InvalidBasePrice");
        defaultBondingBasePrice = basePrice;
        defaultBondingSlope = slope;
        defaultGraduationThreshold = graduationThreshold;
        emit BondingParamsUpdated(basePrice, slope, graduationThreshold);
    }

    function setTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newTreasury != address(0), "ZeroAddress");
        treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    function setAgentWalletRegistry(address newRegistry) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newRegistry != address(0), "ZeroAddress");
        agentWalletRegistry = newRegistry;
        emit AgentWalletRegistryUpdated(newRegistry);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /// @notice Rescues ERC-20 tokens accidentally sent directly to this contract. Cannot be
    /// used to drain launch reserves since those are only ever held as part of `usdc`'s
    /// balance, tracked separately via `launches[].usdcRaised` — callers should verify
    /// off-chain that `amount` does not exceed the contract's "unaccounted" balance before
    /// calling.
    function withdrawStuckTokens(address token, uint256 amount, address to) external onlyRole(DEFAULT_ADMIN_ROLE) {
        IERC20(token).safeTransfer(to, amount);
    }
}
