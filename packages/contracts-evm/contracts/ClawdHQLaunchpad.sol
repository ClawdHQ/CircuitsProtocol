// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {AgentToken} from "./tokens/AgentToken.sol";
import {IClawdHQCore} from "./interfaces/IClawdHQCore.sol";

/// @dev Same minimal-interface pattern as IClawdHQCore.sol — declares only what this contract
/// needs from AgentWalletRegistry.sol, matching its auto-generated public-mapping getter.
interface IAgentWalletRegistry {
    function agentWallet(uint256 agentId) external view returns (address);
}

/// @dev Minimal Uniswap V2 Router02 surface — only `addLiquidity`, which is all
/// {ClawdHQLaunchpad-graduateLaunch} needs. Signature is Uniswap V2's own stable,
/// unchanged-since-launch interface, not this project's own design.
interface IUniswapV2Router02 {
    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity);
}

/// @title ClawdHQLaunchpad
/// @notice Bonding-curve agent-token launchpad — split out of ClawdHQCore (which owns agent
/// identity and the job marketplace) into its own UUPS proxy, same reasoning that already put
/// the ownership exchange and the x402 facilitator in their own contracts: ClawdHQCore sits at
/// Solidity's EIP-170 24576-byte deployed-bytecode limit with no headroom for more logic. All
/// USDC amounts use USDC's native 6 decimals; all AgentToken amounts use the standard 18
/// decimals.
/// @dev Reads agent ownership from ClawdHQCore via {IClawdHQCore-agents} rather than holding
/// its own copy — Core remains the sole source of truth for who owns an agent.
///
/// Fair-launch tokenomics (v2 of this contract): 100% of TOTAL_AGENT_TOKEN_SUPPLY starts on the
/// curve — no creator pre-allocation. Every buy and sell pays TRADE_FEE_BPS, split 50/50 between
/// the creator (paid immediately, same {_payoutAddress} destination the old pre-allocation used)
/// and a per-launch buyback pool that anyone can spend via {executeBuyback} to repurchase-and-
/// burn from the curve at the current price — gated to once per the creator's own chosen
/// {BuybackInterval}, picked at {createLaunch} time and fixed for the life of the launch.
/// Graduation now actually migrates liquidity to a real DEX (see {graduateLaunch}) instead of
/// just flipping a flag.
///
/// Bonding curve (v3 of this contract): constant-product with a virtual USDC reserve — the same
/// family of mechanism Virtuals.io/pump.fun use, ported to this launchpad's USDC-denominated,
/// fixed-1B-supply shape. Each launch's price is the ratio of a virtual USDC reserve (which
/// starts at {AgentLaunch-initialVirtualUsdcReserve} and grows by every real USDC that flows in,
/// see {_virtualUsdcReserve}) to the real remaining token reserve (`totalSupply - tokensSold`).
/// The product of those two is a fixed invariant `k = initialVirtualUsdcReserve * totalSupply`,
/// computed from launch-time constants alone rather than stored — see {_tokensOutForBuy} and
/// {_usdcOutForSell}. This replaces the prior `basePrice + slope*x` linear curve, whose starting
/// price was a single raw-USDC-per-whole-token integer and so had a hard $1,000 minimum
/// achievable FDV (the smallest non-zero price, $0.000001/token, times the fixed 1B supply) — a
/// reserve *ratio* has no such floor, since both sides can be scaled arbitrarily fine. The old
/// `bondingBasePrice`/`bondingSlope` fields (struct) and `defaultBondingBasePrice`/
/// `defaultBondingSlope` (storage) are kept declared but unused post-upgrade, both to preserve
/// the UUPS storage layout and because a launch created before this upgrade (see
/// {migrateLaunchVirtualLiquidity}) still has them.
contract ClawdHQLaunchpad is Initializable, AccessControlUpgradeable, PausableUpgradeable, UUPSUpgradeable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============================================================ Roles ===

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    // ============================================================ Types ===

    /// @notice How often {executeBuyback} may run for a given launch — chosen once by the
    /// creator at {createLaunch} time, fixed for the launch's lifetime (not admin- or
    /// creator-adjustable afterward, so it can't be loosened/tightened to game holder
    /// expectations post-launch).
    enum BuybackInterval {
        DAILY,
        WEEKLY,
        MONTHLY,
        QUARTERLY
    }

    struct AgentLaunch {
        uint256 launchId;
        uint256 agentId;
        address token;
        string name;
        string symbol;
        address creator;
        uint256 totalSupply; // fixed 1_000_000_000e18
        uint256 usdcRaised; // current USDC reserve held against this launch (excludes fees)
        uint256 tokensSold; // 18-decimal token units sold via the curve (includes buyback-burned tokens)
        uint256 graduationThreshold; // USDC, 6 decimals
        /// @dev Deprecated — superseded by `initialVirtualUsdcReserve` (see the contract-level
        /// doc comment on the v3 constant-product curve). Always 0 for a launch created after
        /// this upgrade; kept declared, not deleted, for the same storage-layout reason
        /// `creatorAllocBps` below is.
        uint256 bondingBasePrice;
        /// @dev Deprecated — see `bondingBasePrice` just above.
        uint256 bondingSlope;
        uint64 createdAt;
        uint64 graduatedAt;
        /// @dev Until this timestamp, every buy pays ANTI_SNIPE_FEE_BPS instead of the normal
        /// TRADE_FEE_BPS (see {buyTokens}) — an economic deterrent, not a hard cap. Previously
        /// gated a hard per-wallet cap (ANTI_SNIPE_MAX_BPS, enforced via `launchBuyerPurchased`)
        /// that reverted `AntiSnipeLimitExceeded`; replaced because a flat percentage-of-supply
        /// cap interacts badly with the v3 curve's much shallower starting liquidity — a cap
        /// sized for the old $1M-FDV default could revert on a completely ordinary buy against a
        /// $4,000-FDV curve. A fee is scale-invariant: it costs a sniper more in *absolute* terms
        /// to buy a large chunk regardless of how shallow the curve happens to start.
        uint64 antiSnipeUntil;
        bool graduated;
        bool active;
        /// @dev Deprecated — creator pre-allocations were removed in favor of 100% fair launch
        /// (see the contract-level doc comment). Always written as 0 now; kept declared, not
        /// deleted, so the UUPS upgrade from the pre-fair-launch version doesn't reorder any
        /// trailing struct field's storage slot.
        uint16 creatorAllocBps;
        uint256 buybackPoolUsdc; // deprecated — buybacks now funded directly from Agent Operating Treasury
        BuybackInterval buybackInterval; // creator's choice at createLaunch time, or set via setBuybackConfig
        uint64 nextBuybackAt; // executeBuyback reverts (BuybackNotDue) before this timestamp
        /// @dev USDC (6dec), fixed at createLaunch time (or by {migrateLaunchVirtualLiquidity}
        /// for a pre-v3 launch). 0 means "not yet on the v3 curve" — {_virtualUsdcReserve} and
        /// {getCurrentPrice} would divide-by-zero/misbehave if ever read while this is 0, which
        /// is exactly what {migrateLaunchVirtualLiquidity} exists to prevent for old launches.
        uint256 initialVirtualUsdcReserve;
        /// @dev Appended field (upgrade-safe — see 05-upgrade-launchpad.ts) — the timestamp
        /// {buyTokens}/{sellTokens} enforce as a hard on-chain floor, not just an app-side UI
        /// countdown. Set at {createLaunch} time from the creator's optional `launchAt` param:
        /// `max(launchAt, block.timestamp)`, so a past/omitted value means "trading opens
        /// immediately," matching every launch created before this field existed (which all
        /// read back as 0 here — the zero value — and so are never gated by it, since
        /// `block.timestamp < 0` can never be true). {antiSnipeUntil} above is anchored to this
        /// value, not `createdAt`, so a scheduled launch's anti-snipe window starts when trading
        /// actually opens rather than potentially having already elapsed by then.
        uint64 tradingStartsAt;
        /// @dev Percentage of Agent Operating Treasury to use for periodic buybacks (in basis points, e.g. 2000 = 20%).
        uint16 buybackBps;
    }

    // ===================================================== Constants =====

    uint256 public constant TOTAL_AGENT_TOKEN_SUPPLY = 1_000_000_000e18;
    uint256 public constant TRADE_FEE_BPS = 200; // 2%, applied to both buys and sells
    uint256 public constant ANTI_SNIPE_WINDOW = 10 minutes;
    /// @dev Applied instead of TRADE_FEE_BPS to every buy while `block.timestamp <
    /// launch.antiSnipeUntil` — see the struct field's own doc comment for why this replaced a
    /// hard per-wallet cap. 10x the normal 2% rate; still split via {_distributeTradeFee} the
    /// same 50/50 way, so a sniper's extra fee disproportionately benefits the creator/buyback
    /// pool during exactly the window a snipe attempt is most likely.
    uint256 public constant ANTI_SNIPE_FEE_BPS = 2_000; // 20%
    uint256 public constant TOKEN_DECIMALS_FACTOR = 1e18;
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    // ======================================================== Storage =====

    IClawdHQCore public core;
    IERC20 public usdc;
    address public treasury;
    address public agentWalletRegistry;

    uint256 public launchFee; // USDC, 6 decimals
    /// @dev Deprecated — see the contract-level doc comment on the v3 constant-product curve.
    /// Unused by {createLaunch} post-upgrade; kept declared for storage-layout reasons.
    uint256 public defaultBondingBasePrice;
    /// @dev Deprecated — see `defaultBondingBasePrice` just above.
    uint256 public defaultBondingSlope;
    uint256 public defaultGraduationThreshold;

    uint256 public totalLaunches;
    uint256 public graduatedLaunches;

    uint256 private _nextLaunchId;

    mapping(uint256 => AgentLaunch) public launches;
    mapping(uint256 => uint256) public launchIdByAgentId;
    /// @dev Deprecated — tracked per-wallet cumulative buys for the old hard anti-snipe cap (see
    /// AgentLaunch.antiSnipeUntil's doc comment on why that was replaced with a fee instead).
    /// Unread post-upgrade; kept declared for storage-layout reasons.
    mapping(uint256 => mapping(address => uint256)) public launchBuyerPurchased;

    /// @notice Uniswap V2 Router02 used at graduation to migrate liquidity to a real DEX.
    /// address(0) means graduation isn't wired up on this chain yet — {graduateLaunch} reverts
    /// rather than silently skipping the DEX migration. Only Ethereum Sepolia has a verified
    /// official Uniswap V2 deployment among this app's supported testnets as of this writing
    /// (confirmed against developers.uniswap.org's own deployments list, then against the
    /// address's actual deployed bytecode) — Base Sepolia and Arc Testnet have none, so this
    /// stays unset (and graduation stays disabled) there until a real DEX is verified.
    address public uniswapV2Router;

    /// @notice Default starting virtual USDC reserve (6dec) for a new launch's v3
    /// constant-product curve — see the contract-level doc comment. Set post-upgrade via
    /// {setBondingParams}; 0 until then, which {createLaunch} would happily (and wrongly) accept
    /// — set this before the first post-upgrade {createLaunch} call on a given chain.
    uint256 public defaultInitialVirtualUsdcReserve;

    // ========================================================= Events =====

    event LaunchCreated(uint256 indexed launchId, uint256 indexed agentId, address indexed token, string name, string symbol);
    event TokensPurchased(uint256 indexed launchId, address indexed buyer, uint256 usdcIn, uint256 tokensOut);
    event TokensSold(uint256 indexed launchId, address indexed seller, uint256 tokensIn, uint256 usdcOut);
    event LaunchGraduated(uint256 indexed launchId, uint256 indexed agentId, address indexed token, uint256 usdcRaised, uint256 tokensSold);
    event BuybackExecuted(uint256 indexed launchId, uint256 usdcSpent, uint256 tokensBurned);
    event BuybackConfigUpdated(uint256 indexed launchId, BuybackInterval interval, uint16 buybackBps);

    event LaunchFeeUpdated(uint256 launchFee);
    event BondingParamsUpdated(uint256 initialVirtualUsdcReserve, uint256 graduationThreshold);
    event TreasuryUpdated(address treasury);
    event AgentWalletRegistryUpdated(address agentWalletRegistry);
    event UniswapV2RouterUpdated(address uniswapV2Router);
    event LaunchVirtualLiquidityMigrated(uint256 indexed launchId, uint256 initialVirtualUsdcReserve);
    event TradingStartedEarly(uint256 indexed launchId);

    // ========================================================= Errors =====

    error NotAgentOwner();
    error ZeroAmount();
    error AlreadyLaunched();
    error LaunchNotActive();
    error ThresholdNotMet();
    error AlreadyGraduated();
    error SlippageExceeded();
    error InsufficientTokensSold();
    error NoBuybackPool();
    error DexNotConfigured();
    error BuybackNotDue();
    error VirtualReserveNotConfigured();
    error AlreadyMigrated();
    error LaunchHasActivity();
    error LaunchNotStarted();
    error TradingAlreadyStarted();
    error BuybackDisabled();
    error AgentWalletNotProvisioned();
    error InvalidBuybackBps();
    error NoBuybackFunds();

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
        // Deprecated fields (see the contract-level doc comment) — left set only so a fresh
        // deploy's initial values are self-documenting; unread by createLaunch.
        defaultBondingBasePrice = 1_000;
        defaultBondingSlope = 1;
        defaultGraduationThreshold = 19_000e6; // 19,000 USDC
        // FDV at tokensSold=0 is exactly initialVirtualUsdcReserve (the totalSupply/1e18 factor
        // in price × totalSupply cancels out) — 4_000e6 is precisely $4,000, calibrated (not an
        // arbitrary round number) to land close to Virtuals.io/pump.fun's own real starting
        // valuation (~$4,200) while keeping the anti-snipe window usable: the maximum single buy
        // that stays under the 5%-of-supply anti-snipe cap is ~initialVirtualUsdcReserve*0.0526,
        // so $4,000 gives ~$210 of headroom for a normal-sized buy in the first 10 minutes — a
        // smaller reserve (e.g. the $400 first considered) makes the curve so shallow that even a
        // ~$21 buy already trips it. Also produces a real, non-trivial ~1.5x FDV run from launch
        // to the 900 USDC graduation threshold ((1 + 900/4000)^2), not just a flat line.
        defaultInitialVirtualUsdcReserve = 4_000e6; // $4,000

        _nextLaunchId = 1;
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    /// @dev Payout destination for an agent's trading-fee creator share: its
    /// AgentWalletRegistry-registered wallet, or its Core-registered owner if this agent's
    /// wallet hasn't been provisioned there yet. Mirrors ClawdHQCore's own `_payoutAddress`
    /// (used there for job payouts) exactly, reading ownership via {IClawdHQCore-agents}
    /// instead of a local mapping since agent identity lives on Core, not here.
    function _payoutAddress(uint256 agentId, address ownerFallback) private view returns (address) {
        address wallet = IAgentWalletRegistry(agentWalletRegistry).agentWallet(agentId);
        return wallet != address(0) ? wallet : ownerFallback;
    }

    /// @dev Fixed-seconds mapping for {BuybackInterval} — MONTHLY/QUARTERLY use the common
    /// 30-day/90-day on-chain approximation (exact calendar months aren't representable as a
    /// fixed second count), not a real calendar-month calculation.
    function _intervalSeconds(BuybackInterval interval) private pure returns (uint64) {
        if (interval == BuybackInterval.DAILY) return 1 days;
        if (interval == BuybackInterval.WEEKLY) return 7 days;
        if (interval == BuybackInterval.MONTHLY) return 30 days;
        return 90 days; // QUARTERLY
    }

    /// @dev Splits a trade fee:
    /// - 50% to protocol treasury (funds protocol operations)
    /// - 30% to human creator / owner
    /// - 20% to agent operating treasury (funds autonomous runtime fuel & buybacks)
    function _distributeTradeFee(AgentLaunch storage launch, uint256 fee) private {
        if (fee == 0) return;
        uint256 protocolShare = (fee * 50) / 100;
        uint256 creatorShare = (fee * 30) / 100;
        uint256 agentShare = fee - protocolShare - creatorShare; // 20%

        if (protocolShare > 0 && treasury != address(0)) {
            usdc.safeTransfer(treasury, protocolShare);
        }
        if (creatorShare > 0) {
            usdc.safeTransfer(launch.creator, creatorShare);
        }
        if (agentShare > 0) {
            address agentWallet = _payoutAddress(launch.agentId, launch.creator);
            usdc.safeTransfer(agentWallet, agentShare);
        }
    }

    // ============================================================ Launchpad

    function createLaunch(
        uint256 agentId,
        string calldata name,
        string calldata symbol,
        BuybackInterval buybackInterval,
        uint16 buybackBps,
        /// @dev Unix timestamp trading should open at; 0 or anything at/before block.timestamp
        /// means "immediately".
        uint64 launchAt
    ) public whenNotPaused nonReentrant returns (uint256 launchId, address token) {
        (, address ownerAddr) = core.agents(agentId);
        if (ownerAddr != msg.sender) revert NotAgentOwner();
        if (launchIdByAgentId[agentId] != 0) revert AlreadyLaunched();
        if (defaultInitialVirtualUsdcReserve == 0) revert VirtualReserveNotConfigured();
        if (buybackBps > 10_000) revert InvalidBuybackBps();

        if (launchFee > 0) {
            usdc.safeTransferFrom(msg.sender, treasury, launchFee);
        }

        AgentToken deployed = new AgentToken(name, symbol, TOTAL_AGENT_TOKEN_SUPPLY, address(this));
        token = address(deployed);

        uint64 tradingStartsAt = launchAt > block.timestamp ? launchAt : uint64(block.timestamp);
        uint16 finalBuybackBps = buybackBps > 0 ? buybackBps : 2000; // default 20%

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
            bondingBasePrice: 0, // deprecated — see the contract-level doc comment
            bondingSlope: 0, // deprecated — see the contract-level doc comment
            createdAt: uint64(block.timestamp),
            graduatedAt: 0,
            antiSnipeUntil: tradingStartsAt + uint64(ANTI_SNIPE_WINDOW),
            graduated: false,
            active: true,
            creatorAllocBps: 0,
            buybackPoolUsdc: 0,
            buybackInterval: buybackInterval,
            nextBuybackAt: tradingStartsAt + _intervalSeconds(buybackInterval),
            initialVirtualUsdcReserve: defaultInitialVirtualUsdcReserve,
            tradingStartsAt: tradingStartsAt,
            buybackBps: finalBuybackBps
        });
        launchIdByAgentId[agentId] = launchId;
        totalLaunches++;

        emit LaunchCreated(launchId, agentId, token, name, symbol);
        emit BuybackConfigUpdated(launchId, buybackInterval, finalBuybackBps);
    }

    /// @notice Allows the agent owner to adjust the periodic buyback cadence and treasury percentage at any time.
    function setBuybackConfig(
        uint256 launchId,
        BuybackInterval interval,
        uint16 buybackBps
    ) external whenNotPaused {
        AgentLaunch storage launch = launches[launchId];
        (, address ownerAddr) = core.agents(launch.agentId);
        if (ownerAddr != msg.sender && launch.creator != msg.sender) revert NotAgentOwner();
        if (buybackBps > 10_000) revert InvalidBuybackBps();

        launch.buybackInterval = interval;
        launch.buybackBps = buybackBps;

        emit BuybackConfigUpdated(launchId, interval, buybackBps);
    }

    function buyTokens(uint256 launchId, uint256 usdcAmount, uint256 minTokensOut) external whenNotPaused nonReentrant {
        AgentLaunch storage launch = launches[launchId];
        if (!launch.active || launch.graduated) revert LaunchNotActive();
        if (block.timestamp < launch.tradingStartsAt) revert LaunchNotStarted();
        if (usdcAmount == 0) revert ZeroAmount();

        // The anti-snipe fee deters outside bots front-running a public launch — it has nothing
        // to deter the creator's own buy from, so exempting them keeps their bootstrap purchase
        // fee-free.
        uint256 feeBps = msg.sender == launch.creator
            ? 0
            : block.timestamp < launch.antiSnipeUntil
            ? ANTI_SNIPE_FEE_BPS
            : TRADE_FEE_BPS;
        uint256 fee = (usdcAmount * feeBps) / 10_000;
        uint256 netUsdc = usdcAmount - fee;

        uint256 tokensOut = _tokensOutForBuy(launch, netUsdc);
        if (tokensOut < minTokensOut) revert SlippageExceeded();

        uint256 remainingTokens = launch.totalSupply - launch.tokensSold;
        if (tokensOut > remainingTokens) tokensOut = remainingTokens;

        launch.tokensSold += tokensOut;
        launch.usdcRaised += netUsdc;

        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);
        IERC20(launch.token).safeTransfer(msg.sender, tokensOut);
        _distributeTradeFee(launch, fee);

        emit TokensPurchased(launchId, msg.sender, usdcAmount, tokensOut);
    }

    function sellTokens(uint256 launchId, uint256 tokenAmount, uint256 minUsdcOut) external whenNotPaused nonReentrant {
        AgentLaunch storage launch = launches[launchId];
        if (!launch.active || launch.graduated) revert LaunchNotActive();
        if (block.timestamp < launch.tradingStartsAt) revert LaunchNotStarted();
        if (tokenAmount == 0) revert ZeroAmount();
        if (tokenAmount > launch.tokensSold) revert InsufficientTokensSold();

        (uint256 grossUsdcOut, uint256 netUsdcOut) = _usdcOutForSell(launch, tokenAmount);
        if (grossUsdcOut > launch.usdcRaised) {
            grossUsdcOut = launch.usdcRaised;
            uint256 fee = (grossUsdcOut * TRADE_FEE_BPS) / 10_000;
            netUsdcOut = grossUsdcOut - fee;
        }
        if (netUsdcOut < minUsdcOut) revert SlippageExceeded();

        launch.tokensSold -= tokenAmount;
        launch.usdcRaised -= grossUsdcOut;

        IERC20(launch.token).safeTransferFrom(msg.sender, address(this), tokenAmount);

        uint256 diff = grossUsdcOut - netUsdcOut;
        usdc.safeTransfer(msg.sender, netUsdcOut);
        _distributeTradeFee(launch, diff);

        emit TokensSold(launchId, msg.sender, tokenAmount, netUsdcOut);
    }

    /// @notice Lets the creator open trading before a scheduled `tradingStartsAt`.
    function startTradingNow(uint256 launchId) external whenNotPaused nonReentrant {
        AgentLaunch storage launch = launches[launchId];
        if (launch.creator != msg.sender) revert NotAgentOwner();
        if (!launch.active || launch.graduated) revert LaunchNotActive();
        if (block.timestamp >= launch.tradingStartsAt) revert TradingAlreadyStarted();

        launch.tradingStartsAt = uint64(block.timestamp);
        launch.antiSnipeUntil = uint64(block.timestamp) + uint64(ANTI_SNIPE_WINDOW);
        launch.nextBuybackAt = uint64(block.timestamp) + _intervalSeconds(launch.buybackInterval);

        emit TradingStartedEarly(launchId);
    }

    /// @notice Spends the owner-configured percentage of the agent's operating treasury to
    /// repurchase tokens from the curve at the current price and burn them permanently.
    /// Pulls `buybackAmount` USDC from the agent's smart custody wallet (which approves the Launchpad)
    /// or from caller if caller is the agent wallet.
    function executeBuyback(uint256 launchId) external whenNotPaused nonReentrant {
        AgentLaunch storage launch = launches[launchId];
        if (!launch.active || launch.graduated) revert LaunchNotActive();
        if (block.timestamp < launch.nextBuybackAt) revert BuybackNotDue();
        if (launch.buybackBps == 0) revert BuybackDisabled();

        address agentWallet = IAgentWalletRegistry(agentWalletRegistry).agentWallet(launch.agentId);
        if (agentWallet == address(0)) revert AgentWalletNotProvisioned();

        uint256 treasuryBalance = usdc.balanceOf(agentWallet);
        if (treasuryBalance == 0) revert NoBuybackFunds();

        uint256 buybackAmount = (treasuryBalance * launch.buybackBps) / 10_000;
        if (buybackAmount == 0) revert NoBuybackFunds();

        if (msg.sender == agentWallet) {
            usdc.safeTransferFrom(msg.sender, address(this), buybackAmount);
        } else {
            usdc.safeTransferFrom(agentWallet, address(this), buybackAmount);
        }

        uint256 tokensOut = _tokensOutForBuy(launch, buybackAmount);

        launch.tokensSold += tokensOut;
        launch.usdcRaised += buybackAmount;
        launch.nextBuybackAt = uint64(block.timestamp) + _intervalSeconds(launch.buybackInterval);

        AgentToken(launch.token).burnFromLaunchpad(tokensOut);

        emit BuybackExecuted(launchId, buybackAmount, tokensOut);
    }

    /// @notice Allows the agent wallet or keeper to execute a buyback with an explicit amount up to the treasury balance.
    function executeBuybackWithAmount(uint256 launchId, uint256 buybackAmount) external whenNotPaused nonReentrant {
        AgentLaunch storage launch = launches[launchId];
        if (!launch.active || launch.graduated) revert LaunchNotActive();
        if (block.timestamp < launch.nextBuybackAt) revert BuybackNotDue();
        if (buybackAmount == 0) revert ZeroAmount();

        usdc.safeTransferFrom(msg.sender, address(this), buybackAmount);

        uint256 tokensOut = _tokensOutForBuy(launch, buybackAmount);

        launch.tokensSold += tokensOut;
        launch.usdcRaised += buybackAmount;
        launch.nextBuybackAt = uint64(block.timestamp) + _intervalSeconds(launch.buybackInterval);

        AgentToken(launch.token).burnFromLaunchpad(tokensOut);

        emit BuybackExecuted(launchId, buybackAmount, tokensOut);
    }

    /// @notice Once a launch crosses its graduation threshold, migrates the raised USDC plus
    /// every unsold token into a real Uniswap V2 pool, then burns the LP tokens outright (sent
    /// straight to BURN_ADDRESS as `addLiquidity`'s recipient) — no one, including this
    /// contract's admin, can ever pull that liquidity back out, which is the whole point: it's
    /// what actually backs the token once it leaves the curve. Reverts if this chain has no
    /// uniswapV2Router configured rather than pretending to graduate without real liquidity.
    function graduateLaunch(uint256 launchId) external nonReentrant {
        AgentLaunch storage launch = launches[launchId];
        if (launch.graduated) revert AlreadyGraduated();
        if (launch.usdcRaised < launch.graduationThreshold) revert ThresholdNotMet();
        if (uniswapV2Router == address(0)) revert DexNotConfigured();

        launch.graduated = true;
        launch.active = false;
        launch.graduatedAt = uint64(block.timestamp);
        graduatedLaunches++;

        uint256 remainingTokens = launch.totalSupply - launch.tokensSold;
        uint256 usdcForLiquidity = launch.usdcRaised;

        if (remainingTokens > 0 && usdcForLiquidity > 0) {
            IERC20(launch.token).forceApprove(uniswapV2Router, remainingTokens);
            usdc.forceApprove(uniswapV2Router, usdcForLiquidity);

            IUniswapV2Router02(uniswapV2Router).addLiquidity(
                launch.token,
                address(usdc),
                remainingTokens,
                usdcForLiquidity,
                0, // amountAMin — a testnet launchpad; accept full slippage rather than risk graduation reverting
                0, // amountBMin
                BURN_ADDRESS,
                block.timestamp
            );
        }

        AgentToken(launch.token).graduateToken(_payoutAddress(launch.agentId, launch.creator), treasury);

        emit LaunchGraduated(launchId, launch.agentId, launch.token, launch.usdcRaised, launch.tokensSold);
    }

    /// @dev The v3 curve's evolving USDC-side reserve: the launch's fixed starting virtual
    /// amount plus every real net USDC the curve has actually taken in so far. This is the one
    /// number that blends "virtual" and "real" liquidity into a single evolving reserve — there
    /// is no separate real-only USDC reserve tracked for pricing purposes (usdcRaised itself
    /// remains the real-only figure everything outside pricing, e.g. the graduation gate and
    /// what's migrated to the DEX, is keyed on).
    function _virtualUsdcReserve(AgentLaunch storage launch) private view returns (uint256) {
        return launch.initialVirtualUsdcReserve + launch.usdcRaised;
    }

    /// @notice Best-effort convenience getter — USDC (6dec) *integer* per whole token, floors
    /// to 0 for any launch whose true price is below $0.000001/token (i.e. below $1,000 FDV on
    /// this launchpad's fixed 1B supply), since that's the smallest non-zero value this specific
    /// return type can represent. This is a real (if narrow) limitation of *this one view
    /// function* — it is not what the app's own UI relies on for display (see apps/web's
    /// bondingCurve.ts, which reads `initialVirtualUsdcReserve`/`usdcRaised`/`tokensSold`
    /// directly and computes price with far more precision than a single integer allows), and it
    /// is never used by {_tokensOutForBuy}/{_usdcOutForSell} — both solve the constant-product
    /// invariant directly and never round through a "price" at all, so trade execution has none
    /// of this function's precision ceiling.
    function getCurrentPrice(uint256 launchId) external view returns (uint256 priceUsdcPerWholeToken) {
        AgentLaunch storage launch = launches[launchId];
        uint256 realTokensWhole = (launch.totalSupply - launch.tokensSold) / TOKEN_DECIMALS_FACTOR;
        if (realTokensWhole == 0) return type(uint256).max;
        return _virtualUsdcReserve(launch) / realTokensWhole;
    }

    /// @dev Constant-product (x*y=k) buy-side solve. `k` is never stored — it's reconstructible
    /// at any point from launch-time constants alone (`initialVirtualUsdcReserve * totalSupply`),
    /// since the invariant never changes once a launch is created. Given `usdcAmount` flowing
    /// into the virtual USDC reserve, solves for how much must leave the real token reserve to
    /// hold `k` constant: `tokensOut = realTokens - k/(virtualUsdc + usdcAmount)`.
    function _tokensOutForBuy(AgentLaunch storage launch, uint256 usdcAmount) private view returns (uint256 tokensOut) {
        uint256 virtualUsdc = _virtualUsdcReserve(launch);
        uint256 realTokens = launch.totalSupply - launch.tokensSold;
        uint256 k = launch.initialVirtualUsdcReserve * launch.totalSupply;

        uint256 newRealTokens = k / (virtualUsdc + usdcAmount);
        tokensOut = realTokens - newRealTokens;
    }

    /// @dev The sell-side mirror of {_tokensOutForBuy}: given `tokenAmount` flowing back into
    /// the real token reserve, solves for how much must leave the virtual USDC reserve to hold
    /// the same fixed `k` constant. Returns both the gross curve value and the net amount after
    /// the protocol's `TRADE_FEE_BPS` sell fee.
    function _usdcOutForSell(AgentLaunch storage launch, uint256 tokenAmount) private view returns (uint256 grossUsdcOut, uint256 netUsdcOut) {
        uint256 virtualUsdc = _virtualUsdcReserve(launch);
        uint256 realTokens = launch.totalSupply - launch.tokensSold;
        uint256 k = launch.initialVirtualUsdcReserve * launch.totalSupply;

        uint256 newVirtualUsdc = k / (realTokens + tokenAmount);
        grossUsdcOut = virtualUsdc - newVirtualUsdc;
        uint256 fee = (grossUsdcOut * TRADE_FEE_BPS) / 10_000;
        netUsdcOut = grossUsdcOut - fee;
    }

    // ============================================================== Admin =

    function setLaunchFee(uint256 newFee) external onlyRole(DEFAULT_ADMIN_ROLE) {
        launchFee = newFee;
        emit LaunchFeeUpdated(newFee);
    }

    /// @notice Sets the defaults every new {createLaunch} call picks up: the starting virtual
    /// USDC reserve for its v3 constant-product curve, and the USDC-raised graduation gate.
    /// Neither retroactively affects an already-created launch — each captures its own copy of
    /// both at creation time (or via {migrateLaunchVirtualLiquidity} for one created before this
    /// upgrade).
    function setBondingParams(uint256 initialVirtualUsdcReserve, uint256 graduationThreshold) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(initialVirtualUsdcReserve > 0, "InvalidVirtualReserve");
        defaultInitialVirtualUsdcReserve = initialVirtualUsdcReserve;
        defaultGraduationThreshold = graduationThreshold;
        emit BondingParamsUpdated(initialVirtualUsdcReserve, graduationThreshold);
    }

    /// @notice One-time migration for a launch created before the v3 constant-product curve
    /// existed (i.e. `initialVirtualUsdcReserve == 0`) onto it. Restricted to a launch with zero
    /// real trading activity (`tokensSold == 0`): retroactively changing the curve shape under
    /// existing holders would be indistinguishable from a rug, so this only ever applies to a
    /// launch nobody has bought into yet — for anything else, the old linear-curve fields simply
    /// stay in place and unread (see the contract-level doc comment).
    function migrateLaunchVirtualLiquidity(uint256 launchId, uint256 initialVirtualUsdcReserve) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(initialVirtualUsdcReserve > 0, "InvalidVirtualReserve");
        AgentLaunch storage launch = launches[launchId];
        if (launch.initialVirtualUsdcReserve != 0) revert AlreadyMigrated();
        if (launch.tokensSold != 0) revert LaunchHasActivity();
        launch.initialVirtualUsdcReserve = initialVirtualUsdcReserve;
        emit LaunchVirtualLiquidityMigrated(launchId, initialVirtualUsdcReserve);
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

    /// @notice Points graduation at a real Uniswap V2 Router02 for this chain — leave unset
    /// (address(0)) on any chain without a verified official deployment; {graduateLaunch}
    /// reverts rather than migrating liquidity to an unverified contract.
    function setUniswapV2Router(address newRouter) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uniswapV2Router = newRouter;
        emit UniswapV2RouterUpdated(newRouter);
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
