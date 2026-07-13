// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal interface into Circle's CCTP V2 MessageTransmitter — only the one function
/// ClawdHQCrossChainIdentity calls. Deployed by Circle itself at the same address on every CCTP
/// V2 testnet chain (see .env.example's `*_CCTP_MESSAGE_TRANSMITTER_ADDRESS`); this file does not
/// deploy or own that contract, it just declares enough of its ABI to call it.
/// @dev Reference: https://github.com/circlefin/evm-cctp-contracts (src/v2/MessageTransmitterV2.sol).
/// `destinationCaller` is passed as `bytes32(0)` by ClawdHQCrossChainIdentity, meaning any address
/// (in practice, the off-chain relayer in apps/indexer, or anyone) may submit the resulting
/// attestation via `receiveMessage` on the destination chain — the message's authenticity comes
/// from Circle's attestation, not from restricting who may relay it.
interface IMessageTransmitterV2 {
    function sendMessage(
        uint32 destinationDomain,
        bytes32 recipient,
        bytes32 destinationCaller,
        uint32 minFinalityThreshold,
        bytes calldata messageBody
    ) external;
}

/// @notice The receiver interface CCTP V2's MessageTransmitterV2 calls back into once an inbound
/// message's attestation has been verified on-chain — implementing this is what makes a contract
/// a valid CCTP V2 message recipient. Two callbacks, not one: V2 distinguishes "fast" (soft,
/// finality threshold below 2000) from "standard" (hard, >= 2000) attestations so the recipient
/// can choose which it's willing to trust.
/// @dev Reference: https://github.com/circlefin/evm-cctp-contracts
/// (src/interfaces/v2/IMessageHandlerV2.sol). MessageTransmitterV2 itself decides which of the
/// two methods to invoke based on the attestation's actual `finalityThresholdExecuted` — the
/// recipient does not choose per-call, only by which method(s) it implements meaningfully vs.
/// reverts on.
interface IMessageHandlerV2 {
    function handleReceiveFinalizedMessage(
        uint32 sourceDomain,
        bytes32 sender,
        uint32 finalityThresholdExecuted,
        bytes calldata messageBody
    ) external returns (bool);

    function handleReceiveUnfinalizedMessage(
        uint32 sourceDomain,
        bytes32 sender,
        uint32 finalityThresholdExecuted,
        bytes calldata messageBody
    ) external returns (bool);
}
