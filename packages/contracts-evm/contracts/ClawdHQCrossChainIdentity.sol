// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

import {IClawdHQCore} from "./interfaces/IClawdHQCore.sol";
import {IMessageTransmitterV2, IMessageHandlerV2} from "./interfaces/ICCTPMessageTransmitterV2.sol";

/// @title ClawdHQCrossChainIdentity
/// @notice Lets an agent owner assert "this agent on chain A and that agent on chain B are the
/// same conceptual agent" — the cross-chain-identity gap identified comparing the AIP
/// Marketplace to Virtuals Protocol's ACP. Deployed independently (identical source, separate
/// proxy + separate storage) on Base Sepolia, Ethereum Sepolia, and Arc Testnet — the three CCTP
/// V2 testnet chains this app otherwise supports (BSC Testnet has no CCTP deployment; Solana's
/// CCTP integration is program-based, not EVM, and is out of scope here).
/// @dev Uses Circle's raw CCTP V2 message-passing primitive (MessageTransmitterV2.sendMessage /
/// the IMessageHandlerV2 receiver callbacks) rather than packages/circle/src/cctpBridge.ts's
/// higher-level wrapper — that wrapper is hardcoded to USDC value transfer
/// (TokenMessengerV2.depositForBurn) and has no path for carrying arbitrary bytes, which is all
/// this contract needs (it never moves any USDC itself).
///
/// Trust model, spelled out because it's the one genuinely novel piece of this whole gap-closing
/// effort: a `globalId` is `keccak256(originDomain, originAgentId, owner)` — the owner address is
/// one of the hash's own pre-images, so establishing a link on a second chain (via
/// {claimLocalAgent}) requires the *same* address to own an agent there too. This deliberately
/// does not support "agent owned by address X on chain A is the same as agent owned by address Y
/// on chain B" — a v1 simplification, not an oversight. Inbound messages are trusted because
/// (a) only the real MessageTransmitterV2 can ever call {handleReceiveFinalizedMessage} (it
/// verifies Circle's attestation signature before invoking any recipient), and (b) this contract
/// additionally checks the attested `sender` against {peerContractByDomain}, so only messages
/// originated by this same contract's own deployment on a *trusted, admin-configured* sibling
/// chain are ever accepted — arbitrary CCTP traffic addressed to us from anywhere else reverts.
///
/// @dev Genuinely higher-risk/lower-precedent than this codebase's other satellites: raw CCTP
/// message contracts, a hand-rolled attestation relay (apps/indexer), no in-repo pattern to lean
/// on. Correctness beyond Hardhat's local-network tests (which cannot simulate Circle's real
/// attestation service) requires a live testnet smoke test — see the deploy scripts' doc
/// comments for the manual steps.
contract ClawdHQCrossChainIdentity is Initializable, AccessControlUpgradeable, PausableUpgradeable, UUPSUpgradeable, IMessageHandlerV2 {
    // ============================================================ Roles ===

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @notice CCTP V2 finality threshold at/above which a message is considered "hard" finalized
    /// (see IMessageHandlerV2's doc comment). This contract only ever sends at this threshold and
    /// only ever accepts inbound messages at this threshold — identity links have no reason to
    /// trade security for the speed a lower "fast transfer" threshold would buy.
    uint32 public constant FINALITY_THRESHOLD = 2000;

    // ======================================================== Storage =====

    IClawdHQCore public core;
    IMessageTransmitterV2 public messageTransmitter;
    uint32 public localDomain;

    mapping(uint32 => bytes32) public peerContractByDomain; // CCTP domain => sibling deployment (as bytes32)
    mapping(uint32 => bool) public isPeerDomainTracked; // guards {peerDomains} against duplicate pushes if a peer is toggled off/on
    uint32[] public peerDomains; // iterable list of ever-configured peer domains, for {registerLink}'s broadcast

    mapping(bytes32 => address) public ownerOfGlobalId; // globalId => owner, once established (locally or via an attested inbound message)
    mapping(bytes32 => uint256) public localAgentIdOfGlobalId; // globalId => this chain's local agent id claimed under it (0 = not yet claimed here)
    mapping(uint256 => bytes32) public globalIdOfLocalAgent; // reverse lookup for UI convenience

    // ========================================================= Events =====

    event LinkRegistered(uint256 indexed localAgentId, bytes32 indexed globalId, address indexed owner);
    event LinkAttested(bytes32 indexed globalId, uint32 indexed sourceDomain, uint256 sourceAgentId, address owner);
    event LocalAgentClaimed(bytes32 indexed globalId, uint256 indexed localAgentId, address indexed owner);
    event PeerUpdated(uint32 indexed domain, address peerContract);

    // ========================================================= Errors =====

    error NotAgentOwner();
    error NotMessageTransmitter();
    error UntrustedSender();
    error UnfinalizedMessagesNotSupported();
    error GlobalIdNotFound();
    error OwnerMismatch();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin, address coreAddress, uint32 localDomain_, address messageTransmitterAddress) external initializer {
        __AccessControl_init();
        __Pausable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);

        core = IClawdHQCore(coreAddress);
        localDomain = localDomain_;
        messageTransmitter = IMessageTransmitterV2(messageTransmitterAddress);
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    // ===================================================== Origination =====

    /// @notice Originates (or re-broadcasts — this is idempotent and safe to retry) a global
    /// identity for `localAgentId`, owned by `msg.sender`, and relays it to every configured peer
    /// chain over CCTP. Safe to call again if an earlier relay never landed (e.g. the off-chain
    /// relayer missed the event, or Circle's attestation timed out) — the recomputed `globalId`
    /// is identical every time for the same (domain, agentId, owner) triple, so re-sending is a
    /// harmless no-op on chains that already received it.
    function registerLink(uint256 localAgentId) external whenNotPaused returns (bytes32 globalId) {
        (, address owner) = core.agents(localAgentId);
        if (owner != msg.sender) revert NotAgentOwner();

        globalId = keccak256(abi.encode(localDomain, localAgentId, owner));
        ownerOfGlobalId[globalId] = owner;
        localAgentIdOfGlobalId[globalId] = localAgentId;
        globalIdOfLocalAgent[localAgentId] = globalId;
        emit LinkRegistered(localAgentId, globalId, owner);

        bytes memory messageBody = abi.encode(globalId, localDomain, localAgentId, owner);
        uint256 length = peerDomains.length;
        for (uint256 i = 0; i < length; i++) {
            uint32 destinationDomain = peerDomains[i];
            bytes32 recipient = peerContractByDomain[destinationDomain];
            if (recipient == bytes32(0)) continue; // peer was configured once, then unset — skip rather than send nowhere
            messageTransmitter.sendMessage(destinationDomain, recipient, bytes32(0), FINALITY_THRESHOLD, messageBody);
        }
    }

    /// @notice Attaches a local agent on *this* chain to a global identity already established
    /// elsewhere (via an attested inbound {handleReceiveFinalizedMessage}) — or on this chain
    /// itself, a redundant but harmless no-op if called after {registerLink} already set it.
    /// Requires the caller to own both the local agent being claimed *and* the address the global
    /// identity was originated under.
    function claimLocalAgent(bytes32 globalId, uint256 localAgentId) external whenNotPaused {
        address expectedOwner = ownerOfGlobalId[globalId];
        if (expectedOwner == address(0)) revert GlobalIdNotFound();
        if (expectedOwner != msg.sender) revert OwnerMismatch();

        (, address localOwner) = core.agents(localAgentId);
        if (localOwner != msg.sender) revert NotAgentOwner();

        localAgentIdOfGlobalId[globalId] = localAgentId;
        globalIdOfLocalAgent[localAgentId] = globalId;
        emit LocalAgentClaimed(globalId, localAgentId, msg.sender);
    }

    // ================================================== CCTP receiver =====

    /// @inheritdoc IMessageHandlerV2
    function handleReceiveFinalizedMessage(
        uint32 sourceDomain,
        bytes32 sender,
        uint32, /* finalityThresholdExecuted */
        bytes calldata messageBody
    ) external override whenNotPaused returns (bool) {
        if (msg.sender != address(messageTransmitter)) revert NotMessageTransmitter();
        if (sender == bytes32(0) || peerContractByDomain[sourceDomain] != sender) revert UntrustedSender();

        (bytes32 globalId, , uint256 sourceAgentId, address owner) = abi.decode(messageBody, (bytes32, uint32, uint256, address));

        // `owner` is one of globalId's own hash pre-images (see contract-level doc comment), so a
        // legitimate message can never carry a globalId that disagrees with an already-recorded
        // owner — safe to set unconditionally rather than branch on "already set".
        ownerOfGlobalId[globalId] = owner;
        emit LinkAttested(globalId, sourceDomain, sourceAgentId, owner);
        return true;
    }

    /// @inheritdoc IMessageHandlerV2
    /// @dev Always reverts — this contract only ever sends at {FINALITY_THRESHOLD} (hard
    /// finality), so a legitimate message from a trusted peer should never route here. Rejecting
    /// outright, rather than accepting a lower-confidence attestation, is the safer default for
    /// identity claims, which have no reason to trade security for speed.
    function handleReceiveUnfinalizedMessage(uint32, bytes32, uint32, bytes calldata) external pure override returns (bool) {
        revert UnfinalizedMessagesNotSupported();
    }

    // ============================================================== Admin =

    /// @notice Registers (or updates) the sibling deployment on `domain` as a trusted message
    /// source/destination. Must be called on all 3 chains, pointing at each of the other 2, after
    /// all 3 have been deployed — a deploy-time chicken-and-egg (see
    /// scripts/deploy-evm/02g-configure-cross-chain-identity-peers.ts). Passing `address(0)`
    /// disables the peer (its messages will be rejected, and {registerLink} will skip sending to
    /// it) without needing a separate "remove" method.
    function setPeer(uint32 domain, address peerContract) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!isPeerDomainTracked[domain]) {
            isPeerDomainTracked[domain] = true;
            peerDomains.push(domain);
        }
        peerContractByDomain[domain] = bytes32(uint256(uint160(peerContract)));
        emit PeerUpdated(domain, peerContract);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }
}
