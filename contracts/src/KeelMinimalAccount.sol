// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {IValidator} from "erc7579-implementation/src/interfaces/IERC7579Module.sol";

import {IERC7579Hook, MODULE_TYPE_VALIDATOR, MODULE_TYPE_HOOK} from "./interfaces/IERC7579.sol";

/// @dev ERC-7579 batch execution entry (only the shape matters here).
struct Call {
    address target;
    uint256 value;
    bytes data;
}

// ============================================================================
// KeelMinimalAccount — a second, independent ERC-7579 account, used to prove
// that KeelPolicyHook is account-agnostic.
//
// It deliberately walks different code paths from the Rhinestone MSA:
//   * install — modules are installed by the account itself in the constructor
//     (no proxy, no `Bootstrap`, no `ModuleManager`);
//   * validation — the owner validator is a stored immutable, called directly
//     (MSA derives it from the top 96 bits of the ERC-4337 nonce);
//   * execution — its own single/batch decoder (`ExecutionHelper`-free).
//
// What it shares with every ERC-7579 account is only the *standard* surface:
// `execute(bytes32,bytes)`, the mode/executionCalldata framing, and
// `isModuleInstalled` / `supportsExecutionMode` / `accountId`. Because the hook
// keys its storage by `msg.sender` and reads the account's received calldata,
// the exact same policy enforces identically here.
// ============================================================================
contract KeelMinimalAccount {
    bytes1 internal constant _CALLTYPE_SINGLE = 0x00;
    bytes1 internal constant _CALLTYPE_BATCH = 0x01;

    /// @notice Immutable ERC-4337 EntryPoint allowed to drive validation/execution.
    address public immutable entryPoint;
    /// @notice Immutable owner validator module.
    address public immutable validator;
    /// @notice Immutable hook module.
    address public immutable hook;

    error Unauthorized();
    error UnsupportedExecutionMode(bytes32 mode);
    error ExecutionFailed(address target, uint256 value, bytes reason);

    /// @param validatorInitData `onInstall` payload for the validator (e.g. `abi.encode(owner)`).
    /// @param hookInitData      `onInstall` payload for the hook (e.g. `abi.encode(sessionId, policyData)`).
    constructor(
        address entryPoint_,
        address validator_,
        address hook_,
        bytes memory validatorInitData,
        bytes memory hookInitData
    ) {
        entryPoint = entryPoint_;
        validator = validator_;
        hook = hook_;

        IValidator(validator_).onInstall(validatorInitData);
        IERC7579Hook(hook_).onInstall(hookInitData);
    }

    receive() external payable {}

    // ===================== ERC-4337 =====================

    function validateUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 missingAccountFunds
    ) external returns (uint256 validationData) {
        if (msg.sender != entryPoint) revert Unauthorized();
        validationData = IValidator(validator).validateUserOp(userOp, userOpHash);

        // Ignore failure: funding the prefund is EntryPoint's check to make.
        if (missingAccountFunds != 0) {
            (bool ok,) = payable(msg.sender).call{value: missingAccountFunds}("");
            ok;
        }
    }

    // ===================== ERC-7579 execution =====================

    function execute(bytes32 mode, bytes calldata executionCalldata) external payable {
        if (msg.sender != entryPoint && msg.sender != address(this)) revert Unauthorized();

        // `msg.sender` (the account) and `msg.data` (this execute call) are the
        // only things the hook needs — no account-specific context leaks in.
        IERC7579Hook(hook).preCheck(msg.sender, msg.value, msg.data);
        _execute(mode, executionCalldata);
        IERC7579Hook(hook).postCheck("");
    }

    function _execute(bytes32 mode, bytes calldata executionCalldata) internal {
        bytes1 callType = bytes1(mode);
        if (callType == _CALLTYPE_SINGLE) {
            address target = address(bytes20(executionCalldata[0:20]));
            uint256 value = uint256(bytes32(executionCalldata[20:52]));
            _call(target, value, executionCalldata[52:]);
        } else if (callType == _CALLTYPE_BATCH) {
            Call[] memory calls = abi.decode(executionCalldata, (Call[]));
            for (uint256 i; i < calls.length; ++i) {
                _call(calls[i].target, calls[i].value, calls[i].data);
            }
        } else {
            revert UnsupportedExecutionMode(mode);
        }
    }

    function _call(address target, uint256 value, bytes memory data) internal {
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) revert ExecutionFailed(target, value, ret);
    }

    // ===================== ERC-7579 views =====================

    function isModuleInstalled(uint256 moduleTypeId, address module, bytes calldata)
        external
        view
        returns (bool)
    {
        if (moduleTypeId == MODULE_TYPE_VALIDATOR) return module == validator;
        if (moduleTypeId == MODULE_TYPE_HOOK) return module == hook;
        return false;
    }

    function supportsExecutionMode(bytes32 mode) external pure returns (bool) {
        bytes1 callType = bytes1(mode);
        return callType == _CALLTYPE_SINGLE || callType == _CALLTYPE_BATCH;
    }

    function accountId() external pure returns (string memory) {
        return "keel.minimal.v0.1";
    }
}
