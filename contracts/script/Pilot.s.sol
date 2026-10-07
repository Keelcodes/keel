// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";

import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";

import {MSAFactory} from "erc7579-implementation/src/MSAFactory.sol";
import {Bootstrap, BootstrapConfig} from "erc7579-implementation/src/utils/Bootstrap.sol";
import {IERC7579Account} from "erc7579-implementation/src/interfaces/IERC7579Account.sol";
import {ModeLib} from "erc7579-implementation/src/lib/ModeLib.sol";
import {ExecutionLib} from "erc7579-implementation/src/lib/ExecutionLib.sol";

import {KeelPolicyHook, Rule, TokenLimit} from "../src/KeelPolicyHook.sol";
import {OwnerECDSAValidator} from "../src/OwnerECDSAValidator.sol";

// ============================================================================
// Pilot.s.sol — the per-chain wave runner for the production migration waves
// (RUNBOOK §9 W1–W4, plan §7.5 steps 3–5). One account, two real UserOps.
//
// Unlike `Acceptance.s.sol` (which proves four *independent* account codebases
// on a fresh chain and therefore deploys its own stacks), this script REUSES the
// infrastructure already deployed on the chain — the deterministic Keel hook and
// validator (§1), plus the MSA factory + Bootstrap recorded in
// `deployments/acceptance-<chainId>.json`. It deploys nothing; it only creates
// ONE tightly-capped pilot account and drives the §3 gate on it.
//
// Flow (RUNBOOK §9 checklist D + E):
//   1. create a fresh MSA pilot with a tiny daily cap (Bootstrap installs the
//      validator + the Keel hook atomically, one session id)
//   2. dual probe: `isModuleInstalled(4, hook)` AND `hook.isInitialized`
//   3. UserOp #1 — value UNDER the cap: must SUCCEED and accrue
//   4. UserOp #2 — value OVER the cap: must FAIL on-chain with
//      `DailyLimitExceeded` (0x194bd314), leaving accrual UNCHANGED
//   → ledger `deployments/pilot-<chainId>.json`
//
// Environment (all reusable addresses default to the chain's fleet values):
//   PRIVATE_KEY                        signer + account owner (REQUIRED on mainnet)
//   PILOT_HOOK                         default the deterministic KeelPolicyHook
//   PILOT_VALIDATOR                    default the deterministic OwnerECDSAValidator
//   PILOT_MSA_FACTORY                  required — reuse the deployed MSAFactory
//   PILOT_BOOTSTRAP                    optional — reuse the deployed Bootstrap;
//                                      when unset one is deployed (e.g. BSC)
//   PILOT_ENTRYPOINT                   default the canonical ERC-4337 v0.7 EntryPoint
//   PILOT_SALT                         CREATE2 salt (default per chain id)
//   PILOT_LEDGER                       ledger path (default deployments/pilot-<chainId>.json)
//   PILOT_SESSION_ID                   default keccak256("keel.pilot.session.v1")
//   PILOT_RECIPIENT                    policy target (default: 0x…bEEF)
//   PILOT_VALUE_UNDER / _VALUE_OVER / _DAILY_CAP / _FUNDING
//   PILOT_MAX_FEE_PER_GAS / _MAX_PRIORITY_FEE_PER_GAS
//   PILOT_VERIFICATION_GAS_LIMIT / _CALL_GAS_LIMIT / _PRE_VERIFICATION_GAS
//
// A wave is `PILOT_*` + `forge script … --rpc-url <chain> --broadcast`. Re-running
// with the same salt is refused by the factory (the account already exists); use a
// fresh `PILOT_SALT` (or a fresh daily window) for a re-entrant run, which is the
// normal path after a rollback (§9).
// ============================================================================
contract Pilot is Script {
    /// @dev Canonical ERC-4337 v0.7 EntryPoint (hard-coded by MSAAdvanced).
    address internal constant DEFAULT_ENTRYPOINT = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    /// @dev KeelPolicyHook — same address on BSC (56), Base (8453) and Ethereum (1).
    address internal constant DEFAULT_HOOK = 0x466b5DC3796D44b0B63FdF2d3bC7a8Ea371a891F;
    /// @dev OwnerECDSAValidator — same address on all three chains.
    address internal constant DEFAULT_VALIDATOR = 0x26423D1c7EFf7F21a56DD3065081eB700Cd02f50;

    /// @dev Well-known, pre-funded anvil account #0 (forks only).
    uint256 internal constant ANVIL_PK0 = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    /// @dev Default policy target for the value transfer. MUST differ from the
    ///      bundling deployer: `handleOps`'s beneficiary is also the deployer, and
    ///      its balance absorbs the gas refund, which would break the exact
    ///      balance assertions. A codeless burn address is the Acceptance convention.
    address internal constant DEFAULT_RECIPIENT = 0x000000000000000000000000000000000000bEEF;

    uint256 internal constant MODULE_TYPE_HOOK = 4;

    bytes32 internal constant UOE_TOPIC =
        keccak256("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)");
    bytes32 internal constant UORR_TOPIC =
        keccak256("UserOperationRevertReason(bytes32,address,uint256,bytes)");

    /// @dev EntryPoint aborts the bundle (AA95) unless the outer tx carries at
    ///      least the operation's declared gas; the estimator only reports actual use.
    uint256 internal constant HANDLE_OPS_GAS = 2_500_000;

    struct Cfg {
        address entryPoint;
        address hook;
        address validator;
        address factory;
        address bootstrap;
        address recipient;
        bytes32 sessionId;
        bytes32 salt;
        uint256 valueUnder;
        uint256 valueOver;
        uint256 dailyCap;
        uint256 funding;
        uint256 maxFeePerGas;
        uint256 maxPriorityFeePerGas;
        uint256 verificationGasLimit;
        uint256 callGasLimit;
        uint256 preVerificationGas;
    }

    function run() external {
        uint256 pk = vm.envOr("PRIVATE_KEY", ANVIL_PK0);
        address deployer = vm.addr(pk);

        Cfg memory c = _config(deployer);

        require(c.hook.code.length != 0, "PILOT_HOOK has no code");
        require(c.validator.code.length != 0, "PILOT_VALIDATOR has no code");
        require(c.entryPoint.code.length != 0, "PILOT_ENTRYPOINT has no code");
        require(c.factory.code.length != 0, "PILOT_MSA_FACTORY has no code");

        // The MSA's initData embeds a Bootstrap, which the account delegatecalls
        // at creation. Reuse the configured one; deploy one only when none is
        // given (e.g. BSC, whose recorded address no longer holds code).
        if (c.bootstrap == address(0)) {
            vm.startBroadcast(pk);
            c.bootstrap = address(new Bootstrap());
            vm.stopBroadcast();
            console2.log("deployed Bootstrap:", c.bootstrap);
        } else {
            require(c.bootstrap.code.length != 0, "PILOT_BOOTSTRAP has no code");
        }

        bytes memory policyData;
        bytes32 commitment;
        (policyData, commitment) = _buildPolicy(c.recipient, c.dailyCap);

        address account = _createPilot(c, pk, deployer, policyData);

        _dryProbe(c, account, commitment);

        (bytes32 uh1, bool step1Pass) = _runUnder(c, pk, deployer, account, commitment);
        (bytes32 uh2, bool step2Pass) = _runOver(c, pk, deployer, account, commitment);

        bool passed = step1Pass && step2Pass;
        _writeLedger(c, deployer, account, commitment, uh1, uh2, step1Pass, step2Pass, passed);
        _print(c, deployer, account, commitment, uh1, uh2, step1Pass, step2Pass, passed);
        require(passed, "pilot FAILED");
    }

    function _config(address deployer) internal view returns (Cfg memory c) {
        c.entryPoint = vm.envOr("PILOT_ENTRYPOINT", DEFAULT_ENTRYPOINT);
        c.hook = vm.envOr("PILOT_HOOK", DEFAULT_HOOK);
        c.validator = vm.envOr("PILOT_VALIDATOR", DEFAULT_VALIDATOR);
        c.factory = vm.envAddress("PILOT_MSA_FACTORY");
        c.bootstrap = vm.envOr("PILOT_BOOTSTRAP", address(0));
        c.recipient = vm.envOr("PILOT_RECIPIENT", DEFAULT_RECIPIENT);
        c.sessionId = vm.envOr("PILOT_SESSION_ID", keccak256("keel.pilot.session.v1"));
        c.salt = keccak256(
            bytes(vm.envOr("PILOT_SALT", string.concat("keel.pilot.", vm.toString(block.chainid), ".v1")))
        );

        c.valueUnder = vm.envOr("PILOT_VALUE_UNDER", uint256(100_000_000_000_000));
        c.valueOver = vm.envOr("PILOT_VALUE_OVER", uint256(200_000_000_000_000));
        c.dailyCap = vm.envOr("PILOT_DAILY_CAP", uint256(150_000_000_000_000));
        c.funding = vm.envOr("PILOT_FUNDING", uint256(200_000_000_000_000));
        c.maxFeePerGas = vm.envOr("PILOT_MAX_FEE_PER_GAS", uint256(50_000_000));
        c.maxPriorityFeePerGas = vm.envOr("PILOT_MAX_PRIORITY_FEE_PER_GAS", uint256(10_000_000));
        c.verificationGasLimit = vm.envOr("PILOT_VERIFICATION_GAS_LIMIT", uint256(400_000));
        c.callGasLimit = vm.envOr("PILOT_CALL_GAS_LIMIT", uint256(400_000));
        c.preVerificationGas = vm.envOr("PILOT_PRE_VERIFICATION_GAS", uint256(120_000));

        // The gate only means something if step 1 fits under the cap and step 2
        // does not — a scaled-down run must keep that relationship.
        require(c.valueUnder <= c.dailyCap && c.valueUnder + c.valueOver > c.dailyCap, "scenario inconsistent");
        require(
            c.funding >= c.valueUnder
                + (c.verificationGasLimit + c.callGasLimit + c.preVerificationGas) * c.maxFeePerGas,
            "funding does not cover the second UserOp prefund"
        );
    }

    /// @dev `abi.encode(version, validAfter, validUntil, rules)` — the same bytes
    ///      `encodePolicy(policy)` produces off-chain, so the on-chain commitment
    ///      equals `policyCommitment(policy)`.
    function _buildPolicy(address recipient, uint256 dailyCap)
        internal
        pure
        returns (bytes memory policyData, bytes32 commitment)
    {
        Rule[] memory rules = new Rule[](1);
        rules[0] = Rule({
            target: recipient,
            selectors: new bytes4[](0),
            maxPerTx: 0,
            maxDaily: dailyCap,
            maxCalls: 0,
            tokenLimits: new TokenLimit[](0)
        });
        policyData = abi.encode(uint256(1), uint256(0), uint256(0), rules);
        commitment = keccak256(policyData);
    }

    /// @dev Creates the MSA pilot with the reused factory/Bootstrap; the hook is
    ///      installed atomically at creation (one session id, tightly capped).
    function _createPilot(Cfg memory c, uint256 pk, address deployer, bytes memory policyData)
        internal
        returns (address account)
    {
        BootstrapConfig[] memory validators = new BootstrapConfig[](1);
        validators[0] = BootstrapConfig({module: c.validator, data: abi.encode(deployer)});
        BootstrapConfig[] memory executors = new BootstrapConfig[](0);
        BootstrapConfig memory hookCfg = BootstrapConfig({module: c.hook, data: abi.encode(c.sessionId, policyData)});
        BootstrapConfig[] memory fallbacks = new BootstrapConfig[](0);

        bytes memory initData =
            Bootstrap(payable(c.bootstrap))._getInitMSACalldata(validators, executors, hookCfg, fallbacks);

        MSAFactory factory = MSAFactory(c.factory);
        account = factory.getAddress(c.salt, initData);
        require(account.code.length == 0, "pilot account already deployed; use a fresh PILOT_SALT");

        vm.startBroadcast(pk);
        factory.createAccount(c.salt, initData);
        _fund(c, account);
        vm.stopBroadcast();
        require(account.code.length != 0, "pilot account deployment failed");
    }

    function _fund(Cfg memory c, address account) internal {
        (bool funded,) = payable(account).call{value: c.funding}("");
        require(funded, "account funding failed");
    }

    function _dryProbe(Cfg memory c, address account, bytes32 commitment) internal view {
        KeelPolicyHook h = KeelPolicyHook(c.hook);
        require(
            IERC7579Account(account).isModuleInstalled(MODULE_TYPE_HOOK, c.hook, ""),
            "probe failed: hook not installed"
        );
        require(h.isInitialized(account), "probe failed: hook not initialized");
        require(h.policyCommitmentOf(account, c.sessionId) == commitment, "probe failed: commitment mismatch");
        bytes32[] memory ids = h.sessionIdsOf(account);
        require(ids.length == 1 && ids[0] == c.sessionId, "probe failed: session list mismatch");
    }

    function _runUnder(Cfg memory c, uint256 pk, address deployer, address account, bytes32 commitment)
        internal
        returns (bytes32 userOpHash, bool pass)
    {
        uint256 recipientBefore = c.recipient.balance;
        (PackedUserOperation memory op, bytes32 uh) =
            _makeValueOp(c, account, c.valueUnder, _nonce(c, account), pk);
        userOpHash = uh;
        (bool found, bool ok, bytes memory reason) = _submit(c, pk, deployer, op, uh);
        (uint256 calls, uint256 spent) = _usage(c, account);
        bytes32[] memory ids = KeelPolicyHook(c.hook).sessionIdsOf(account);
        pass = found && ok && reason.length == 0 && calls == 1 && spent == c.valueUnder
            && KeelPolicyHook(c.hook).policyCommitmentOf(account, c.sessionId) == commitment
            && ids.length == 1 && ids[0] == c.sessionId && c.recipient.balance == recipientBefore + c.valueUnder;
    }

    function _runOver(Cfg memory c, uint256 pk, address deployer, address account, bytes32 commitment)
        internal
        returns (bytes32 userOpHash, bool pass)
    {
        uint256 recipientBefore = c.recipient.balance;
        (PackedUserOperation memory op, bytes32 uh) =
            _makeValueOp(c, account, c.valueOver, _nonce(c, account), pk);
        userOpHash = uh;
        (bool found, bool ok, bytes memory reason) = _submit(c, pk, deployer, op, uh);
        (uint256 calls, uint256 spent) = _usage(c, account);
        bytes4 selector = _selectorOf(reason);
        pass = found && !ok && selector == KeelPolicyHook.DailyLimitExceeded.selector && calls == 1
            && spent == c.valueUnder && c.recipient.balance == recipientBefore
            && KeelPolicyHook(c.hook).policyCommitmentOf(account, c.sessionId) == commitment;
    }

    // ===================== userOp plumbing =====================

    /// @dev MSAAdvanced derives the validator as the top 160 bits of the nonce key.
    function _nonce(Cfg memory c, address account) internal view returns (uint256) {
        uint192 validatorKey = uint192(uint256(uint160(c.validator)) << 32);
        return IEntryPoint(c.entryPoint).getNonce(account, validatorKey);
    }

    function _makeValueOp(Cfg memory c, address account, uint256 value, uint256 nonce, uint256 pk)
        internal
        view
        returns (PackedUserOperation memory op, bytes32 userOpHash)
    {
        bytes memory executeCall = abi.encodeCall(
            IERC7579Account.execute,
            (ModeLib.encodeSimpleSingle(), ExecutionLib.encodeSingle(c.recipient, value, ""))
        );
        op = PackedUserOperation({
            sender: account,
            nonce: nonce,
            initCode: "",
            callData: executeCall,
            accountGasLimits: bytes32(
                abi.encodePacked(uint128(c.verificationGasLimit), uint128(c.callGasLimit))
            ),
            preVerificationGas: c.preVerificationGas,
            gasFees: bytes32(abi.encodePacked(uint128(c.maxPriorityFeePerGas), uint128(c.maxFeePerGas))),
            paymasterAndData: "",
            signature: ""
        });
        userOpHash = IEntryPoint(c.entryPoint).getUserOpHash(op);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, userOpHash);
        op.signature = abi.encodePacked(r, s, v);
    }

    /// @dev `handleOps` never reverts on an execution-phase failure — it emits
    ///      `UserOperationRevertReason` — so the outcome is read from the logs.
    function _submit(Cfg memory c, uint256 pk, address deployer, PackedUserOperation memory op, bytes32 uh)
        internal
        returns (bool found, bool success, bytes memory reason)
    {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;

        vm.startBroadcast(pk);
        vm.recordLogs();
        IEntryPoint(c.entryPoint).handleOps{gas: HANDLE_OPS_GAS}(ops, payable(deployer));
        vm.stopBroadcast();

        return _outcome(vm.getRecordedLogs(), uh);
    }

    function _outcome(Vm.Log[] memory logs, bytes32 userOpHash)
        internal
        pure
        returns (bool found, bool success, bytes memory reason)
    {
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory log = logs[i];
            if (log.topics.length >= 2 && log.topics[1] == userOpHash) {
                if (log.topics[0] == UOE_TOPIC) {
                    (, bool s,,) = abi.decode(log.data, (uint256, bool, uint256, uint256));
                    found = true;
                    success = s;
                } else if (log.topics[0] == UORR_TOPIC) {
                    (, bytes memory r) = abi.decode(log.data, (uint256, bytes));
                    reason = r;
                }
            }
        }
    }

    function _usage(Cfg memory c, address account) internal view returns (uint256 calls, uint256 spent) {
        (, calls, spent) = KeelPolicyHook(c.hook).usageOf(account, c.sessionId, 0);
    }

    function _selectorOf(bytes memory data) internal pure returns (bytes4 selector) {
        if (data.length < 4) return bytes4(0);
        assembly ("memory-safe") {
            selector := mload(add(data, 0x20))
        }
    }

    // ===================== reporting =====================

    function _writeLedger(
        Cfg memory c,
        address deployer,
        address account,
        bytes32 commitment,
        bytes32 uh1,
        bytes32 uh2,
        bool step1Pass,
        bool step2Pass,
        bool passed
    ) internal {
        string memory j = "{";
        j = string.concat(j, _fd("chainId", vm.toString(block.chainid)));
        j = string.concat(j, _fd("deployer", vm.toString(deployer)));
        j = string.concat(j, _fd("entryPoint", vm.toString(c.entryPoint)));
        j = string.concat(j, _fd("keelPolicyHook", vm.toString(c.hook)));
        j = string.concat(j, _fd("validator", vm.toString(c.validator)));
        j = string.concat(j, _fd("msaFactory", vm.toString(c.factory)));
        j = string.concat(j, _fd("bootstrap", vm.toString(c.bootstrap)));
        j = string.concat(j, _fd("recipient", vm.toString(c.recipient)));
        j = string.concat(j, _fd("valueUnder", vm.toString(c.valueUnder)));
        j = string.concat(j, _fd("valueOver", vm.toString(c.valueOver)));
        j = string.concat(j, _fd("dailyCap", vm.toString(c.dailyCap)));
        j = string.concat(j, _fd("funding", vm.toString(c.funding)));
        j = string.concat(j, _fd("maxFeePerGas", vm.toString(c.maxFeePerGas)));
        j = string.concat(j, _fd("sessionId", vm.toString(c.sessionId)));
        j = string.concat(j, _fd("policyCommitment", vm.toString(commitment)));
        j = string.concat(j, _fd("account", vm.toString(account)));
        j = string.concat(j, _fd("userOpHash1", vm.toString(uh1)));
        j = string.concat(j, _fd("userOpHash2", vm.toString(uh2)));
        j = string.concat(j, _fd("step1Pass", step1Pass ? "true" : "false"));
        j = string.concat(j, _fd("step2Pass", step2Pass ? "true" : "false"));
        j = string.concat(j, _fdLast("passed", passed ? "true" : "false"));
        j = string.concat(j, "}");
        string memory path = vm.envOr(
            "PILOT_LEDGER", string.concat("deployments/pilot-", vm.toString(block.chainid), ".json")
        );
        vm.writeFile(path, j);
    }

    function _fd(string memory k, string memory v) internal pure returns (string memory) {
        return string.concat('"', k, '":"', v, '",');
    }

    function _fdLast(string memory k, string memory v) internal pure returns (string memory) {
        return string.concat('"', k, '":"', v, '"');
    }

    function _print(
        Cfg memory c,
        address deployer,
        address account,
        bytes32 commitment,
        bytes32 uh1,
        bytes32 uh2,
        bool step1Pass,
        bool step2Pass,
        bool passed
    ) internal view {
        console2.log("=== Keel pilot (RUNBOOK 9 wave) ===");
        console2.log("chainId        :", block.chainid);
        console2.log("deployer       :", deployer);
        console2.log("account        :", account);
        console2.log("hook           :", c.hook);
        console2.log("validator      :", c.validator);
        console2.log("recipient      :", c.recipient);
        console2.log("valueUnder     :", c.valueUnder);
        console2.log("valueOver      :", c.valueOver);
        console2.log("dailyCap       :", c.dailyCap);
        console2.log("sessionId      :", vm.toString(c.sessionId));
        console2.log("commitment     :", vm.toString(commitment));
        console2.log("userOpHash1    :", vm.toString(uh1));
        console2.log("userOpHash2    :", vm.toString(uh2));
        console2.log("step1 under cap:", step1Pass);
        console2.log("step2 over cap :", step2Pass);
        console2.log(passed ? "RESULT: PASS" : "RESULT: FAIL");
    }
}
