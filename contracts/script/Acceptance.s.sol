// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";

import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
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
import {KeelMinimalAccount} from "../src/KeelMinimalAccount.sol";

interface IAccountIdView {
    function accountId() external view returns (string memory);
}

/// @dev ERC-4337 v0.7 `IAccountExecute`: when a UserOp's callData starts with this
///      selector the EntryPoint hands the full UserOp to the account instead.
interface IAccountExecuteView {
    function executeUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash) external;
}

/// @dev The slice of ZeroDev Kernel's `initialize` the harness calls.
interface IKernelInit {
    function initialize(
        bytes21 rootValidator,
        address hook,
        bytes calldata validatorData,
        bytes calldata hookData,
        bytes[] calldata initConfig
    ) external payable;
}

interface IKernelFactoryView {
    function getAddress(bytes calldata data, bytes32 salt) external view returns (address);
    function createAccount(bytes calldata data, bytes32 salt) external payable returns (address);
}

/// @dev `ModuleInit` as Safe7579 / the launchpad expect it.
struct ModuleInit {
    address module;
    bytes initData;
    uint256 moduleType;
}

/// @dev The slice of Safe's proxy factory the harness needs.
interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes calldata initializer, uint256 saltNonce)
        external
        returns (address proxy);
}

/// @dev Only used for its `setup` selector, to build the proxy initializer.
interface ISafeSetup {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;
}

/// @dev The slice of Safe the harness drives: EIP-712 tx hashing + execution.
interface ISafeExec {
    function encodeTransactionData(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        uint256 nonce
    ) external view returns (bytes memory);

    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes calldata signatures
    ) external payable returns (bool success);
}

interface ISafe7579Launchpad {
    function addSafe7579(
        address safe7579,
        ModuleInit[] calldata modules,
        address[] calldata attesters,
        uint8 threshold
    ) external;
}

