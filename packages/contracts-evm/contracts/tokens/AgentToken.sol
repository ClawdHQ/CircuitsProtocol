// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title AgentToken
/// @notice Bonding-curve token for a single agent launch on ClawdHQ's launchpad.
/// @dev Not upgradeable — each launch deploys a fresh instance. The entire fixed
/// supply is minted to the launchpad (ClawdHQCore) at construction. Before
/// graduation, transfers are restricted to those where the launchpad is either
/// the sender or the recipient (i.e. buys and sells through the bonding curve);
/// peer-to-peer transfers are blocked to prevent an off-curve secondary market
/// from forming before the token graduates to a DEX. After graduation, transfers
/// are unrestricted and a 1% fee applies, split 50/50 between burn and the
/// agent's treasury.
contract AgentToken is ERC20 {
    /// @notice The ClawdHQCore contract that deployed this token and controls the bonding curve.
    address public immutable launchpad;

    /// @notice Set once at graduation; receives half of every post-graduation transfer fee.
    address public agentTreasury;

    /// @notice True once `graduateToken` has been called by the launchpad.
    bool public graduated;

    /// @notice Cumulative amount of tokens burned via the post-graduation transfer fee.
    uint256 public burnedSupply;

    /// @notice Post-graduation transfer fee, in basis points (1% = 100 bps).
    uint16 public constant TRANSFER_FEE_BPS = 100;

    error OnlyLaunchpad();
    error AlreadyGraduated();
    error TransfersLocked();

    modifier onlyLaunchpad() {
        if (msg.sender != launchpad) revert OnlyLaunchpad();
        _;
    }

    /// @param name_ ERC-20 name
    /// @param symbol_ ERC-20 symbol
    /// @param totalSupply_ Fixed total supply, minted entirely to `launchpad_`
    /// @param launchpad_ The ClawdHQCore contract address
    constructor(string memory name_, string memory symbol_, uint256 totalSupply_, address launchpad_) ERC20(name_, symbol_) {
        launchpad = launchpad_;
        _mint(launchpad_, totalSupply_);
    }

    /// @notice Called once by the launchpad when the bonding curve graduates. Unlocks
    /// transfers and designates the treasury that receives half of future transfer fees.
    function graduateToken(address agentTreasury_) external onlyLaunchpad {
        if (graduated) revert AlreadyGraduated();
        graduated = true;
        agentTreasury = agentTreasury_;
    }

    /// @dev Enforces the pre-graduation transfer lock and applies the post-graduation fee.
    function _update(address from, address to, uint256 value) internal override {
        // Minting (from == address(0)) and burning (to == address(0)) bypass the lock/fee logic.
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }

        if (!graduated) {
            if (from != launchpad && to != launchpad) revert TransfersLocked();
            super._update(from, to, value);
            return;
        }

        uint256 fee = (value * TRANSFER_FEE_BPS) / 10_000;
        if (fee == 0) {
            super._update(from, to, value);
            return;
        }

        uint256 halfFee = fee / 2;
        uint256 netAmount = value - fee;

        super._update(from, to, netAmount);
        super._update(from, address(0), halfFee);
        burnedSupply += halfFee;
        super._update(from, agentTreasury, fee - halfFee);
    }
}
