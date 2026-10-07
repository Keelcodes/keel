// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {KeelPolicyHook} from "../src/KeelPolicyHook.sol";

// ============================================================================
// Deploy.s.sol — deploys KeelPolicyHook and writes a deployments ledger.
//
// Chain-agnostic: the same script works against any `--rpc-url`; the ledger is
// keyed by `block.chainid` so repeated runs against different chains do not
// collide. The signer comes from `PRIVATE_KEY` when set, otherwise the first
// default anvil dev key (pre-funded on a local anvil) is used.
// ============================================================================
contract Deploy is Script {
    // Anvil account #0 (well-known, pre-funded on every local anvil).
    uint256 internal constant ANVIL_PK0 = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    function run() external {
        uint256 pk = vm.envOr("PRIVATE_KEY", ANVIL_PK0);
        address deployer = vm.addr(pk);
        uint256 chainId = block.chainid;

        vm.startBroadcast(pk);
        KeelPolicyHook hook = new KeelPolicyHook();
        vm.stopBroadcast();

        // Build the JSON by hand: the `vm.serialize*`/`vm.writeJson` cheatcodes
        // blow past the via-ir stack depth when co-located with a broadcast
        // deployment, so we assemble the document and use `vm.writeFile`.
        string memory j = "{";
        j = string.concat(j, _fd("chainId", vm.toString(chainId)));
        j = string.concat(j, _fd("keelPolicyHook", vm.toString(address(hook))));
        j = string.concat(j, _fd("deployer", vm.toString(deployer)));
        j = string.concat(j, _fdLast("timestamp", vm.toString(block.timestamp)));
        j = string.concat(j, "}");

        string memory path = string.concat("deployments/", vm.toString(chainId), ".json");
        vm.writeFile(path, j);

        console2.log("chainId          :", chainId);
        console2.log("deployer         :", deployer);
        console2.log("KeelPolicyHook   :", address(hook));
        console2.log("ledger           :", path);
    }

    /// @dev JSON field `"key":"value",` (trailing comma).
    function _fd(string memory k, string memory v) internal pure returns (string memory) {
        return string.concat('"', k, '":"', v, '",');
    }

    /// @dev JSON field `"key":"value"` (no trailing comma).
    function _fdLast(string memory k, string memory v) internal pure returns (string memory) {
        return string.concat('"', k, '":"', v, '"');
    }
}
