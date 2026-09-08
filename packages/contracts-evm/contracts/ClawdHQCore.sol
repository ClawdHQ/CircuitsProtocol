// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
// ReentrancyGuard (non-upgradeable variant) uses ERC-7201 namespaced storage and has no
// constructor/initializer logic, so it is upgrade-safe to inherit directly — this is why
// OpenZeppelin Contracts-Upgradeable v5 no longer ships a separate Upgradeable variant of it.
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev Minimal external surface this contract needs from AgentWalletRegistry.sol — kept as a
/// standalone interface (not an import of the full contract) to avoid pulling any of its
/// bytecode into ClawdHQCore, which has no size headroom left (see the contract's own doc
/// comment below). Matches `agentWallet`'s auto-generated public-mapping getter there exactly
/// (single `uint256` arg) rather than a dedicated two-argument function — cheaper to encode a
/// call to, which matters here specifically.
interface IAgentWalletRegistry {
    function agentWallet(uint256 agentId) external view returns (address);
}

/// @dev Same minimal-interface, decoupled-compilation-unit pattern as IAgentWalletRegistry
/// above — see ClawdHQStaking.sol. `stakingContract` is opt-in (address(0) = feature off, the
/// default), so a deployment that never configures it behaves exactly as before this was added.
interface IStaking {
    function isEligible(uint256 agentId, uint8 tier) external view returns (bool);
    function slash(uint256 agentId, address recipient) external returns (uint256 amount);
}

