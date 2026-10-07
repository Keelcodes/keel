// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Execution, KeelPolicyHook, Rule, TokenLimit} from "../src/KeelPolicyHook.sol";

/// Minimal ERC-7579 account stand-in. It calls the hook itself, so the hook sees
/// the account as `msg.sender` — exactly how a real account invokes a hook.
contract MockAccount {
    bytes4 internal constant EXECUTE = 0xe9ae5c53;
    bytes4 internal constant EXECUTE_FROM_EXECUTOR = 0xd691c964;

    function install(KeelPolicyHook hook, bytes32 sessionId, bytes calldata policyData) external {
        hook.onInstall(abi.encode(sessionId, policyData));
    }

    function installRaw(KeelPolicyHook hook, bytes calldata data) external {
        hook.onInstall(data);
    }

    function uninstall(KeelPolicyHook hook, bytes32 sessionId) external {
        hook.onUninstall(abi.encode(sessionId));
    }

    function uninstallRaw(KeelPolicyHook hook, bytes calldata data) external {
        hook.onUninstall(data);
    }

    function bind(KeelPolicyHook hook, bytes32 sessionId, address registry, bytes32 envelopeId) external {
        hook.bindEnvelope(sessionId, registry, envelopeId);
    }

    function execute(KeelPolicyHook hook, bytes32 mode, bytes calldata executionCalldata) external {
        hook.preCheck(msg.sender, 0, abi.encodeWithSelector(EXECUTE, mode, executionCalldata));
    }

    function executeFromExecutor(KeelPolicyHook hook, bytes32 mode, bytes calldata executionCalldata)
        external
    {
        hook.preCheck(msg.sender, 0, abi.encodeWithSelector(EXECUTE_FROM_EXECUTOR, mode, executionCalldata));
    }

    function callRaw(KeelPolicyHook hook, bytes calldata msgData) external {
        hook.preCheck(msg.sender, 0, msgData);
    }
}

