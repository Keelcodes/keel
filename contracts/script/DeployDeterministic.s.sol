// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {KeelPolicyHook} from "../src/KeelPolicyHook.sol";
import {KeelBoundedActions} from "../src/KeelBoundedActions.sol";
import {OwnerECDSAValidator} from "../src/OwnerECDSAValidator.sol";

// ============================================================================
// DeployDeterministic.s.sol — deploys Keel's shared on-chain pieces at the
// *same address* on every chain by routing CREATE2 through a canonical
// deterministic deployment proxy that already exists at one address on BSC,
// Base and Ethereum mainnet (verified: 69-byte runtime at each).
//
//   forge script script/DeployDeterministic.s.sol \
//     --rpc-url $RPC --broadcast [--verify]
//
// Environment:
//   PRIVATE_KEY                  signer (defaults to anvil account #0 — forks only)
//   KEEL_BOUNDED_ACTIONS_OWNER   required; admin of the BoundedActions substrate
//   CREATE2_FACTORY              override (default: the Arachnid proxy below)
//   DEPLOY_SALT                  policy-hook salt override
//   DEPLOY_SALT_VALIDATOR        owner-validator salt override
//   DEPLOY_SALT_BOUNDED_ACTIONS  BoundedActions salt override
//
// The three contracts are fleet singletons — deployed once, referenced by every
// account and by the SDK. `KeelMinimalAccount` is deliberately absent from this
// list: its constructor installs the validator and the hook on itself, so it is
// a *per-account* deployment whose address belongs to the account owner, not a
// fleet address that has to match across chains.
//
// Why this is separate from Deploy.s.sol: a blank local anvil has no CREATE2
// proxy deployed, so the nonce-based Deploy.s.sol remains the local-dev path.
// This script is the real-chain path, where address parity across chains is
// what keeps the address book, the SDK and the docs single-sourced.
// ============================================================================
contract DeployDeterministic is Script {
    /// @dev Canonical deterministic deployment proxy ("Arachnid"). It deploys
    ///      `salt ++ initCode` with CREATE2 and returns the new address.
    address internal constant DEFAULT_FACTORY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// @dev Anvil account #0 — funded on every fork.
    uint256 internal constant ANVIL_PK0 = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    /// @dev Per-contract default salts. Bump a suffix to force a fresh deployment.
    string internal constant SALT_POLICY_HOOK = "keel.policy-hook.v1";
    string internal constant SALT_OWNER_VALIDATOR = "keel.owner-ecdsa-validator.v1";
    string internal constant SALT_BOUNDED_ACTIONS = "keel.bounded-actions.v1";

    error FactoryMissing(address factory);
    error FactoryCallFailed(bytes reason);
    error BoundedActionsOwnerRequired();

    /// @dev One planned deployment: the ledger key, the resolved address, and
    ///      the two inputs that make that address reproducible on another chain.
    struct Deployment {
        string name;
        address addr;
        bytes32 salt;
        bytes initCode;
    }

    function run() external {
        uint256 pk = vm.envOr("PRIVATE_KEY", ANVIL_PK0);
        address deployer = vm.addr(pk);
        address factory = vm.envOr("CREATE2_FACTORY", DEFAULT_FACTORY);
        if (factory.code.length == 0) revert FactoryMissing(factory);

        // The substrate's admin is baked into its init code, so it is part of
        // the CREATE2 address: a different owner on one chain means a different
        // address there. Required explicitly rather than defaulted — `owner`
        // has no setter, so a silent default would be unrecoverable.
        address boundedActionsOwner = vm.envOr("KEEL_BOUNDED_ACTIONS_OWNER", address(0));
        if (boundedActionsOwner == address(0)) revert BoundedActionsOwnerRequired();

        Deployment memory policyHook = _plan(
            "keelPolicyHook", vm.envOr("DEPLOY_SALT", SALT_POLICY_HOOK), type(KeelPolicyHook).creationCode
        );
        Deployment memory ownerValidator = _plan(
            "ownerECDSAValidator",
            vm.envOr("DEPLOY_SALT_VALIDATOR", SALT_OWNER_VALIDATOR),
            type(OwnerECDSAValidator).creationCode
        );
        Deployment memory boundedActions = _plan(
            "keelBoundedActions",
            vm.envOr("DEPLOY_SALT_BOUNDED_ACTIONS", SALT_BOUNDED_ACTIONS),
            abi.encodePacked(type(KeelBoundedActions).creationCode, abi.encode(boundedActionsOwner))
        );

        _deploy(factory, pk, policyHook);
        _deploy(factory, pk, ownerValidator);
        _deploy(factory, pk, boundedActions);

        _writeLedger(deployer, factory, policyHook, ownerValidator, boundedActions);

        console2.log("chainId            :", block.chainid);
        console2.log("deployer           :", deployer);
        console2.log("factory            :", factory);
        console2.log("boundedActionsOwner:", boundedActionsOwner);
        console2.log("keelPolicyHook     :", policyHook.addr);
        console2.log("ownerECDSAValidator:", ownerValidator.addr);
        console2.log("keelBoundedActions :", boundedActions.addr);
    }

    /// @dev Describes one deployment; the address is resolved in `_deploy`, once
    ///      the (possibly overridden) factory is known.
    function _plan(string memory name, string memory saltText, bytes memory initCode)
        internal
        pure
        returns (Deployment memory d)
    {
        d.name = name;
        d.salt = keccak256(bytes(saltText));
        d.initCode = initCode;
    }

    function _deploy(address factory, uint256 pk, Deployment memory d) internal {
        d.addr = computeAddress(factory, d.salt, keccak256(d.initCode));
        if (d.addr.code.length > 0) {
            // CREATE2 is idempotent: a rerun against a chain that already holds
            // the deployment is a no-op, not a failure.
            console2.log("already deployed - skipping:", d.name);
            return;
        }

        vm.startBroadcast(pk);
        (bool ok, bytes memory ret) = factory.call(abi.encodePacked(d.salt, d.initCode));
        vm.stopBroadcast();
        if (!ok) revert FactoryCallFailed(ret);
        // The factory returns the new address, but it is not decoded: under
        // this toolchain `abi.decode` of that return reverts. It is not needed
        // either — the CREATE2 address is `d.addr` by construction, and the
        // factory itself reverts when the slot is already occupied. Presence on
        // chain is confirmed afterwards (`cast codesize`).
    }

    /// @dev EIP-1014 CREATE2 address. Depends only on the factory address, the
    ///      salt and the init code hash, so it is identical on every chain where
    ///      the factory lives at the same address.
    function computeAddress(address factory, bytes32 salt, bytes32 initCodeHash)
        public
        pure
        returns (address)
    {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), factory, salt, initCodeHash))))
        );
    }

    function _writeLedger(
        address deployer,
        address factory,
        Deployment memory a,
        Deployment memory b,
        Deployment memory c
    ) internal {
        // Built by hand: the `vm.serialize*`/`vm.writeJson` cheatcodes blow past
        // the via-ir stack depth when co-located with a broadcast deployment.
        string memory j = string.concat(
            '{"chainId":"',
            vm.toString(block.chainid),
            '","deployer":"',
            vm.toString(deployer),
            '","factory":"',
            vm.toString(factory),
            '","contracts":{'
        );
        j = string.concat(j, _entry(a), ",", _entry(b), ",", _entry(c));
        j = string.concat(j, '},"timestamp":"', vm.toString(block.timestamp), '"}');

        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.writeFile(path, j);
        console2.log("ledger             :", path);
    }

    /// @dev `<name>` → `{"address","salt","initCodeHash"}`, so cross-chain parity
    ///      is auditable rather than asserted.
    function _entry(Deployment memory d) internal view returns (string memory) {
        return string.concat(
            '"',
            d.name,
            '":{"address":"',
            vm.toString(d.addr),
            '","salt":"',
            vm.toString(d.salt),
            '","initCodeHash":"',
            vm.toString(keccak256(d.initCode)),
            '"}'
        );
    }
}
