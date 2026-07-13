// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title AgentWalletRegistry
/// @notice Maps each agent to its own canonical custodied wallet (see
/// packages/custody-core/src/agentWalletCustody.ts), kept in a satellite contract rather than
/// inside ClawdHQCore because that contract already sits at Solidity's EIP-170 24576-byte
/// deployed-bytecode limit (see its own doc comment: "no room left... any new agent-related
/// functionality... belongs in its own contract, not this one") — same reasoning that already
/// put the ownership exchange and the x402 facilitator in their own contracts. ClawdHQCore
/// reads {agentWallet}'s auto-generated getter directly at payout time (job completion,
/// launchpad creator allocation) — a plain public mapping getter rather than a dedicated
/// `walletOrOwner`-style function, deliberately: ClawdHQCore has zero bytecode headroom to
/// spare (see its own doc comment), and encoding a call to an existing single-argument getter
/// costs meaningfully less than a custom two-argument function, with the owner-fallback check
/// done on ClawdHQCore's side instead of passed across the call boundary.
contract AgentWalletRegistry is Ownable {
    address public registrar;
    mapping(uint256 => address) public agentWallet;

    event RegistrarUpdated(address indexed previousRegistrar, address indexed newRegistrar);
    event AgentWalletSet(uint256 indexed agentId, address indexed wallet);

    error NotRegistrar();
    error ZeroAddress();
    error WalletAlreadySet();

    modifier onlyRegistrar() {
        if (msg.sender != registrar) revert NotRegistrar();
        _;
    }

    constructor(address initialOwner, address initialRegistrar) Ownable(initialOwner) {
        if (initialRegistrar == address(0)) revert ZeroAddress();
        registrar = initialRegistrar;
    }

    /// @notice One-time-settable: binds `agentId` to its off-chain-provisioned custodied
    /// wallet. Called by the indexer's privileged signer shortly after the agent registers on
    /// ClawdHQCore (see agentWalletCustody.ts's provisionAgentWallet). Reverts if already set —
    /// the wallet is meant to be a stable, permanent identity for the agent, not reassignable
    /// after the fact.
    function setAgentWallet(uint256 agentId, address wallet) external onlyRegistrar {
        if (wallet == address(0)) revert ZeroAddress();
        if (agentWallet[agentId] != address(0)) revert WalletAlreadySet();
        agentWallet[agentId] = wallet;
        emit AgentWalletSet(agentId, wallet);
    }

    /// @notice Rotates the authorized registrar signer — e.g. after a key-custody migration.
    function setRegistrar(address newRegistrar) external onlyOwner {
        if (newRegistrar == address(0)) revert ZeroAddress();
        emit RegistrarUpdated(registrar, newRegistrar);
        registrar = newRegistrar;
    }
}
