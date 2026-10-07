// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

// ============================================================================
// Minimal ERC-7579 module interfaces (https://eips.ethereum.org/EIPS/eip-7579).
//
// Declared locally: Keel has no dependency on any account implementation, and
// the module only needs these two interfaces to be installable on Kernel,
// Nexus and Safe7579 alike.
// ============================================================================

// Module type IDs from ERC-7579.
uint256 constant MODULE_TYPE_VALIDATOR = 1;
uint256 constant MODULE_TYPE_EXECUTOR = 2;
uint256 constant MODULE_TYPE_FALLBACK = 3;
uint256 constant MODULE_TYPE_HOOK = 4;

interface IERC7579Module {
    /// Called by the smart account on installation; MUST revert on error.
    function onInstall(bytes calldata data) external payable;

    /// Called by the smart account on uninstallation; MUST revert on error.
    function onUninstall(bytes calldata data) external payable;

    /// MUST return true if this module implements the given ERC-7579 module type.
    function isModuleType(uint256 moduleTypeId) external view returns (bool);

    /// MUST return true if the module was already initialised for `smartAccount`.
    function isInitialized(address smartAccount) external view returns (bool);
}

interface IERC7579Hook is IERC7579Module {
    /**
     * Called by the smart account before execution.
     *
     * Note the two distinct "senders": `msg.sender` inside the hook is the
     * smart account itself, while `msgSender` is the address that called the
     * account (the EntryPoint in an ERC-4337 flow). `msgData` is the calldata
     * the account received — for an ERC-4337 flow that is the account's
     * `execute(bytes32,bytes)` call, regardless of account implementation.
     */
    function preCheck(address msgSender, uint256 msgValue, bytes calldata msgData)
        external
        payable
        returns (bytes memory hookData);

    /// Called by the smart account after execution with the `preCheck` return value.
    function postCheck(bytes calldata hookData) external payable;
}
