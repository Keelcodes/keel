// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {
    IValidator,
    VALIDATION_SUCCESS,
    VALIDATION_FAILED,
    MODULE_TYPE_VALIDATOR
} from "erc7579-implementation/src/interfaces/IERC7579Module.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {ECDSA} from "solady/utils/ECDSA.sol";

// ============================================================================
// OwnerECDSAValidator — minimal single-owner ERC-7579 validator used by the
// on-chain acceptance harness.
//
// The Rhinestone reference `SimpleExecutionValidator` accepts *any* signature
// (it only decodes the execution framing), which is perfect for its own tests
// but cannot prove that a specific funded key controls the account. This module
// stores one ECDSA owner per account at install time and validates the ERC-4337
// `userOpHash` against it, so a UserOp only lands if it is signed by the owner.
//
// Install data: `abi.encode(address owner)`.
// ============================================================================
contract OwnerECDSAValidator is IValidator {
    mapping(address account => address owner) private _owners;

    error InvalidOwner();

    function onInstall(bytes calldata data) external {
        if (_owners[msg.sender] != address(0)) revert AlreadyInitialized(msg.sender);
        address owner = abi.decode(data, (address));
        if (owner == address(0)) revert InvalidOwner();
        _owners[msg.sender] = owner;
    }

    function onUninstall(bytes calldata) external {
        if (_owners[msg.sender] == address(0)) revert NotInitialized(msg.sender);
        delete _owners[msg.sender];
    }

    function isInitialized(address smartAccount) external view returns (bool) {
        return _owners[smartAccount] != address(0);
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == MODULE_TYPE_VALIDATOR;
    }

    function ownerOf(address account) external view returns (address) {
        return _owners[account];
    }

    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash)
        external
        view
        returns (uint256)
    {
        address owner = _owners[msg.sender];
        if (owner == address(0)) return VALIDATION_FAILED;
        address signer = ECDSA.recover(userOpHash, userOp.signature);
        return signer == owner ? VALIDATION_SUCCESS : VALIDATION_FAILED;
    }

    function isValidSignatureWithSender(address, bytes32 hash, bytes calldata data)
        external
        view
        returns (bytes4)
    {
        address owner = _owners[msg.sender];
        if (owner != address(0) && ECDSA.recover(hash, data) == owner) {
            return 0x1626ba7e; // EIP-1271 magic value
        }
        return 0xffffffff;
    }
}