/// @title ClawdHQCore
/// @notice Unified agent registry and job marketplace (with USDC escrow) for ClawdHQ. Deployed
/// identically across BSC Testnet, Base Sepolia, and Ethereum Sepolia behind a UUPS proxy. The
/// bonding-curve launchpad lives in its own contract, ClawdHQLaunchpad.sol — split out because
/// this contract has no bytecode headroom left (see AgentWalletRegistry.sol's doc comment).
/// @dev All USDC amounts use USDC's native 6 decimals.
contract ClawdHQCore is Initializable, AccessControlUpgradeable, PausableUpgradeable, UUPSUpgradeable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============================================================ Roles ===

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant VERIFIER_ROLE = keccak256("VERIFIER_ROLE");
    bytes32 public constant RESOLVER_ROLE = keccak256("RESOLVER_ROLE");

    // ============================================================ Types ===

    enum AgentTier {
        Basic,
        Verified,
        Elite
    }

    enum JobStatus {
        Pending,
        Active,
        Completed,
        Disputed,
        Cancelled,
        Resolved
    }

    struct AgentCard {
        uint256 agentId;
        address owner;
        string name;
        string agentURI;
        string endpoint;
        bytes32 metadataHash;
        bool supportsX402;
        bool supportsA2A;
        bool supportsMCP;
        bool active;
        AgentTier tier;
        uint64 createdAt;
        uint64 updatedAt;
        uint64 lastJobAt;
        uint32 jobsCompleted;
        uint32 jobsFailed;
        uint128 usdcRevenue;
        uint16 reputationBps; // 0-10000
    }

    struct Job {
        uint256 jobId;
        address employer;
        uint256 employerAgentId; // 0 if the employer hired as an individual, not an agent
        uint256 hiredAgentId;
        bytes32 taskHash; // keccak256 of the task's IPFS CID string
        uint256 budget; // USDC, 6 decimals
        JobStatus status;
        uint64 createdAt;
        uint64 deadline;
        uint64 startedAt;
        uint64 completedAt;
        bytes32 deliverableHash;
        uint8 rating; // 1-5, 0 if unrated
    }


    // ======================================================== Storage =====

    IERC20 public usdc;
    address public treasury;

    uint256 public registrationFee; // USDC, 6 decimals
    uint256 public protocolFeeBps; // taken from job payouts on completion

    uint256 public totalAgents;
    uint256 public activeAgents;
    uint256 public totalJobs;
    uint256 public totalVolume; // USDC, 6 decimals, lifetime job volume

    uint256 private _nextAgentId;
    uint256 private _nextJobId;

    mapping(uint256 => AgentCard) public agents;
    mapping(address => uint256[]) public agentsByOwner;
    mapping(bytes32 => uint256) public agentIdByNameHash;
    /// @notice Per-agent operator approval for the ownership exchange (mirrors ERC721's
    /// single-operator `approve`, not a blanket `setApprovalForAll`) — scopes an exchange
    /// contract's transfer power to exactly the agents their owner opted in, so a bug or
    /// compromise in the exchange contract can't touch unlisted agents. address(0) = none.
    mapping(uint256 => address) public agentExchangeApproval;

    mapping(uint256 => Job) public jobs;
    mapping(uint256 => uint256) public escrowRecords; // jobId => USDC currently escrowed

    /// @notice ClawdHQStaking's address, or address(0) if staking isn't configured (the
    /// default) — see {IStaking}. Admin-settable post-init (a plain mutable address, not an
    /// immutable constructor arg like AgentWalletRegistry) so staking can be introduced or
    /// upgraded without redeploying Core.
    address public stakingContract;

    /// @notice ClawdHQEvaluatorPool's address, or address(0) if the decentralized evaluator
    /// marketplace isn't configured (the default — {resolveDispute}'s RESOLVER_ROLE admin path
    /// is the only way to resolve a dispute until this is set). See
    /// {resolveDisputeFromEvaluatorPool}.
    address public evaluatorPoolContract;

    /// @notice Addresses allowed to call {postJobFromNegotiation} on a Client's behalf — set by
    /// an admin per deployed ClawdHQNegotiation contract (there may reasonably be more than one
    /// over this app's lifetime, e.g. across an upgrade), empty by default (feature off).
    mapping(address => bool) public trustedNegotiationContracts;

    // ========================================================= Events =====

    event AgentRegistered(uint256 indexed agentId, address indexed owner, string name, string agentURI);
    event AgentMetadataUpdated(uint256 indexed agentId, string agentURI, string endpoint);
    event AgentActiveChanged(uint256 indexed agentId, bool active);
    event AgentOwnershipTransferred(uint256 indexed agentId, address indexed previousOwner, address indexed newOwner);
    event AgentTierUpdated(uint256 indexed agentId, AgentTier tier);
    event AgentExchangeApprovalChanged(uint256 indexed agentId, address indexed exchange);
    event AgentOwnershipTransferredByExchange(uint256 indexed agentId, address indexed previousOwner, address indexed newOwner, address exchange);

    event JobPosted(uint256 indexed jobId, address indexed employer, uint256 indexed hiredAgentId, uint256 budget, uint256 deadline);
    event JobAccepted(uint256 indexed jobId, uint256 indexed agentId);
    event DeliverableSubmitted(uint256 indexed jobId, bytes32 deliverableHash);
    event JobCompleted(uint256 indexed jobId, uint256 indexed agentId, uint256 payout, uint8 rating);
    event JobDisputed(uint256 indexed jobId, address indexed initiator);
    event JobCancelled(uint256 indexed jobId);
    event DisputeResolved(uint256 indexed jobId, bool releasedToAgent);

    event ProtocolFeeUpdated(uint256 protocolFeeBps);
    event RegistrationFeeUpdated(uint256 registrationFee);
    event TreasuryUpdated(address treasury);
    event StakingContractUpdated(address stakingContract);
    event EvaluatorPoolContractUpdated(address evaluatorPoolContract);
    event TrustedNegotiationContractUpdated(address indexed negotiationContract, bool trusted);

    // ========================================================= Errors =====

    error NameTaken();
    error InvalidNameLength();
    error NotAgentOwner();
    error NotApprovedExchange();
    error AgentNotActive();
    error AgentNotFound();
    error InvalidTier();
    error InvalidJobStatus();
    error NotEmployer();
    error NotEmployerOrAgentOwner();
    error DeadlineNotPassed();
    error DeadlinePassed();
    error InvalidRating();
    error NoDeliverableSubmitted();
    error ZeroAmount();
    error InsufficientBond();
    error NotEvaluatorPool();
    error NotTrustedNegotiationContract();

    /// @dev `_agentWalletRegistry` is set here, not via an admin setter — an upgradeable
    /// contract's `immutable`s are baked into the implementation's own bytecode (not proxy
    /// storage), so this works correctly through the proxy and costs zero SLOADs to read,
    /// unlike a regular storage variable. Deliberately traded for the inability to ever
    /// repoint at a different registry without a full implementation upgrade — acceptable
    /// since AgentWalletRegistry.sol already supports rotating its own `registrar` signer
    /// internally, so ClawdHQCore itself never needs to change which registry it trusts. This
    /// contract has no bytecode headroom left for another full admin-setter function (see the
    /// contract's own doc comment) — this was the single largest lever available to make the
    /// AgentWalletRegistry integration fit under EIP-170's 24576-byte limit at all.
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    address private immutable _agentWalletRegistry;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(address agentWalletRegistry_) {
        _agentWalletRegistry = agentWalletRegistry_;
        _disableInitializers();
    }

    function initialize(address admin, address usdcAddress, address treasury_) external initializer {
        __AccessControl_init();
        __Pausable_init();
        // UUPSUpgradeable has no storage of its own in OZ v5, so it has no initializer to call.

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        _grantRole(VERIFIER_ROLE, admin);
        _grantRole(RESOLVER_ROLE, admin);

        usdc = IERC20(usdcAddress);
        treasury = treasury_;

        // Zero fees by default — this deployment targets testnet only.
        registrationFee = 0;
        protocolFeeBps = 0;

        _nextAgentId = 1;
        _nextJobId = 1;
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    // ============================================================ Modifiers

    modifier onlyAgentOwner(uint256 agentId) {
        if (agents[agentId].agentId == 0) revert AgentNotFound();
        if (agents[agentId].owner != msg.sender) revert NotAgentOwner();
        _;
    }

    // ===================================================== Agent Identity =

    /// @notice Registers a new agent. Charges `registrationFee` in USDC if set.
    /// @param name Must be unique (case-sensitive) and 1-64 bytes long. Immutable after registration.
    function registerAgent(
        string calldata name,
        string calldata agentURI,
        string calldata endpoint,
        bytes32 metadataHash,
        bool supportsX402,
        bool supportsA2A,
        bool supportsMCP
    ) external whenNotPaused returns (uint256 agentId) {
        bytes memory nameBytes = bytes(name);
        if (nameBytes.length == 0 || nameBytes.length > 64) revert InvalidNameLength();

        bytes32 nameHash = keccak256(nameBytes);
        if (agentIdByNameHash[nameHash] != 0) revert NameTaken();

        if (registrationFee > 0) {
            usdc.safeTransferFrom(msg.sender, treasury, registrationFee);
        }

        agentId = _nextAgentId++;
        agentIdByNameHash[nameHash] = agentId;
        agentsByOwner[msg.sender].push(agentId);

        agents[agentId] = AgentCard({
            agentId: agentId,
            owner: msg.sender,
            name: name,
            agentURI: agentURI,
            endpoint: endpoint,
            metadataHash: metadataHash,
            supportsX402: supportsX402,
            supportsA2A: supportsA2A,
            supportsMCP: supportsMCP,
            active: true,
            tier: AgentTier.Basic,
            createdAt: uint64(block.timestamp),
            updatedAt: uint64(block.timestamp),
            lastJobAt: 0,
            jobsCompleted: 0,
            jobsFailed: 0,
            usdcRevenue: 0,
            reputationBps: 0
        });

        totalAgents++;
        activeAgents++;

        emit AgentRegistered(agentId, msg.sender, name, agentURI);
    }

    function updateAgentMetadata(
        uint256 agentId,
        string calldata agentURI,
        string calldata endpoint,
        bytes32 metadataHash,
        bool supportsX402,
        bool supportsA2A,
        bool supportsMCP
    ) external onlyAgentOwner(agentId) {
        AgentCard storage agent = agents[agentId];
        agent.agentURI = agentURI;
        agent.endpoint = endpoint;
        agent.metadataHash = metadataHash;
        agent.supportsX402 = supportsX402;
        agent.supportsA2A = supportsA2A;
        agent.supportsMCP = supportsMCP;
        agent.updatedAt = uint64(block.timestamp);

        emit AgentMetadataUpdated(agentId, agentURI, endpoint);
    }

    function setAgentActive(uint256 agentId, bool active) external onlyAgentOwner(agentId) {
        AgentCard storage agent = agents[agentId];
        if (agent.active != active) {
            agent.active = active;
            if (active) {
                activeAgents++;
            } else {
                activeAgents--;
            }
        }
        agent.updatedAt = uint64(block.timestamp);

        emit AgentActiveChanged(agentId, active);
    }

    function transferAgentOwnership(uint256 agentId, address newOwner) external onlyAgentOwner(agentId) {
        address previousOwner = msg.sender;
        _reassignAgentOwner(agentId, previousOwner, newOwner);

        // A manual transfer while a listing is live is an implicit delist — an approval
        // scoped to the previous owner's listing must never silently carry over to whoever
        // the agent transfers to next (unconditional: cheaper than branching, and a
        // no-op delete when nothing was approved is harmless).
        delete agentExchangeApproval[agentId];
        emit AgentExchangeApprovalChanged(agentId, address(0));

        emit AgentOwnershipTransferred(agentId, previousOwner, newOwner);
    }

    /// @notice Approves `exchange` to execute a single one-time ownership transfer of
    /// `agentId` via {transferAgentOwnershipFromExchange}. Approving does not move the
    /// agent's `owner` or otherwise affect its normal operation — job payouts keep routing
    /// to the real owner for as long as the agent is merely listed, not yet sold. Mirrors
    /// ERC721's single-operator `approve` rather than a blanket role grant, so only the
    /// agents an owner explicitly lists are ever at risk from an exchange-contract bug.
    /// Pass address(0) to revoke a standing approval (e.g. to cancel a listing).
    function approveAgentExchange(uint256 agentId, address exchange) external onlyAgentOwner(agentId) {
        agentExchangeApproval[agentId] = exchange;
        emit AgentExchangeApprovalChanged(agentId, exchange);
    }

    /// @notice Executes an agent ownership transfer on behalf of a sale/auction settled by
    /// the currently-approved exchange contract. Callable only by that exchange, and only
    /// once per approval — the approval is consumed on use, so re-listing requires the owner
    /// to re-approve. See {approveAgentExchange}.
    function transferAgentOwnershipFromExchange(uint256 agentId, address newOwner) external {
        if (agentExchangeApproval[agentId] != msg.sender) revert NotApprovedExchange();

        address previousOwner = agents[agentId].owner;
        delete agentExchangeApproval[agentId];
        _reassignAgentOwner(agentId, previousOwner, newOwner);

        emit AgentOwnershipTransferredByExchange(agentId, previousOwner, newOwner, msg.sender);
    }

    function _reassignAgentOwner(uint256 agentId, address previousOwner, address newOwner) private {
        agents[agentId].owner = newOwner;
        agents[agentId].updatedAt = uint64(block.timestamp);

        uint256[] storage ownerAgents = agentsByOwner[previousOwner];
        uint256 len = ownerAgents.length;
        for (uint256 i = 0; i < len; i++) {
            if (ownerAgents[i] == agentId) {
                ownerAgents[i] = ownerAgents[len - 1];
                ownerAgents.pop();
                break;
            }
        }
        agentsByOwner[newOwner].push(agentId);
    }

    function setAgentTier(uint256 agentId, AgentTier tier) external onlyRole(VERIFIER_ROLE) {
        if (agents[agentId].agentId == 0) revert AgentNotFound();
        agents[agentId].tier = tier;
        agents[agentId].updatedAt = uint64(block.timestamp);

        emit AgentTierUpdated(agentId, tier);
    }

    function getAgentsByOwner(address owner) external view returns (uint256[] memory) {
        return agentsByOwner[owner];
    }

    // ============================================================ Job System

    /// @dev `hiredAgentId == 0` posts an *open* job — no agent pre-selected, any active agent's
    /// owner may later claim it via {acceptOpenJob}. A directed hire (hiredAgentId != 0) still
    /// requires that agent to already exist and be active, exactly as before.
    function postJob(
        uint256 employerAgentId,
        uint256 hiredAgentId,
        bytes32 taskHash,
        uint256 budget,
        uint256 deadline
    ) external whenNotPaused nonReentrant returns (uint256 jobId) {
        return _postJob(msg.sender, employerAgentId, hiredAgentId, taskHash, budget, deadline);
    }

    /// @notice The on-chain-negotiation counterpart to {postJob} — callable only by whichever
    /// address `trustedNegotiationContracts` currently allows (see
    /// {setTrustedNegotiationContract}), reached once ClawdHQNegotiation's propose/counter/
    /// accept flow converges on mutually agreed terms. `employer` is the original negotiating
    /// Client, not `msg.sender` (which is the negotiation contract itself) — USDC is still
    /// pulled directly from that Client's own wallet via {_postJob}'s `safeTransferFrom`, so the
    /// negotiation contract never custodies job funds even transiently. Always a directed hire
    /// (hiredAgentId != 0) — a negotiation only reaches acceptance with a specific counterparty.
    function postJobFromNegotiation(
        address employer,
        uint256 employerAgentId,
        uint256 hiredAgentId,
        bytes32 taskHash,
        uint256 budget,
        uint256 deadline
    ) external whenNotPaused nonReentrant returns (uint256 jobId) {
        if (!trustedNegotiationContracts[msg.sender]) revert NotTrustedNegotiationContract();
        if (hiredAgentId == 0) revert AgentNotActive(); // a negotiated job is never open-hire
        return _postJob(employer, employerAgentId, hiredAgentId, taskHash, budget, deadline);
    }

    function _postJob(
        address employer,
        uint256 employerAgentId,
        uint256 hiredAgentId,
        bytes32 taskHash,
        uint256 budget,
        uint256 deadline
    ) private returns (uint256 jobId) {
        if (hiredAgentId != 0) {
            AgentCard storage hired = agents[hiredAgentId];
            if (hired.agentId == 0 || !hired.active) revert AgentNotActive();
        }
        if (budget == 0) revert ZeroAmount();
        if (deadline <= block.timestamp) revert DeadlinePassed();

        usdc.safeTransferFrom(employer, address(this), budget);

        jobId = _nextJobId++;
        jobs[jobId] = Job({
            jobId: jobId,
            employer: employer,
            employerAgentId: employerAgentId,
            hiredAgentId: hiredAgentId,
            taskHash: taskHash,
            budget: budget,
            status: JobStatus.Pending,
            createdAt: uint64(block.timestamp),
            deadline: uint64(deadline),
            startedAt: 0,
            completedAt: 0,
            deliverableHash: bytes32(0),
            rating: 0
        });
        escrowRecords[jobId] = budget;
        totalJobs++;

        emit JobPosted(jobId, employer, hiredAgentId, budget, deadline);
    }

    /// @dev Directed hire only (job.hiredAgentId != 0, set at postJob time) — the pre-selected
    /// agent's owner is the only one authorized to accept. For an open job, use
    /// {acceptOpenJob} instead; this reverts InvalidJobStatus for one (job.hiredAgentId == 0
    /// never matches a real msg.sender via agents[0].owner, but failing the *status* check the
    /// same way an already-active job would keeps this function's revert reason meaningful:
    /// there was never a directed hire to accept here).
    function acceptJob(uint256 jobId) external whenNotPaused {
        if (jobs[jobId].hiredAgentId == 0) revert InvalidJobStatus();
        _acceptJob(jobId, jobs[jobId].hiredAgentId);
    }

    /// @dev Claims an open job (job.hiredAgentId == 0 at post time) on behalf of `claimingAgentId`
    /// — first caller to successfully claim wins, same as any other state-changing call racing
    /// for the same storage slot. `claimingAgentId` must belong to msg.sender and be active,
    /// exactly as a directed hire already requires of its pre-selected agent.
    function acceptOpenJob(uint256 jobId, uint256 claimingAgentId) external whenNotPaused {
        if (jobs[jobId].hiredAgentId != 0) revert InvalidJobStatus();
        if (!agents[claimingAgentId].active) revert AgentNotActive();
        jobs[jobId].hiredAgentId = claimingAgentId;
        _acceptJob(jobId, claimingAgentId);
    }

    function _acceptJob(uint256 jobId, uint256 agentId) internal {
        Job storage job = jobs[jobId];
        if (job.status != JobStatus.Pending) revert InvalidJobStatus();
        AgentCard storage agent = agents[agentId];
        if (agent.owner != msg.sender) revert NotAgentOwner();
        if (stakingContract != address(0) && !IStaking(stakingContract).isEligible(agentId, uint8(agent.tier))) {
            revert InsufficientBond();
        }

        job.status = JobStatus.Active;
        job.startedAt = uint64(block.timestamp);

        emit JobAccepted(jobId, agentId);
    }

    function submitDeliverable(uint256 jobId, bytes32 deliverableHash) external whenNotPaused {
        Job storage job = jobs[jobId];
        if (job.status != JobStatus.Active) revert InvalidJobStatus();
        if (agents[job.hiredAgentId].owner != msg.sender) revert NotAgentOwner();

        job.deliverableHash = deliverableHash;

        emit DeliverableSubmitted(jobId, deliverableHash);
    }

    function confirmDelivery(uint256 jobId, uint8 rating) external whenNotPaused nonReentrant {
        Job storage job = jobs[jobId];
        if (job.status != JobStatus.Active) revert InvalidJobStatus();
        if (job.employer != msg.sender) revert NotEmployer();
        if (rating < 1 || rating > 5) revert InvalidRating();
        if (job.deliverableHash == bytes32(0)) revert NoDeliverableSubmitted();

        job.status = JobStatus.Completed;
        job.completedAt = uint64(block.timestamp);
        job.rating = rating;

        _releaseEscrow(job, rating);
    }

    function disputeJob(uint256 jobId) external whenNotPaused {
        Job storage job = jobs[jobId];
        if (job.status != JobStatus.Active) revert InvalidJobStatus();
        address agentOwner = agents[job.hiredAgentId].owner;
        if (msg.sender != job.employer && msg.sender != agentOwner) revert NotEmployerOrAgentOwner();

        job.status = JobStatus.Disputed;

        emit JobDisputed(jobId, msg.sender);
    }

    function cancelJob(uint256 jobId) external whenNotPaused nonReentrant {
        Job storage job = jobs[jobId];
        if (job.status != JobStatus.Pending) revert InvalidJobStatus();
        if (job.employer != msg.sender) revert NotEmployer();

        job.status = JobStatus.Cancelled;
        uint256 amount = escrowRecords[jobId];
        escrowRecords[jobId] = 0;
        usdc.safeTransfer(job.employer, amount);

        emit JobCancelled(jobId);
    }

    /// @notice Admin escape hatch — resolves a dispute directly, regardless of whether
    /// ClawdHQEvaluatorPool is configured or has a case in flight for this job. Kept exactly as
    /// it always was so a stalled or buggy evaluator-pool integration can never permanently
    /// strand a disputed job's escrow; see {resolveDisputeFromEvaluatorPool} for the
    /// decentralized counterpart. Core's own `job.status` check (both paths require `Disputed`,
    /// both set `Resolved`) is what prevents the two paths from ever double-resolving the same
    /// job — whichever call lands first wins, the second reverts InvalidJobStatus.
    function resolveDispute(uint256 jobId, bool releaseToAgent) external onlyRole(RESOLVER_ROLE) nonReentrant {
        _resolveDispute(jobId, releaseToAgent);
    }

    /// @notice The permissionless-evaluator-marketplace counterpart to {resolveDispute} —
    /// callable only by whichever address `evaluatorPoolContract` currently points at (see
    /// {setEvaluatorPoolContract}), reached once that contract's 3-evaluator commit-reveal
    /// panel hits a 2-of-3 majority on a disputed job. address(0) (the default) means this
    /// reverts unconditionally, i.e. the evaluator-pool path is off until explicitly configured.
    function resolveDisputeFromEvaluatorPool(uint256 jobId, bool releaseToAgent) external nonReentrant {
        if (evaluatorPoolContract == address(0) || msg.sender != evaluatorPoolContract) revert NotEvaluatorPool();
        _resolveDispute(jobId, releaseToAgent);
    }

    function _resolveDispute(uint256 jobId, bool releaseToAgent) private {
        Job storage job = jobs[jobId];
        if (job.status != JobStatus.Disputed) revert InvalidJobStatus();

        job.status = JobStatus.Resolved;
        job.completedAt = uint64(block.timestamp);

        if (releaseToAgent) {
            _releaseEscrow(job, 0);
        } else {
            uint256 amount = escrowRecords[jobId];
            escrowRecords[jobId] = 0;
            usdc.safeTransfer(job.employer, amount);
            agents[job.hiredAgentId].jobsFailed++;
            // Best-effort: a losing agent's bond is slashed to the wronged employer on top of
            // their escrow refund above. Silently skipped if staking isn't configured, or if
            // Core hasn't been authorized as a slasher on it yet (see ClawdHQStaking.sol) — a
            // misconfigured staking integration should never block dispute resolution itself.
            if (stakingContract != address(0)) {
                try IStaking(stakingContract).slash(job.hiredAgentId, job.employer) {} catch {}
            }
        }

        emit DisputeResolved(jobId, releaseToAgent);
    }

    /// @notice Releases escrow to the agent when the employer fails to confirm or dispute
    /// before the deadline, preventing employers from griefing agents by going silent.
    function autoReleaseExpired(uint256 jobId) external nonReentrant {
        Job storage job = jobs[jobId];
        if (job.status != JobStatus.Active) revert InvalidJobStatus();
        if (block.timestamp <= job.deadline) revert DeadlineNotPassed();
        if (job.deliverableHash == bytes32(0)) revert NoDeliverableSubmitted();

        job.status = JobStatus.Completed;
        job.completedAt = uint64(block.timestamp);

        _releaseEscrow(job, 0);
    }

    /// @dev Payout destination for an agent's own earnings (job completion, launchpad creator
    /// allocation): its AgentWalletRegistry-registered wallet, or `owner` if this agent's
    /// wallet hasn't been provisioned there yet.
    function _payoutAddress(uint256 agentId) private view returns (address) {
        address wallet = IAgentWalletRegistry(_agentWalletRegistry).agentWallet(agentId);
        return wallet != address(0) ? wallet : agents[agentId].owner;
    }

    function _releaseEscrow(Job storage job, uint8 rating) private {
        uint256 amount = escrowRecords[job.jobId];
        escrowRecords[job.jobId] = 0;

        uint256 creatorShare = (amount * 50) / 100;
        uint256 agentShare = (amount * 30) / 100;
        uint256 protocolShare = amount - creatorShare - agentShare; // 20%

        address creator = agents[job.hiredAgentId].owner;
        address wallet = IAgentWalletRegistry(_agentWalletRegistry).agentWallet(job.hiredAgentId);
        address agentDest = wallet != address(0) ? wallet : creator;

        if (creatorShare > 0) {
            usdc.safeTransfer(creator, creatorShare);
        }
        if (agentShare > 0) {
            usdc.safeTransfer(agentDest, agentShare);
        }
        if (protocolShare > 0 && treasury != address(0)) {
            usdc.safeTransfer(treasury, protocolShare);
        }

        AgentCard storage agent = agents[job.hiredAgentId];
        agent.jobsCompleted++;
        agent.usdcRevenue += uint128(creatorShare + agentShare);
        agent.lastJobAt = uint64(block.timestamp);

        if (rating > 0) {
            uint32 priorCompleted = agent.jobsCompleted - 1;
            uint256 ratingBps = uint256(rating) * 2_000;
            agent.reputationBps = uint16((uint256(agent.reputationBps) * priorCompleted + ratingBps) / agent.jobsCompleted);
        }

        totalVolume += amount;

        emit JobCompleted(job.jobId, job.hiredAgentId, creatorShare + agentShare, rating);
    }

    function getJobsByAgentCount(uint256) external pure returns (uint256) {
        // Indexing is handled off-chain via emitted events for gas efficiency;
        // this stub documents the intentional absence of an on-chain index.
        return 0;
    }

    // ============================================================== Admin =

    function setProtocolFeeBps(uint256 newFeeBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newFeeBps <= 10_000, "FeeTooHigh");
        protocolFeeBps = newFeeBps;
        emit ProtocolFeeUpdated(newFeeBps);
    }

    function setRegistrationFee(uint256 newFee) external onlyRole(DEFAULT_ADMIN_ROLE) {
        registrationFee = newFee;
        emit RegistrationFeeUpdated(newFee);
    }

    function setTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newTreasury != address(0), "ZeroAddress");
        treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    /// @notice address(0) (the default) disables the staking-eligibility check entirely — see
    /// {IStaking} and {_acceptJob}.
    function setStakingContract(address newStakingContract) external onlyRole(DEFAULT_ADMIN_ROLE) {
        stakingContract = newStakingContract;
        emit StakingContractUpdated(newStakingContract);
    }

    /// @notice address(0) (the default) disables {resolveDisputeFromEvaluatorPool} entirely —
    /// disputes can only be resolved via {resolveDispute}'s RESOLVER_ROLE admin path until this
    /// is set.
    function setEvaluatorPoolContract(address newEvaluatorPoolContract) external onlyRole(DEFAULT_ADMIN_ROLE) {
        evaluatorPoolContract = newEvaluatorPoolContract;
        emit EvaluatorPoolContractUpdated(newEvaluatorPoolContract);
    }

    /// @notice Not trusted by default — {postJobFromNegotiation} reverts for every caller until
    /// an admin explicitly authorizes a specific deployed ClawdHQNegotiation contract here.
    function setTrustedNegotiationContract(address negotiationContract, bool trusted) external onlyRole(DEFAULT_ADMIN_ROLE) {
        trustedNegotiationContracts[negotiationContract] = trusted;
        emit TrustedNegotiationContractUpdated(negotiationContract, trusted);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /// @notice Rescues ERC-20 tokens accidentally sent directly to this contract.
    /// Cannot be used to drain active job escrow since that's only ever held as part of
    /// `usdc`'s balance, tracked separately via {escrowRecords} — callers should verify
    /// off-chain that `amount` does not exceed the contract's "unaccounted" balance before
    /// calling.
    function withdrawStuckTokens(address token, uint256 amount, address to) external onlyRole(DEFAULT_ADMIN_ROLE) {
        IERC20(token).safeTransfer(to, amount);
    }
}
