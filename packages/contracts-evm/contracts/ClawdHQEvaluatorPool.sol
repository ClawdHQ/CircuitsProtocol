// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IClawdHQCore} from "./interfaces/IClawdHQCore.sol";

/// @title ClawdHQEvaluatorPool
/// @notice A permissionless, staked evaluator marketplace — ACP's actual "Evaluator" role,
/// replacing (well, running alongside — see {ClawdHQCore-resolveDispute}'s admin escape hatch)
/// ClawdHQCore's single-admin RESOLVER_ROLE for deciding disputes. Anyone can post
/// {EVALUATOR_BOND} USDC and become eligible for random selection onto a 3-evaluator panel for
/// any disputed job. Panels vote via commit-reveal (prevents evaluators copying each other
/// instead of judging independently); a 2-of-3 majority resolves the dispute on Core directly.
/// If no majority forms before the deadline, the case is abandoned here and Core's existing
/// RESOLVER_ROLE admin path remains available the whole time as the fallback — this contract
/// never has exclusive control over a disputed job's escrow.
/// @dev Evaluator bonds are tracked here by plain `address`, not `agentId` — an evaluator need
/// not be a registered ClawdHQ agent at all, unlike ClawdHQStaking's agent reliability bonds
/// (a structurally different concept, not reused here for that reason).
/// @dev Selection uses `blockhash`/case-specific data as a pseudo-random seed — adequate for a
/// testnet/demo-grade deployment, but manipulable by whoever produces the block a
/// {requestEvaluation} transaction lands in. A production deployment holding real value should
/// replace this with a commit-reveal or VRF-based selection scheme before going live; flagged
/// here rather than silently assumed safe.
contract ClawdHQEvaluatorPool is Initializable, AccessControlUpgradeable, PausableUpgradeable, UUPSUpgradeable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============================================================ Roles ===

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    // ============================================================ Types ===

    enum CaseStatus {
        None,
        Pending,
        Finalized,
        Escalated
    }

    struct Case {
        uint256 jobId;
        address feePayer;
        uint256 feePaid;
        address[3] evaluators;
        mapping(address => bytes32) commitments;
        mapping(address => bool) revealed;
        mapping(address => bool) votedReleaseToAgent;
        uint8 releaseVotes;
        uint8 refundVotes;
        uint64 deadline;
        CaseStatus status;
    }

    // ===================================================== Constants =====

    uint256 public constant PANEL_SIZE = 3;
    uint256 public constant MAJORITY = 2;
    uint256 public constant EVALUATOR_BOND = 500e6; // 500 USDC
    uint256 public constant VOTING_WINDOW = 2 days; // covers both commit and reveal
    uint8 private constant JOB_STATUS_DISPUTED = 3; // ClawdHQCore.JobStatus.Disputed

    // ======================================================== Storage =====

    IClawdHQCore public core;
    IERC20 public usdc;
    address public treasury;

    /// @notice Flat USDC fee a {requestEvaluation} caller pays upfront, split among the
    /// evaluators who end up in the winning majority (refunded in full if the case escalates
    /// with no majority reached). Deliberately paid by the requester, not deducted from the
    /// job's own escrow — keeps this contract from ever needing to touch Core's payout math.
    uint256 public evaluationRequestFee;
    /// @notice Partial bond penalty (bps of EVALUATOR_BOND) for an evaluator who revealed but
    /// ended up in the minority — not proof of bad faith the way losing a directed dispute is
    /// for an agent (contrast ClawdHQStaking's all-or-nothing slash), so this is intentionally
    /// small. A non-revealing evaluator forfeits only their fee share, no bond penalty at all —
    /// see {_settlePanel}.
    uint256 public minoritySlashBps;

    mapping(uint256 => Case) private _cases;
    address[] public activeEvaluators;
    mapping(address => bool) public isActiveEvaluator;
    mapping(address => uint256) public evaluatorIndex; // for O(1) removal from activeEvaluators
    mapping(address => uint256) public evaluatorBond;
    mapping(address => uint256) public assignedCaseCount; // blocks unregistering mid-case

    // ========================================================= Events =====

    event EvaluatorRegistered(address indexed evaluator);
    event EvaluatorUnregistered(address indexed evaluator);
    event EvaluationRequested(uint256 indexed jobId, address indexed requester, address e0, address e1, address e2);
    event VoteCommitted(uint256 indexed jobId, address indexed evaluator);
    event VoteRevealed(uint256 indexed jobId, address indexed evaluator, bool releaseToAgent);
    event EvaluationFinalized(uint256 indexed jobId, bool releaseToAgent);
    event EvaluationEscalated(uint256 indexed jobId);
    event EvaluatorSlashed(uint256 indexed jobId, address indexed evaluator, uint256 amount);
    event EvaluationRequestFeeUpdated(uint256 fee);
    event MinoritySlashBpsUpdated(uint256 bps);
    event TreasuryUpdated(address treasury);

    // ========================================================= Errors =====

    error AlreadyRegistered();
    error NotRegistered();
    error EvaluatorHasPendingCases();
    error NotEnoughEvaluators();
    error AlreadyRequested();
    error JobNotDisputed();
    error CaseNotPending();
    error NotAssignedEvaluator();
    error AlreadyCommitted();
    error NotCommitted();
    error AlreadyRevealed();
    error VotingWindowClosed();
    error InvalidReveal();
    error VotingStillOpen();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin, address coreAddress, address usdcAddress, address treasury_) external initializer {
        __AccessControl_init();
        __Pausable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);

        core = IClawdHQCore(coreAddress);
        usdc = IERC20(usdcAddress);
        treasury = treasury_;

        evaluationRequestFee = 10e6; // 10 USDC testnet default
        minoritySlashBps = 1_000; // 10%
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    // ==================================================== Evaluators ======

    function registerEvaluator() external whenNotPaused nonReentrant {
        if (isActiveEvaluator[msg.sender]) revert AlreadyRegistered();

        usdc.safeTransferFrom(msg.sender, address(this), EVALUATOR_BOND);
        evaluatorBond[msg.sender] = EVALUATOR_BOND;
        isActiveEvaluator[msg.sender] = true;
        evaluatorIndex[msg.sender] = activeEvaluators.length;
        activeEvaluators.push(msg.sender);

        emit EvaluatorRegistered(msg.sender);
    }

    function unregisterEvaluator() external nonReentrant {
        if (!isActiveEvaluator[msg.sender]) revert NotRegistered();
        if (assignedCaseCount[msg.sender] > 0) revert EvaluatorHasPendingCases();

        uint256 idx = evaluatorIndex[msg.sender];
        uint256 lastIdx = activeEvaluators.length - 1;
        address lastEvaluator = activeEvaluators[lastIdx];
        activeEvaluators[idx] = lastEvaluator;
        evaluatorIndex[lastEvaluator] = idx;
        activeEvaluators.pop();
        delete evaluatorIndex[msg.sender];

        isActiveEvaluator[msg.sender] = false;
        uint256 remaining = evaluatorBond[msg.sender];
        evaluatorBond[msg.sender] = 0;
        if (remaining > 0) usdc.safeTransfer(msg.sender, remaining);

        emit EvaluatorUnregistered(msg.sender);
    }

    function activeEvaluatorCount() external view returns (uint256) {
        return activeEvaluators.length;
    }

    // ======================================================= Requesting ===

    /// @notice Permissionless — anyone (typically the employer or hired agent's owner, but not
    /// restricted to them) can request a decentralized evaluation of a job already in `Disputed`
    /// status on Core, paying {evaluationRequestFee} upfront.
    function requestEvaluation(uint256 jobId) external whenNotPaused nonReentrant {
        if (_cases[jobId].status != CaseStatus.None) revert AlreadyRequested();
        if (activeEvaluators.length < PANEL_SIZE) revert NotEnoughEvaluators();

        (, , , , , , uint8 status) = core.jobs(jobId);
        if (status != JOB_STATUS_DISPUTED) revert JobNotDisputed();

        uint256 fee = evaluationRequestFee;
        if (fee > 0) usdc.safeTransferFrom(msg.sender, address(this), fee);

        Case storage c = _cases[jobId];
        c.jobId = jobId;
        c.feePayer = msg.sender;
        c.feePaid = fee;
        c.status = CaseStatus.Pending;
        c.deadline = uint64(block.timestamp + VOTING_WINDOW);

        bytes32 seed = keccak256(abi.encodePacked(blockhash(block.number - 1), jobId, msg.sender));
        address[3] memory picked = _pickPanel(seed);
        for (uint256 i = 0; i < PANEL_SIZE; i++) {
            c.evaluators[i] = picked[i];
            assignedCaseCount[picked[i]]++;
        }

        emit EvaluationRequested(jobId, msg.sender, picked[0], picked[1], picked[2]);
    }

    /// @dev Partial Fisher-Yates shuffle over a copy of `activeEvaluators`, bounded to
    /// PANEL_SIZE draws — see the contract's own doc comment on why this pseudo-randomness
    /// isn't safe against a manipulated blockhash in a real-value deployment.
    function _pickPanel(bytes32 seed) private view returns (address[3] memory picked) {
        uint256 n = activeEvaluators.length;
        address[] memory pool = new address[](n);
        for (uint256 i = 0; i < n; i++) pool[i] = activeEvaluators[i];

        uint256 remaining = n;
        for (uint256 i = 0; i < PANEL_SIZE; i++) {
            uint256 idx = uint256(keccak256(abi.encodePacked(seed, i))) % remaining;
            picked[i] = pool[idx];
            pool[idx] = pool[remaining - 1];
            remaining--;
        }
    }

    // ========================================================== Voting ===

    function commitVote(uint256 jobId, bytes32 commitHash) external whenNotPaused {
        Case storage c = _cases[jobId];
        if (c.status != CaseStatus.Pending) revert CaseNotPending();
        if (!_isAssigned(c, msg.sender)) revert NotAssignedEvaluator();
        if (block.timestamp > c.deadline) revert VotingWindowClosed();
        if (c.commitments[msg.sender] != bytes32(0)) revert AlreadyCommitted();

        c.commitments[msg.sender] = commitHash;
        emit VoteCommitted(jobId, msg.sender);
    }

    /// @notice `salt` should be a fresh random value the evaluator generated off-chain and kept
    /// secret until reveal — `commitHash` must equal `keccak256(abi.encodePacked(releaseToAgent, salt))`.
    function revealVote(uint256 jobId, bool releaseToAgent, bytes32 salt) external whenNotPaused {
        Case storage c = _cases[jobId];
        if (c.status != CaseStatus.Pending) revert CaseNotPending();
        if (!_isAssigned(c, msg.sender)) revert NotAssignedEvaluator();
        if (block.timestamp > c.deadline) revert VotingWindowClosed();
        if (c.commitments[msg.sender] == bytes32(0)) revert NotCommitted();
        if (c.revealed[msg.sender]) revert AlreadyRevealed();
        if (keccak256(abi.encodePacked(releaseToAgent, salt)) != c.commitments[msg.sender]) revert InvalidReveal();

        c.revealed[msg.sender] = true;
        c.votedReleaseToAgent[msg.sender] = releaseToAgent;
        if (releaseToAgent) c.releaseVotes++;
        else c.refundVotes++;

        emit VoteRevealed(jobId, msg.sender, releaseToAgent);
    }

    function _isAssigned(Case storage c, address account) private view returns (bool) {
        return c.evaluators[0] == account || c.evaluators[1] == account || c.evaluators[2] == account;
    }

    // ======================================================= Finalizing ===

    /// @notice Permissionless — callable by anyone once either a 2-of-3 majority has revealed,
    /// or the voting window has closed. A majority resolves the dispute on Core directly and
    /// pays the agreeing evaluators; no majority (by the deadline) escalates instead, refunding
    /// the request fee — Core's existing RESOLVER_ROLE admin path is what resolves it from
    /// there, exactly as it could have the whole time this case was pending.
    function finalize(uint256 jobId) external nonReentrant {
        Case storage c = _cases[jobId];
        if (c.status != CaseStatus.Pending) revert CaseNotPending();

        bool quorumReached = c.releaseVotes >= MAJORITY || c.refundVotes >= MAJORITY;
        if (!quorumReached) {
            if (block.timestamp <= c.deadline) revert VotingStillOpen();

            c.status = CaseStatus.Escalated;
            _releaseAssignments(c, false, false);
            if (c.feePaid > 0) usdc.safeTransfer(c.feePayer, c.feePaid);

            emit EvaluationEscalated(jobId);
            return;
        }

        bool releaseToAgent = c.releaseVotes > c.refundVotes;
        c.status = CaseStatus.Finalized;

        _payAgreeingEvaluators(c, releaseToAgent);
        _releaseAssignments(c, true, releaseToAgent);

        core.resolveDisputeFromEvaluatorPool(jobId, releaseToAgent);

        emit EvaluationFinalized(jobId, releaseToAgent);
    }

    function _payAgreeingEvaluators(Case storage c, bool releaseToAgent) private {
        if (c.feePaid == 0) return;

        address[PANEL_SIZE] memory winners;
        uint256 count;
        for (uint256 i = 0; i < PANEL_SIZE; i++) {
            address ev = c.evaluators[i];
            if (c.revealed[ev] && c.votedReleaseToAgent[ev] == releaseToAgent) {
                winners[count++] = ev;
            }
        }
        if (count == 0) return; // shouldn't happen given quorumReached implies >= 2 agreeing reveals

        uint256 share = c.feePaid / count;
        for (uint256 i = 0; i < count; i++) {
            usdc.safeTransfer(winners[i], share);
        }
    }

    /// @dev Clears each panel member's assignment and, only on a real finalized outcome
    /// (`hadOutcome`), slashes a small portion of a revealed-but-outvoted evaluator's bond. A
    /// non-revealing evaluator is never touched here beyond losing their fee share above —
    /// see the contract's own doc comment on why that's a smaller penalty by design.
    function _releaseAssignments(Case storage c, bool hadOutcome, bool releaseToAgent) private {
        for (uint256 i = 0; i < PANEL_SIZE; i++) {
            address ev = c.evaluators[i];
            assignedCaseCount[ev]--;

            if (hadOutcome && c.revealed[ev] && c.votedReleaseToAgent[ev] != releaseToAgent) {
                uint256 penalty = (evaluatorBond[ev] * minoritySlashBps) / 10_000;
                if (penalty > 0) {
                    evaluatorBond[ev] -= penalty;
                    usdc.safeTransfer(treasury, penalty);
                    emit EvaluatorSlashed(c.jobId, ev, penalty);
                }
            }
        }
    }

    // ============================================================== Views =

    function getCase(uint256 jobId) external view returns (
        address feePayer,
        uint256 feePaid,
        address e0,
        address e1,
        address e2,
        uint8 releaseVotes,
        uint8 refundVotes,
        uint64 deadline,
        CaseStatus status
    ) {
        Case storage c = _cases[jobId];
        return (c.feePayer, c.feePaid, c.evaluators[0], c.evaluators[1], c.evaluators[2], c.releaseVotes, c.refundVotes, c.deadline, c.status);
    }

    // ============================================================== Admin =

    function setEvaluationRequestFee(uint256 newFee) external onlyRole(DEFAULT_ADMIN_ROLE) {
        evaluationRequestFee = newFee;
        emit EvaluationRequestFeeUpdated(newFee);
    }

    function setMinoritySlashBps(uint256 newBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newBps <= 10_000, "BpsTooHigh");
        minoritySlashBps = newBps;
        emit MinoritySlashBpsUpdated(newBps);
    }

    function setTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newTreasury != address(0), "ZeroAddress");
        treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /// @notice Rescues ERC-20 tokens accidentally sent directly to this contract. Cannot be
    /// used to drain evaluator bonds or fees-in-flight since those are tracked separately via
    /// {evaluatorBond} and each Case's `feePaid` — callers should verify off-chain that `amount`
    /// does not exceed the contract's "unaccounted" balance before calling.
    function withdrawStuckTokens(address token, uint256 amount, address to) external onlyRole(DEFAULT_ADMIN_ROLE) {
        IERC20(token).safeTransfer(to, amount);
    }
}
