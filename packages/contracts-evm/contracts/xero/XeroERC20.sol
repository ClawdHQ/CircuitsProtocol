// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title XeroERC20
/// @notice LP-token base for XeroPair — every Xero liquidity pool is itself a standard ERC20.
/// One name/symbol pair is shared across every pool (the pool's own address, not its LP-token
/// name, is what distinguishes one pair from another) — matches Uniswap V2's original
/// UniswapV2ERC20 design exactly.
/// @dev Deliberately no EIP-2612 `permit` support, unlike the original UniswapV2ERC20: pulling
/// in OpenZeppelin's `ERC20Permit`/`EIP712` transitively requires the `mcopy` opcode (Cancun
/// hardfork) in this installed OZ version, which would mean pinning this whole package's EVM
/// target to Cancun — a shared compiler-config change affecting every already-deployed
/// contract here, on a testnet (Arc) with unconfirmed Cancun-opcode support. Nothing else in
/// this codebase uses gasless-permit approvals (every existing flow does explicit
/// approve+transferFrom, e.g. the SDK's `ensureErc20Allowance`), so this isn't a real feature
/// loss — just scope matching the rest of the app's own conventions.
contract XeroERC20 is ERC20 {
    constructor() ERC20("Xero LP Token", "XERO-LP") {}
}
