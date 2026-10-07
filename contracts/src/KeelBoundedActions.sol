// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {IBoundedAgentAction} from "./interfaces/IERC8312.sol";

// ============================================================================
// KeelBoundedActions — the on-chain substrate for ERC-8312 Bounded Agent
// Actions, plus Keel's own accounting profile.
//
// ERC-8312 defines a narrow *envelope*: a principal, an immutable capability
// commitment (`capabilityRoot`), a mutable aggregate-state commitment
// (`cursorRoot`), an expiry and a lifecycle status. The standard is explicit
// that it does **accounting, not enforcement** ("counting ≠ enforcing");
// non-bypassability is a property of the substrate that owns the assets or
// gates the account's only execution path (see `KeelPolicyHook`).
//
// This contract is the on-chain half of Keel's substrate and mirrors
// `packages/policy/src/bounded.ts` byte-for-byte:
//   * `capabilityData = abi.encode(version, asset, cap, trustTier, notBefore,
//     delegate, threshold, approvers)` and `capabilityRoot = keccak256(...)`;
//   * `cursorData = abi.encode(spent, draws, lastAdvance)`, `cursorRoot =
//     keccak256(...)`;
//   * `id = keccak256(abi.encode(registry, principal, capabilityRoot, salt))`.
// So the two layers can never disagree about what a capability means.
//
// ERC-8312 leaves `capabilityRoot` opaque on purpose, so everything *inside*
// the capability (trust tier, release gate, approval set) is Keel's own
// profile, not a claim of standard conformance. What is standard is the
// envelope shape, the cursor, the budget profile (`spent <= cap`), the
// aggregate profile's conservation/attenuation rules and the status machine.
//
// Aligned with the draft of 2026-05-09 (requires ERC-165); see
// `docs/BOUNDED_ACTIONS.md` for the exact revision and the honest boundaries.
// ============================================================================

/// @dev Canonical capability, matching `encodeCapability` off-chain field-by-field.
///      Declared at file level so the ABI tuple is decodable from any source unit.
struct Capability {
    uint256 version;
    address asset;
    uint256 cap;
    uint8 trustTier;
    uint256 notBefore;
    bool delegate;
    uint256 threshold;
    address[] approvers;
}

/// @dev Running aggregate state, matching `encodeCursor` off-chain field-by-field.
struct Cursor {
    uint256 spent;
    uint256 draws;
    uint256 lastAdvance;
}