contract KeelPolicyHookTest is Test {
    KeelPolicyHook internal hook;
    MockAccount internal account;

    address internal constant TOKEN = address(0x1111111111111111111111111111111111111111);
    address internal constant ROUTER = address(0x2222222222222222222222222222222222222222);
    address internal constant OTHER = address(0x3333333333333333333333333333333333333333);

    bytes4 internal constant TRANSFER = 0xa9059cbb;
    bytes4 internal constant APPROVE = 0x095ea7b3;
    bytes4 internal constant TRANSFER_FROM = 0x23b872dd;

    bytes32 internal constant SESSION_A = bytes32(uint256(0xA1));
    bytes32 internal constant SESSION_B = bytes32(uint256(0xB2));

    bytes32 internal constant MODE_SINGLE = bytes32(bytes1(0x00));
    bytes32 internal constant MODE_BATCH = bytes32(bytes1(0x01));
    bytes32 internal constant MODE_DELEGATECALL = bytes32(bytes1(0xff));

    // Commitment of `_vectorInitData()`, pinned from the @keelcodes/policy
    // `policyCommitment` of the same policy. Both layers must agree.
    bytes32 internal constant VECTOR_COMMITMENT =
        0xbd6fc210c0c6de10268533612c917efc893ab57755dfc70be2e92b06c8d5d35c;

    uint256 internal constant NOW = 1_700_000_000;
    uint64 internal constant MARKS = uint64(uint256(1_700_000_000) / 1 days);

    function setUp() public {
        hook = new KeelPolicyHook();
        account = new MockAccount();
        vm.warp(NOW);
    }

    // ===================== helpers =====================

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

    function _twoSelectors(bytes4 a, bytes4 b) internal pure returns (bytes4[] memory list) {
        list = new bytes4[](2);
        list[0] = a;
        list[1] = b;
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

    /// Policy payload, exactly `encodePolicy(policy)` off-chain.
    function _policyData(uint256 version, uint256 validAfter, uint256 validUntil, Rule[] memory rules)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(version, validAfter, validUntil, rules);
    }

    function _initData(Rule[] memory rules) internal pure returns (bytes memory) {
        return _policyData(uint256(1), uint256(0), uint256(1_800_000_000), rules);
    }

    function _basicRules() internal pure returns (Rule[] memory) {
        return _rules1(_rule(ROUTER, _noSelectors(), 0, 0, 0, _noLimits()));
    }

    function _basicPolicy() internal pure returns (bytes memory) {
        return _initData(_basicRules());
    }

    function _tokenRules(uint256 maxPerTx, uint256 maxDaily) internal pure returns (Rule[] memory) {
        return _rules1(_rule(TOKEN, _noSelectors(), 0, 0, 0, _limit(TOKEN, maxPerTx, maxDaily)));
    }

    function _tokenPolicy(uint256 maxPerTx, uint256 maxDaily) internal pure returns (bytes memory) {
        return _initData(_tokenRules(maxPerTx, maxDaily));
    }

    function _install(bytes32 sessionId, Rule[] memory rules) internal {
        account.install(hook, sessionId, _initData(rules));
    }

    function _installOne(Rule[] memory rules) internal {
        _install(SESSION_A, rules);
    }

    function _single(address target, uint256 value, bytes memory data) internal pure returns (bytes memory) {
        return abi.encodePacked(target, value, data);
    }

    function _transfer(address to, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(TRANSFER, to, amount);
    }

    function _runSingle(address target, uint256 value, bytes memory data) internal {
        account.execute(hook, MODE_SINGLE, _single(target, value, data));
    }

    function _vectorInitData() internal pure returns (bytes memory) {
        Rule[] memory rules = new Rule[](2);
        rules[0] = _rule(
            TOKEN,
            _twoSelectors(TRANSFER, APPROVE),
            1_000_000,
            5_000_000,
            50,
            _limit(TOKEN, 1_000_000, 5_000_000)
        );
        rules[1] = _rule(ROUTER, _noSelectors(), 0, 0, 0, _noLimits());
        return abi.encode(uint256(1), uint256(0), uint256(1_800_000_000), rules);
    }

    // ===================== install =====================

    function test_install_storesSessionAndCommitment() public {
        bytes memory policyData = _basicPolicy();
        account.install(hook, SESSION_A, policyData);

        assertTrue(hook.isInitialized(address(account)));
        assertTrue(hook.isModuleType(4));
        assertFalse(hook.isModuleType(1));
        assertEq(hook.policyCommitmentOf(address(account), SESSION_A), keccak256(policyData));

        bytes32[] memory ids = hook.sessionIdsOf(address(account));
        assertEq(ids.length, 1);
        assertEq(ids[0], SESSION_A);

        (uint256 version, uint256 validAfter, uint256 validUntil, Rule[] memory rules) =
            hook.policyOf(address(account), SESSION_A);
        assertEq(version, 1);
        assertEq(validAfter, 0);
        assertEq(validUntil, 1_800_000_000);
        assertEq(rules.length, 1);
        assertEq(rules[0].target, ROUTER);
    }

    function test_commitment_matchesTypeScriptVector() public {
        bytes memory policyData = _vectorInitData();
        account.install(hook, SESSION_A, policyData);
        assertEq(hook.policyCommitmentOf(address(account), SESSION_A), VECTOR_COMMITMENT);
        assertEq(keccak256(policyData), VECTOR_COMMITMENT);
    }

    function test_install_addsManySessions() public {
        account.install(hook, SESSION_A, _basicPolicy());
        account.install(hook, SESSION_B, _tokenPolicy(1, 1));

        bytes32[] memory ids = hook.sessionIdsOf(address(account));
        assertEq(ids.length, 2);
        assertEq(ids[0], SESSION_A);
        assertEq(ids[1], SESSION_B);
        assertEq(hook.policyCommitmentOf(address(account), SESSION_A), keccak256(_basicPolicy()));
        assertEq(hook.policyCommitmentOf(address(account), SESSION_B), keccak256(_tokenPolicy(1, 1)));
    }

    function test_install_rejectsDuplicateSessionId() public {
        account.install(hook, SESSION_A, _basicPolicy());
        vm.expectRevert(
            abi.encodeWithSelector(
                KeelPolicyHook.SessionAlreadyInstalled.selector, address(account), SESSION_A
            )
        );
        account.install(hook, SESSION_A, _basicPolicy());
    }

    function test_install_rejectsZeroSessionId() public {
        vm.expectRevert(KeelPolicyHook.InvalidSessionId.selector);
        account.install(hook, bytes32(0), _basicPolicy());
    }

    function test_install_rejectsEmptyData() public {
        vm.expectRevert(KeelPolicyHook.EmptyPolicy.selector);
        account.installRaw(hook, "");
    }

    function test_install_rejectsUnsupportedVersion() public {
        vm.expectRevert(abi.encodeWithSelector(KeelPolicyHook.UnsupportedVersion.selector, 2));
        account.install(hook, SESSION_A, _policyData(2, 0, 0, _basicRules()));
    }

    function test_install_rejectsInvertedWindow() public {
        vm.expectRevert(abi.encodeWithSelector(KeelPolicyHook.InvalidWindow.selector, 100, 100));
        account.install(hook, SESSION_A, _policyData(1, 100, 100, _basicRules()));
    }

    function test_install_rejectsEmptyRules() public {
        vm.expectRevert(KeelPolicyHook.EmptyPolicy.selector);
        account.install(hook, SESSION_A, _policyData(1, 0, 0, new Rule[](0)));
    }

    function test_install_rejectsZeroTarget() public {
        Rule[] memory rules = _rules1(_rule(address(0), _noSelectors(), 0, 0, 0, _noLimits()));
        vm.expectRevert(KeelPolicyHook.InvalidTarget.selector);
        account.install(hook, SESSION_A, _initData(rules));
    }

    function test_install_rejectsTokenLimitOffTarget() public {
        Rule[] memory rules = _rules1(_rule(TOKEN, _noSelectors(), 0, 0, 0, _limit(OTHER, 1, 1)));
        vm.expectRevert(abi.encodeWithSelector(KeelPolicyHook.TokenLimitOffTarget.selector, OTHER, TOKEN));
        account.install(hook, SESSION_A, _initData(rules));
    }

    function test_install_rejectsDuplicateTokenLimit() public {
        TokenLimit[] memory limits = new TokenLimit[](2);
        limits[0] = TokenLimit({token: TOKEN, maxPerTx: 1, maxDaily: 1});
        limits[1] = TokenLimit({token: TOKEN, maxPerTx: 2, maxDaily: 2});
        Rule[] memory rules = _rules1(_rule(TOKEN, _noSelectors(), 0, 0, 0, limits));
        vm.expectRevert(abi.encodeWithSelector(KeelPolicyHook.DuplicateTokenLimit.selector, TOKEN));
        account.install(hook, SESSION_A, _initData(rules));
    }

    // ===================== uninstall =====================

    function test_uninstall_removesOnlyThatSession() public {
        account.install(hook, SESSION_A, _basicPolicy());
        account.install(
            hook, SESSION_B, _initData(_rules1(_rule(TOKEN, _noSelectors(), 0, 0, 0, _noLimits())))
        );
        account.uninstall(hook, SESSION_A);

        assertEq(hook.policyCommitmentOf(address(account), SESSION_A), bytes32(0));
        bytes32[] memory ids = hook.sessionIdsOf(address(account));
        assertEq(ids.length, 1);
        assertEq(ids[0], SESSION_B);

        _runSingle(TOKEN, 0, ""); // still admitted via SESSION_B
        vm.expectRevert(abi.encodeWithSelector(KeelPolicyHook.NoMatchingRule.selector, ROUTER, bytes4(0)));
        _runSingle(ROUTER, 0, "");
    }

    function test_uninstall_lastSessionDeInitializes() public {
        account.install(hook, SESSION_A, _basicPolicy());
        account.uninstall(hook, SESSION_A);

        assertFalse(hook.isInitialized(address(account)));
        vm.expectRevert(abi.encodeWithSelector(KeelPolicyHook.NotInitialized.selector, address(account)));
        _runSingle(ROUTER, 0, "");
    }

    function test_uninstall_rejectsUnknownSession() public {
        vm.expectRevert(
            abi.encodeWithSelector(KeelPolicyHook.SessionNotInstalled.selector, address(account), SESSION_A)
        );
        account.uninstall(hook, SESSION_A);
    }

    function test_uninstall_rejectsMalformedData() public {
        vm.expectRevert(KeelPolicyHook.InvalidSessionId.selector);
        account.uninstallRaw(hook, "");
    }

    function test_preCheck_rejectsCallerWithoutPolicy() public {
        vm.expectRevert(abi.encodeWithSelector(KeelPolicyHook.NotInitialized.selector, address(this)));
        hook.preCheck(address(this), 0, "");
    }

    // ===================== validity window =====================

    function test_rejectsBeforeValidAfter() public {
        account.install(hook, SESSION_A, _policyData(1, NOW + 60, 0, _basicRules()));
        vm.expectRevert(abi.encodeWithSelector(KeelPolicyHook.NotYetValid.selector, NOW + 60));
        _runSingle(ROUTER, 0, "");
    }

    function test_rejectsAfterValidUntil() public {
        account.install(hook, SESSION_A, _policyData(1, 0, NOW - 1, _basicRules()));
        vm.expectRevert(abi.encodeWithSelector(KeelPolicyHook.Expired.selector, NOW - 1));
        _runSingle(ROUTER, 0, "");
    }

    // ===================== rule matching =====================

    function test_allowsWhitelistedCall() public {
        _installOne(_basicRules());
        _runSingle(ROUTER, 0, abi.encodeWithSelector(bytes4(0xdeadbeef)));
    }

    function test_rejectsUnknownTarget() public {
        _installOne(_basicRules());
        vm.expectRevert(abi.encodeWithSelector(KeelPolicyHook.NoMatchingRule.selector, OTHER, bytes4(0)));
        _runSingle(OTHER, 0, "");
    }

    function test_rejectsSelectorOutsideWhitelist() public {
        _installOne(_rules1(_rule(ROUTER, _selectors(TRANSFER), 0, 0, 0, _noLimits())));
        vm.expectRevert(abi.encodeWithSelector(KeelPolicyHook.NoMatchingRule.selector, ROUTER, APPROVE));
        _runSingle(ROUTER, 0, abi.encodeWithSelector(APPROVE, OTHER, 1));
    }

    function test_skipsRuleWhoseTargetMatchesButSelectorDoesNot() public {
        // First rule targets ROUTER but only allows APPROVE; the second allows
        // any selector on ROUTER. Declaration order wins, so TRANSFER falls through.
        Rule[] memory rules = new Rule[](2);
        rules[0] = _rule(ROUTER, _selectors(APPROVE), 1, 0, 0, _noLimits());
        rules[1] = _rule(ROUTER, _noSelectors(), 0, 0, 0, _noLimits());
        _installOne(rules);

        _runSingle(ROUTER, 0, abi.encodeWithSelector(TRANSFER, OTHER, 1));

        (, uint256 calls,) = hook.usageOf(address(account), SESSION_A, 1);
        assertEq(calls, 1);
    }

    // ===================== native ceilings =====================

    function test_rejectsValueOverPerTx() public {
        _installOne(_rules1(_rule(ROUTER, _noSelectors(), 5, 0, 0, _noLimits())));
        vm.expectRevert(abi.encodeWithSelector(KeelPolicyHook.ValuePerTxExceeded.selector, 6, 5));
        _runSingle(ROUTER, 6, "");
    }

    function test_batchAccumulatesNativeDaily() public {
        _installOne(_rules1(_rule(ROUTER, _noSelectors(), 0, 10, 0, _noLimits())));

        Execution[] memory batch = new Execution[](2);
        batch[0] = Execution({target: ROUTER, value: 6, callData: ""});
        batch[1] = Execution({target: ROUTER, value: 6, callData: ""});

        vm.expectRevert(abi.encodeWithSelector(KeelPolicyHook.DailyLimitExceeded.selector, 12, 10));
        account.execute(hook, MODE_BATCH, abi.encode(batch));
    }

    function test_dailySpentResetsOnNewDay() public {
        _installOne(_rules1(_rule(ROUTER, _noSelectors(), 0, 10, 0, _noLimits())));

        _runSingle(ROUTER, 6, "");
        vm.warp(NOW + 1 days);
        _runSingle(ROUTER, 6, "");

        (, uint256 calls, uint256 dailySpent) = hook.usageOf(address(account), SESSION_A, 0);
        assertEq(calls, 2);
        assertEq(dailySpent, 6); // only today's call counts
    }

    function test_callCountIsLifetimeCap() public {
        _installOne(_rules1(_rule(ROUTER, _noSelectors(), 0, 0, 2, _noLimits())));

        _runSingle(ROUTER, 0, "");
        _runSingle(ROUTER, 0, "");

        vm.expectRevert(abi.encodeWithSelector(KeelPolicyHook.CallCountExceeded.selector, 3, 2));
        _runSingle(ROUTER, 0, "");
    }

    // ===================== execution framing =====================

    function test_rejectsDelegatecall() public {
        _installOne(_basicRules());
        vm.expectRevert(abi.encodeWithSelector(KeelPolicyHook.UnsupportedCallType.selector, bytes1(0xff)));
        account.execute(hook, MODE_DELEGATECALL, abi.encodePacked(ROUTER, ""));
    }

    function test_rejectsUnknownFraming() public {
        _installOne(_basicRules());
        vm.expectRevert(
            abi.encodeWithSelector(KeelPolicyHook.UnsupportedCallData.selector, bytes4(0xdeadbeef))
        );
        account.callRaw(hook, abi.encodeWithSelector(bytes4(0xdeadbeef)));
    }

    function test_acceptsExecuteFromExecutorFraming() public {
        _installOne(_basicRules());
        account.executeFromExecutor(hook, MODE_SINGLE, _single(ROUTER, 0, ""));
    }

    function test_batchAppliesEveryCall() public {
        _installOne(_rules1(_rule(ROUTER, _noSelectors(), 0, 0, 0, _noLimits())));

        Execution[] memory batch = new Execution[](2);
        batch[0] = Execution({target: ROUTER, value: 1, callData: ""});
        batch[1] = Execution({target: OTHER, value: 0, callData: ""});

        vm.expectRevert(abi.encodeWithSelector(KeelPolicyHook.NoMatchingRule.selector, OTHER, bytes4(0)));
        account.execute(hook, MODE_BATCH, abi.encode(batch));
    }

    // ===================== ERC-20 token limits =====================

    function test_tokenPerTxCap() public {
        _installOne(_tokenRules(5, 0));
        _runSingle(TOKEN, 0, _transfer(OTHER, 5));

        vm.expectRevert(abi.encodeWithSelector(KeelPolicyHook.TokenPerTxExceeded.selector, 6, 5));
        _runSingle(TOKEN, 0, _transfer(OTHER, 6));
    }

    function test_tokenDailyCapAccruesAcrossCalls() public {
        _installOne(_tokenRules(0, 10));
        _runSingle(TOKEN, 0, _transfer(OTHER, 6));

        assertEq(hook.tokenSpentOf(address(account), SESSION_A, 0, TOKEN, MARKS), 6);

        vm.expectRevert(abi.encodeWithSelector(KeelPolicyHook.TokenDailyLimitExceeded.selector, 11, 10));
        _runSingle(TOKEN, 0, _transfer(OTHER, 5));
    }

    function test_tokenTransferFromBlocked() public {
        _installOne(_tokenRules(0, 100));
        vm.expectRevert(KeelPolicyHook.TokenTransferFromBlocked.selector);
        _runSingle(TOKEN, 0, abi.encodeWithSelector(TRANSFER_FROM, OTHER, ROUTER, 1));
    }

    function test_tokenMalformedAmountRejected() public {
        _installOne(_tokenRules(0, 100));
        vm.expectRevert(KeelPolicyHook.TokenAmountUnparsable.selector);
        _runSingle(TOKEN, 0, abi.encodeWithSelector(TRANSFER));
    }

    function test_tokenNonStandardSelectorLeftToWhitelist() public {
        _installOne(_rules1(_rule(TOKEN, _noSelectors(), 0, 0, 0, _limit(TOKEN, 1, 1))));

        // Not transfer/approve/transferFrom: the (empty) selector whitelist governs.
        _runSingle(TOKEN, 0, abi.encodeWithSelector(bytes4(0xdeadbeef)));

        assertEq(hook.tokenSpentOf(address(account), SESSION_A, 0, TOKEN, MARKS), 0);
    }

    // ===================== multi-session union semantics =====================

    function test_union_admitsViaSecondSession() public {
        // SESSION_A caps a transfer at 5; SESSION_B caps it at 100.
        _installOne(_tokenRules(5, 0));
        _install(SESSION_B, _tokenRules(100, 0));

        _runSingle(TOKEN, 0, _transfer(OTHER, 6));

        (, uint256 callsA,) = hook.usageOf(address(account), SESSION_A, 0);
        (, uint256 callsB,) = hook.usageOf(address(account), SESSION_B, 0);
        assertEq(callsA, 0, "narrow session untouched");
        assertEq(callsB, 1, "charged to the admitting session");
    }

    function test_union_chargesFirstAdmittingSession() public {
        _installOne(_tokenRules(5, 0));
        _install(SESSION_B, _tokenRules(100, 0));

        _runSingle(TOKEN, 0, _transfer(OTHER, 5));

        (, uint256 callsA,) = hook.usageOf(address(account), SESSION_A, 0);
        (, uint256 callsB,) = hook.usageOf(address(account), SESSION_B, 0);
        assertEq(callsA, 1);
        assertEq(callsB, 0);
    }

    function test_union_revertsOnlyWhenNoSessionAdmits() public {
        _installOne(_tokenRules(5, 0));
        _install(SESSION_B, _tokenRules(5, 0));

        vm.expectRevert(abi.encodeWithSelector(KeelPolicyHook.TokenPerTxExceeded.selector, 6, 5));
        _runSingle(TOKEN, 0, _transfer(OTHER, 6));
    }

    function test_union_prefersTheInformativeFailure() public {
        // SESSION_A does not cover TOKEN at all (NoMatchingRule); SESSION_B covers
        // it but rejects the amount — the surfaced error must be the latter.
        _installOne(_basicRules());
        _install(SESSION_B, _tokenRules(5, 0));

        vm.expectRevert(abi.encodeWithSelector(KeelPolicyHook.TokenPerTxExceeded.selector, 6, 5));
        _runSingle(TOKEN, 0, _transfer(OTHER, 6));
    }

    function test_union_windowsArePerSession() public {
        account.install(hook, SESSION_A, _policyData(1, 0, NOW - 1, _basicRules())); // expired
        _install(SESSION_B, _basicRules());

        _runSingle(ROUTER, 0, ""); // admitted via SESSION_B
    }

    function test_sessionAccrualIsIsolated() public {
        // The same policy under two ids must not share counters.
        _installOne(_basicRules());
        _install(SESSION_B, _basicRules());

        _runSingle(ROUTER, 0, "");
        _runSingle(ROUTER, 0, "");

        (, uint256 callsA,) = hook.usageOf(address(account), SESSION_A, 0);
        (, uint256 callsB,) = hook.usageOf(address(account), SESSION_B, 0);
        assertEq(callsA, 2); // the first session absorbs every call
        assertEq(callsB, 0);
    }

    function test_applySession_rejectsExternalCallers() public {
        Execution[] memory none = new Execution[](0);
        vm.expectRevert(KeelPolicyHook.Unauthorized.selector);
        hook.applySession(address(account), SESSION_A, none, NOW);
    }
}
