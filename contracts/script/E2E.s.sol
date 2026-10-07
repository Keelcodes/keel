// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";

import {MSAAdvanced} from "erc7579-implementation/src/MSAAdvanced.sol";
import {MSAFactory} from "erc7579-implementation/src/MSAFactory.sol";
import {Bootstrap, BootstrapConfig} from "erc7579-implementation/src/utils/Bootstrap.sol";
import {IERC7579Account} from "erc7579-implementation/src/interfaces/IERC7579Account.sol";
import {ModeLib} from "erc7579-implementation/src/lib/ModeLib.sol";
import {ExecutionLib} from "erc7579-implementation/src/lib/ExecutionLib.sol";

import {KeelPolicyHook, Rule, TokenLimit} from "../src/KeelPolicyHook.sol";
import {OwnerECDSAValidator} from "../src/OwnerECDSAValidator.sol";

// ============================================================================
// E2E.s.sol — one real UserOp on a live chain: HOT-INSTALL KeelPolicyHook on an
// already-created account, then verify with read-only probes.
//
// This is the mainnet counterpart of `packages/adapters/scripts/migration-drill.mjs`:
// the drill proves the same install path on a fork (where the account can be
// impersonated), this script proves it against a real deployed hook with a real
// signed UserOp — no impersonation, no fork.
//
// Flow:
//   0. deploy the MSA stack + owner validator (the hook is reused, not redeployed)
//   1. create a Rhinestone MSA WITHOUT a hook (Bootstrap skips a zero hook config)
//   2. one UserOp: the account executes `installModule(4, hook, abi.encode(sessionId, policyData))`
//   3. read-only probes: isModuleInstalled / isInitialized / policyCommitmentOf / sessionIdsOf
//
// Environment:
//   PRIVATE_KEY       signer + account owner (defaults to anvil account #0 — forks only)
//   KEEL_POLICY_HOOK  the deployed hook (default: the deterministic BSC/Base/ETH address)
//   E2E_RECIPIENT     policy target (default: the deployer)
//   E2E_SALT          CREATE2 salt for the account (default below)
//
// Because the install is a ERC-7579 module-management call it runs through the
// hook's `preCheck` on a hook-GATED account — the account here has no hook yet,
// which is exactly the state a migration starts from.
// ============================================================================
contract E2E is Script {
    /// @dev Canonical ERC-4337 v0.7 EntryPoint (hard-coded by MSAAdvanced).
    address internal constant ENTRYPOINT_ADDR = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;

    /// @dev KeelPolicyHook deployed at the same address on BSC (56), Base (8453) and Ethereum (1).
    address internal constant DEFAULT_HOOK = 0x466b5DC3796D44b0B63FdF2d3bC7a8Ea371a891F;

    uint256 internal constant ANVIL_PK0 = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    uint256 internal constant MODULE_TYPE_HOOK = 4;
    uint256 internal constant DAILY_CAP = 0.1 ether;

    /// @dev UserOp gas limits. Kept deliberately tight: the prefund EntryPoint
    ///      pulls from the account is `(verification + call + preVerification) * maxFeePerGas`.
    ///      The fee caps are deliberately low — this runs on BSC, whose base fee
    ///      is near zero, and the deployer's balance is small.
    uint256 internal constant VERIFICATION_GAS_LIMIT = 400_000;
    uint256 internal constant CALL_GAS_LIMIT = 800_000;
    uint256 internal constant PRE_VERIFICATION_GAS = 150_000;
    uint256 internal constant MAX_FEE_PER_GAS = 0.5 gwei;
    uint256 internal constant MAX_PRIORITY_FEE_PER_GAS = 0.1 gwei;
    uint256 internal constant ACCOUNT_FUNDING = 0.0015 ether;

    /// @dev EntryPoint aborts the bundle (AA95) unless the outer tx carries at
    ///      least the operation's declared gas; the estimator only reports actual use.
    uint256 internal constant HANDLE_OPS_GAS = 2_500_000;

    bytes32 internal constant SESSION_ID = keccak256("keel.e2e.bsc.session.v1");

    function run() external {
        uint256 pk = vm.envOr("PRIVATE_KEY", ANVIL_PK0);
        address deployer = vm.addr(pk);
        address hook = vm.envOr("KEEL_POLICY_HOOK", DEFAULT_HOOK);
        address recipient = vm.envOr("E2E_RECIPIENT", deployer);
        bytes32 salt = keccak256(bytes(vm.envOr("E2E_SALT", string("keel.e2e.bsc.account.v1"))));

        require(hook.code.length != 0, "hook not deployed at the configured address");
        require(ENTRYPOINT_ADDR.code.length != 0, "EntryPoint missing at the canonical address");
        IEntryPoint ep = IEntryPoint(ENTRYPOINT_ADDR);

        (OwnerECDSAValidator validator, MSAFactory factory, Bootstrap bootstrap) = _deployInfra(pk);

        (bytes memory policyData, bytes32 commitment) = _buildPolicy(recipient);

        address account = _createAccount(factory, bootstrap, validator, deployer, salt, pk);

        bytes32 userOpHash = _hotInstall(ep, pk, deployer, account, validator, hook, policyData);

        _verify(account, hook, commitment);
        _writeLedger(deployer, account, hook, userOpHash, commitment);

        console2.log("chainId        :", block.chainid);
        console2.log("deployer       :", deployer);
        console2.log("account (MSA)  :", account);
        console2.log("hook           :", hook);
        console2.log("sessionId      :", vm.toString(SESSION_ID));
        console2.log("commitment     :", vm.toString(commitment));
        console2.log("userOpHash     :", vm.toString(userOpHash));
        console2.log("PROBES         : all passed (installed / initialized / commitment / session list)");
    }

    // ===================== setup =====================

    function _deployInfra(uint256 pk)
        internal
        returns (OwnerECDSAValidator validator, MSAFactory factory, Bootstrap bootstrap)
    {
        vm.startBroadcast(pk);
        validator = new OwnerECDSAValidator();
        MSAAdvanced implementation = new MSAAdvanced();
        factory = new MSAFactory(address(implementation));
        bootstrap = new Bootstrap();
        vm.stopBroadcast();
    }

    /// @dev `abi.encode(version, validAfter, validUntil, rules)` — the same bytes
    ///      `encodePolicy(policy)` produces off-chain, so the on-chain commitment
    ///      equals `policyCommitment(policy)`.
    function _buildPolicy(address recipient)
        internal
        pure
        returns (bytes memory policyData, bytes32 commitment)
    {
        Rule[] memory rules = new Rule[](1);
        rules[0] = Rule({
            target: recipient,
            selectors: new bytes4[](0),
            maxPerTx: 0,
            maxDaily: DAILY_CAP,
            maxCalls: 0,
            tokenLimits: new TokenLimit[](0)
        });
        policyData = abi.encode(uint256(1), uint256(0), uint256(0), rules);
        commitment = keccak256(policyData);
    }

    /// @dev Creates the MSA with the owner validator and NO hook — the state a
    ///      migration starts from. Re-running reuses the account.
    function _createAccount(
        MSAFactory factory,
        Bootstrap bootstrap,
        OwnerECDSAValidator validator,
        address owner,
        bytes32 salt,
        uint256 pk
    ) internal returns (address account) {
        BootstrapConfig[] memory validatorCfgs = new BootstrapConfig[](1);
        validatorCfgs[0] = BootstrapConfig({module: address(validator), data: abi.encode(owner)});
        BootstrapConfig[] memory executors = new BootstrapConfig[](0);
        BootstrapConfig memory noHook = BootstrapConfig({module: address(0), data: bytes("")});
        BootstrapConfig[] memory fallbacks = new BootstrapConfig[](0);

        bytes memory initData = bootstrap._getInitMSACalldata(validatorCfgs, executors, noHook, fallbacks);
        account = factory.getAddress(salt, initData);

        if (account.code.length == 0) {
            vm.startBroadcast(pk);
            factory.createAccount(salt, initData);
            vm.stopBroadcast();
        }
        require(account.code.length != 0, "MSA creation failed");
    }

    // ===================== the hot install =====================

    /// @dev One real UserOp whose callData is the account executing
    ///      `installModule(4, hook, abi.encode(sessionId, policyData))` on itself.
    function _hotInstall(
        IEntryPoint ep,
        uint256 pk,
        address deployer,
        address account,
        OwnerECDSAValidator validator,
        address hook,
        bytes memory policyData
    ) internal returns (bytes32 userOpHash) {
        if (KeelPolicyHook(hook).policyCommitmentOf(account, SESSION_ID) != bytes32(0)) {
            console2.log("hook already installed on this account - skipping the UserOp");
            return bytes32(0);
        }

        bytes memory installCall = abi.encodeCall(
            IERC7579Account.installModule, (MODULE_TYPE_HOOK, hook, abi.encode(SESSION_ID, policyData))
        );
        bytes memory executionCalldata = ExecutionLib.encodeSingle(account, 0, installCall);
        bytes memory callData =
            abi.encodeCall(IERC7579Account.execute, (ModeLib.encodeSimpleSingle(), executionCalldata));

        // MSAAdvanced derives the validator as the top 160 bits of the nonce, and
        // the nonce is `key << 64 | seq`, so the key must carry the address at
        // `key >> 32`. Stated explicitly rather than via `bytes24` casting.
        uint192 validatorKey = uint192(uint256(uint160(address(validator))) << 32);

        PackedUserOperation memory op = PackedUserOperation({
            sender: account,
            nonce: ep.getNonce(account, validatorKey),
            initCode: "",
            callData: callData,
            accountGasLimits: bytes32(
                abi.encodePacked(uint128(VERIFICATION_GAS_LIMIT), uint128(CALL_GAS_LIMIT))
            ),
            preVerificationGas: PRE_VERIFICATION_GAS,
            gasFees: bytes32(abi.encodePacked(uint128(MAX_PRIORITY_FEE_PER_GAS), uint128(MAX_FEE_PER_GAS))),
            paymasterAndData: "",
            signature: ""
        });
        userOpHash = ep.getUserOpHash(op);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, userOpHash);
        op.signature = abi.encodePacked(r, s, v);

        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;

        vm.startBroadcast(pk);
        (bool funded,) = payable(account).call{value: ACCOUNT_FUNDING}("");
        require(funded, "account funding failed");
        ep.handleOps{gas: HANDLE_OPS_GAS}(ops, payable(deployer));
        vm.stopBroadcast();
    }

    // ===================== read-only probes =====================

    /// @dev The dual probe: the standard ERC-7579 surface plus the hook's own state.
    function _verify(address account, address hook, bytes32 commitment) internal view {
        KeelPolicyHook h = KeelPolicyHook(hook);
        require(
            IERC7579Account(account).isModuleInstalled(MODULE_TYPE_HOOK, hook, ""),
            "probe failed: hook not installed"
        );
        require(h.isInitialized(account), "probe failed: hook not initialized");
        require(h.policyCommitmentOf(account, SESSION_ID) == commitment, "probe failed: commitment mismatch");
        bytes32[] memory ids = h.sessionIdsOf(account);
        require(ids.length == 1 && ids[0] == SESSION_ID, "probe failed: session list mismatch");
    }

    // ===================== ledger =====================

    function _writeLedger(
        address deployer,
        address account,
        address hook,
        bytes32 userOpHash,
        bytes32 commitment
    ) internal {
        // Assembled by hand: `vm.serialize*`/`vm.writeJson` blow past the via-ir
        // stack depth when co-located with a broadcast.
        string memory j = "{";
        j = string.concat(j, _f("chainId", vm.toString(block.chainid)));
        j = string.concat(j, _f("account", vm.toString(account)));
        j = string.concat(j, _f("keelPolicyHook", vm.toString(hook)));
        j = string.concat(j, _f("sessionId", vm.toString(SESSION_ID)));
        j = string.concat(j, _f("commitment", vm.toString(commitment)));
        j = string.concat(j, _f("userOpHash", vm.toString(userOpHash)));
        j = string.concat(j, _f("deployer", vm.toString(deployer)));
        j = string.concat(j, _fLast("timestamp", vm.toString(block.timestamp)));
        j = string.concat(j, "}");

        string memory path = string.concat("deployments/e2e-", vm.toString(block.chainid), ".json");
        vm.writeFile(path, j);
        console2.log("ledger         :", path);
    }

    function _f(string memory k, string memory v) internal pure returns (string memory) {
        return string.concat('"', k, '":"', v, '",');
    }

    function _fLast(string memory k, string memory v) internal pure returns (string memory) {
        return string.concat('"', k, '":"', v, '"');
    }
}
