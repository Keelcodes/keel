// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {IERC7579Hook, MODULE_TYPE_HOOK} from "./interfaces/IERC7579.sol";
import {IBoundedAgentAction} from "./interfaces/IERC8312.sol";

// ============================================================================
// KeelPolicyHook — account-agnostic ERC-7579 hook (module type 4) that enforces
// the Keel policy DSL on-chain, for **many concurrent sessions per account**.
//
// Why a hook and not a validator: a validator runs during the ERC-4337
// validation phase, where ERC-7562 forbids touching storage that is not
// associated with the sending account. That makes per-rule daily accounting
// (nested mappings) impossible to enforce on-chain. A hook is invoked by the
// account during *execution*, so it may read and write its own storage freely —
// per-tx, per-day, per-token and call-count ceilings are all enforced on-chain,
// for real, instead of being an off-chain pre-check the session key could skip.
//
// Account agnosticism: the account calls `hook.preCheck(...)`, so inside the
// hook `msg.sender` is the smart account and keying storage by it works for
// Kernel, Nexus and Safe7579 alike. `msgData` is the calldata the account
// received; for an ERC-4337 flow that is the standard ERC-7579
// `execute(bytes32,bytes)` call, whose `mode` + `executionCalldata` encoding is
// identical across accounts. (Kernel's older `exec`-style selectors are not
// handled — this module targets the ERC-7579 execution interface.)
//
// Multi-session: an account may install any number of sessions, each identified
// by a caller-chosen `bytes32 sessionId` (the off-chain `Session.id`). Install
// data is `abi.encode(bytes32 sessionId, bytes policyData)` where `policyData`
// is the exact output of the TypeScript `encodePolicy(policy)`, i.e.
// `abi.encode(version, validAfter, validUntil, rules)`. The commitment stored
// for a session is `keccak256(policyData)`, which therefore equals
// `policyCommitment(policy)` off-chain — the two layers commit to the same
// bytes, so an installed policy can be verified against what was signed.
//
// Union semantics: a hook cannot tell which session a call belongs to (no
// session identity reaches `preCheck`), so sessions act as a **union of grants**.
// A call is admitted if *any* installed session admits it; sessions are tried in
// install order and the first admitting session is charged. Each attempt is
// trial-and-commit: it runs in a self-call and is rolled back if it reverts, so a
// rejected attempt never leaves partial accrual behind. When no session admits
// the call, the surfaced error is the most informative failure (a matched rule
// that hit a ceiling, preferred over `NoMatchingRule`).
//
// Accrual is keyed by `(account, sessionId)`, so sessions never share counters —
// reinstalling an identical policy under a new id starts a fresh epoch, while
// reusing an id is rejected. Usage for an uninstalled session is left unreachable.
//
// Enforcement is fail-closed: an unparseable/unsupported `msgData`, a call that
// matches no rule in any session, and `delegatecall` (callType 0xff) all revert.
//
// Two-layer enforcement (optional): a session may additionally be bound to an
// ERC-8312 envelope (`bindEnvelope`). Then `applySession` charges the envelope's
// cross-call aggregate budget on top of the per-call policy — see
// `_chargeEnvelope`. This is additive: unbound sessions behave exactly as
// before, and the charge runs inside the same atomic trial, so it can never be
// bypassed on the account's only execution path.
// ============================================================================

struct TokenLimit {
    address token;
    uint256 maxPerTx;
    uint256 maxDaily;
}

struct Rule {
    address target;
    bytes4[] selectors;
    uint256 maxPerTx;
    uint256 maxDaily;
    uint256 maxCalls;
    TokenLimit[] tokenLimits;
}

/// ERC-7579 batch execution entry (only the shape matters here).
struct Execution {
    address target;
    uint256 value;
    bytes callData;
}

/// Policy validity window and schema version (same fields as the ABI prefix).
struct PolicyMeta {
    uint256 version;
    uint256 validAfter;
    uint256 validUntil;
}

/// Accrued usage for one rule within the current day window.
struct RuleState {
    uint64 day;
    uint256 calls;
    uint256 dailySpent;
}

/// One installed session: the commitment of its policy payload plus the policy.
struct Session {
    bytes32 commitment;
    PolicyMeta meta;
    Rule[] rules;
}

/// Binds a session to an ERC-8312 envelope, so the account's aggregate budget
/// is charged on the only execution path (see `applySession`).
struct EnvelopeBinding {
    address registry;
    bytes32 envelopeId;
}

