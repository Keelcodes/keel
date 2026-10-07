// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

// ============================================================================
// ERC-8312 — Bounded Agent Actions (draft of 2026-05-09, requires ERC-165).
//
// Declared locally on purpose: Keel depends on the *standard* surface, not on
// any reference implementation, and the repository already declares its
// ERC-7579 interfaces the same way (see `./IERC7579.sol`). `IERC165` is
// re-declared here rather than imported so this interface file has no external
// dependency and cannot be pulled in by a wider import graph.
//
// The interface is copied verbatim from the draft: the `Status` enum, the
// `Envelope` struct, the three events and the seven functions. Keel's own
// accounting profile (budget, aggregate/attenuation, contest) lives in the
// substrate (`../KeelBoundedActions.sol`), because ERC-8312 deliberately treats
// `capabilityRoot` as opaque.
// ============================================================================

interface IERC165 {
    /// @notice Returns true if this contract implements the interface defined by `interfaceId`.
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

interface IBoundedAgentAction is IERC165 {
    /// @notice Lifecycle status of an envelope. `None` is the "unknown id" result.
    enum Status {
        None, // 0: nonexistent / not registered
        Active, // 1
        Completed, // 2
        Contested, // 3
        Revoked, // 4
        Expired // 5
    }

    /// @notice An on-chain envelope: an immutable capability commitment plus a
    ///         mutable aggregate-state commitment, an expiry and a status.
    struct Envelope {
        bytes32 id;
        address principal;
        bytes32 capabilityRoot;
        bytes32 cursorRoot;
        uint64 createdAt;
        uint64 expiresAt;
        Status status;
    }

    event EnvelopeRegistered(bytes32 indexed id, address indexed principal, bytes32 indexed capabilityRoot);
    event EnvelopeAdvanced(bytes32 indexed id, bytes32 prevCursor, bytes32 newCursor);
    event EnvelopeStatusChanged(bytes32 indexed id, Status fromStatus, Status toStatus);

    /// @notice Registers a new envelope. `initData` fixes the initial cursor
    ///         (and, for Keel, the capability itself). MUST revert if the id is
    ///         taken, including by a historical (terminal) envelope.
    function registerEnvelope(
        address principal,
        bytes32 capabilityRoot,
        uint64 expiresAt,
        bytes calldata initData
    ) external returns (bytes32 id);

    function getEnvelope(bytes32 id) external view returns (Envelope memory);

    function getCursor(bytes32 id) external view returns (bytes32);

    function getStatus(bytes32 id) external view returns (Status);

    function isActive(bytes32 id) external view returns (bool);

    /// @notice Advances the cursor by one accepted draw, against a witness.
    function advanceCursor(bytes32 id, bytes calldata witness) external returns (bytes32 newCursor);

    /// @notice Moves the envelope along its lifecycle state machine.
    function setStatus(bytes32 id, Status newStatus) external;
}
