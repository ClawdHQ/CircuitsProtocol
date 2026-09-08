// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {XeroERC20} from "./XeroERC20.sol";
import {IXeroFactory} from "./interfaces/IXeroFactory.sol";
import {IXeroCallee} from "./interfaces/IXeroCallee.sol";
import {UQ112x112} from "./libraries/UQ112x112.sol";

/// @title XeroPair
/// @notice Constant-product (x*y=k) AMM pool for one token pair, plus its own LP token — a
/// faithful port of Uniswap V2's UniswapV2Pair to Solidity 0.8.24. Deployed exclusively via
/// {XeroFactory-createPair}'s CREATE2 call (never directly), which is why the constructor
/// takes no arguments and `initialize` sets `token0`/`token1` separately right after deploy —
/// keeping the creation bytecode parameter-free is what makes the pair's address a pure
/// function of `(factory, token0, token1)`.
/// @dev Two intentional deviations from the canonical 0.5.16 source, both load-bearing:
/// (1) `MINIMUM_LIQUIDITY` is minted to `BURN_ADDRESS` (0x...dEaD) instead of literal
///     `address(0)` — OpenZeppelin v5's `ERC20._mint` reverts on a zero-address recipient
///     (`ERC20InvalidReceiver`), a safety check the original hand-rolled 0.5.16 mint didn't
///     have. Economically identical (permanently unspendable, dilutes future liquidity math
///     exactly the same way); only the destination address differs.
/// (2) All `require(cond, "string")` reverts become custom errors, matching this codebase's
///     own convention (see ClawdHQLaunchpad.sol) — same conditions, same control flow, just
///     cheaper and consistent with everything else here.
/// (3) Doesn't declare `is IXeroPair`: Solidity's strict 0.8.x override rules would require
///     boilerplate `override(ERC20, IXeroPair)` re-declarations for every plain-ERC20 function
///     the interface also lists (symbol, totalSupply, transfer, ...) purely to resolve an
///     inheritance-diamond ambiguity, not because behavior differs. `IXeroPair` remains the
///     type every other Xero contract (Router, Library, Factory) calls through — ABI dispatch
///     resolves by function selector, not by whether the concrete contract declares "is
///     IXeroPair", so this costs nothing at the call site.
contract XeroPair is XeroERC20 {
    using SafeERC20 for IERC20;
    using UQ112x112 for uint224;

    event Mint(address indexed sender, uint256 amount0, uint256 amount1);
    event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to);
    event Swap(
        address indexed sender,
        uint256 amount0In,
        uint256 amount1In,
        uint256 amount0Out,
        uint256 amount1Out,
        address indexed to
    );
    event Sync(uint112 reserve0, uint112 reserve1);

    uint256 public constant MINIMUM_LIQUIDITY = 1000;
    address private constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    address public immutable factory;

    address public token0;
    address public token1;

    uint112 private reserve0;
    uint112 private reserve1;
    uint32 private blockTimestampLast;

    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;
    /// @dev reserve0 * reserve1, as of the most recent liquidity event — only meaningful while
    /// the protocol fee (`factory.feeTo`) is turned on; used to compute the fee's mint amount.
    uint256 public kLast;

    uint256 private unlocked = 1;

    error Locked();
    error Forbidden();
    error Overflow();
    error InsufficientLiquidityMinted();
    error InsufficientLiquidityBurned();
    error InsufficientOutputAmount();
    error InsufficientLiquidity();
    error InvalidTo();
    error InsufficientInputAmount();
    error K();

    modifier lock() {
        if (unlocked != 1) revert Locked();
        unlocked = 0;
        _;
        unlocked = 1;
    }

    constructor() {
        factory = msg.sender;
    }

    /// @notice Called once by the factory immediately after CREATE2 deployment.
    function initialize(address _token0, address _token1) external {
        if (msg.sender != factory) revert Forbidden();
        token0 = _token0;
        token1 = _token1;
    }

    function getReserves() public view returns (uint112 _reserve0, uint112 _reserve1, uint32 _blockTimestampLast) {
        _reserve0 = reserve0;
        _reserve1 = reserve1;
        _blockTimestampLast = blockTimestampLast;
    }

    /// @dev Updates reserves and, on the first call in a new block, accumulates the TWAP price
    /// observations. `timeElapsed`'s subtraction and the accumulator `+=` are both intentionally
    /// `unchecked`: `blockTimestamp` is truncated to `uint32`, so both are designed to wrap
    /// around every ~136 years — under 0.8.x's default checked arithmetic this would revert
    /// instead of wrapping, breaking the TWAP the moment it naturally wraps. See
    /// XeroPair.test.ts's dedicated wraparound test.
    function _update(uint256 balance0, uint256 balance1, uint112 _reserve0, uint112 _reserve1) private {
        if (balance0 > type(uint112).max || balance1 > type(uint112).max) revert Overflow();
        uint32 blockTimestamp = uint32(block.timestamp % 2 ** 32);
        unchecked {
            uint32 timeElapsed = blockTimestamp - blockTimestampLast;
            if (timeElapsed > 0 && _reserve0 != 0 && _reserve1 != 0) {
                price0CumulativeLast += uint256(UQ112x112.encode(_reserve1).uqdiv(_reserve0)) * timeElapsed;
                price1CumulativeLast += uint256(UQ112x112.encode(_reserve0).uqdiv(_reserve1)) * timeElapsed;
            }
        }
        reserve0 = uint112(balance0);
        reserve1 = uint112(balance1);
        blockTimestampLast = blockTimestamp;
        emit Sync(reserve0, reserve1);
    }

    /// @dev If the protocol fee is on (`factory.feeTo() != address(0)`), mints LP tokens to
    /// `feeTo` worth 1/6th of the growth in `sqrt(k)` since the last liquidity event — the
    /// standard Uniswap V2 protocol-fee formula, unchanged.
    function _mintFee(uint112 _reserve0, uint112 _reserve1) private returns (bool feeOn) {
        address feeTo = IXeroFactory(factory).feeTo();
        feeOn = feeTo != address(0);
        uint256 _kLast = kLast;
        if (feeOn) {
            if (_kLast != 0) {
                uint256 rootK = Math.sqrt(uint256(_reserve0) * _reserve1);
                uint256 rootKLast = Math.sqrt(_kLast);
                if (rootK > rootKLast) {
                    uint256 numerator = totalSupply() * (rootK - rootKLast);
                    uint256 denominator = rootK * 5 + rootKLast;
                    uint256 liquidity = numerator / denominator;
                    if (liquidity > 0) _mint(feeTo, liquidity);
                }
            }
        } else if (_kLast != 0) {
            kLast = 0;
        }
    }

    /// @notice Mints LP tokens for whatever this pair's balance has grown by beyond its last-
    /// known reserves (i.e. whatever the caller already transferred in before calling this) —
    /// standard Uniswap V2 mint-after-transfer pattern, letting a Router batch the transfer and
    /// this call, or a direct integrator do the same.
    function mint(address to) external lock returns (uint256 liquidity) {
        (uint112 _reserve0, uint112 _reserve1,) = getReserves();
        uint256 balance0 = IERC20(token0).balanceOf(address(this));
        uint256 balance1 = IERC20(token1).balanceOf(address(this));
        uint256 amount0 = balance0 - _reserve0;
        uint256 amount1 = balance1 - _reserve1;

        bool feeOn = _mintFee(_reserve0, _reserve1);
        uint256 _totalSupply = totalSupply(); // read after _mintFee, which may itself mint
        if (_totalSupply == 0) {
            liquidity = Math.sqrt(amount0 * amount1) - MINIMUM_LIQUIDITY;
            _mint(BURN_ADDRESS, MINIMUM_LIQUIDITY);
        } else {
            liquidity = Math.min((amount0 * _totalSupply) / _reserve0, (amount1 * _totalSupply) / _reserve1);
        }
        if (liquidity == 0) revert InsufficientLiquidityMinted();
        _mint(to, liquidity);

        _update(balance0, balance1, _reserve0, _reserve1);
        if (feeOn) kLast = uint256(reserve0) * reserve1;
        emit Mint(msg.sender, amount0, amount1);
    }

    /// @notice Burns whatever LP-token balance this pair already holds (the caller must
    /// transfer it in before calling, same pattern as `mint`) and pays out the corresponding
    /// pro-rata share of both reserves.
    function burn(address to) external lock returns (uint256 amount0, uint256 amount1) {
        (uint112 _reserve0, uint112 _reserve1,) = getReserves();
        address _token0 = token0;
        address _token1 = token1;
        uint256 balance0 = IERC20(_token0).balanceOf(address(this));
        uint256 balance1 = IERC20(_token1).balanceOf(address(this));
        uint256 liquidity = balanceOf(address(this));

        bool feeOn = _mintFee(_reserve0, _reserve1);
        uint256 _totalSupply = totalSupply();
        amount0 = (liquidity * balance0) / _totalSupply;
        amount1 = (liquidity * balance1) / _totalSupply;
        if (amount0 == 0 || amount1 == 0) revert InsufficientLiquidityBurned();
        _burn(address(this), liquidity);
        IERC20(_token0).safeTransfer(to, amount0);
        IERC20(_token1).safeTransfer(to, amount1);
        balance0 = IERC20(_token0).balanceOf(address(this));
        balance1 = IERC20(_token1).balanceOf(address(this));

        _update(balance0, balance1, _reserve0, _reserve1);
        if (feeOn) kLast = uint256(reserve0) * reserve1;
        emit Burn(msg.sender, amount0, amount1, to);
    }

    /// @notice Swaps whatever's already been transferred in for `amount0Out`/`amount1Out` of
    /// the other token, enforcing the constant-product invariant net of the 0.3% fee (the
    /// `*1000 - amountIn*3` / `997` trick below) against the actual pre/post balance delta —
    /// not a pre-computed nominal amount. This is what makes {XeroRouter}'s fee-on-transfer-
    /// supporting swap path correct for a token like AgentToken that takes its own cut on
    /// transfer: this function only ever cares about what it actually received.
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external lock {
        if (amount0Out == 0 && amount1Out == 0) revert InsufficientOutputAmount();
        (uint112 _reserve0, uint112 _reserve1,) = getReserves();
        if (amount0Out >= _reserve0 || amount1Out >= _reserve1) revert InsufficientLiquidity();

        uint256 balance0;
        uint256 balance1;
        {
            address _token0 = token0;
            address _token1 = token1;
            if (to == _token0 || to == _token1) revert InvalidTo();
            if (amount0Out > 0) IERC20(_token0).safeTransfer(to, amount0Out);
            if (amount1Out > 0) IERC20(_token1).safeTransfer(to, amount1Out);
            if (data.length > 0) IXeroCallee(to).xeroCall(msg.sender, amount0Out, amount1Out, data);
            balance0 = IERC20(_token0).balanceOf(address(this));
            balance1 = IERC20(_token1).balanceOf(address(this));
        }
        uint256 amount0In = balance0 > _reserve0 - amount0Out ? balance0 - (_reserve0 - amount0Out) : 0;
        uint256 amount1In = balance1 > _reserve1 - amount1Out ? balance1 - (_reserve1 - amount1Out) : 0;
        if (amount0In == 0 && amount1In == 0) revert InsufficientInputAmount();
        {
            uint256 balance0Adjusted = balance0 * 1000 - amount0In * 3;
            uint256 balance1Adjusted = balance1 * 1000 - amount1In * 3;
            if (balance0Adjusted * balance1Adjusted < uint256(_reserve0) * _reserve1 * 1_000_000) revert K();
        }

        _update(balance0, balance1, _reserve0, _reserve1);
        emit Swap(msg.sender, amount0In, amount1In, amount0Out, amount1Out, to);
    }

    /// @notice Forces this pair's reserves to match its actual token balances, paying any
    /// excess to `to` — recovers from a direct transfer into the pair that bypassed mint/swap.
    function skim(address to) external lock {
        address _token0 = token0;
        address _token1 = token1;
        IERC20(_token0).safeTransfer(to, IERC20(_token0).balanceOf(address(this)) - reserve0);
        IERC20(_token1).safeTransfer(to, IERC20(_token1).balanceOf(address(this)) - reserve1);
    }

    /// @notice Forces this pair's reserves to match its actual token balances.
    function sync() external lock {
        _update(IERC20(token0).balanceOf(address(this)), IERC20(token1).balanceOf(address(this)), reserve0, reserve1);
    }
}
