// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Execution, KeelPolicyHook, Rule, TokenLimit} from "../../src/KeelPolicyHook.sol";
import {KeelBoundedActions} from "../../src/KeelBoundedActions.sol";
import {MockAccount} from "../KeelPolicyHook.t.sol";

/// @title KeelPolicyHook red-team suite
/// @notice Adversarial cases for `KeelPolicyHook`. Each test frames a *bypass
///         attempt* against one of the hook's guarantees and asserts it is
///         refused. Threat ids (`T-*`) map to `docs/THREAT_MODEL.md`.
///
///         These intentionally overlap the functional suite: the point here is
///         the adversarial framing and the "must not be possible" assertions,
///         not new happy paths.
contract KeelPolicyHookRedTeamTest is Test {
    KeelPolicyHook internal hook;
    MockAccount internal account;

    address internal constant TOKEN = address(0x1111111111111111111111111111111111111111);
    address internal constant ROUTER = address(0x2222222222222222222222222222222222222222);
    address internal constant OTHER = address(0x3333333333333333333333333333333333333333);

    bytes4 internal constant TRANSFER = 0xa9059cbb;
    bytes4 internal constant APPROVE = 0x095ea7b3;
    bytes4 internal constant TRANSFER_FROM = 0x23b872dd;

    bytes32 internal constant SESSION = bytes32(uint256(0x5E55));
    bytes32 internal constant MODE_SINGLE = bytes32(bytes1(0x00));
    bytes32 internal constant MODE_BATCH = bytes32(bytes1(0x01));
    bytes32 internal constant MODE_DELEGATECALL = bytes32(bytes1(0xff));

    uint256 internal constant NOW = 1_700_000_000;

    function setUp() public {
        hook = new KeelPolicyHook();
        account = new MockAccount();
        vm.warp(NOW);
    }

    // ===================== helpers =====================

    function _rule(
        address target,
        bytes4[] memory selectors,
        uint256 maxPerTx,
        uint256 maxDaily,
        uint256 maxCalls,
        TokenLimit[] memory limits
    ) internal pure returns (Rule memory) {
        return Rule({
            target: target,
            selectors: selectors,
            maxPerTx: maxPerTx,
            maxDaily: maxDaily,
            maxCalls: maxCalls,
            tokenLimits: limits
        });
    }

    function _rules1(Rule memory rule) internal pure returns (Rule[] memory list) {
        list = new Rule[](1);
        list[0] = rule;
    }

    function _noSelectors() internal pure returns (bytes4[] memory) {
        return new bytes4[](0);
    }

    function _noLimits() internal pure returns (TokenLimit[] memory) {
        return new TokenLimit[](0);
    }

    function _selectors(bytes4 a) internal pure returns (bytes4[] memory list) {
        list = new bytes4[](1);
        list[0] = a;
    }

    function _limit(address token, uint256 maxPerTx, uint256 maxDaily)
        internal
        pure
        returns (TokenLimit[] memory)
    {
        TokenLimit[] memory list = new TokenLimit[](1);
        list[0] = TokenLimit({token: token, maxPerTx: maxPerTx, maxDaily: maxDaily});
        return list;
    }

    function _install(Rule[] memory rules) internal {
        account.install(hook, SESSION, abi.encode(uint256(1), uint256(0), uint256(1_800_000_000), rules));
    }

    function _run(address target, uint256 value, bytes memory data) internal {
        account.execute(hook, MODE_SINGLE, abi.encodePacked(target, value, data));
    }

    function _transfer(address to, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(TRANSFER, to, amount);
    }

    function _tokenRules(uint256 maxPerTx, uint256 maxDaily) internal pure returns (Rule[] memory) {
        return _rules1(_rule(TOKEN, _noSelectors(), 0, 0, 0, _limit(TOKEN, maxPerTx, maxDaily)));
    }

    // ===================== T-BYPASS: reach the chain, skip the policy =====================

    /// threat: T-BYPASS-01 — routing execution through delegatecall to dodge the check.
    function test_T_BYPASS_01_delegatecallCannotReachThePolicy() public {
        _install(_rules1(_rule(ROUTER, _noSelectors(), 0, 0, 0, _noLimits())));

        vm.expectRevert(abi.encodeWithSelector(KeelPolicyHook.UnsupportedCallType.selector, bytes1(0xff)));
        account.execute(hook, MODE_DELEGATECALL, abi.encodePacked(ROUTER, ""));
    }

    /// threat: T-BYPASS-02 — dispatching a selector the hook does not police.
    function test_T_BYPASS_02_unknownDispatchSelectorRefused() public {
        _install(_rules1(_rule(ROUTER, _noSelectors(), 0, 0, 0, _noLimits())));

        vm.expectRevert(
            abi.encodeWithSelector(KeelPolicyHook.UnsupportedCallData.selector, bytes4(0xdeadbeef))
        );
        account.callRaw(hook, abi.encodeWithSelector(bytes4(0xdeadbeef)));
    }

    /// threat: T-BYPASS-03 — draining a token-limited rule with transferFrom.
    function test_T_BYPASS_03_transferFromCannotDrain() public {
        _install(_tokenRules(0, 100));

        vm.expectRevert(KeelPolicyHook.TokenTransferFromBlocked.selector);
        _run(TOKEN, 0, abi.encodeWithSelector(TRANSFER_FROM, OTHER, ROUTER, 1));
    }

    /// threat: T-BYPASS-04 — shortening the calldata so the amount reads as 0.
    function test_T_BYPASS_04_shortCalldataCannotSpoofAmount() public {
        _install(_tokenRules(1, 1));

        vm.expectRevert(KeelPolicyHook.TokenAmountUnparsable.selector);
        _run(TOKEN, 0, abi.encodeWithSelector(TRANSFER));
    }

    /// threat: T-BYPASS-05 — widening a rule's selector whitelist from the call site.
    function test_T_BYPASS_05_selectorWhitelistCannotBeWidened() public {
        _install(_rules1(_rule(TOKEN, _selectors(TRANSFER), 0, 0, 0, _limit(TOKEN, 1_000_000, 0))));

        vm.expectRevert(abi.encodeWithSelector(KeelPolicyHook.NoMatchingRule.selector, TOKEN, APPROVE));
        _run(TOKEN, 0, abi.encodeWithSelector(APPROVE, ROUTER, 1));
    }

    /// threat: T-BYPASS-06 — calling a target no rule authorises.
    function test_T_BYPASS_06_unauthorisedTargetRefused() public {
        _install(_tokenRules(1_000_000, 0));

        vm.expectRevert(abi.encodeWithSelector(KeelPolicyHook.NoMatchingRule.selector, OTHER, bytes4(0)));
        _run(OTHER, 0, "");
    }

    // ===================== T-CEILING: split a call to stay under the cap =====================

    /// threat: T-CEILING-01 — splitting a native transfer across a batch to dodge maxDaily.
    function test_T_CEILING_01_batchCannotSplitAroundDailyCap() public {
        _install(_rules1(_rule(ROUTER, _noSelectors(), 0, 10, 0, _noLimits())));

        Execution[] memory batch = new Execution[](2);
        batch[0] = Execution({target: ROUTER, value: 6, callData: ""});
        batch[1] = Execution({target: ROUTER, value: 6, callData: ""});

        vm.expectRevert(abi.encodeWithSelector(KeelPolicyHook.DailyLimitExceeded.selector, 12, 10));
        account.execute(hook, MODE_BATCH, abi.encode(batch));
    }

    /// threat: T-CEILING-02 — splitting token transfers across a batch to dodge maxDaily.
    function test_T_CEILING_02_batchCannotSplitAroundTokenDailyCap() public {
        _install(_tokenRules(0, 10));

        Execution[] memory batch = new Execution[](2);
        batch[0] = Execution({target: TOKEN, value: 0, callData: _transfer(OTHER, 6)});
        batch[1] = Execution({target: TOKEN, value: 0, callData: _transfer(OTHER, 6)});

        vm.expectRevert(abi.encodeWithSelector(KeelPolicyHook.TokenDailyLimitExceeded.selector, 12, 10));
        account.execute(hook, MODE_BATCH, abi.encode(batch));
    }

    // ===================== T-ACCRUAL: wipe or move the counters =====================

    /// threat: T-ACCRUAL-01 — reinstalling the same session id to reset usage.
    function test_T_ACCRUAL_01_reinstallCannotResetCounters() public {
        Rule[] memory rules = _rules1(_rule(ROUTER, _noSelectors(), 0, 0, 2, _noLimits()));
        _install(rules);
        _run(ROUTER, 0, "");
        _run(ROUTER, 0, "");

        vm.expectRevert(
            abi.encodeWithSelector(KeelPolicyHook.SessionAlreadyInstalled.selector, address(account), SESSION)
        );
        _install(rules);
    }

    /// threat: T-ACCRUAL-02 — charging or wiping another account's session directly.
    function test_T_ACCRUAL_02_foreignCallerCannotTouchAccrual() public {
        _install(_rules1(_rule(ROUTER, _noSelectors(), 0, 0, 0, _noLimits())));

        vm.expectRevert(KeelPolicyHook.Unauthorized.selector);
        hook.applySession(address(account), SESSION, new Execution[](0), NOW);
    }

    // ===================== T-WINDOW / T-LIFECYCLE =====================

    /// threat: T-WINDOW-01 — using a gated session outside its validity window.
    function test_T_WINDOW_01_expiredSessionRefused() public {
        Rule[] memory rules = _rules1(_rule(ROUTER, _noSelectors(), 0, 0, 0, _noLimits()));
        account.install(hook, SESSION, abi.encode(uint256(1), uint256(0), NOW - 1, rules));

        vm.expectRevert(abi.encodeWithSelector(KeelPolicyHook.Expired.selector, NOW - 1));
        _run(ROUTER, 0, "");
    }

    /// threat: T-LIFECYCLE-01 — using a session after it was uninstalled.
    function test_T_LIFECYCLE_01_uninstalledSessionCannotBeUsed() public {
        _install(_rules1(_rule(ROUTER, _noSelectors(), 0, 0, 0, _noLimits())));
        account.uninstall(hook, SESSION);

        vm.expectRevert(abi.encodeWithSelector(KeelPolicyHook.NotInitialized.selector, address(account)));
        _run(ROUTER, 0, "");
    }

    // ===================== T-ENVELOPE: the aggregate-budget binding =====================

    /// threat: T-ENVELOPE-08 — binding a stranger's envelope so every admitted
    ///         execution charges (or zero-cost corrupts) someone else's budget.
    function test_T_ENVELOPE_08_foreignEnvelopeCannotBeBound() public {
        KeelBoundedActions registry = new KeelBoundedActions(address(this));
        bytes memory capabilityData = abi.encode(
            uint256(1), address(0), uint256(10), uint8(0), uint256(0), false, uint256(0), new address[](0)
        );

        // The envelope's principal is OTHER, not the attacker's account.
        vm.prank(OTHER);
        bytes32 foreignId = registry.registerEnvelope(
            OTHER, keccak256(capabilityData), 0, abi.encode(bytes32(uint256(1)), capabilityData)
        );

        _install(_rules1(_rule(ROUTER, _noSelectors(), 0, 0, 0, _noLimits())));

        vm.expectRevert(
            abi.encodeWithSelector(KeelPolicyHook.EnvelopeNotOwned.selector, address(account), foreignId)
        );
        account.bind(hook, SESSION, address(registry), foreignId);
    }
}
