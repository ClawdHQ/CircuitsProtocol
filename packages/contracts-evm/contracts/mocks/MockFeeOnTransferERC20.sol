// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Minimal fee-on-transfer ERC20 test double — burns a fixed bps fee on every
/// transfer, used to unit-test XeroRouter's
/// swapExactTokensForTokensSupportingFeeOnTransferTokens in isolation from AgentToken/
/// ClawdHQLaunchpad's own graduation wiring (see XeroGraduationIntegration.test.ts for that
/// real end-to-end wiring).
contract MockFeeOnTransferERC20 is ERC20 {
    uint16 public immutable feeBps;

    constructor(string memory name_, string memory symbol_, uint16 feeBps_) ERC20(name_, symbol_) {
        feeBps = feeBps_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0) || feeBps == 0) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = (value * feeBps) / 10_000;
        super._update(from, to, value - fee);
        if (fee > 0) super._update(from, address(0), fee);
    }
}
