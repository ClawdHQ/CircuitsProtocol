// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Matches ClawdHQLaunchpad.sol's own local (minimal) IUniswapV2Router02 declaration for
/// `addLiquidity` exactly, byte-for-byte on that one function's signature, so a deployed
/// XeroRouter is drop-in ABI-compatible with what {ClawdHQLaunchpad-graduateLaunch} already
/// calls. Deliberately ERC20<->ERC20 only — no ETH-native functions, no WETH — since Arc
/// Testnet's native gas token is USDC itself, already a plain ERC20 everywhere in this app.
interface IXeroRouter02 {
    function factory() external view returns (address);

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

    function removeLiquidity(
        address tokenA,
        address tokenB,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB);

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    function swapTokensForExactTokens(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    /// @dev The one addition beyond Uniswap V2 Router02's literal add/remove-liquidity + plain
    /// swap surface — required because a graduated AgentToken charges a 2% fee on every
    /// transfer (see AgentToken.sol's `_update` override), which makes the plain
    /// `swapExactTokensForTokens` revert on every attempt to sell one (the pair receives less
    /// than the pre-computed nominal amount, failing its own `k`-invariant check). This is
    /// Uniswap V2's own well-known, standard pattern for fee-on-transfer tokens, not novel
    /// code — see XeroRouter's `_swapSupportingFeeOnTransferTokens`.
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;

    function quote(uint256 amountA, uint256 reserveA, uint256 reserveB) external pure returns (uint256 amountB);
    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) external pure returns (uint256 amountOut);
    function getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut) external pure returns (uint256 amountIn);
    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts);
    function getAmountsIn(uint256 amountOut, address[] calldata path) external view returns (uint256[] memory amounts);
}
