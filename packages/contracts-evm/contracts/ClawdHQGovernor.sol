// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

import {IClawdHQCoreForGovernor} from "./interfaces/IClawdHQCoreForGovernor.sol";
import {IClawdHQStakingForGovernor} from "./interfaces/IClawdHQStakingForGovernor.sol";

/// @title ClawdHQGovernor
/// @notice On-chain protocol governance — replaces the Governance page's old localStorage mock
/// with real proposals, real votes, real quorum. Identity and voting weight are both per
/// *agent* (an on-chain AgentCard), not per wallet, since one wallet can own several agents:
/// `msg.sender` must equal `core.agents(agentId).owner` for every action (checked live, never
/// cached, so a transferred agent naturally carries over both permissions and its prior vote
/// lock — no stale-owner bug). Vote weight is `staking.bondOf(agentId)` — the same USDC
/// reliability bond ClawdHQStaking already tracks for job-acceptance eligibility, reused here
/// as real economic stake rather than inventing a separate governance token.
/// @dev Deliberately has no ReentrancyGuard: every external call this contract makes into Core
/// or Staking is `view`, so there is no reentrancy surface to guard against.
/// @dev `execute` is ratification-only — it flips a flag and emits an event, it does not carry
/// out arbitrary on-chain calldata against other contracts. A generic allowlisted executor is
/// its own security-critical scope (target allowlisting, call-data validation, replay
/// protection); plenty of real production DAOs (Snapshot, Compound Governor Alpha without a
/// Timelock wired up) ship with exactly this "on-chain vote of record, execution handled
/// off-chain by the admin" split. Frontend copy must say "ratified on-chain", not imply this
/// contract auto-executes protocol changes.
/// @dev Sybil/bond-cycling note: ClawdHQStaking.withdrawBond has no cooldown and agent
/// registration is free, so without a further check an attacker could otherwise cycle one bond
/// across many freshly-registered agentIds (postBond -> vote -> withdrawBond -> repeat) to
/// multiply voting power for the cost of gas alone. Mitigated by requiring `jobsCompleted >=
/// minJobsCompletedToVote` in {vote} in addition to a nonzero bond — forging real completed-job
/// history per Sybil agent isn't free or instant, unlike registering an agentId. Deliberately
/// not patching ClawdHQStaking itself: its no-cooldown design is intentional and documented
/// there for the bonding/reliability-bond feature, and changing it is out of this contract's
/// scope.
contract ClawdHQGovernor is Initializable, AccessControlUpgradeable, PausableUpgradeable, UUPSUpgradeable {
    // ============================================================ Roles ===

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    /// @notice Can {cancel} a proposal before it executes — a spam/malicious-proposal safety
    /// valve, separate from PAUSER_ROLE since vetoing one proposal shouldn't require pausing
    /// the whole contract.
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    // ======================================================= Constants ====

    uint8 public constant CATEGORY_COUNT = 5; // Parameters, Treasury, Upgrade, Skill, Other — matches the frontend's CATEGORY_STYLE order
    uint256 public constant MAX_TITLE_BYTES = 120;
    uint256 public constant MAX_DESCRIPTION_BYTES = 4000;
    uint64 public constant MIN_VOTING_PERIOD = 3 days;
    uint64 public constant MAX_VOTING_PERIOD = 14 days;
    /// @notice Timelock buffer after a proposal succeeds, before {execute} may be called —
    /// gives a GUARDIAN_ROLE holder a window to {cancel} an outcome discovered to be malicious
    /// or mistaken before it's ratified.
    uint64 public constant EXECUTION_DELAY = 1 days;

    // ========================================================== Types =====

    enum ProposalState {
        Active,
        Succeeded,
        Defeated,
        QuorumNotMet,
        Canceled,
        Executed
    }

    struct Proposal {
        uint256 id;
        address proposer;
        uint256 proposerAgentId;
        uint8 category;
        string title;
        string description;
        uint64 startTime;
        uint64 endTime;
        uint256 quorumRequired; // absolute USDC-bond-weighted-vote target (6dp), not a percentage
        uint256 votesFor;
        uint256 votesAgainst;
        bool canceled;
        bool executed;
    }

    // ======================================================== Storage =====

    IClawdHQCoreForGovernor public core;
    IClawdHQStakingForGovernor public staking;

    mapping(uint256 => Proposal) public proposals; // 1-indexed; id 0 means "doesn't exist"
    uint256 public proposalCount;
    mapping(uint256 => mapping(uint256 => bool)) public hasVotedAgent; // proposalId => agentId => voted
    mapping(uint8 => uint256) public quorumByCategory; // admin-settable, seeded with defaults in {initialize}

    uint256 public minJobsCompletedToPropose;
    uint256 public minJobsCompletedToVote;

    // ========================================================= Events =====

    event ProposalCreated(
        uint256 indexed id,
        address indexed proposer,
        uint256 indexed proposerAgentId,
        uint8 category,
        uint64 startTime,
        uint64 endTime,
        uint256 quorumRequired
    );
    event VoteCast(uint256 indexed proposalId, uint256 indexed agentId, address indexed voter, bool support, uint256 weight);
    event ProposalCanceled(uint256 indexed id);
    event ProposalExecuted(uint256 indexed id);
    event QuorumUpdated(uint8 category, uint256 amount);
    event MinJobsCompletedToProposeUpdated(uint256 amount);
    event MinJobsCompletedToVoteUpdated(uint256 amount);

    // ========================================================= Errors =====

    error NotAgentOwner();
    error NotEligibleToPropose();
    error NotEligibleToVote();
    error InvalidCategory();
    error InvalidVotingPeriod();
    error TitleInvalidLength();
    error DescriptionInvalidLength();
    error QuorumNotConfigured();
    error ProposalNotFound();
    error ProposalNotActive();
    error AlreadyVoted();
    error NoVotingWeight();
    error ProposalNotSucceeded();
    error ExecutionTimelockNotElapsed();
    error ProposalAlreadyExecuted();
    error ProposalAlreadyCanceled();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @dev Seeds every category's quorum with a sane default so the contract is immediately
    /// usable — unlike ClawdHQStaking's deliberately-manual post-deploy wiring (bond
    /// requirements there are real economic decisions best left to an explicit admin call),
    /// governance needs at least *some* working quorum from block one for the feature to be
    /// testable/usable at all. An admin can retune per-category via {setQuorum} afterward.
    function initialize(address admin, address coreAddress, address stakingAddress) external initializer {
        __AccessControl_init();
        __Pausable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, admin);

        core = IClawdHQCoreForGovernor(coreAddress);
        staking = IClawdHQStakingForGovernor(stakingAddress);

        minJobsCompletedToPropose = 10;
        minJobsCompletedToVote = 1;

        for (uint8 i = 0; i < CATEGORY_COUNT; i++) {
            quorumByCategory[i] = 5_000_000_000; // 5,000 USDC (6dp) bond-weighted votes
        }
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    // =============================================================== Read =

    function _agentOwnerAndJobs(uint256 agentId) private view returns (address owner, uint32 jobsCompleted) {
        (, owner, , , , , , , , , , , , , jobsCompleted) = core.agents(agentId);
    }

    /// @notice Computed live from timestamps/votes/quorum, never stored, so it can never drift.
    function state(uint256 proposalId) public view returns (ProposalState) {
        Proposal storage p = proposals[proposalId];
        if (p.id == 0) revert ProposalNotFound();

        if (p.canceled) return ProposalState.Canceled;
        if (p.executed) return ProposalState.Executed;
        if (block.timestamp < p.endTime) return ProposalState.Active;

        uint256 total = p.votesFor + p.votesAgainst;
        if (total < p.quorumRequired) return ProposalState.QuorumNotMet;
        return p.votesFor > p.votesAgainst ? ProposalState.Succeeded : ProposalState.Defeated;
    }

    function getProposal(uint256 proposalId) external view returns (Proposal memory) {
        if (proposals[proposalId].id == 0) revert ProposalNotFound();
        return proposals[proposalId];
    }

    // ======================================================= Proposing ====

    function createProposal(
        uint256 proposerAgentId,
        string calldata title,
        string calldata description,
        uint8 category,
        uint64 votingPeriodSeconds
    ) external whenNotPaused returns (uint256 id) {
        (address owner, uint32 jobsCompleted) = _agentOwnerAndJobs(proposerAgentId);
        if (owner != msg.sender) revert NotAgentOwner();
        if (jobsCompleted < minJobsCompletedToPropose) revert NotEligibleToPropose();
        if (category >= CATEGORY_COUNT) revert InvalidCategory();
        if (votingPeriodSeconds < MIN_VOTING_PERIOD || votingPeriodSeconds > MAX_VOTING_PERIOD) revert InvalidVotingPeriod();
        if (bytes(title).length == 0 || bytes(title).length > MAX_TITLE_BYTES) revert TitleInvalidLength();
        if (bytes(description).length == 0 || bytes(description).length > MAX_DESCRIPTION_BYTES) revert DescriptionInvalidLength();

        uint256 quorumRequired = quorumByCategory[category];
        if (quorumRequired == 0) revert QuorumNotConfigured();

        proposalCount += 1;
        id = proposalCount;
        uint64 startTime = uint64(block.timestamp);
        uint64 endTime = startTime + votingPeriodSeconds;

        proposals[id] = Proposal({
            id: id,
            proposer: msg.sender,
            proposerAgentId: proposerAgentId,
            category: category,
            title: title,
            description: description,
            startTime: startTime,
            endTime: endTime,
            quorumRequired: quorumRequired,
            votesFor: 0,
            votesAgainst: 0,
            canceled: false,
            executed: false
        });

        emit ProposalCreated(id, msg.sender, proposerAgentId, category, startTime, endTime, quorumRequired);
    }

    // =========================================================== Voting ===

    function vote(uint256 proposalId, uint256 voterAgentId, bool support) external whenNotPaused {
        Proposal storage p = proposals[proposalId];
        if (p.id == 0) revert ProposalNotFound();
        if (p.canceled || block.timestamp < p.startTime || block.timestamp >= p.endTime) revert ProposalNotActive();
        if (hasVotedAgent[proposalId][voterAgentId]) revert AlreadyVoted();

        (address owner, uint32 jobsCompleted) = _agentOwnerAndJobs(voterAgentId);
        if (owner != msg.sender) revert NotAgentOwner();
        if (jobsCompleted < minJobsCompletedToVote) revert NotEligibleToVote();

        uint256 weight = staking.bondOf(voterAgentId);
        if (weight == 0) revert NoVotingWeight();

        hasVotedAgent[proposalId][voterAgentId] = true;
        if (support) {
            p.votesFor += weight;
        } else {
            p.votesAgainst += weight;
        }

        emit VoteCast(proposalId, voterAgentId, msg.sender, support, weight);
    }

    // ==================================================== Execution/veto ==

    /// @notice Ratification only — see this contract's top-level NatSpec. Permissionless once
    /// the timelock has passed, same "anyone can trigger a state transition whose conditions
    /// are all already on-chain" pattern as ClawdHQAgentExchange's settleAuction.
    function execute(uint256 proposalId) external whenNotPaused {
        Proposal storage p = proposals[proposalId];
        if (p.id == 0) revert ProposalNotFound();
        if (p.executed) revert ProposalAlreadyExecuted();
        if (p.canceled) revert ProposalAlreadyCanceled();
        if (state(proposalId) != ProposalState.Succeeded) revert ProposalNotSucceeded();
        if (block.timestamp < p.endTime + EXECUTION_DELAY) revert ExecutionTimelockNotElapsed();

        p.executed = true;
        emit ProposalExecuted(proposalId);
    }

    function cancel(uint256 proposalId) external onlyRole(GUARDIAN_ROLE) {
        Proposal storage p = proposals[proposalId];
        if (p.id == 0) revert ProposalNotFound();
        if (p.executed) revert ProposalAlreadyExecuted();
        if (p.canceled) revert ProposalAlreadyCanceled();

        p.canceled = true;
        emit ProposalCanceled(proposalId);
    }

    // ============================================================== Admin =

    function setQuorum(uint8 category, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (category >= CATEGORY_COUNT) revert InvalidCategory();
        quorumByCategory[category] = amount;
        emit QuorumUpdated(category, amount);
    }

    function setMinJobsCompletedToPropose(uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        minJobsCompletedToPropose = amount;
        emit MinJobsCompletedToProposeUpdated(amount);
    }

    function setMinJobsCompletedToVote(uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        minJobsCompletedToVote = amount;
        emit MinJobsCompletedToVoteUpdated(amount);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }
}