contract KeelBoundedActions is IBoundedAgentAction {
    // --- everything stored for one envelope ---
    struct Record {
        Envelope envelope;
        Capability capability;
        Cursor cursor;
        bytes32 parentId;
        bool attenuated;
        uint256 contestedAt;
        uint256 resolutionDeadline;
    }

    /// @notice Schema version mixed into the capability, so a future profile
    ///         change can never collide with an older one.
    uint256 public constant CAPABILITY_VERSION = 1;

    /// @notice Admin that may configure gates and the contest window. Supplied
    ///         at construction — deliberately *not* `msg.sender`: this contract
    ///         is deployed through the CREATE2 deterministic proxy, where
    ///         `msg.sender` is the proxy itself, which would leave the admin
    ///         surface (`setGate`, `setContestWindow`) permanently unreachable.
    address public owner;

    /// @notice The contest window opened by a challenge; owner-tunable.
    uint256 public contestWindow = 3 days;

    /// @notice Addresses permitted to register on a principal's behalf and to
    ///         advance a cursor (e.g. `KeelPolicyHook`). A gate is trusted to
    ///         have obtained upstream authorization (EIP-712 / ERC-1271).
    mapping(address => bool) public isGate;

    mapping(bytes32 id => Record) private _records;

    /// @notice Sum of child allocations keyed by the parent's `capabilityRoot`
    ///         (a root-keyed meter, so identical capabilities share one budget).
    mapping(bytes32 capabilityRoot => uint256) private _allocated;

    error CapabilityRootMismatch();
    error EnvelopeExists();
    error UnknownEnvelope();
    error NotActive();
    error NotYetReleased();
    error ApprovalRequired();
    error CapExceeded();
    error IllegalTransition();
    error UnauthorizedAdvance();
    error UnauthorizedStatus();
    error UnauthorizedRegistration();
    error ConservationViolated();
    error AttenuationViolated();
    error InvalidExpiry();
    error UnsupportedVersion(uint256 version);
    error NotOwner();
    error InvalidContestWindow();

    constructor(address initialOwner) {
        owner = initialOwner;
    }

    // ===================== admin =====================

    /// @notice Adds or removes a gateway (e.g. the policy hook) allowed to
    ///         register and to advance cursors.
    function setGate(address gate, bool allowed) external {
        if (msg.sender != owner) revert NotOwner();
        isGate[gate] = allowed;
    }

    /// @notice Sets the contest resolution window; MUST be greater than zero.
    function setContestWindow(uint256 window) external {
        if (msg.sender != owner) revert NotOwner();
        if (window == 0) revert InvalidContestWindow();
        contestWindow = window;
    }

    // ===================== registration =====================

    /// @notice Registers an envelope.
    ///
    ///         `initData = abi.encode(bytes32 salt, bytes capabilityData)`,
    ///         where `capabilityData` is the canonical capability encoding from
    ///         `bounded.ts`; `capabilityRoot` MUST be `keccak256(capabilityData)`.
    ///         The initial cursor is the zero cursor (`ZERO_CURSOR`), readable
    ///         immediately after registration.
    ///
    ///         Authorization: the principal may register for itself; a registered
    ///         gate may register on a principal's behalf (taken as proof of
    ///         upstream authorization — EIP-712 / ERC-1271 delegation is a
    ///         documented future extension).
    function registerEnvelope(
        address principal,
        bytes32 capabilityRoot,
        uint64 expiresAt,
        bytes calldata initData
    ) external returns (bytes32 id) {
        bytes memory init = initData;
        (bytes32 salt, bytes memory capabilityData) = abi.decode(init, (bytes32, bytes));
        if (keccak256(capabilityData) != capabilityRoot) revert CapabilityRootMismatch();

        Capability memory capability = _decodeCapability(capabilityData);
        if (capability.version != CAPABILITY_VERSION) revert UnsupportedVersion(capability.version);
        // `expiresAt == 0` means "no expiry"; anything else must be in the future.
        if (expiresAt != 0 && expiresAt <= block.timestamp) revert InvalidExpiry();
        if (principal != msg.sender && !isGate[msg.sender]) revert UnauthorizedRegistration();

        id = _createEnvelope(principal, capabilityRoot, salt, expiresAt, capability);
    }

    /// @notice Precomputes the deterministic id for a prospective envelope, so a
    ///         reference can be embedded upstream before registration.
    function precomputeId(address principal, bytes32 capabilityRoot, bytes32 salt)
        external
        view
        returns (bytes32)
    {
        return _deriveId(principal, capabilityRoot, salt);
    }

    /// @notice Derives an attenuated child envelope from an Active parent
    ///         (the aggregate profile).
    ///
    ///         `childCapabilityData` MUST be no wider than the parent (same
    ///         asset, `cap <=`, `trustTier <=`, `notBefore >=`, `threshold >=`,
    ///         `approvers ⊆`) and MUST NOT itself delegate. The conservation rule
    ///         (`Σ child.cap <= parent.cap`) is enforced with a root-keyed
    ///         meter. The child inherits the parent's principal and expiry (a
    ///         child may not outlive its parent).
    function registerAttenuated(bytes32 parentId, bytes calldata childCapabilityData, bytes32 salt)
        external
        returns (bytes32 childId)
    {
        Record storage parent = _records[parentId];
        if (parent.envelope.status == Status.None) revert UnknownEnvelope();
        if (_effectiveStatus(parent) != Status.Active) revert NotActive();
        // A parent that cannot delegate, or is itself attenuated, may not spawn.
        if (!parent.capability.delegate || parent.attenuated) revert AttenuationViolated();
        if (msg.sender != parent.envelope.principal && !isGate[msg.sender]) {
            revert UnauthorizedRegistration();
        }

        bytes memory childData = childCapabilityData;
        Capability memory child = _decodeCapability(childData);
        if (child.version != CAPABILITY_VERSION) revert UnsupportedVersion(child.version);
        _checkAttenuation(parent.capability, child);

        // Conservation: leaf allocations may not conjure headroom the root was
        // never granted. Charge the root-keyed meter before deriving the child.
        bytes32 parentRoot = parent.envelope.capabilityRoot;
        if (_allocated[parentRoot] + child.cap > parent.capability.cap) revert ConservationViolated();
        _allocated[parentRoot] += child.cap;

        bytes32 childRoot = keccak256(childData);
        childId =
            _createEnvelope(parent.envelope.principal, childRoot, salt, parent.envelope.expiresAt, child);

        Record storage childRecord = _records[childId];
        childRecord.parentId = parentId;
        childRecord.attenuated = true;
    }

    // ===================== standard reads =====================

    function getEnvelope(bytes32 id) external view returns (Envelope memory) {
        return _records[id].envelope;
    }

    function getCursor(bytes32 id) external view returns (bytes32) {
        return _records[id].envelope.cursorRoot;
    }

    /// @notice Returns the *effective* status: an Active envelope past its
    ///         expiry reads as `Expired`; an unknown id reads as `None`.
    function getStatus(bytes32 id) external view returns (Status) {
        Record storage record = _records[id];
        if (record.envelope.status == Status.None) return Status.None;
        return _effectiveStatus(record);
    }

    /// @notice True only while the envelope is Active and not expired.
    function isActive(bytes32 id) external view returns (bool) {
        Record storage record = _records[id];
        if (record.envelope.status == Status.None) return false;
        return _effectiveStatus(record) == Status.Active;
    }

    // ===================== cursor =====================

    /// @notice Advances the cursor by one accepted draw.
    ///
    ///         `witness = abi.encode(uint256 amount, address[] approvals)`. The
    ///         gates run in the same order as `canDraw` off-chain: status →
    ///         notBefore → approvals → cap. (`trustTier` is a consumer-side
    ///         minimum, so the substrate does not enforce it.) The caller must
    ///         be the principal or a registered gate.
    function advanceCursor(bytes32 id, bytes calldata witness) external returns (bytes32 newCursor) {
        Record storage record = _records[id];
        if (record.envelope.status == Status.None) revert UnknownEnvelope();
        if (!isGate[msg.sender] && msg.sender != record.envelope.principal) revert UnauthorizedAdvance();
        if (_effectiveStatus(record) != Status.Active) revert NotActive();

        (uint256 amount, address[] memory approvals) = abi.decode(witness, (uint256, address[]));
        Capability storage capability = record.capability;

        if (capability.notBefore != 0 && block.timestamp < capability.notBefore) revert NotYetReleased();
        if (!_approvalsSatisfied(capability, approvals)) revert ApprovalRequired();

        Cursor memory cursor = record.cursor;
        if (cursor.spent + amount > capability.cap) revert CapExceeded();

        cursor.spent += amount;
        cursor.draws += 1;
        cursor.lastAdvance = block.timestamp;
        record.cursor = cursor;

        bytes32 prevCursor = record.envelope.cursorRoot;
        newCursor = keccak256(abi.encode(cursor.spent, cursor.draws, cursor.lastAdvance));
        record.envelope.cursorRoot = newCursor;

        emit EnvelopeAdvanced(id, prevCursor, newCursor);
    }

    // ===================== lifecycle =====================

    /// @notice Moves the envelope along the status state machine.
    ///
    ///         Active → {Completed, Contested, Revoked, Expired}
    ///         Contested → {Active (dismissed), Revoked (upheld)}
    ///         Completed / Revoked / Expired are terminal.
    ///
    ///         Authorization: the principal drives Active→{Completed, Contested,
    ///         Revoked} and Contested→{Active, Revoked}; once the contest window
    ///         lapses any caller may resolve a contest back to Active (the
    ///         documented default, so an accused party cannot run out the
    ///         clock); once expired any caller may mark an Active envelope
    ///         Expired.
    function setStatus(bytes32 id, Status newStatus) external {
        Record storage record = _records[id];
        Status from = record.envelope.status;
        if (from == Status.None) revert UnknownEnvelope();
        if (!_canTransition(from, newStatus)) revert IllegalTransition();
        if (!_isAuthorizedStatusChange(record, from, newStatus)) revert UnauthorizedStatus();

        if (newStatus == Status.Contested) {
            record.contestedAt = block.timestamp;
            record.resolutionDeadline = block.timestamp + contestWindow;
        }
        record.envelope.status = newStatus;

        emit EnvelopeStatusChanged(id, from, newStatus);
    }

    // ===================== ERC-165 =====================

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == type(IBoundedAgentAction).interfaceId;
    }

    // ===================== reconciliation helpers =====================

    /// @notice The full capability committed by an envelope (Keel profile).
    function capabilityOf(bytes32 id) external view returns (Capability memory) {
        return _records[id].capability;
    }

    /// @notice The raw cursor fields behind `cursorRoot`.
    function rawCursorOf(bytes32 id)
        external
        view
        returns (uint256 spent, uint256 draws, uint256 lastAdvance)
    {
        Cursor storage cursor = _records[id].cursor;
        return (cursor.spent, cursor.draws, cursor.lastAdvance);
    }

    /// @notice Budget allocated to children so far, keyed by `capabilityRoot`.
    function allocatedOf(bytes32 capabilityRoot) external view returns (uint256) {
        return _allocated[capabilityRoot];
    }

    /// @notice Remaining headroom under an envelope's cap; never negative.
    function remainingOf(bytes32 id) external view returns (uint256) {
        Record storage record = _records[id];
        if (record.cursor.spent >= record.capability.cap) return 0;
        return record.capability.cap - record.cursor.spent;
    }

    // ===================== internal =====================

    /// @dev Decodes the canonical capability tuple into a `Capability`.
    ///
    ///      Decoded as an explicit tuple rather than `abi.decode(.., (Capability))`:
    ///      under this project's `via_ir` build (solc 0.8.24) the struct decoder
    ///      for a struct with a dynamic member reverts on otherwise-valid data,
    ///      while the equivalent tuple decoder is correct. The wire format — and
    ///      therefore `capabilityRoot` — is identical.
    function _decodeCapability(bytes memory data) internal pure returns (Capability memory capability) {
        (
            uint256 version,
            address asset,
            uint256 cap,
            uint8 trustTier,
            uint256 notBefore,
            bool delegateFlag,
            uint256 threshold,
            address[] memory approvers
        ) = abi.decode(data, (uint256, address, uint256, uint8, uint256, bool, uint256, address[]));

        capability.version = version;
        capability.asset = asset;
        capability.cap = cap;
        capability.trustTier = trustTier;
        capability.notBefore = notBefore;
        capability.delegate = delegateFlag;
        capability.threshold = threshold;
        capability.approvers = approvers;
    }

    /// @dev Stores a fresh Active envelope with the zero cursor and emits the
    ///      standard registration event.
    function _createEnvelope(
        address principal,
        bytes32 capabilityRoot,
        bytes32 salt,
        uint64 expiresAt,
        Capability memory capability
    ) internal returns (bytes32 id) {
        id = _deriveId(principal, capabilityRoot, salt);
        if (_records[id].envelope.status != Status.None) revert EnvelopeExists();

        Record storage record = _records[id];
        record.envelope = Envelope({
            id: id,
            principal: principal,
            capabilityRoot: capabilityRoot,
            cursorRoot: keccak256(abi.encode(uint256(0), uint256(0), uint256(0))),
            createdAt: uint64(block.timestamp),
            expiresAt: expiresAt,
            status: Status.Active
        });
        record.capability = capability;

        emit EnvelopeRegistered(id, principal, capabilityRoot);
    }

    /// @dev Deterministic id, per the standard's recommended derivation.
    function _deriveId(address principal, bytes32 capabilityRoot, bytes32 salt)
        internal
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(address(this), principal, capabilityRoot, salt));
    }

    /// @dev Narrowing only: the child may not be wider than the parent, and an
    ///      attenuated node may never delegate further (so widening cannot be
    ///      re-introduced transitively).
    function _checkAttenuation(Capability storage parent, Capability memory child) internal view {
        if (child.asset != parent.asset) revert AttenuationViolated();
        if (child.cap > parent.cap) revert AttenuationViolated();
        if (child.trustTier > parent.trustTier) revert AttenuationViolated();
        if (child.notBefore < parent.notBefore) revert AttenuationViolated();
        if (child.threshold < parent.threshold) revert AttenuationViolated();
        if (child.delegate) revert AttenuationViolated();
        // The approval gate is identity-based, so a non-weaker threshold is not
        // enough: every child approver must already be one of the parent's, or a
        // delegate could swap in an approver set of its own choosing.
        uint256 childApprovers = child.approvers.length;
        for (uint256 i; i < childApprovers; ++i) {
            if (!_isApprover(parent.approvers, child.approvers[i])) revert AttenuationViolated();
        }
    }

    /// @dev Membership test over the parent's approver set.
    function _isApprover(address[] storage approvers, address who) internal view returns (bool) {
        uint256 length = approvers.length;
        for (uint256 i; i < length; ++i) {
            if (approvers[i] == who) return true;
        }
        return false;
    }

    function _effectiveStatus(Record storage record) internal view returns (Status) {
        if (
            record.envelope.status == Status.Active && record.envelope.expiresAt != 0
                && block.timestamp > record.envelope.expiresAt
        ) {
            return Status.Expired;
        }
        return record.envelope.status;
    }

    function _canTransition(Status from, Status to) internal pure returns (bool) {
        if (from == Status.Active) {
            return
                to == Status.Completed || to == Status.Contested || to == Status.Revoked
                    || to == Status.Expired;
        }
        if (from == Status.Contested) return to == Status.Active || to == Status.Revoked;
        return false;
    }

    function _isAuthorizedStatusChange(Record storage record, Status from, Status to)
        internal
        view
        returns (bool)
    {
        if (msg.sender == record.envelope.principal) {
            if (
                from == Status.Active
                    && (to == Status.Completed || to == Status.Contested || to == Status.Revoked)
            ) {
                return true;
            }
            if (from == Status.Contested && (to == Status.Active || to == Status.Revoked)) return true;
        }
        // Default resolution: a lapsed contest returns to Active for anyone.
        if (from == Status.Contested && to == Status.Active) {
            return record.resolutionDeadline != 0 && block.timestamp > record.resolutionDeadline;
        }
        // Only an actually-expired envelope may be marked Expired, by anyone.
        if (from == Status.Active && to == Status.Expired) {
            return record.envelope.expiresAt != 0 && block.timestamp > record.envelope.expiresAt;
        }
        return false;
    }

    /// @dev Whether the collected `approvals` satisfy the capability's M-of-N
    ///      gate, counting distinct authorized approvers (mirrors `approvalsSatisfied`).
    function _approvalsSatisfied(Capability storage capability, address[] memory approvals)
        internal
        view
        returns (bool)
    {
        uint256 threshold = capability.threshold;
        if (threshold == 0) return true;

        uint256 seen;
        uint256 n = capability.approvers.length;
        for (uint256 i; i < n; ++i) {
            for (uint256 j; j < approvals.length; ++j) {
                if (approvals[j] == capability.approvers[i]) {
                    seen += 1;
                    break;
                }
            }
            if (seen >= threshold) return true;
        }
        return false;
    }
}
