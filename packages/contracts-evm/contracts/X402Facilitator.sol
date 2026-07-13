// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title X402Facilitator
/// @notice Custodial allowance-pull facilitator for metered per-call agent payments (x402).
/// @dev Not a trustless x402 settlement layer — MockUSDC has no EIP-3009/permit, so there is no
/// signed-voucher path. A payer instead grants this contract a bounded, short-lived ERC20
/// allowance, and the single authorized `facilitator` signer (a server-custodied key — see
/// packages/custody-core/src/facilitatorPullPayment.ts) pulls a specific, already-agreed amount
/// on the payer's behalf. This moves double-pull/replay risk from "trust the server's
/// database" to "enforced on-chain": `idempotencyKey` is checked-and-marked atomically in the
/// same transaction as the transfer, not just recorded in an off-chain ledger afterward. It
/// does NOT remove the risk that a compromised facilitator key can authorize new pulls up to
/// whatever allowance a payer has outstanding — only real per-call signatures (which MockUSDC
/// can't support) remove that.
contract X402Facilitator is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    address public facilitator;
    bool public paused;

    mapping(bytes32 => bool) public usedIdempotencyKeys;

    event PaymentPulled(address indexed payer, address indexed recipient, uint256 amount, bytes32 indexed idempotencyKey);
    event FacilitatorUpdated(address indexed previousFacilitator, address indexed newFacilitator);
    event PausedSet(bool paused);

    error NotFacilitator();
    error FacilitatorPaused();
    error IdempotencyKeyAlreadyUsed();
    error ZeroAmount();
    error ZeroAddress();

    modifier onlyFacilitator() {
        if (msg.sender != facilitator) revert NotFacilitator();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert FacilitatorPaused();
        _;
    }

    constructor(address initialOwner, IERC20 usdc_, address initialFacilitator) Ownable(initialOwner) {
        if (initialFacilitator == address(0)) revert ZeroAddress();
        usdc = usdc_;
        facilitator = initialFacilitator;
    }

    /// @notice Pulls `amount` of USDC from `payer` to `recipient`, provided `payer` has already
    /// granted this contract a sufficient ERC20 allowance. Reverts (rather than silently
    /// no-op'ing) if `idempotencyKey` was already used, so a retried/duplicated call can never
    /// double-pull — callers should treat that revert as "already settled," not as a failure,
    /// and look up the original pull (see packages/custody-db's PaymentPull table).
    function pullPayment(address payer, address recipient, uint256 amount, bytes32 idempotencyKey)
        external
        onlyFacilitator
        whenNotPaused
        nonReentrant
    {
        if (amount == 0) revert ZeroAmount();
        if (payer == address(0) || recipient == address(0)) revert ZeroAddress();
        if (usedIdempotencyKeys[idempotencyKey]) revert IdempotencyKeyAlreadyUsed();

        usedIdempotencyKeys[idempotencyKey] = true;
        usdc.safeTransferFrom(payer, recipient, amount);

        emit PaymentPulled(payer, recipient, amount, idempotencyKey);
    }

    /// @notice Rotates the authorized facilitator signer — e.g. after a key-custody migration.
    function setFacilitator(address newFacilitator) external onlyOwner {
        if (newFacilitator == address(0)) revert ZeroAddress();
        emit FacilitatorUpdated(facilitator, newFacilitator);
        facilitator = newFacilitator;
    }

    /// @notice Kill switch — stops every new pull immediately. Already-used idempotency keys
    /// stay marked (there is nothing to undo), and payers' allowances are entirely unaffected —
    /// this only gates this contract's own ability to call transferFrom; it can never revoke an
    /// ERC20 allowance itself (a payer can always revoke by calling `approve(0)` directly).
    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }
}
