// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IClawdHQCore} from "./interfaces/IClawdHQCore.sol";

/// @title ClawdHQNegotiation
/// @notice Fully on-chain Client/Provider negotiation — ACP's missing middle phase between
/// "post a job" and "escrow moves." Previously, an employer fixed price and scope unilaterally
/// at `postJob` time; a directed agent could only accept as-is, and an open job went to
/// whoever claimed it first at the posted price — no counter-offer, no mutual agreement
/// distinct from the on-chain job record itself. Here, a Client proposes terms, a Provider
/// (any agent owner, or a specific one the Client names) can counter or accept, and only once
/// both sides have converged on the *same* terms (`Agreed`) does {commit} create the real job
/// on ClawdHQCore — via {IClawdHQCore-postJobFromNegotiation}, which pulls USDC directly from
/// the Client's own wallet, so this contract never custodies job funds even transiently.
/// @dev Split into its own UUPS proxy for the same reason every other satellite already is —
/// ClawdHQCore has limited bytecode headroom and this is a self-contained concern.
/// @dev The on-chain sequence of `Countered`/`acceptTerms` transactions, from two known
/// addresses, agreeing to byte-identical terms, *is* this system's "Proof of Agreement" — there
/// is no separate off-chain signature to verify, unlike an EIP-712-based negotiation design.
contract ClawdHQNegotiation is Initializable, AccessControlUpgradeable, PausableUpgradeable, UUPSUpgradeable, ReentrancyGuard {
    // ============================================================ Roles ===

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    // ============================================================ Types ===

    enum NegotiationStatus {
        Proposed,
        Countered,
        Agreed,
        Committed,
        Withdrawn
    }

    struct Negotiation {
        address client;
        uint256 employerAgentId;
        /// @dev 0 = open to any Provider until the first counter-offer locks it in — mirrors
        /// ClawdHQCore's `hiredAgentId == 0` open-job convention.
        uint256 counterpartyAgentId;
        bytes32 taskHash;
        uint256 budget;
        /// @dev A *duration* (days), not an absolute timestamp — a negotiation can take
        /// unpredictable real time to reach agreement, so the actual deadline is computed as
        /// `block.timestamp + deadlineDays` only at {commit} time, not frozen at propose time.
        uint256 deadlineDays;
        bool lastProposerIsClient;
        NegotiationStatus status;
    }

    // ======================================================== Storage =====

    IClawdHQCore public core;
    mapping(uint256 => Negotiation) public negotiations;
    uint256 private _nextNegotiationId;

    // ========================================================= Events =====

    event JobProposed(uint256 indexed negotiationId, address indexed client, uint256 counterpartyAgentId, uint256 budget);
    event JobCountered(uint256 indexed negotiationId, address indexed counterer, uint256 counterpartyAgentId, uint256 budget);
    event TermsAgreed(uint256 indexed negotiationId);
    event NegotiationCommitted(uint256 indexed negotiationId, uint256 indexed jobId);
    event NegotiationWithdrawn(uint256 indexed negotiationId);

    // ========================================================= Errors =====

    error ZeroAmount();
    error InvalidNegotiationStatus();
    error NotClient();
    error NotCounterparty();
    error CounterpartyAlreadyLocked();
    error CannotCounterYourOwnOffer();
    error CannotAcceptYourOwnOffer();
    error NoCounterpartyEngagedYet();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin, address coreAddress) external initializer {
        __AccessControl_init();
        __Pausable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);

        core = IClawdHQCore(coreAddress);
        _nextNegotiationId = 1;
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    // ===================================================== Negotiating ====

    /// @notice Opens a negotiation. `counterpartyAgentId = 0` leaves it open to any Provider;
    /// a non-zero value names a specific target (who still must {counterOffer} or
    /// {acceptTerms} themselves — naming them here doesn't commit them to anything).
    function proposeJob(
        uint256 employerAgentId,
        uint256 counterpartyAgentId,
        bytes32 taskHash,
        uint256 budget,
        uint256 deadlineDays
    ) external whenNotPaused returns (uint256 negotiationId) {
        if (budget == 0) revert ZeroAmount();
        if (deadlineDays == 0) revert ZeroAmount();

        negotiationId = _nextNegotiationId++;
        negotiations[negotiationId] = Negotiation({
            client: msg.sender,
            employerAgentId: employerAgentId,
            counterpartyAgentId: counterpartyAgentId,
            taskHash: taskHash,
            budget: budget,
            deadlineDays: deadlineDays,
            lastProposerIsClient: true,
            status: NegotiationStatus.Proposed
        });

        emit JobProposed(negotiationId, msg.sender, counterpartyAgentId, budget);
    }

    /// @notice Mirrors ClawdHQCore's `totalJobs` convention — lets the UI do a bounded recent-
    /// id scan without needing an off-chain indexer, same as the Tasks marketplace already does.
    function totalNegotiations() external view returns (uint256) {
        return _nextNegotiationId - 1;
    }

    /// @notice Revises the current terms. The Client may counter their own still-open proposal
    /// only after a Provider has countered it back (alternation, enforced below); a Provider
    /// countering an *open* negotiation for the first time locks `counterpartyAgentId` to
    /// `providerAgentId` — every subsequent Provider-side call must come from that same agent's
    /// owner. `providerAgentId` is ignored once already locked (the locked id is what's
    /// checked), so callers may safely pass their own agent id on every call regardless of
    /// whether this is the first or a later counter.
    function counterOffer(
        uint256 negotiationId,
        uint256 providerAgentId,
        bytes32 taskHash,
        uint256 budget,
        uint256 deadlineDays
    ) external whenNotPaused {
        Negotiation storage n = negotiations[negotiationId];
        if (n.status != NegotiationStatus.Proposed && n.status != NegotiationStatus.Countered) revert InvalidNegotiationStatus();
        if (budget == 0) revert ZeroAmount();
        if (deadlineDays == 0) revert ZeroAmount();

        _applyCounter(n, providerAgentId, taskHash, budget, deadlineDays);

        emit JobCountered(negotiationId, msg.sender, n.counterpartyAgentId, budget);
    }

    function _applyCounter(
        Negotiation storage n,
        uint256 providerAgentId,
        bytes32 taskHash,
        uint256 budget,
        uint256 deadlineDays
    ) private {
        bool isClient = msg.sender == n.client;
        if (isClient) {
            // The Client can only counter after the Provider's most recent move — never twice
            // in a row.
            if (n.lastProposerIsClient) revert CannotCounterYourOwnOffer();
        } else {
            if (n.counterpartyAgentId == 0) {
                (, address owner) = core.agents(providerAgentId);
                if (owner != msg.sender) revert NotCounterparty();
                n.counterpartyAgentId = providerAgentId;
            } else {
                (, address owner) = core.agents(n.counterpartyAgentId);
                if (owner != msg.sender) revert NotCounterparty();
            }
            if (!n.lastProposerIsClient) revert CannotCounterYourOwnOffer();
        }

        n.taskHash = taskHash;
        n.budget = budget;
        n.deadlineDays = deadlineDays;
        n.lastProposerIsClient = isClient;
        n.status = NegotiationStatus.Countered;
    }

    /// @notice Accepts the current terms exactly as they stand — callable only by whichever
    /// side did *not* propose them most recently, and only once a Provider has actually engaged
    /// (an open, never-countered proposal has no counterparty to accept it into existence; the
    /// Provider must {counterOffer} at least once, even with identical terms, to lock in and
    /// then let the Client accept — see this contract's own doc comment on why).
    function acceptTerms(uint256 negotiationId) external whenNotPaused {
        Negotiation storage n = negotiations[negotiationId];
        if (n.status != NegotiationStatus.Proposed && n.status != NegotiationStatus.Countered) revert InvalidNegotiationStatus();
        if (n.counterpartyAgentId == 0) revert NoCounterpartyEngagedYet();

        if (msg.sender == n.client) {
            if (n.lastProposerIsClient) revert CannotAcceptYourOwnOffer();
        } else {
            (, address owner) = core.agents(n.counterpartyAgentId);
            if (owner != msg.sender) revert NotCounterparty();
            if (!n.lastProposerIsClient) revert CannotAcceptYourOwnOffer();
        }

        n.status = NegotiationStatus.Agreed;
        emit TermsAgreed(negotiationId);
    }

    /// @notice Client-only — creates the real job on ClawdHQCore via
    /// {IClawdHQCore-postJobFromNegotiation}, pulling USDC directly from the Client's own
    /// wallet (requires a prior USDC approval on Core, exactly like a normal {postJob} caller
    /// needs). The deadline is computed *now*, not frozen at propose time — see
    /// {Negotiation-deadlineDays}'s doc comment.
    function commit(uint256 negotiationId) external whenNotPaused nonReentrant returns (uint256 jobId) {
        Negotiation storage n = negotiations[negotiationId];
        if (n.status != NegotiationStatus.Agreed) revert InvalidNegotiationStatus();
        if (msg.sender != n.client) revert NotClient();

        n.status = NegotiationStatus.Committed;
        uint256 deadline = block.timestamp + (n.deadlineDays * 1 days);

        jobId = core.postJobFromNegotiation(n.client, n.employerAgentId, n.counterpartyAgentId, n.taskHash, n.budget, deadline);

        emit NegotiationCommitted(negotiationId, jobId);
    }

    /// @notice Either side may withdraw any time before {commit} — the Client, or (only once
    /// locked in) the Provider.
    function withdraw(uint256 negotiationId) external {
        Negotiation storage n = negotiations[negotiationId];
        if (
            n.status != NegotiationStatus.Proposed &&
            n.status != NegotiationStatus.Countered &&
            n.status != NegotiationStatus.Agreed
        ) revert InvalidNegotiationStatus();

        bool isClient = msg.sender == n.client;
        if (!isClient) {
            if (n.counterpartyAgentId == 0) revert NotCounterparty();
            (, address owner) = core.agents(n.counterpartyAgentId);
            if (owner != msg.sender) revert NotCounterparty();
        }

        n.status = NegotiationStatus.Withdrawn;
        emit NegotiationWithdrawn(negotiationId);
    }

    // ============================================================== Admin =

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }
}
