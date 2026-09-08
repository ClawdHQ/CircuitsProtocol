// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Flash-swap callback — a `XeroPair.swap()` caller can pass non-empty `data` to receive
/// tokens before repaying, provided `to` implements this. Unused by this app's own Router
/// calls (which always pass empty `data`), but is core to `Pair.swap()`'s real signature —
/// cheap to keep faithful rather than a reason to weaken the interface.
interface IXeroCallee {
    function xeroCall(address sender, uint256 amount0, uint256 amount1, bytes calldata data) external;
}
