// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {KeelBoundedActions} from "../../src/KeelBoundedActions.sol";
import {IBoundedAgentAction} from "../../src/interfaces/IERC8312.sol";

/// @title KeelBoundedActions red-team suite
/// @notice Adversarial cases for the ERC-8312 substrate. Each test frames a
///         *bypass attempt* against one of the accounting profile's guarantees
///         and asserts it is refused. Threat ids (`T-ENVELOPE-*`) map to
///         `docs/THREAT_MODEL.md` and the conformance registry
///         (`packages/conformance/src/redteam.ts`).
contract KeelBoundedActionsRedTeamTest is Test {
    KeelBoundedActions internal registry;

    address internal constant OTHER = address(0x4444444444444444444444444444444444444444);

    bytes32 internal constant SALT = bytes32(uint256(0x5A17));
    uint256 internal constant NOW = 1_700_000_000;

    function setUp() public {
        registry = new KeelBoundedActions(address(this));
        vm.warp(NOW);
    }

    // ===================== helpers =====================

    function _noApprovers() internal pure returns (address[] memory) {
        return new address[](0);
    }

    function _capabilityData(uint256 cap, uint8 trustTier, bool delegate)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(
            uint256(1), address(0), cap, trustTier, uint256(0), delegate, uint256(0), _noApprovers()
        );
    }

    function _capabilityDataWithApprovers(
        uint256 cap,
        bool delegate,
        uint256 threshold,
        address[] memory approvers
    ) internal pure returns (bytes memory) {
        return abi.encode(uint256(1), address(0), cap, uint8(0), uint256(0), delegate, threshold, approvers);
    }

    function _register(bytes memory capabilityData, uint64 expiresAt) internal returns (bytes32 id) {
        id = registry.registerEnvelope(
            address(this), keccak256(capabilityData), expiresAt, abi.encode(SALT, capabilityData)
        );
    }

    function _draw(bytes32 id, uint256 amount) internal {
        registry.advanceCursor(id, abi.encode(amount, _noApprovers()));
    }

    // ===================== T-ENVELOPE: the aggregate budget =====================

    /// threat: T-ENVELOPE-01 — draw past the envelope's cap to escape the budget.
    function test_T_ENVELOPE_01_drawBeyondCapRefused() public {
        bytes32 id = _register(_capabilityData(10, 0, false), 0);
        _draw(id, 6);

        vm.expectRevert(KeelBoundedActions.CapExceeded.selector);
        _draw(id, 5);
    }

    /// threat: T-ENVELOPE-02 — an already-attenuated node re-delegates, widening
    ///         authority that the aggregate profile flattened.
    function test_T_ENVELOPE_02_attenuatedCannotRedelegate() public {
        bytes32 parentId = _register(_capabilityData(10, 2, true), 0);

        vm.expectRevert(KeelBoundedActions.AttenuationViolated.selector);
        registry.registerAttenuated(parentId, _capabilityData(5, 1, true), bytes32(uint256(1)));
    }

    /// threat: T-ENVELOPE-03 — child allocations sum past the root cap, conjuring
    ///         headroom the root was never granted.
    function test_T_ENVELOPE_03_allocationsCannotExceedRootCap() public {
        bytes32 parentId = _register(_capabilityData(10, 0, true), 0);
        registry.registerAttenuated(parentId, _capabilityData(6, 0, false), bytes32(uint256(1)));

        vm.expectRevert(KeelBoundedActions.ConservationViolated.selector);
        registry.registerAttenuated(parentId, _capabilityData(6, 0, false), bytes32(uint256(2)));
    }

    /// threat: T-ENVELOPE-04 — advance a revoked or expired envelope, whose
    ///         authority should no longer exist.
    function test_T_ENVELOPE_04_revokedOrExpiredAdvanceRefused() public {
        bytes32 revoked = _register(_capabilityData(10, 0, false), 0);
        registry.setStatus(revoked, IBoundedAgentAction.Status.Revoked);
        vm.expectRevert(KeelBoundedActions.NotActive.selector);
        _draw(revoked, 1);

        bytes32 expiring = _register(_capabilityData(11, 0, false), uint64(NOW + 10));
        vm.warp(NOW + 11);
        vm.expectRevert(KeelBoundedActions.NotActive.selector);
        _draw(expiring, 1);
    }

    /// threat: T-ENVELOPE-05 — a stranger advances a cursor or drives an
    ///         unauthorized status transition.
    function test_T_ENVELOPE_05_unauthorizedAdvanceAndStatusRefused() public {
        bytes32 id = _register(_capabilityData(10, 0, false), 0);

        vm.expectRevert(KeelBoundedActions.UnauthorizedAdvance.selector);
        vm.prank(OTHER);
        registry.advanceCursor(id, abi.encode(uint256(1), _noApprovers()));

        vm.expectRevert(KeelBoundedActions.UnauthorizedStatus.selector);
        vm.prank(OTHER);
        registry.setStatus(id, IBoundedAgentAction.Status.Revoked);
    }

    /// threat: T-ENVELOPE-06 — register a capability whose committed data does
    ///         not hash to the `capabilityRoot` it claims.
    function test_T_ENVELOPE_06_capabilityRootMismatchRefused() public {
        bytes memory capabilityData = _capabilityData(10, 0, false);

        vm.expectRevert(KeelBoundedActions.CapabilityRootMismatch.selector);
        registry.registerEnvelope(
            address(this), keccak256("something-else"), 0, abi.encode(SALT, capabilityData)
        );
    }

    /// threat: T-ENVELOPE-07 — replay/re-register the same
    ///         (principal, capabilityRoot, salt) to reset a spent cursor.
    function test_T_ENVELOPE_07_duplicateRegistrationRefused() public {
        bytes memory capabilityData = _capabilityData(10, 0, false);
        bytes32 id = _register(capabilityData, 0);
        _draw(id, 6);

        vm.expectRevert(KeelBoundedActions.EnvelopeExists.selector);
        registry.registerEnvelope(
            address(this), keccak256(capabilityData), 0, abi.encode(SALT, capabilityData)
        );
    }

    /// threat: T-ENVELOPE-09 — a delegate swaps its own approver set into an
    ///         attenuated child, replacing the principal's identity-based gate.
    function test_T_ENVELOPE_09_childApproversMustBeSubset() public {
        address approverA = address(uint160(0xA11CE));
        address approverB = address(uint160(0xB0B));

        address[] memory parentApprovers = new address[](2);
        parentApprovers[0] = approverA;
        parentApprovers[1] = approverB;
        bytes32 parentId = _register(_capabilityDataWithApprovers(10, true, 2, parentApprovers), 0);

        // Same threshold, but one approver is an outsider the delegate chose.
        address[] memory foreign = new address[](2);
        foreign[0] = approverA;
        foreign[1] = OTHER;
        vm.expectRevert(KeelBoundedActions.AttenuationViolated.selector);
        registry.registerAttenuated(
            parentId, _capabilityDataWithApprovers(5, false, 2, foreign), bytes32(uint256(1))
        );

        // A true subset of the parent's approvers is accepted.
        address[] memory subset = new address[](2);
        subset[0] = approverA;
        subset[1] = approverB;
        registry.registerAttenuated(
            parentId, _capabilityDataWithApprovers(5, false, 2, subset), bytes32(uint256(1))
        );
    }
}