contract KeelPolicyHook is IERC7579Hook {
    // --- ERC-7579 ---
    bytes4 internal constant _SEL_EXECUTE = 0xe9ae5c53; // execute(bytes32,bytes)
    bytes4 internal constant _SEL_EXECUTE_FROM_EXECUTOR = 0xd691c964; // executeFromExecutor(bytes32,bytes)

    bytes1 internal constant _CALLTYPE_SINGLE = 0x00;
    bytes1 internal constant _CALLTYPE_BATCH = 0x01;

    // --- ERC-20 ---
    bytes4 internal constant _SEL_TRANSFER = 0xa9059cbb; // transfer(address,uint256)
    bytes4 internal constant _SEL_APPROVE = 0x095ea7b3; // approve(address,uint256)
    bytes4 internal constant _SEL_TRANSFER_FROM = 0x23b872dd; // transferFrom(address,address,uint256)

    // Policy schema version; MUST match `POLICY_VERSION` in @keelcodes/policy.
    uint256 public constant POLICY_VERSION = 1;

    // Byte length of a standard two-word ERC-20 call (transfer/approve).
    uint256 internal constant _ERC20_MIN_LENGTH = 68;

    // Sentinel for "no index" / "this rule declares no limit for the call target".
    uint256 internal constant _NO_LIMIT = type(uint256).max;

    // --- installed sessions, in install order per account ---
    mapping(address account => bytes32[] sessionIds) private _order;
    mapping(address account => mapping(bytes32 sessionId => Session)) private _sessions;

    // --- accrued usage, keyed by the (account, sessionId) slot ---
    mapping(bytes32 slot => mapping(uint256 ruleIndex => RuleState)) private _ruleState;
    mapping(
        bytes32 slot => mapping(uint256 ruleIndex => mapping(address token => mapping(uint64 day => uint256)))
    ) private _tokenDaily;

    // --- optional ERC-8312 envelope binding, keyed by the (account, sessionId) slot ---
    mapping(address account => mapping(bytes32 sessionId => EnvelopeBinding)) private _envelopes;

    event SessionInstalled(
        address indexed account,
        bytes32 indexed sessionId,
        bytes32 indexed commitment,
        uint256 version,
        uint256 validAfter,
        uint256 validUntil,
        uint256 ruleCount
    );
    event SessionUninstalled(address indexed account, bytes32 indexed sessionId, bytes32 commitment);

    /// Emitted when a session is bound to / unbound from an ERC-8312 envelope.
    event EnvelopeBound(
        address indexed account, bytes32 indexed sessionId, address registry, bytes32 envelopeId
    );
    event EnvelopeUnbound(address indexed account, bytes32 indexed sessionId);

    error NotInitialized(address account);
    error EmptyPolicy();
    error UnsupportedVersion(uint256 version);
    error InvalidWindow(uint256 validAfter, uint256 validUntil);
    error InvalidTarget();
    error TokenLimitOffTarget(address token, address target);
    error DuplicateTokenLimit(address token);
    error UnsupportedCallData(bytes4 selector);
    error UnsupportedCallType(bytes1 callType);
    error InvalidExecutionCalldata();
    error NotYetValid(uint256 validAfter);
    error Expired(uint256 validUntil);
    error NoMatchingRule(address target, bytes4 selector);
    error ValuePerTxExceeded(uint256 value, uint256 limit);
    error TokenAmountUnparsable();
    error TokenTransferFromBlocked();
    error TokenPerTxExceeded(uint256 amount, uint256 limit);
    error TokenDailyLimitExceeded(uint256 attempted, uint256 limit);
    error DailyLimitExceeded(uint256 attempted, uint256 limit);
    error CallCountExceeded(uint256 attempted, uint256 limit);
    error InvalidSessionId();
    error InvalidRegistry();
    error EnvelopeNotOwned(address account, bytes32 envelopeId);
    error SessionAlreadyInstalled(address account, bytes32 sessionId);
    error SessionNotInstalled(address account, bytes32 sessionId);
    error Unauthorized();
    error SessionDenied();

    // ===================== IModule =====================

    /// @notice Installs (or, with a fresh id, adds) a session for `msg.sender`.
    ///         `data` MUST be `abi.encode(sessionId, encodePolicy(policy))`.
    function onInstall(bytes calldata data) external payable {
        address account = msg.sender;
        if (data.length == 0) revert EmptyPolicy();

        (bytes32 sessionId, bytes memory policyData) = abi.decode(data, (bytes32, bytes));
        if (sessionId == bytes32(0)) revert InvalidSessionId();
        if (_sessions[account][sessionId].rules.length != 0) {
            revert SessionAlreadyInstalled(account, sessionId);
        }

        (uint256 version, uint256 validAfter, uint256 validUntil, Rule[] memory rules) =
            abi.decode(policyData, (uint256, uint256, uint256, Rule[]));

        if (version != POLICY_VERSION) revert UnsupportedVersion(version);
        if (validUntil != 0 && validUntil <= validAfter) revert InvalidWindow(validAfter, validUntil);
        if (rules.length == 0) revert EmptyPolicy();

        Session storage session = _sessions[account][sessionId];
        session.commitment = keccak256(policyData);
        session.meta = PolicyMeta({version: version, validAfter: validAfter, validUntil: validUntil});

        for (uint256 i; i < rules.length; ++i) {
            Rule memory rule = rules[i];
            if (rule.target == address(0)) revert InvalidTarget();
            // A token cap is only enforceable on calls made directly to the token
            // (the same invariant the off-chain normaliser rejects), and a token
            // may appear at most once per rule.
            uint256 limits = rule.tokenLimits.length;
            for (uint256 j; j < limits; ++j) {
                if (rule.tokenLimits[j].token != rule.target) {
                    revert TokenLimitOffTarget(rule.tokenLimits[j].token, rule.target);
                }
                for (uint256 k; k < j; ++k) {
                    if (rule.tokenLimits[k].token == rule.tokenLimits[j].token) {
                        revert DuplicateTokenLimit(rule.tokenLimits[j].token);
                    }
                }
            }
            session.rules.push(rule);
        }

        _order[account].push(sessionId);
        emit SessionInstalled(
            account, sessionId, session.commitment, version, validAfter, validUntil, rules.length
        );
    }

    /// @notice Removes the session identified by `data` (a `bytes32 sessionId`).
    ///         Its accrual is left unreachable.
    function onUninstall(bytes calldata data) external payable {
        address account = msg.sender;
        if (data.length != 32) revert InvalidSessionId();
        bytes32 sessionId = abi.decode(data, (bytes32));

        Session storage session = _sessions[account][sessionId];
        if (session.rules.length == 0) revert SessionNotInstalled(account, sessionId);
        bytes32 commitment = session.commitment;

        delete _sessions[account][sessionId];
        _removeSessionId(account, sessionId);

        emit SessionUninstalled(account, sessionId, commitment);
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == MODULE_TYPE_HOOK;
    }

    function isInitialized(address smartAccount) external view returns (bool) {
        return _order[smartAccount].length != 0;
    }

    // ===================== ERC-8312 envelope binding =====================

    /// @notice Binds one installed session to an ERC-8312 envelope. Called by the
    ///         account itself (`msg.sender` is the account), so it can only ever
    ///         bind its own sessions. A zero registry is refused (it would be a
    ///         silent no-op); binding is fully optional, so an account that never
    ///         calls this keeps the exact pre-envelope behaviour.
    ///
    ///         The envelope MUST name this account as its principal: `preCheck`
    ///         charges the bound envelope on every admitted execution, so without
    ///         this check any account could bind a stranger's envelope and spend
    ///         (or zero-cost corrupt) its budget.
    function bindEnvelope(bytes32 sessionId, address registry, bytes32 envelopeId) external {
        address account = msg.sender;
        if (_sessions[account][sessionId].rules.length == 0) {
            revert SessionNotInstalled(account, sessionId);
        }
        if (registry == address(0)) revert InvalidRegistry();
        if (IBoundedAgentAction(registry).getEnvelope(envelopeId).principal != account) {
            revert EnvelopeNotOwned(account, envelopeId);
        }

        _envelopes[account][sessionId] = EnvelopeBinding({registry: registry, envelopeId: envelopeId});
        emit EnvelopeBound(account, sessionId, registry, envelopeId);
    }

    /// @notice Removes a session's envelope binding. The session keeps working
    ///         under its per-call policy; only the aggregate charge stops.
    function unbindEnvelope(bytes32 sessionId) external {
        address account = msg.sender;
        if (_sessions[account][sessionId].rules.length == 0) {
            revert SessionNotInstalled(account, sessionId);
        }
        delete _envelopes[account][sessionId];
        emit EnvelopeUnbound(account, sessionId);
    }

    /// @notice The registry an account's session is bound to, or the zero address.
    function envelopeOf(address account, bytes32 sessionId)
        external
        view
        returns (address registry, bytes32 envelopeId)
    {
        EnvelopeBinding storage binding = _envelopes[account][sessionId];
        return (binding.registry, binding.envelopeId);
    }

    // ===================== IHook =====================

    /// @notice Admits this execution if any installed session admits every call.
    ///         Runs each session as an atomic trial (see `applySession`).
    function preCheck(address, uint256, bytes calldata msgData) external payable returns (bytes memory) {
        address account = msg.sender;
        bytes32[] storage sessionIds = _order[account];
        if (sessionIds.length == 0) revert NotInitialized(account);

        // Framing is session-independent: an unparseable/unsupported call reverts
        // here, before any session is tried (fail-closed).
        Execution[] memory executions = _parseExecutions(msgData);
        uint256 nowTs = block.timestamp;

        bytes memory chosen;
        for (uint256 i; i < sessionIds.length; ++i) {
            try this.applySession(account, sessionIds[i], executions, nowTs) returns (bool) {
                return "";
            } catch (bytes memory reason) {
                chosen = _preferReason(chosen, reason);
            }
        }

        if (chosen.length == 0) revert SessionDenied();
        assembly ("memory-safe") {
            revert(add(chosen, 0x20), mload(chosen))
        }
    }

    /// @notice No post-execution work: ceilings are checked and accrued up front.
    function postCheck(bytes calldata) external payable {}

    // ===================== views =====================

    /// @notice The session ids installed for `account`, in install order.
    function sessionIdsOf(address account) external view returns (bytes32[] memory) {
        return _order[account];
    }

    /// @notice The commitment stored for a session (equals `policyCommitment` off-chain).
    function policyCommitmentOf(address account, bytes32 sessionId) external view returns (bytes32) {
        return _sessions[account][sessionId].commitment;
    }

    function policyOf(address account, bytes32 sessionId)
        external
        view
        returns (uint256 version, uint256 validAfter, uint256 validUntil, Rule[] memory rules)
    {
        Session storage session = _sessions[account][sessionId];
        return (session.meta.version, session.meta.validAfter, session.meta.validUntil, session.rules);
    }

    function usageOf(address account, bytes32 sessionId, uint256 ruleIndex)
        external
        view
        returns (uint64 day, uint256 calls, uint256 dailySpent)
    {
        RuleState storage state = _ruleState[_slot(account, sessionId)][ruleIndex];
        return (state.day, state.calls, state.dailySpent);
    }

    function tokenSpentOf(address account, bytes32 sessionId, uint256 ruleIndex, address token, uint64 day)
        external
        view
        returns (uint256)
    {
        return _tokenDaily[_slot(account, sessionId)][ruleIndex][token][day];
    }

    // ===================== internal =====================

    /// @notice Charges exactly one session, reverting on any violation.
    ///
    ///         This is the atomic **trial** primitive behind the union semantics:
    ///         `preCheck` invokes it as a self-call inside `try/catch`, so a revert
    ///         rolls back every write this attempt made, while a success keeps
    ///         them. Restricted to the hook itself — no external caller can mutate
    ///         another account's accrual.
    function applySession(address account, bytes32 sessionId, Execution[] memory executions, uint256 nowTs)
        external
        returns (bool)
    {
        if (msg.sender != address(this)) revert Unauthorized();

        Session storage session = _sessions[account][sessionId];
        PolicyMeta memory meta = session.meta;
        if (meta.validAfter != 0 && nowTs < meta.validAfter) revert NotYetValid(meta.validAfter);
        if (meta.validUntil != 0 && nowTs > meta.validUntil) revert Expired(meta.validUntil);

        bytes32 slot = _slot(account, sessionId);
        Rule[] storage rules = session.rules;
        for (uint256 i; i < executions.length; ++i) {
            _check(slot, rules, executions[i].target, executions[i].value, executions[i].callData, nowTs);
        }

        _chargeEnvelope(account, sessionId, executions);
        return true;
    }

    /// @dev Second enforcement layer: if the session is bound to an ERC-8312
    ///      envelope, charge its aggregate budget with the batch's total native
    ///      value. Runs *after* every per-call policy check, inside the same
    ///      atomic trial — so a `CapExceeded`/`NotActive`/… revert rolls the whole
    ///      session attempt back and, if no other session admits the call,
    ///      `preCheck` surfaces it. Metering native `value` corresponds to an
    ///      envelope denominated in the native asset; an ERC-20 budget is charged
    ///      by the gateway/principal calling `advanceCursor` with token amounts.
    ///      A session with no binding (registry `address(0)`) skips this entirely,
    ///      so the envelope layer is strictly additive.
    function _chargeEnvelope(address account, bytes32 sessionId, Execution[] memory executions) internal {
        EnvelopeBinding memory binding = _envelopes[account][sessionId];
        if (binding.registry == address(0)) return;

        uint256 amount;
        for (uint256 i; i < executions.length; ++i) {
            amount += executions[i].value;
        }
        IBoundedAgentAction(binding.registry)
            .advanceCursor(binding.envelopeId, abi.encode(amount, new address[](0)));
    }

    /// @dev Applies the first rule matching (target, selector) — declaration order wins,
    ///      mirroring `evaluateCall` / `simulateCalls` off-chain.
    function _check(
        bytes32 slot,
        Rule[] storage rules,
        address target,
        uint256 value,
        bytes memory data,
        uint256 nowTs
    ) internal {
        bytes4 selector = _selectorOf(data);

        uint256 ruleIndex = _NO_LIMIT;
        for (uint256 i; i < rules.length; ++i) {
            Rule storage candidate = rules[i];
            if (candidate.target != target) continue;
            if (candidate.selectors.length != 0 && !_containsSelector(candidate.selectors, selector)) {
                continue;
            }
            ruleIndex = i;
            break;
        }
        if (ruleIndex == _NO_LIMIT) revert NoMatchingRule(target, selector);

        Rule storage rule = rules[ruleIndex];
        RuleState storage state = _ruleState[slot][ruleIndex];
        uint64 today = uint64(nowTs / 1 days);
        if (state.day != today) {
            state.day = today;
            state.dailySpent = 0;
        }

        // 1. native value, per call
        if (rule.maxPerTx != 0 && value > rule.maxPerTx) revert ValuePerTxExceeded(value, rule.maxPerTx);

        // 2. ERC-20 amount ceilings (only when a limit is declared for this token)
        uint256 limitIndex = _tokenLimitIndex(rule, target);
        uint256 tokenAmount;
        if (limitIndex != _NO_LIMIT) {
            TokenLimit storage limit = rule.tokenLimits[limitIndex];
            bool standard =
                selector == _SEL_TRANSFER || selector == _SEL_APPROVE || selector == _SEL_TRANSFER_FROM;
            if (!standard) {
                // Not a standard value-moving call: the rule's selector whitelist governs.
            } else if (data.length < _ERC20_MIN_LENGTH) {
                revert TokenAmountUnparsable();
            } else if (selector == _SEL_TRANSFER_FROM) {
                // Bounding a pull from an arbitrary address is ambiguous: refuse.
                revert TokenTransferFromBlocked();
            } else {
                tokenAmount = _wordAt(data, 36); // transfer/approve end with the uint256 amount
                if (limit.maxPerTx != 0 && tokenAmount > limit.maxPerTx) {
                    revert TokenPerTxExceeded(tokenAmount, limit.maxPerTx);
                }
                uint256 spent = _tokenDaily[slot][ruleIndex][limit.token][today];
                if (limit.maxDaily != 0 && spent + tokenAmount > limit.maxDaily) {
                    revert TokenDailyLimitExceeded(spent + tokenAmount, limit.maxDaily);
                }
            }
        }

        // 3. native value, per day
        if (rule.maxDaily != 0 && state.dailySpent + value > rule.maxDaily) {
            revert DailyLimitExceeded(state.dailySpent + value, rule.maxDaily);
        }

        // 4. call count
        if (rule.maxCalls != 0 && state.calls + 1 > rule.maxCalls) {
            revert CallCountExceeded(state.calls + 1, rule.maxCalls);
        }

        // 5. accrue
        state.calls += 1;
        state.dailySpent += value;
        if (tokenAmount != 0) {
            _tokenDaily[slot][ruleIndex][rule.tokenLimits[limitIndex].token][today] += tokenAmount;
        }
    }

    /// @dev Decodes `msgData` into the executions it carries, enforcing the ERC-7579
    ///      execution framing. Session-independent, so failures revert immediately.
    function _parseExecutions(bytes calldata msgData) internal pure returns (Execution[] memory) {
        if (msgData.length < 4) revert InvalidExecutionCalldata();
        bytes4 selector = bytes4(msgData[0:4]);
        if (selector != _SEL_EXECUTE && selector != _SEL_EXECUTE_FROM_EXECUTOR) {
            revert UnsupportedCallData(selector);
        }

        (bytes32 mode, bytes memory executionCalldata) = abi.decode(msgData[4:], (bytes32, bytes));
        bytes1 callType = bytes1(mode);

        if (callType == _CALLTYPE_SINGLE) {
            (address target, uint256 value, bytes memory data) = _decodeSingle(executionCalldata);
            Execution[] memory executions = new Execution[](1);
            executions[0] = Execution({target: target, value: value, callData: data});
            return executions;
        }
        if (callType == _CALLTYPE_BATCH) {
            return abi.decode(executionCalldata, (Execution[]));
        }
        // delegatecall (0xff) and anything unknown: refuse.
        revert UnsupportedCallType(callType);
    }

    /// @dev Keeps the most informative failure across session attempts: a rule that
    ///      matched but hit a ceiling explains more than "no rule matched here".
    function _preferReason(bytes memory current, bytes memory candidate)
        internal
        pure
        returns (bytes memory)
    {
        if (candidate.length == 0) return current;
        if (current.length == 0) return candidate;
        if (
            _selectorOf(current) == NoMatchingRule.selector
                && _selectorOf(candidate) != NoMatchingRule.selector
        ) {
            return candidate;
        }
        return current;
    }

    /// @dev Storage slot isolating one session's accrual: `(account, sessionId)`.
    function _slot(address account, bytes32 sessionId) internal pure returns (bytes32) {
        return keccak256(abi.encode(account, sessionId));
    }

    /// @dev Removes `sessionId` from the account's ordered list, preserving order.
    function _removeSessionId(address account, bytes32 sessionId) internal {
        bytes32[] storage sessionIds = _order[account];
        uint256 length = sessionIds.length;
        for (uint256 i; i < length; ++i) {
            if (sessionIds[i] != sessionId) continue;
            for (uint256 j = i; j + 1 < length; ++j) {
                sessionIds[j] = sessionIds[j + 1];
            }
            sessionIds.pop();
            return;
        }
    }

    /// @dev Index of the token limit declared for `target`, or `_NO_LIMIT` when the
    ///      rule declares none. At install time a limit's token is constrained to
    ///      equal the rule target, so this is also the token-limit lookup.
    function _tokenLimitIndex(Rule storage rule, address target) internal view returns (uint256) {
        uint256 limits = rule.tokenLimits.length;
        for (uint256 i; i < limits; ++i) {
            if (rule.tokenLimits[i].token == target) return i;
        }
        return _NO_LIMIT;
    }

    function _containsSelector(bytes4[] storage selectors, bytes4 selector) internal view returns (bool) {
        uint256 length = selectors.length;
        for (uint256 i; i < length; ++i) {
            if (selectors[i] == selector) return true;
        }
        return false;
    }

    /// @dev ERC-7579 single execution: `abi.encodePacked(target, value, callData)`.
    function _decodeSingle(bytes memory executionCalldata)
        internal
        pure
        returns (address target, uint256 value, bytes memory data)
    {
        if (executionCalldata.length < 52) revert InvalidExecutionCalldata();
        assembly ("memory-safe") {
            target := shr(96, mload(add(executionCalldata, 0x20)))
            value := mload(add(executionCalldata, 0x34))
        }
        data = _tail(executionCalldata, 52);
    }

    /// @dev Reads the 32-byte word at `offset`. Callers MUST have bounds-checked first.
    function _wordAt(bytes memory data, uint256 offset) internal pure returns (uint256 word) {
        assembly ("memory-safe") {
            word := mload(add(data, add(0x20, offset)))
        }
    }

    /// @dev First four bytes of `data` as a selector, or `bytes4(0)` when too short.
    function _selectorOf(bytes memory data) internal pure returns (bytes4 selector) {
        if (data.length < 4) return bytes4(0);
        assembly ("memory-safe") {
            selector := mload(add(data, 0x20))
        }
    }

    /// @dev Copies `data[start:]` into a fresh `bytes`. (Memory range access is only
    ///      permitted on calldata arrays, hence the explicit copy.)
    function _tail(bytes memory data, uint256 start) internal pure returns (bytes memory result) {
        uint256 length = data.length - start;
        result = new bytes(length);
        if (length != 0) {
            assembly ("memory-safe") {
                mcopy(add(result, 0x20), add(data, add(0x20, start)), length)
            }
        }
    }
}
