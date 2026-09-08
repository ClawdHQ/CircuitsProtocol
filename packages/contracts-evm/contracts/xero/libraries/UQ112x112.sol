// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Uniswap V2's original fixed-point library for the TWAP price accumulators — a UQ112x112
/// value is a uint224 with 112 integer bits and 112 fractional bits. Ported unchanged: this is
/// pure bit-arithmetic with no version-specific overflow/underflow behavior to update for 0.8.x.
library UQ112x112 {
    uint224 constant Q112 = 2 ** 112;

    /// @dev Encodes a uint112 as a UQ112x112.
    function encode(uint112 y) internal pure returns (uint224 z) {
        z = uint224(y) * Q112; // never overflows
    }

    /// @dev Divides a UQ112x112 by a uint112, returning a UQ112x112.
    function uqdiv(uint224 x, uint112 y) internal pure returns (uint224 z) {
        z = x / uint224(y);
    }
}