// ============================================================================
// Acceptance.s.sol — real end-to-end, on-chain acceptance for KeelPolicyHook.
//
// Against a live RPC it deploys (or reuses) the canonical ERC-4337 EntryPoint,
// the Rhinestone MSA stack, an ECDSA owner validator, KeelPolicyHook and — from
// committed artifacts (`fixtures/kernel/`, `fixtures/safe7579/`) — the ZeroDev
// Kernel and Rhinestone Safe7579 accounts. It then creates FOUR smart accounts
// whose *implementations differ*, installs the IDENTICAL policy on each, and
// drives each through the SAME two real UserOps:
//
//   policy: target = recipient, any selector, no per-tx cap, 1 ether / day
//   #1  transfer 0.4 ether  -> must SUCCEED and accrue (calls=1, spent=0.4)
//   #2  transfer 0.7 ether  -> must FAIL on-chain (0.4 + 0.7 > 1.0 daily cap),
//                              leaving usage UNCHANGED (no partial accrual)
//
// Those amounts are the defaults tuned for a fork, where the deployer is a
// pre-funded anvil account and gas is free. On a public chain — where `funding`
// is real money and the EntryPoint makes each account pre-fund
// `(verification + call + preVerification) * maxFeePerGas` — pass the
// `ACCEPTANCE_*` overrides documented next to the scenario fields below: scale
// the values down, shrink the gas limits and `maxFeePerGas`, and point
// `KEEL_POLICY_HOOK` / `KEEL_OWNER_VALIDATOR` at the deterministic fleet
// deployments so the run does not mint a second hook at a different address.
//
// Account A  Rhinestone MSA (`uMSA.advanced/withHook.v0.1`): proxy + Bootstrap
//            install, validator selected from the ERC-4337 nonce.
// Account B  KeelMinimalAccount (`keel.minimal.v0.1`): constructor install,
//            directly stored validator, its own execution decoder.
// Account C  ZeroDev Kernel v3.3 (`kernel.v0.3.3`): third-party, loaded from a
//            prebuilt fixture and driven through its `executeUserOp` flow.
// Account D  Rhinestone Safe7579 v2.0.0 (`rhinestone.safe7579.v1.0.0`): a plain
//            Safe with the Safe7579 adapter installed via `addSafe7579`.
//
// The hook sees only `msg.sender` (the account) and the account's received
// `execute(bytes32,bytes)` calldata — identical enforcement across four
// unrelated account implementations, with independent per-account accrual under
// a shared session id, is the account-agnosticism proof.
//
// All assertions read on-chain state; the result is written to
// `deployments/acceptance-<chainId>.json`.
//
// NOTE ON ENTRYPOINT: `MSAAdvanced` hard-codes the canonical v0.7 EntryPoint
// address (0x...da032). To run against ANY chain (including a fresh local anvil
// that does not have it), the script deploys a real `EntryPoint` and installs
// its runtime code at the canonical address via `anvil_setCode` (real code, real
// immutable SenderCreator; only anvil exposes this method).
// ============================================================================
contract Acceptance is Script {
    // Canonical ERC-4337 v0.7 EntryPoint address (hard-coded by MSAAdvanced).
    address internal constant ENTRYPOINT_ADDR = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;

    // Well-known, pre-funded anvil account #0.
    uint256 internal constant ANVIL_PK0 = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    bytes32 internal constant UOE_TOPIC =
        keccak256("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)");
    bytes32 internal constant UORR_TOPIC =
        keccak256("UserOperationRevertReason(bytes32,address,uint256,bytes)");

    // ---- scenario parameters -------------------------------------------------
    //
    // Defaults are the local-fork values (0.4 ok / 0.7 over a 1 ether cap) and
    // reproduce `deployments/acceptance-31337.json` byte for byte. On a public
    // chain they MUST be overridden: `handleOps` requires the account to cover
    // `(verificationGasLimit + callGasLimit + preVerificationGas) * maxFeePerGas`
    // up front, so the 20 gwei default asks each account to hold ~0.044 ether of
    // headroom, and `funding` — deliberately 3 ether on a fork, where the deployer
    // is an anvil account — is real money on mainnet.
    //
    //   ACCEPTANCE_FUNDING                     ether sent to each account
    //   ACCEPTANCE_VALUE_OP1 / _VALUE_OP2 / _DAILY_CAP
    //   ACCEPTANCE_MAX_FEE_PER_GAS / _MAX_PRIORITY_FEE_PER_GAS
    //   ACCEPTANCE_VERIFICATION_GAS_LIMIT / _CALL_GAS_LIMIT / _PRE_VERIFICATION_GAS
    //   ACCEPTANCE_RECIPIENT                   defaults to the 0x…bEEF burner
    //
    // The three gas limits are the other half of the funding budget: the
    // EntryPoint makes each account pre-fund `(verification + call +
    // preVerification) * maxFeePerGas` *per UserOp*, and both UserOps run on the
    // same account, so the balance left after UserOp #1 must still cover the
    // prefund of #2. Shrinking the limits (and maxFeePerGas) is what lets a run
    // fit inside a low-balance deployer.
    uint256 internal valueOp1;
    uint256 internal valueOp2;
    uint256 internal dailyCap;
    uint256 internal funding;
    uint256 internal maxFeePerGas;
    uint256 internal maxPriorityFeePerGas;
    uint256 internal verificationGasLimit;
    uint256 internal callGasLimit;
    uint256 internal preVerificationGas;

    /// Session id reused across ALL accounts on purpose: the hook keys accrual by
    /// `(account, sessionId)`, so the same id must yield independent state.
    bytes32 internal constant SESSION_ID = keccak256("keel.acceptance.session.v1");

    /// @dev Safe7579 runs the hook through `Safe.execTransactionFromModuleReturnData`,
    ///      which returns `(success=false, retData)`; the adapter discards the inner
    ///      reason and reverts with its own `ExecutionFailed()`. On-chain the policy
    ///      revert therefore surfaces wrapped, unlike MSA/Keel/Kernel where
    ///      `DailyLimitExceeded` bubbles up unchanged.
    bytes4 internal constant SAFE7579_EXECUTION_FAILED = bytes4(keccak256("ExecutionFailed()"));

    // EntryPoint requires the outer `handleOps` tx to carry enough gas to fund
    // the operation's declared `verificationGasLimit + callGasLimit +
    // preVerificationGas` (else it aborts the bundle with `AA95`). Forge's
    // estimator only returns the *actual* usage, which is far lower, so we pin
    // an explicit gas limit on the call.
    uint256 internal constant HANDLE_OPS_GAS = 3_000_000;

    struct Stack {
        IEntryPoint entryPoint;
        OwnerECDSAValidator validator;
        MSAAdvanced implementation;
        MSAFactory factory;
        Bootstrap bootstrap;
        KeelPolicyHook hook;
    }

    /// @dev Kernel stack deployed from `fixtures/kernel/*.json`.
    struct KernelStack {
        address implementation;
        address factory;
        address validator;
    }

    /// @dev Safe7579 stack deployed from `fixtures/safe7579/*.json`.
    struct Safe7579Stack {
        address singleton;
        address proxyFactory;
        address safe7579;
        address launchpad;
    }

    /// Per-account outcome of the two-UserOp scenario.
    struct Scenario {
        bytes32 userOpHash1;
        bytes32 userOpHash2;
        bool step1Pass;
        bool step2Pass;
    }

    struct Record {
        uint256 chainId;
        address deployer;
        address recipient;
        bytes32 commitment;
        address msaAccount;
        string msaAccountId;
        Scenario msa;
        address keelAccount;
        string keelAccountId;
        Scenario keel;
        address kernelAccount;
        string kernelAccountId;
        Scenario kernel;
        address safeAccount;
        string safeAccountId;
        Scenario safe;
        bool passed;
    }

    function run() external {
        uint256 pk = vm.envOr("PRIVATE_KEY", ANVIL_PK0);
        address recipient =
            vm.envOr("ACCEPTANCE_RECIPIENT", address(0x000000000000000000000000000000000000bEEF));

        valueOp1 = vm.envOr("ACCEPTANCE_VALUE_OP1", uint256(0.4 ether));
        valueOp2 = vm.envOr("ACCEPTANCE_VALUE_OP2", uint256(0.7 ether));
        dailyCap = vm.envOr("ACCEPTANCE_DAILY_CAP", uint256(1 ether));
        funding = vm.envOr("ACCEPTANCE_FUNDING", uint256(3 ether));
        maxFeePerGas = vm.envOr("ACCEPTANCE_MAX_FEE_PER_GAS", uint256(20 gwei));
        maxPriorityFeePerGas = vm.envOr("ACCEPTANCE_MAX_PRIORITY_FEE_PER_GAS", uint256(1 gwei));
        verificationGasLimit = vm.envOr("ACCEPTANCE_VERIFICATION_GAS_LIMIT", uint256(1_000_000));
        callGasLimit = vm.envOr("ACCEPTANCE_CALL_GAS_LIMIT", uint256(1_000_000));
        preVerificationGas = vm.envOr("ACCEPTANCE_PRE_VERIFICATION_GAS", uint256(200_000));
        // The scenario only means anything if step 1 fits under the cap and step
        // 2 does not — a scaled-down mainnet run must keep that relationship.
        require(valueOp1 <= dailyCap && valueOp1 + valueOp2 > dailyCap, "scenario values inconsistent");
        // Each account funds both UserOps, so [#1's value + #2's prefund] is the
        // real floor — and on a public chain `funding` is the deployer's money.
        require(
            funding >= valueOp1 + (verificationGasLimit + callGasLimit + preVerificationGas) * maxFeePerGas,
            "funding does not cover the second UserOp prefund"
        );

        Stack memory s = _deployStack(pk);
        KernelStack memory k = _deployKernelStack(s, pk);
        Safe7579Stack memory z = _deploySafe7579Stack(s, pk);
        (bytes memory policyData, bytes32 commitment) = _buildPolicy(recipient);

        // MSA and KeelMinimalAccount select their validator from the nonce key.
        uint192 validatorKey = uint192(bytes24(bytes20(address(s.validator))));

        Record memory r;
        r.chainId = block.chainid;
        r.deployer = vm.addr(pk);
        r.recipient = recipient;
        r.commitment = commitment;

        // ---- Account A: Rhinestone MSA (proxy + Bootstrap install) -------------
        r.msaAccount = _createMsaAccount(s, pk, r.deployer, policyData);
        r.msaAccountId = IAccountIdView(r.msaAccount).accountId();
        r.msa = _runScenario(
            s, pk, r.deployer, r.msaAccount, recipient, commitment, validatorKey, false, bytes4(0)
        );

        // ---- Account B: KeelMinimalAccount (constructor install) --------------
        r.keelAccount = _deployKeelAccount(s, pk, policyData);
        r.keelAccountId = IAccountIdView(r.keelAccount).accountId();
        r.keel = _runScenario(
            s, pk, r.deployer, r.keelAccount, recipient, commitment, validatorKey, false, bytes4(0)
        );

        // ---- Account C: ZeroDev Kernel (third-party fixture) ------------------
        r.kernelAccount = _createKernelAccount(s, k, pk, r.deployer, policyData);
        r.kernelAccountId = IAccountIdView(r.kernelAccount).accountId();
        // Kernel decodes the nonce as [mode|type|...]; key 0 == ROOT + default.
        r.kernel = _runScenario(s, pk, r.deployer, r.kernelAccount, recipient, commitment, 0, true, bytes4(0));

        // ---- Account D: Rhinestone Safe7579 (existing Safe + adapter) ---------
        r.safeAccount = _createSafe7579Account(s, z, pk, r.deployer, policyData);
        r.safeAccountId = IAccountIdView(r.safeAccount).accountId();
        r.safe = _runScenario(
            s,
            pk,
            r.deployer,
            r.safeAccount,
            recipient,
            commitment,
            validatorKey,
            false,
            SAFE7579_EXECUTION_FAILED
        );

        r.passed = r.msa.step1Pass && r.msa.step2Pass && r.keel.step1Pass && r.keel.step2Pass
            && r.kernel.step1Pass && r.kernel.step2Pass && r.safe.step1Pass && r.safe.step2Pass;
        _writeRecord(s, k, z, r);
        _print(s, k, z, r);
        require(r.passed, "acceptance FAILED");
    }

    // ===================== setup =====================

    function _deployStack(uint256 pk) internal returns (Stack memory s) {
        bool needEntryPoint = ENTRYPOINT_ADDR.code.length == 0;

        // Point these at the deterministic fleet deployments (see
        // `DeployDeterministic.s.sol`) to avoid minting a second hook at a
        // different address on a chain that already has one.
        s.hook = KeelPolicyHook(vm.envOr("KEEL_POLICY_HOOK", address(0)));
        s.validator = OwnerECDSAValidator(vm.envOr("KEEL_OWNER_VALIDATOR", address(0)));
        bool needHook = address(s.hook) == address(0);
        bool needValidator = address(s.validator) == address(0);

        vm.startBroadcast(pk);
        EntryPoint deployedEntryPoint;
        if (needEntryPoint) deployedEntryPoint = new EntryPoint();
        if (needValidator) s.validator = new OwnerECDSAValidator();
        s.implementation = new MSAAdvanced();
        s.factory = new MSAFactory(address(s.implementation));
        s.bootstrap = new Bootstrap();
        if (needHook) s.hook = new KeelPolicyHook();
        vm.stopBroadcast();

        require(address(s.hook).code.length != 0, "hook unavailable");
        require(address(s.validator).code.length != 0, "validator unavailable");

        if (needEntryPoint) {
            bytes memory epCode = address(deployedEntryPoint).code;
            // The fork cache already observed an empty account at the canonical
            // address, so a raw `anvil_setCode` alone is not picked up by this
            // in-process simulation; `vm.etch` updates the simulated state.
            vm.etch(ENTRYPOINT_ADDR, epCode);
            // Persist it on the node as well, so broadcasted UserOps hit a real
            // EntryPoint (real code, real immutable SenderCreator).
            string memory params =
                string.concat('["', vm.toString(ENTRYPOINT_ADDR), '","', vm.toString(epCode), '"]');
            vm.rpc("anvil_setCode", params);
        }
        require(ENTRYPOINT_ADDR.code.length != 0, "EntryPoint unavailable at canonical address");
        s.entryPoint = IEntryPoint(ENTRYPOINT_ADDR);
    }

    /// @dev Deploys Kernel v3.3 from the committed artifacts in `fixtures/kernel/`.
    function _deployKernelStack(Stack memory s, uint256 pk) internal returns (KernelStack memory k) {
        vm.startBroadcast(pk);
        k.implementation = vm.deployCode("fixtures/kernel/Kernel.json", abi.encode(address(s.entryPoint)));
        k.factory = vm.deployCode("fixtures/kernel/KernelFactory.json", abi.encode(k.implementation));
        k.validator = vm.deployCode("fixtures/kernel/ECDSAValidator.json");
        vm.stopBroadcast();

        require(k.implementation.code.length != 0, "kernel implementation deploy failed");
        require(k.factory.code.length != 0, "kernel factory deploy failed");
        require(k.validator.code.length != 0, "kernel validator deploy failed");
    }

    /// @dev Deploys the Safe7579 stack from the committed artifacts in
    ///      `fixtures/safe7579/`. The launchpad is constructed with the canonical
    ///      EntryPoint and a zero registry (registry checks are compiled out).
    function _deploySafe7579Stack(Stack memory s, uint256 pk) internal returns (Safe7579Stack memory z) {
        vm.startBroadcast(pk);
        z.singleton = vm.deployCode("fixtures/safe7579/Safe.json");
        z.proxyFactory = vm.deployCode("fixtures/safe7579/SafeProxyFactory.json");
        z.safe7579 = vm.deployCode("fixtures/safe7579/Safe7579.json");
        z.launchpad = vm.deployCode(
            "fixtures/safe7579/Safe7579Launchpad.json", abi.encode(address(s.entryPoint), address(0))
        );
        vm.stopBroadcast();

        require(z.singleton.code.length != 0, "safe singleton deploy failed");
        require(z.proxyFactory.code.length != 0, "safe proxy factory deploy failed");
        require(z.safe7579.code.length != 0, "safe7579 handler deploy failed");
        require(z.launchpad.code.length != 0, "safe7579 launchpad deploy failed");
    }

    /// @dev The single policy all accounts install — `abi.encode(version,
    ///      validAfter, validUntil, rules)`, i.e. `encodePolicy` off-chain.
    function _buildPolicy(address recipient)
        internal
        view
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

    function _createMsaAccount(Stack memory s, uint256 pk, address deployer, bytes memory policyData)
        internal
        returns (address account)
    {
        BootstrapConfig[] memory validators = new BootstrapConfig[](1);
        validators[0] = BootstrapConfig({module: address(s.validator), data: abi.encode(deployer)});
        BootstrapConfig[] memory executors = new BootstrapConfig[](0);
        BootstrapConfig memory hookCfg =
            BootstrapConfig({module: address(s.hook), data: abi.encode(SESSION_ID, policyData)});
        BootstrapConfig[] memory fallbacks = new BootstrapConfig[](0);
        bytes memory initData = s.bootstrap._getInitMSACalldata(validators, executors, hookCfg, fallbacks);

        bytes32 salt = keccak256("keel.acceptance.account.v1");
        account = s.factory.getAddress(salt, initData);
        require(account.code.length == 0, "account already deployed; use a fresh chain");

        vm.startBroadcast(pk);
        s.factory.createAccount(salt, initData);
        _fund(account);
        vm.stopBroadcast();
        require(account.code.length != 0, "account deployment failed");
    }

    /// @dev Deploys KeelMinimalAccount; the constructor installs the validator
    ///      and the hook itself (a different install path from MSA's Bootstrap).
    function _deployKeelAccount(Stack memory s, uint256 pk, bytes memory policyData)
        internal
        returns (address account)
    {
        vm.startBroadcast(pk);
        KeelMinimalAccount a = new KeelMinimalAccount(
            address(s.entryPoint),
            address(s.validator),
            address(s.hook),
            abi.encode(vm.addr(pk)),
            abi.encode(SESSION_ID, policyData)
        );
        account = address(a);
        _fund(account);
        vm.stopBroadcast();
        require(account.code.length != 0, "account deployment failed");
    }

    /// @dev Creates a Kernel v3.3 account with the same policy as the other two.
    function _createKernelAccount(
        Stack memory s,
        KernelStack memory k,
        uint256 pk,
        address deployer,
        bytes memory policyData
    ) internal returns (address account) {
        address kernelValidator = k.validator;
        // Kernel's root ValidationId = 1 byte type (0x01 = validator) ++ address.
        bytes21 rootValidation;
        assembly ("memory-safe") {
            rootValidation := or(
                0x0100000000000000000000000000000000000000000000000000000000000000,
                shl(88, kernelValidator)
            )
        }

        bytes memory validatorData = abi.encodePacked(deployer);
        // Kernel strips one leading flag byte before forwarding to `hook.onInstall`.
        bytes memory hookData = abi.encodePacked(bytes1(0x00), abi.encode(SESSION_ID, policyData));
        bytes[] memory initConfig = new bytes[](0);

        bytes memory initData = abi.encodeWithSelector(
            IKernelInit.initialize.selector,
            rootValidation,
            address(s.hook),
            validatorData,
            hookData,
            initConfig
        );

        bytes32 salt = keccak256("keel.acceptance.kernel.v1");
        account = IKernelFactoryView(k.factory).getAddress(initData, salt);
        require(account.code.length == 0, "kernel account already deployed; use a fresh chain");

        vm.startBroadcast(pk);
        IKernelFactoryView(k.factory).createAccount(initData, salt);
        _fund(account);
        vm.stopBroadcast();
        require(account.code.length != 0, "kernel account deployment failed");
    }

    /// @dev Creates an ordinary Safe, then installs the Safe7579 adapter and the
    ///      same validator + hook by delegatecalling the launchpad from a
    ///      owner-signed Safe transaction (the upstream "existing Safe" path).
    function _createSafe7579Account(
        Stack memory s,
        Safe7579Stack memory z,
        uint256 pk,
        address deployer,
        bytes memory policyData
    ) internal returns (address account) {
        address[] memory owners = new address[](1);
        owners[0] = deployer;
        bytes memory initializer = abi.encodeCall(
            ISafeSetup.setup, (owners, 1, address(0), "", address(0), address(0), 0, payable(address(0)))
        );

        bytes32 salt = keccak256("keel.acceptance.safe7579.v1");
        vm.startBroadcast(pk);
        account =
            ISafeProxyFactory(z.proxyFactory).createProxyWithNonce(z.singleton, initializer, uint256(salt));
        _fund(account);
        vm.stopBroadcast();
        require(account.code.length != 0, "safe account deployment failed");

        ModuleInit[] memory modules = new ModuleInit[](2);
        modules[0] = ModuleInit({module: address(s.validator), initData: abi.encode(deployer), moduleType: 1});
        modules[1] = ModuleInit({
            module: address(s.hook), initData: abi.encode(SESSION_ID, policyData), moduleType: 4
        });
        bytes memory data =
            abi.encodeCall(ISafe7579Launchpad.addSafe7579, (z.safe7579, modules, new address[](0), 0));

        // Delegatecall the launchpad through a 1-of-1 owner-signed Safe tx so the
        // adapter runs in the Safe's context and installs itself as its fallback
        // handler + module. `safeTxGas = 0` makes Safe spend its remaining gas on
        // the call (a fixed safeTxGas would trip `GS010` on the gas-estimated
        // broadcast tx); baseGas/gasPrice 0 means no refund accounting.
        uint256 safeTxGas = 0;
        uint256 baseGas = 0;
        uint256 gasPrice = 0;
        bytes memory txData = ISafeExec(account)
            .encodeTransactionData(
                z.launchpad,
                0,
                data,
                1, // Enum.Operation.DelegateCall
                safeTxGas,
                baseGas,
                gasPrice,
                address(0),
                payable(address(0)),
                0
            );
        (uint8 v, bytes32 r, bytes32 sig) = vm.sign(pk, keccak256(txData));

        vm.startBroadcast(pk);
        bool ok = ISafeExec(account)
            .execTransaction(
                z.launchpad,
                0,
                data,
                1,
                safeTxGas,
                baseGas,
                gasPrice,
                address(0),
                payable(address(0)),
                abi.encodePacked(r, sig, v)
            );
        vm.stopBroadcast();
        require(ok, "safe7579 addSafe7579 failed");
        require(
            s.hook.policyCommitmentOf(account, SESSION_ID) == keccak256(policyData),
            "safe7579 policy not installed"
        );
    }

    function _fund(address account) internal {
        (bool funded,) = payable(account).call{value: funding}("");
        require(funded, "account funding failed");
    }

    // ===================== scenario =====================

    /// @dev Runs the two-UserOp scenario for one account and asserts on-chain
    ///      state. Shared verbatim by all four accounts; `wrappedRevert` is the
    ///      account-specific selector under which the policy revert surfaces when
    ///      the account wraps the hook call (Safe7579), or `bytes4(0)` otherwise.
    function _runScenario(
        Stack memory s,
        uint256 pk,
        address deployer,
        address account,
        address recipient,
        bytes32 commitment,
        uint192 nonceKey,
        bool wrapExecuteUserOp,
        bytes4 wrappedRevert
    ) internal returns (Scenario memory r) {
        uint256 recipientBefore = recipient.balance;

        // ---- UserOp #1: 0.4 ether, must SUCCEED --------------------------------
        {
            (PackedUserOperation memory op, bytes32 uh) = _makeValueOp(
                s,
                account,
                recipient,
                valueOp1,
                s.entryPoint.getNonce(account, nonceKey),
                pk,
                wrapExecuteUserOp
            );
            r.userOpHash1 = uh;
            (bool found, bool ok, bytes memory reason) = _submit(s, pk, deployer, op, uh);
            (uint256 calls, uint256 spent) = _usage(s, account);
            bytes32[] memory ids = s.hook.sessionIdsOf(account);
            r.step1Pass = found && ok && reason.length == 0 && calls == 1 && spent == valueOp1
                && s.hook.policyCommitmentOf(account, SESSION_ID) == commitment && ids.length == 1
                && ids[0] == SESSION_ID && recipient.balance == recipientBefore + valueOp1;
        }

        // ---- UserOp #2: 0.7 ether, must FAIL on-chain (daily cap) --------------
        {
            (PackedUserOperation memory op, bytes32 uh) = _makeValueOp(
                s,
                account,
                recipient,
                valueOp2,
                s.entryPoint.getNonce(account, nonceKey),
                pk,
                wrapExecuteUserOp
            );
            r.userOpHash2 = uh;
            (bool found, bool ok, bytes memory reason) = _submit(s, pk, deployer, op, uh);
            (uint256 calls, uint256 spent) = _usage(s, account);
            bytes4 selector = _selectorOf(reason);
            bool dailyLimitRevert = selector == KeelPolicyHook.DailyLimitExceeded.selector
                || (wrappedRevert != bytes4(0) && selector == wrappedRevert);
            r.step2Pass = found && !ok && dailyLimitRevert && calls == 1 && spent == valueOp1
                && recipient.balance == recipientBefore + valueOp1;
        }
    }

    // ===================== userOp plumbing =====================

    function _makeValueOp(
        Stack memory s,
        address account,
        address recipient,
        uint256 value,
        uint256 nonce,
        uint256 pk,
        bool wrapExecuteUserOp
    ) internal view returns (PackedUserOperation memory op, bytes32 userOpHash) {
        bytes memory executeCall = abi.encodeCall(
            IERC7579Account.execute,
            (ModeLib.encodeSimpleSingle(), ExecutionLib.encodeSingle(recipient, value, ""))
        );
        // Kernel only runs its hook via `executeUserOp`, which forwards
        // `callData[4:]` (the standard `execute(...)` call) to `preCheck`.
        bytes memory callData = wrapExecuteUserOp
            ? abi.encodePacked(IAccountExecuteView.executeUserOp.selector, executeCall)
            : executeCall;
        op = PackedUserOperation({
            sender: account,
            nonce: nonce,
            initCode: "",
            callData: callData,
            accountGasLimits: bytes32(abi.encodePacked(uint128(verificationGasLimit), uint128(callGasLimit))),
            preVerificationGas: preVerificationGas,
            gasFees: bytes32(abi.encodePacked(uint128(maxPriorityFeePerGas), uint128(maxFeePerGas))),
            paymasterAndData: "",
            signature: ""
        });
        userOpHash = s.entryPoint.getUserOpHash(op);
        (uint8 v, bytes32 r, bytes32 sig) = vm.sign(pk, userOpHash);
        op.signature = abi.encodePacked(r, sig, v);
    }

    function _submit(
        Stack memory s,
        uint256 pk,
        address deployer,
        PackedUserOperation memory op,
        bytes32 userOpHash
    ) internal returns (bool found, bool success, bytes memory reason) {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;

        vm.startBroadcast(pk);
        vm.recordLogs();
        s.entryPoint.handleOps{gas: HANDLE_OPS_GAS}(ops, payable(deployer));
        vm.stopBroadcast();

        return _outcome(vm.getRecordedLogs(), userOpHash);
    }

    /// @dev Finds the outcome of `userOpHash` in the recorded logs.
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

    /// @dev `usageOf` returns `(uint64 day, uint256 calls, uint256 dailySpent)`.
    function _usage(Stack memory s, address account) internal view returns (uint256 calls, uint256 spent) {
        (, calls, spent) = s.hook.usageOf(account, SESSION_ID, 0);
    }

    /// @dev First four bytes of `data` as a selector, or `bytes4(0)` when shorter.
    function _selectorOf(bytes memory data) internal pure returns (bytes4 selector) {
        if (data.length < 4) return bytes4(0);
        assembly ("memory-safe") {
            selector := mload(add(data, 0x20))
        }
    }

    // ===================== reporting =====================

    function _writeRecord(Stack memory s, KernelStack memory k, Safe7579Stack memory z, Record memory r)
        internal
    {
        // Build the JSON by hand: `vm.serialize*`/`vm.writeJson` blow past the
        // via-ir stack depth in this project, so we assemble the document and
        // write it with `vm.writeFile`.
        string memory j = "{";
        j = string.concat(j, _fd("chainId", vm.toString(r.chainId)));
        j = string.concat(j, _fd("deployer", vm.toString(r.deployer)));
        j = string.concat(j, _fd("entryPoint", vm.toString(address(s.entryPoint))));
        j = string.concat(j, _fd("keelPolicyHook", vm.toString(address(s.hook))));
        j = string.concat(j, _fd("validator", vm.toString(address(s.validator))));
        j = string.concat(j, _fd("msaImplementation", vm.toString(address(s.implementation))));
        j = string.concat(j, _fd("msaFactory", vm.toString(address(s.factory))));
        j = string.concat(j, _fd("bootstrap", vm.toString(address(s.bootstrap))));
        j = string.concat(j, _fd("recipient", vm.toString(r.recipient)));
        // Recorded because a mainnet run scales these down; without them the
        // evidence does not say which scenario actually ran.
        j = string.concat(j, _fd("valueOp1", vm.toString(valueOp1)));
        j = string.concat(j, _fd("valueOp2", vm.toString(valueOp2)));
        j = string.concat(j, _fd("dailyCap", vm.toString(dailyCap)));
        j = string.concat(j, _fd("funding", vm.toString(funding)));
        j = string.concat(j, _fd("maxFeePerGas", vm.toString(maxFeePerGas)));
        j = string.concat(j, _fd("verificationGasLimit", vm.toString(verificationGasLimit)));
        j = string.concat(j, _fd("callGasLimit", vm.toString(callGasLimit)));
        j = string.concat(j, _fd("preVerificationGas", vm.toString(preVerificationGas)));
        j = string.concat(j, _fd("sessionId", vm.toString(SESSION_ID)));
        j = string.concat(j, _fd("policyCommitment", vm.toString(r.commitment)));
        j = string.concat(j, _fd("msaAccount", vm.toString(r.msaAccount)));
        j = string.concat(j, _fd("msaAccountId", r.msaAccountId));
        j = string.concat(j, _fd("msaUserOpHash1", vm.toString(r.msa.userOpHash1)));
        j = string.concat(j, _fd("msaUserOpHash2", vm.toString(r.msa.userOpHash2)));
        j = string.concat(j, _fd("msaStep1Pass", _boolStr(r.msa.step1Pass)));
        j = string.concat(j, _fd("msaStep2Pass", _boolStr(r.msa.step2Pass)));
        j = string.concat(j, _fd("keelAccount", vm.toString(r.keelAccount)));
        j = string.concat(j, _fd("keelAccountId", r.keelAccountId));
        j = string.concat(j, _fd("keelUserOpHash1", vm.toString(r.keel.userOpHash1)));
        j = string.concat(j, _fd("keelUserOpHash2", vm.toString(r.keel.userOpHash2)));
        j = string.concat(j, _fd("keelStep1Pass", _boolStr(r.keel.step1Pass)));
        j = string.concat(j, _fd("keelStep2Pass", _boolStr(r.keel.step2Pass)));
        j = string.concat(j, _fd("kernelImplementation", vm.toString(k.implementation)));
        j = string.concat(j, _fd("kernelFactory", vm.toString(k.factory)));
        j = string.concat(j, _fd("kernelValidator", vm.toString(k.validator)));
        j = string.concat(j, _fd("kernelAccount", vm.toString(r.kernelAccount)));
        j = string.concat(j, _fd("kernelAccountId", r.kernelAccountId));
        j = string.concat(j, _fd("kernelUserOpHash1", vm.toString(r.kernel.userOpHash1)));
        j = string.concat(j, _fd("kernelUserOpHash2", vm.toString(r.kernel.userOpHash2)));
        j = string.concat(j, _fd("kernelStep1Pass", _boolStr(r.kernel.step1Pass)));
        j = string.concat(j, _fd("kernelStep2Pass", _boolStr(r.kernel.step2Pass)));
        j = string.concat(j, _fd("safe7579Singleton", vm.toString(z.singleton)));
        j = string.concat(j, _fd("safe7579ProxyFactory", vm.toString(z.proxyFactory)));
        j = string.concat(j, _fd("safe7579Handler", vm.toString(z.safe7579)));
        j = string.concat(j, _fd("safe7579Launchpad", vm.toString(z.launchpad)));
        j = string.concat(j, _fd("safeAccount", vm.toString(r.safeAccount)));
        j = string.concat(j, _fd("safeAccountId", r.safeAccountId));
        j = string.concat(j, _fd("safeUserOpHash1", vm.toString(r.safe.userOpHash1)));
        j = string.concat(j, _fd("safeUserOpHash2", vm.toString(r.safe.userOpHash2)));
        j = string.concat(j, _fd("safeStep1Pass", _boolStr(r.safe.step1Pass)));
        j = string.concat(j, _fd("safeStep2Pass", _boolStr(r.safe.step2Pass)));
        j = string.concat(j, _fdLast("passed", _boolStr(r.passed)));
        j = string.concat(j, "}");
        vm.writeFile(string.concat("deployments/acceptance-", vm.toString(r.chainId), ".json"), j);
    }

    /// @dev JSON field `"key":"value",` (trailing comma).
    function _fd(string memory k, string memory v) internal pure returns (string memory) {
        return string.concat('"', k, '":"', v, '",');
    }

    /// @dev JSON field `"key":"value"` (no trailing comma).
    function _fdLast(string memory k, string memory v) internal pure returns (string memory) {
        return string.concat('"', k, '":"', v, '"');
    }

    function _boolStr(bool b) internal pure returns (string memory) {
        return b ? "true" : "false";
    }

    function _print(Stack memory s, KernelStack memory k, Safe7579Stack memory z, Record memory r)
        internal
        view
    {
        console2.log("=== KeelPolicyHook on-chain acceptance (four accounts) ===");
        console2.log("chainId          :", r.chainId);
        console2.log("deployer         :", r.deployer);
        console2.log("entryPoint       :", address(s.entryPoint));
        console2.log("keelPolicyHook   :", address(s.hook));
        console2.log("validator        :", address(s.validator));
        console2.log("recipient        :", r.recipient);
        console2.log("valueOp1         :", valueOp1);
        console2.log("valueOp2         :", valueOp2);
        console2.log("dailyCap         :", dailyCap);
        console2.log("funding          :", funding);
        console2.log("maxFeePerGas     :", maxFeePerGas);
        console2.log("gasLimits        :", verificationGasLimit, callGasLimit, preVerificationGas);
        console2.log("msaAccount       :", r.msaAccount);
        console2.log("  step1 under cap:", r.msa.step1Pass);
        console2.log("  step2 over cap :", r.msa.step2Pass);
        console2.log("keelAccount      :", r.keelAccount);
        console2.log("  step1 under cap:", r.keel.step1Pass);
        console2.log("  step2 over cap :", r.keel.step2Pass);
        console2.log("kernelImpl       :", k.implementation);
        console2.log("kernelAccount    :", r.kernelAccount);
        console2.log("  step1 under cap:", r.kernel.step1Pass);
        console2.log("  step2 over cap :", r.kernel.step2Pass);
        console2.log("safe7579Handler  :", z.safe7579);
        console2.log("safeAccount      :", r.safeAccount);
        console2.log("  step1 under cap:", r.safe.step1Pass);
        console2.log("  step2 over cap :", r.safe.step2Pass);
        console2.log(r.passed ? "RESULT: PASS" : "RESULT: FAIL");
    }
}
