// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Capability, KeelBoundedActions} from "../src/KeelBoundedActions.sol";
import {IBoundedAgentAction} from "../src/interfaces/IERC8312.sol";

/// @title KeelBoundedActions functional suite
/// @notice Exercises the ERC-8312 substrate: registration/id derivation, budget
///         draws, the lifecycle state machine, the aggregate
///         (conservation/attenuation) profile and the cross-layer commitment
///         consistency with `packages/policy/src/bounded.ts`.
contract KeelBoundedActionsTest is Test {
    KeelBoundedActions internal registry;

    address internal constant APPROVER_A = address(0xA1);
    address internal constant APPROVER_B = address(0xB2);
    address internal constant OTHER = address(0x4444444444444444444444444444444444444444);

    bytes32 internal constant SALT = bytes32(uint256(0x5A17));

    uint256 internal constant NOW = 1_700_000_000;

    function setUp() public {
        registry = new KeelBoundedActions(address(this));
        vm.warp(NOW);
    }

    // ===================== helpers =====================

    /// Canonical capability encoding, byte-for-byte the same tuple as
    /// `encodeCapability` in bounded.ts.
    function _capabilityData(
        uint256 cap,
        uint8 trustTier,
        uint256 notBefore,
        bool delegate,
        uint256 threshold,
        address[] memory approvers
    ) internal pure returns (bytes memory) {
        return abi.encode(uint256(1), address(0), cap, trustTier, notBefore, delegate, threshold, approvers);
    }

    function _noApprovers() internal pure returns (address[] memory) {
        return new address[](0);
    }

    function _approvers() internal pure returns (address[] memory list) {
        list = new address[](2);
        list[0] = APPROVER_A;
        list[1] = APPROVER_B;
    }

    function _plain(uint256 cap) internal pure returns (bytes memory) {
        return _capabilityData(cap, 0, 0, false, 0, _noApprovers());
    }

    function _parentData(uint256 cap, uint8 tier, uint256 notBefore, uint256 threshold, uint256 approverCount)
        internal
        pure
        returns (bytes memory)
    {
        address[] memory approvers = approverCount == 0 ? _noApprovers() : _approvers();
        return _capabilityData(cap, tier, notBefore, true, threshold, approvers);
    }

    function _childData(
        uint256 cap,
        uint8 tier,
        uint256 notBefore,
        bool delegate,
        uint256 threshold,
        uint256 approverCount
    ) internal pure returns (bytes memory) {
        address[] memory approvers = approverCount == 0 ? _noApprovers() : _approvers();
        return _capabilityData(cap, tier, notBefore, delegate, threshold, approvers);
    }

    function _register(bytes memory capabilityData, uint64 expiresAt) internal returns (bytes32 id) {
        id = registry.registerEnvelope(
            address(this), keccak256(capabilityData), expiresAt, abi.encode(SALT, capabilityData)
        );
    }

    function _registerPlain(uint256 cap) internal returns (bytes32 id) {
        return _register(_plain(cap), 0);
    }

    function _draw(bytes32 id, uint256 amount) internal {
        registry.advanceCursor(id, abi.encode(amount, _noApprovers()));
    }

    function _drawWith(bytes32 id, uint256 amount, address[] memory approvals) internal {
        registry.advanceCursor(id, abi.encode(amount, approvals));
    }

    function _zeroCursorRoot() internal pure returns (bytes32) {
        return keccak256(abi.encode(uint256(0), uint256(0), uint256(0)));
    }

    function _assertStatus(bytes32 id, IBoundedAgentAction.Status expected) internal view {
        assertEq(uint8(registry.getStatus(id)), uint8(expected));
    }

    // ===================== admin =====================

    /// The admin is the address handed to the constructor, not `msg.sender`:
    /// under the CREATE2 deterministic proxy `msg.sender` is the proxy, so
    /// deriving the owner from it would strand the admin surface forever.
    function test_admin_ownerIsConstructorArgument() public {
        address admin = address(0xBEEF);
        KeelBoundedActions owned = new KeelBoundedActions(admin);
        assertEq(owned.owner(), admin);

        vm.prank(admin);
        owned.setGate(address(0x9A7E), true);
        assertTrue(owned.isGate(address(0x9A7E)));
    }

    function test_admin_nonOwnerCannotConfigure() public {
        vm.prank(OTHER);
        vm.expectRevert(KeelBoundedActions.NotOwner.selector);
        registry.setGate(address(0x9A7E), true);

        vm.prank(OTHER);
        vm.expectRevert(KeelBoundedActions.NotOwner.selector);
        registry.setContestWindow(1 days);
    }

    // ===================== registration =====================

    function test_register_idIsDeterministic() public {
        bytes memory capabilityData = _plain(10);
        bytes32 root = keccak256(capabilityData);

        bytes32 expected = keccak256(abi.encode(address(registry), address(this), root, SALT));
        assertEq(registry.precomputeId(address(this), root, SALT), expected);

        bytes32 id = _register(capabilityData, 0);
        assertEq(id, expected);
        assertEq(registry.getEnvelope(id).id, id);
    }

    function test_register_initialStateIsActiveWithZeroCursor() public {
        bytes32 id = _registerPlain(10);

        _assertStatus(id, IBoundedAgentAction.Status.Active);
        assertTrue(registry.isActive(id));
        assertEq(registry.getCursor(id), _zeroCursorRoot());

        (uint256 spent, uint256 draws, uint256 lastAdvance) = registry.rawCursorOf(id);
        assertEq(spent, 0);
        assertEq(draws, 0);
        assertEq(lastAdvance, 0);

        IBoundedAgentAction.Envelope memory envelope = registry.getEnvelope(id);
        assertEq(envelope.principal, address(this));
        assertEq(envelope.createdAt, uint64(NOW));
        assertEq(envelope.expiresAt, 0);
    }

    function test_register_rejectsDuplicateId() public {
        bytes memory capabilityData = _plain(10);
        _register(capabilityData, 0);

        vm.expectRevert(KeelBoundedActions.EnvelopeExists.selector);
        registry.registerEnvelope(
            address(this), keccak256(capabilityData), 0, abi.encode(SALT, capabilityData)
        );
    }

    function test_register_rejectsCapabilityRootMismatch() public {
        bytes memory capabilityData = _plain(10);
        vm.expectRevert(KeelBoundedActions.CapabilityRootMismatch.selector);
        registry.registerEnvelope(address(this), keccak256("wrong"), 0, abi.encode(SALT, capabilityData));
    }

    function test_register_rejectsUnsupportedVersion() public {
        bytes memory bad = abi.encode(
            uint256(2), address(0), uint256(10), uint8(0), uint256(0), false, uint256(0), _noApprovers()
        );
        bytes32 root = keccak256(bad);
        vm.expectRevert(abi.encodeWithSelector(KeelBoundedActions.UnsupportedVersion.selector, 2));
        registry.registerEnvelope(address(this), root, 0, abi.encode(SALT, bad));
    }

    function test_register_rejectsInvalidExpiry() public {
        bytes memory capabilityData = _plain(10);
        bytes32 root = keccak256(capabilityData);

        vm.expectRevert(KeelBoundedActions.InvalidExpiry.selector);
        registry.registerEnvelope(address(this), root, uint64(NOW), abi.encode(SALT, capabilityData));

        vm.expectRevert(KeelBoundedActions.InvalidExpiry.selector);
        registry.registerEnvelope(address(this), root, uint64(NOW - 1), abi.encode(SALT, capabilityData));
    }

    function test_register_rejectsUnauthorizedPrincipal() public {
        bytes memory capabilityData = _plain(10);
        bytes32 root = keccak256(capabilityData);

        vm.expectRevert(KeelBoundedActions.UnauthorizedRegistration.selector);
        vm.prank(OTHER);
        registry.registerEnvelope(address(this), root, 0, abi.encode(SALT, capabilityData));
    }

    function test_register_gateRegistersOnBehalfOfPrincipal() public {
        bytes memory capabilityData = _plain(10);
        bytes32 root = keccak256(capabilityData);
        address gate = address(0x9A7E);
        registry.setGate(gate, true);

        vm.prank(gate);
        bytes32 id = registry.registerEnvelope(OTHER, root, 0, abi.encode(SALT, capabilityData));

        assertEq(registry.getEnvelope(id).principal, OTHER);
    }

    // ===================== budget =====================

    function test_draw_accumulatesCursor() public {
        bytes32 id = _registerPlain(10);

        _draw(id, 4);

        (uint256 spent, uint256 draws, uint256 lastAdvance) = registry.rawCursorOf(id);
        assertEq(spent, 4);
        assertEq(draws, 1);
        assertEq(lastAdvance, NOW);
        assertEq(registry.getCursor(id), keccak256(abi.encode(uint256(4), uint256(1), uint256(NOW))));
        assertEq(registry.remainingOf(id), 6);

        _draw(id, 4);
        (spent, draws,) = registry.rawCursorOf(id);
        assertEq(spent, 8);
        assertEq(draws, 2);
        assertEq(registry.remainingOf(id), 2);
    }

    function test_draw_reachesCapExactly() public {
        bytes32 id = _registerPlain(10);
        _draw(id, 6);
        _draw(id, 4);

        assertEq(registry.remainingOf(id), 0);
    }

    function test_draw_overCapReverts() public {
        bytes32 id = _registerPlain(10);
        _draw(id, 6);

        vm.expectRevert(KeelBoundedActions.CapExceeded.selector);
        _draw(id, 5);
    }

    function test_draw_beforeNotBeforeReverts() public {
        bytes32 id = _register(_capabilityData(10, 0, NOW + 100, false, 0, _noApprovers()), 0);

        vm.expectRevert(KeelBoundedActions.NotYetReleased.selector);
        _draw(id, 1);

        vm.warp(NOW + 101);
        _draw(id, 1);
        (, uint256 draws,) = registry.rawCursorOf(id);
        assertEq(draws, 1);
    }

    function test_draw_requiresMOfNApprovals() public {
        bytes32 id = _register(_capabilityData(10, 0, 0, false, 2, _approvers()), 0);

        address[] memory one = new address[](1);
        one[0] = APPROVER_A;
        vm.expectRevert(KeelBoundedActions.ApprovalRequired.selector);
        _drawWith(id, 1, one);

        _drawWith(id, 1, _approvers());
        (, uint256 draws,) = registry.rawCursorOf(id);
        assertEq(draws, 1);
    }

    function test_draw_unauthorizedCallerRejected() public {
        bytes32 id = _registerPlain(10);

        vm.expectRevert(KeelBoundedActions.UnauthorizedAdvance.selector);
        vm.prank(OTHER);
        _draw(id, 1);
    }

    function test_draw_gateCanAdvance() public {
        bytes32 id = _registerPlain(10);
        address gate = address(0x9A7E);
        registry.setGate(gate, true);

        vm.prank(gate);
        registry.advanceCursor(id, abi.encode(uint256(3), _noApprovers()));
        (, uint256 draws,) = registry.rawCursorOf(id);
        assertEq(draws, 1);
    }

    // ===================== lifecycle =====================

    function test_lifecycle_revokeIsTerminal() public {
        bytes32 id = _registerPlain(10);

        registry.setStatus(id, IBoundedAgentAction.Status.Revoked);
        _assertStatus(id, IBoundedAgentAction.Status.Revoked);

        vm.expectRevert(KeelBoundedActions.IllegalTransition.selector);
        registry.setStatus(id, IBoundedAgentAction.Status.Active);

        vm.expectRevert(KeelBoundedActions.NotActive.selector);
        _draw(id, 1);
    }

    function test_lifecycle_completeIsTerminal() public {
        bytes32 id = _registerPlain(10);

        registry.setStatus(id, IBoundedAgentAction.Status.Completed);
        _assertStatus(id, IBoundedAgentAction.Status.Completed);

        vm.expectRevert(KeelBoundedActions.IllegalTransition.selector);
        registry.setStatus(id, IBoundedAgentAction.Status.Contested);
    }

    function test_lifecycle_contestDefaultResolutionByAnyone() public {
        bytes32 id = _registerPlain(10);

        registry.setStatus(id, IBoundedAgentAction.Status.Contested);
        _assertStatus(id, IBoundedAgentAction.Status.Contested);

        // Before the window lapses, a third party cannot resolve.
        vm.expectRevert(KeelBoundedActions.UnauthorizedStatus.selector);
        vm.prank(OTHER);
        registry.setStatus(id, IBoundedAgentAction.Status.Active);

        vm.warp(NOW + registry.contestWindow() + 1);
        vm.prank(OTHER);
        registry.setStatus(id, IBoundedAgentAction.Status.Active);
        _assertStatus(id, IBoundedAgentAction.Status.Active);
    }

    function test_lifecycle_principalCanResolveContestImmediately() public {
        bytes32 id = _registerPlain(10);
        registry.setStatus(id, IBoundedAgentAction.Status.Contested);
        registry.setStatus(id, IBoundedAgentAction.Status.Revoked);
        _assertStatus(id, IBoundedAgentAction.Status.Revoked);
    }

    function test_lifecycle_expiryIsDerived() public {
        bytes32 id = _register(_plain(10), uint64(NOW + 10));

        assertTrue(registry.isActive(id));
        vm.warp(NOW + 11);

        _assertStatus(id, IBoundedAgentAction.Status.Expired);
        assertFalse(registry.isActive(id));
        vm.expectRevert(KeelBoundedActions.NotActive.selector);
        _draw(id, 1);
    }

    function test_lifecycle_expiredCanBeMarkedByAnyone() public {
        bytes32 id = _register(_plain(10), uint64(NOW + 10));
        vm.warp(NOW + 11);

        vm.prank(OTHER);
        registry.setStatus(id, IBoundedAgentAction.Status.Expired);
        _assertStatus(id, IBoundedAgentAction.Status.Expired);
    }

    // ===================== aggregate profile =====================

    function test_aggregate_validChildDerivesCorrectId() public {
        bytes32 parentId = _register(_parentData(10, 2, 0, 0, 0), 0);
        bytes memory childData = _childData(4, 1, 0, false, 0, 0);

        bytes32 expected = keccak256(
            abi.encode(address(registry), address(this), keccak256(childData), bytes32(uint256(0xC)))
        );
        bytes32 childId = registry.registerAttenuated(parentId, childData, bytes32(uint256(0xC)));

        assertEq(childId, expected);
        assertEq(registry.getEnvelope(childId).capabilityRoot, keccak256(childData));
        assertEq(registry.getEnvelope(childId).principal, address(this));
        _assertStatus(childId, IBoundedAgentAction.Status.Active);
        assertEq(registry.allocatedOf(registry.getEnvelope(parentId).capabilityRoot), 4);
    }

    function test_aggregate_conservationViolated() public {
        bytes32 parentId = _register(_parentData(10, 0, 0, 0, 0), 0);
        registry.registerAttenuated(parentId, _childData(6, 0, 0, false, 0, 0), bytes32(uint256(1)));

        vm.expectRevert(KeelBoundedActions.ConservationViolated.selector);
        registry.registerAttenuated(parentId, _childData(6, 0, 0, false, 0, 0), bytes32(uint256(2)));
    }

    function test_aggregate_attenuationCap() public {
        bytes32 parentId = _register(_parentData(10, 0, 0, 0, 0), 0);
        vm.expectRevert(KeelBoundedActions.AttenuationViolated.selector);
        registry.registerAttenuated(parentId, _childData(11, 0, 0, false, 0, 0), bytes32(uint256(1)));
    }

    function test_aggregate_attenuationTrustTier() public {
        bytes32 parentId = _register(_parentData(10, 1, 0, 0, 0), 0);
        vm.expectRevert(KeelBoundedActions.AttenuationViolated.selector);
        registry.registerAttenuated(parentId, _childData(5, 2, 0, false, 0, 0), bytes32(uint256(1)));
    }

    function test_aggregate_attenuationNotBefore() public {
        bytes32 parentId = _register(_parentData(10, 0, NOW + 100, 0, 0), 0);
        vm.expectRevert(KeelBoundedActions.AttenuationViolated.selector);
        registry.registerAttenuated(parentId, _childData(5, 0, NOW + 50, false, 0, 0), bytes32(uint256(1)));
    }

    function test_aggregate_attenuationThreshold() public {
        bytes32 parentId = _register(_parentData(10, 0, 0, 2, 2), 0);
        vm.expectRevert(KeelBoundedActions.AttenuationViolated.selector);
        registry.registerAttenuated(parentId, _childData(5, 0, 0, false, 1, 2), bytes32(uint256(1)));
    }

    function test_aggregate_attenuationAsset() public {
        bytes32 parentId = _register(_parentData(10, 0, 0, 0, 0), 0);
        bytes memory childData = abi.encode(
            uint256(1), address(0xDEAD), uint256(5), uint8(0), uint256(0), false, uint256(0), _noApprovers()
        );
        vm.expectRevert(KeelBoundedActions.AttenuationViolated.selector);
        registry.registerAttenuated(parentId, childData, bytes32(uint256(1)));
    }

    function test_aggregate_attenuatedCannotRedelegate() public {
        bytes32 parentId = _register(_parentData(10, 0, 0, 0, 0), 0);
        vm.expectRevert(KeelBoundedActions.AttenuationViolated.selector);
        registry.registerAttenuated(parentId, _childData(5, 0, 0, true, 0, 0), bytes32(uint256(1)));
    }

    function test_aggregate_parentCannotDelegate() public {
        bytes32 parentId = _register(_plain(10), 0);
        vm.expectRevert(KeelBoundedActions.AttenuationViolated.selector);
        registry.registerAttenuated(parentId, _childData(5, 0, 0, false, 0, 0), bytes32(uint256(1)));
    }

    function test_aggregate_attenuatedChildCannotSpawn() public {
        bytes32 parentId = _register(_parentData(10, 0, 0, 0, 0), 0);
        bytes32 childId =
            registry.registerAttenuated(parentId, _childData(5, 0, 0, false, 0, 0), bytes32(uint256(1)));

        vm.expectRevert(KeelBoundedActions.AttenuationViolated.selector);
        registry.registerAttenuated(childId, _childData(2, 0, 0, false, 0, 0), bytes32(uint256(2)));
    }

    // ===================== ERC-165 =====================

    function test_supportsInterface() public view {
        assertTrue(registry.supportsInterface(0x01ffc9a7));
        assertTrue(registry.supportsInterface(type(IBoundedAgentAction).interfaceId));
        assertFalse(registry.supportsInterface(0xffffffff));
    }

    function test_capabilityOfReadsBack() public {
        bytes32 id = _register(_capabilityData(10, 2, NOW + 5, false, 0, _noApprovers()), 0);
        Capability memory capability = registry.capabilityOf(id);
        assertEq(capability.cap, 10);
        assertEq(capability.trustTier, 2);
        assertEq(capability.notBefore, NOW + 5);
    }

    // ===================== cross-layer commitment consistency =====================

    function test_crossLayer_capabilityRootAndCursorMatchEncoding() public {
        // Hand-built capabilityData, exactly the tuple bounded.ts commits to.
        address[] memory approvers = new address[](1);
        approvers[0] = APPROVER_A;
        bytes memory capabilityData = abi.encode(
            uint256(1), address(0), uint256(10), uint8(2), uint256(0), false, uint256(0), approvers
        );
        bytes32 capabilityRoot = keccak256(capabilityData);

        bytes32 id =
            registry.registerEnvelope(address(this), capabilityRoot, 0, abi.encode(SALT, capabilityData));
        assertEq(registry.getEnvelope(id).capabilityRoot, capabilityRoot);

        _draw(id, 3);
        assertEq(registry.getCursor(id), keccak256(abi.encode(uint256(3), uint256(1), uint256(NOW))));
        assertEq(registry.getCursor(id), registry.getEnvelope(id).cursorRoot);
    }

    // Pinned vector produced by the `@keelcodes/policy` `bounded.ts`
    // (`capabilityCommitment` / `cursorCommitment`) for the capability below:
    //   asset 0x1111…1111, cap 1000, tier 2, notBefore 1700000000, delegate true,
    //   threshold 2 of [0xaaaa…, 0xbbbb…]; cursor {spent 3, draws 1, lastAdvance 1700000000}.
    // If either layer's ABI encoding drifts, this fails — the two halves of the
    // substrate must commit to identical bytes. Regenerated with
    // `node --input-type=module -e "…"` against the built policy package.
    function test_crossLayer_typeScriptVectorIsReproduced() public {
        bytes32 id = registry.registerEnvelope(
            address(this), TS_CAPABILITY_ROOT, 0, abi.encode(SALT, _tsCapabilityData())
        );
        assertEq(registry.getEnvelope(id).capabilityRoot, TS_CAPABILITY_ROOT);

        // spent=3, draws=1, lastAdvance=NOW — exactly what the TS cursor vector commits to.
        _drawWith(id, 3, _tsApprovers());
        assertEq(registry.getCursor(id), TS_CURSOR_ROOT);
    }

    bytes32 internal constant TS_CAPABILITY_ROOT =
        0xbeb4d48baab134eaa7d486b973abac36719e4288448be537593d178d12d7fbd7;
    bytes32 internal constant TS_CURSOR_ROOT =
        0x1308f4234a3f3d2a99bf251c9c7eb1460ea3870fad019de7e1dc4efdeea4bcdd;

    function _tsCapabilityData() internal pure returns (bytes memory) {
        return hex"0000000000000000000000000000000000000000000000000000000000000001000000000000000000000000111111111111111111111111111111111111111100000000000000000000000000000000000000000000000000000000000003e80000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000006553f1000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000002000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    }

    function _tsApprovers() internal pure returns (address[] memory list) {
        list = new address[](2);
        list[0] = 0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa;
        list[1] = 0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB;
    }
}
