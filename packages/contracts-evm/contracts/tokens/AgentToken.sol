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
/// are unrestricted and a 2% fee applies, split 50/50 between burn and the
/// agent's treasury — matching ClawdHQLaunchpad's own TRADE_FEE_BPS rate, so the
/// fee doesn't drop the moment a token graduates to its DEX secondary market.
contract AgentToken is ERC20 {
    /// @notice The ClawdHQCore contract that deployed this token and controls the bonding curve.
    address public immutable launchpad;

    /// @notice Set once at graduation; receives 30% of every post-graduation transfer fee.
    address public agentTreasury;

    /// @notice Set once at graduation; receives 50% of every post-graduation transfer fee.
    address public protocolTreasury;

    /// @notice True once `graduateToken` has been called by the launchpad.
    bool public graduated;

    /// @notice Cumulative amount of tokens burned via the post-graduation transfer fee or a
    /// pre-graduation {ClawdHQLaunchpad-executeBuyback} call.
    uint256 public burnedSupply;

    /// @notice Post-graduation transfer fee, in basis points (2% = 200 bps).
    uint16 public constant TRANSFER_FEE_BPS = 200;

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
    /// transfers and designates the treasuries for future transfer fees (50% protocol, 30% agent, 20% burn).
    function graduateToken(address agentTreasury_, address protocolTreasury_) external onlyLaunchpad {
        if (graduated) revert AlreadyGraduated();
        graduated = true;
        agentTreasury = agentTreasury_;
        protocolTreasury = protocolTreasury_;
    }

    /// @notice Backward-compatible single-treasury graduation overload.
    function graduateToken(address agentTreasury_) external onlyLaunchpad {
        if (graduated) revert AlreadyGraduated();
        graduated = true;
        agentTreasury = agentTreasury_;
        protocolTreasury = agentTreasury_;
    }

    /// @notice Burns `amount` from the launchpad's own held (unsold) balance — the launchpad's
    /// pre-graduation buyback-and-burn mechanic (see ClawdHQLaunchpad's executeBuyback):
    /// tokens are "bought" from the curve exactly like a real buy (increasing tokensSold at the
    /// current market price) but burned instead of transferred to a buyer.
    function burnFromLaunchpad(uint256 amount) external onlyLaunchpad {
        _burn(launchpad, amount);
        burnedSupply += amount;
    }

    /// @dev Enforces the pre-graduation transfer lock and applies the post-graduation fee
    /// (50% protocol treasury, 30% agent treasury, 20% burn).
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

        uint256 protocolShare = (fee * 50) / 100;
        uint256 creatorShare = (fee * 30) / 100;
        uint256 burnShare = fee - protocolShare - creatorShare; // 20%
        uint256 netAmount = value - fee;

        super._update(from, to, netAmount);

        if (burnShare > 0) {
            super._update(from, address(0), burnShare);
            burnedSupply += burnShare;
        }

        if (protocolShare > 0) {
            address protoDest = protocolTreasury != address(0) ? protocolTreasury : agentTreasury;
            super._update(from, protoDest, protocolShare);
        }

        if (creatorShare > 0) {
            super._update(from, agentTreasury, creatorShare);
        }
    }
}
