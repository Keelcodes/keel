// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Execution, KeelPolicyHook, Rule, TokenLimit} from "../src/KeelPolicyHook.sol";
import {KeelBoundedActions} from "../src/KeelBoundedActions.sol";

/// Minimal ERC-7579 account stand-in that can also bind an envelope. It calls
/// the hook itself, so the hook sees the account as `msg.sender`.
contract BoundAccount {
    bytes4 internal constant EXECUTE = 0xe9ae5c53;

    function install(KeelPolicyHook hook, bytes32 sessionId, bytes calldata policyData) external {
        hook.onInstall(abi.encode(sessionId, policyData));
    }

    function bind(KeelPolicyHook hook, bytes32 sessionId, address registry, bytes32 envelopeId) external {
        hook.bindEnvelope(sessionId, registry, envelopeId);
    }

    function register(
        KeelBoundedActions registry,
        bytes32 capabilityRoot,
        uint64 expiresAt,
        bytes calldata initData
    ) external returns (bytes32) {
        return registry.registerEnvelope(address(this), capabilityRoot, expiresAt, initData);
    }

    function unbind(KeelPolicyHook hook, bytes32 sessionId) external {
        hook.unbindEnvelope(sessionId);
    }

    function execute(KeelPolicyHook hook, bytes32 mode, bytes calldata executionCalldata) external {
        hook.preCheck(msg.sender, 0, abi.encodeWithSelector(EXECUTE, mode, executionCalldata));
    }
}

/// @title KeelPolicyHook × KeelBoundedActions — two-layer enforcement
/// @notice The per-call policy (layer 1) plus the ERC-8312 aggregate budget
///         (layer 2) charged on the account's only execution path.
contract KeelEnvelopeIntegrationTest is Test {
    KeelPolicyHook internal hook;
    KeelBoundedActions internal registry;
    BoundAccount internal account;

    address internal constant ROUTER = address(0x2222222222222222222222222222222222222222);

    bytes32 internal constant SESSION = bytes32(uint256(0x5E55));
    bytes32 internal constant SALT = bytes32(uint256(0x5A17));
    bytes32 internal constant MODE_SINGLE = bytes32(bytes1(0x00));
    bytes32 internal constant MODE_BATCH = bytes32(bytes1(0x01));

    uint256 internal constant NOW = 1_700_000_000;

    function setUp() public {
        hook = new KeelPolicyHook();
        registry = new KeelBoundedActions(address(this));
        account = new BoundAccount();

        // The hook is the gateway allowed to advance the envelope.
        registry.setGate(address(hook), true);
        vm.warp(NOW);
    }

    // ===================== helpers =====================

    function _rules() internal pure returns (Rule[] memory list) {
        list = new Rule[](1);
        list[0] = Rule({
            target: ROUTER,
            selectors: new bytes4[](0),
            maxPerTx: 10,
            maxDaily: 0,
            maxCalls: 0,
            tokenLimits: new TokenLimit[](0)
        });
    }

    function _policyData() internal pure returns (bytes memory) {
        return abi.encode(uint256(1), uint256(0), uint256(1_800_000_000), _rules());
    }

    /// Native-asset envelope with cap 10, matching `encodeCapability` off-chain.
    /// Registered by the account, so the envelope's principal is the account
    /// (required by `bindEnvelope`).
    function _registerEnvelope() internal returns (bytes32 id) {
        bytes memory capabilityData = abi.encode(
            uint256(1), address(0), uint256(10), uint8(0), uint256(0), false, uint256(0), new address[](0)
        );
        bytes32 root = keccak256(capabilityData);
        id = account.register(registry, root, 0, abi.encode(SALT, capabilityData));
    }

    function _run(uint256 value) internal {
        account.execute(hook, MODE_SINGLE, abi.encodePacked(ROUTER, value, bytes("")));
    }

    // ===================== two-layer enforcement =====================

    function test_bindingChargesAggregateBudgetThenRefusesOverCap() public {
        bytes32 envelopeId = _registerEnvelope();
        account.install(hook, SESSION, _policyData());
        account.bind(hook, SESSION, address(registry), envelopeId);

        _run(6);
        (uint256 spent, uint256 draws,) = registry.rawCursorOf(envelopeId);
        assertEq(spent, 6);
        assertEq(draws, 1);
        assertEq(registry.remainingOf(envelopeId), 4);

        // The per-call policy would admit this, but the aggregate budget cannot:
        // the envelope charge reverts and preCheck surfaces it.
        vm.expectRevert(KeelBoundedActions.CapExceeded.selector);
        _run(6);

        // The failed attempt rolled back: the cursor still reflects only 6.
        (spent, draws,) = registry.rawCursorOf(envelopeId);
        assertEq(spent, 6);
        assertEq(draws, 1);
        assertEq(registry.remainingOf(envelopeId), 4);
    }

    function test_envelopeIsChargedOnTheBatchTotal() public {
        bytes32 envelopeId = _registerEnvelope();
        account.install(hook, SESSION, _policyData());
        account.bind(hook, SESSION, address(registry), envelopeId);

        // A batch of two value-3 calls: the aggregate charge is the batch total (6).
        Execution[] memory batch = new Execution[](2);
        batch[0] = Execution({target: ROUTER, value: 3, callData: ""});
        batch[1] = Execution({target: ROUTER, value: 3, callData: ""});
        account.execute(hook, MODE_BATCH, abi.encode(batch));

        (uint256 spent,,) = registry.rawCursorOf(envelopeId);
        assertEq(spent, 6);
    }

    function test_unboundSessionIsUnchanged() public {
        account.install(hook, SESSION, _policyData());

        (address boundRegistry, bytes32 boundId) = hook.envelopeOf(address(account), SESSION);
        assertEq(boundRegistry, address(0));
        assertEq(boundId, bytes32(0));

        // No envelope charge: two value-6 calls both pass (no daily cap).
        _run(6);
        _run(6);
    }

    function test_unbindingStopsTheCharge() public {
        bytes32 envelopeId = _registerEnvelope();
        account.install(hook, SESSION, _policyData());
        account.bind(hook, SESSION, address(registry), envelopeId);

        account.unbind(hook, SESSION);
        _run(6);
        _run(6);

        (, uint256 draws,) = registry.rawCursorOf(envelopeId);
        assertEq(draws, 0);
    }

    function test_bindRejectsZeroRegistry() public {
        account.install(hook, SESSION, _policyData());
        vm.expectRevert(KeelPolicyHook.InvalidRegistry.selector);
        account.bind(hook, SESSION, address(0), bytes32(0));
    }

    function test_bindRejectsUnknownSession() public {
        vm.expectRevert(
            abi.encodeWithSelector(KeelPolicyHook.SessionNotInstalled.selector, address(account), SESSION)
        );
        account.bind(hook, SESSION, address(registry), bytes32(0));
    }
}
