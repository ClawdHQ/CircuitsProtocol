// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IMessageHandlerV2} from "../interfaces/ICCTPMessageTransmitterV2.sol";

/// @notice Test-only stand-in for Circle's real MessageTransmitterV2. Real CCTP requires an
/// off-chain attestation step (Circle's Iris API) between `sendMessage` and `receiveMessage` that
/// Hardhat's local network cannot simulate — this mock instead exposes a `relayFinalized`/
/// `relayUnfinalized` helper that calls a recipient's handler directly, exactly as the real
/// contract would after a genuine attestation, letting tests exercise
/// ClawdHQCrossChainIdentity's receive-side logic without needing Circle's real infrastructure.
/// One shared instance stands in for "the CCTP network" across multiple
/// ClawdHQCrossChainIdentity instances in a test, each simulating a different chain via a
/// different `localDomain`.
contract MockMessageTransmitterV2 {
    event MessageSent(uint32 destinationDomain, bytes32 recipient, bytes32 destinationCaller, uint32 minFinalityThreshold, bytes messageBody);

    function sendMessage(
        uint32 destinationDomain,
        bytes32 recipient,
        bytes32 destinationCaller,
        uint32 minFinalityThreshold,
        bytes calldata messageBody
    ) external {
        emit MessageSent(destinationDomain, recipient, destinationCaller, minFinalityThreshold, messageBody);
    }

    /// @notice Test-only: simulates what happens after a real attestation is fetched and
    /// submitted via the real `receiveMessage` — directly invokes `recipient`'s
    /// `handleReceiveFinalizedMessage`, with this mock as `msg.sender`, exactly as the real
    /// MessageTransmitterV2 would post-attestation. Callable by anyone in tests; the real
    /// contract's security comes from Circle's attestation signature check, which this mock
    /// intentionally does not reimplement.
    function relayFinalized(address recipient, uint32 sourceDomain, bytes32 sender, bytes calldata messageBody) external returns (bool) {
        return IMessageHandlerV2(recipient).handleReceiveFinalizedMessage(sourceDomain, sender, 2000, messageBody);
    }

    function relayUnfinalized(address recipient, uint32 sourceDomain, bytes32 sender, bytes calldata messageBody) external returns (bool) {
        return IMessageHandlerV2(recipient).handleReceiveUnfinalizedMessage(sourceDomain, sender, 1000, messageBody);
    }
}
