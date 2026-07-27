// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Test-only stand-in for Uniswap V2's Router02 — just enough of `addLiquidity` for
/// ClawdHQLaunchpad.graduateLaunch's tests to verify both tokens are actually pulled from the
/// launchpad and a real, transferable "LP token" is minted to `to` (BURN_ADDRESS in production),
/// without depending on a real Uniswap V2 deployment inside the Hardhat test network.
contract MockUniswapV2Router is ERC20 {
    using SafeERC20 for IERC20;

    constructor() ERC20("Mock UNI-V2 LP", "MOCK-UNI-V2") {}

    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256, /* amountAMin */
        uint256, /* amountBMin */
        address to,
        uint256 /* deadline */
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity) {
        IERC20(tokenA).safeTransferFrom(msg.sender, address(this), amountADesired);
        IERC20(tokenB).safeTransferFrom(msg.sender, address(this), amountBDesired);

        liquidity = amountADesired + amountBDesired; // arbitrary, deterministic stand-in for a real LP formula
        _mint(to, liquidity);

        return (amountADesired, amountBDesired, liquidity);
    }
}
