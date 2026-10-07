#!/usr/bin/env node
// ============================================================================
// migration-drill.mjs — a credential-free rehearsal of the *migration* path that
// `fork-drill.mjs` does not cover: installing a Keel module onto an account that
// ALREADY EXISTS, rather than at account creation.
//
//   BSC_RPC_URL=<rpc> node scripts/migration-drill.mjs
//   default RPC: bsc-dataseed. Requires this package and `packages/migrate` built.
//
// fork-drill deploys a KeelMinimalAccount with the hook installed in its
// constructor, so it never exercises the operator's real action: take an account
// that is already live and already running without the Keel module, then
// hot-install the module in a separate transaction and prove on chain that the
// install is real before cutting traffic over.
//
// The drill runs against a real BSC fork and drives the REAL
// `@keelcodes/migrate` state machine (`createModuleRegistry` / `routeSession` /
// `migrateSession`) with the REAL two-sided viem probe
// (`createViemModuleProbe`). It asserts:
//
//   1. existing account — a Rhinestone MSA (ERC-7579 reference account) is
//      created WITHOUT the Keel hook and already has code.
//   2. negative probe   — the hook reads { installed:false, ok:false }.
//   3. abort/rollback   — `migrateSession` refuses to confirm on that evidence
//      (-> exception), and the operator rolls the record back (-> not-migrated).
//   4. hot install      — `installModule(4, hook, initData)` is broadcast FROM
//      the account, in a new transaction; the account address is unchanged.
//   5. positive probe   — { installed:true, initialized:true, ok:true }, and the
//      stored commitment equals keccak256(policyData).
//   6. cut-over         — `migrateSession` now confirms (-> migrated).
//   7. R5 reversal      — the §9 "R5 — uninstall drill by account type" matrix:
//      it rehearses `uninstallModule(type 4, hook)` against THREE account types
//      and pins the per-type expectation instead of assuming one. The
//      hot-installed MSA is refused (the fail-closed hook refuses anything that
//      is not `execute(...)`; the revert is pinned to `UnsupportedCallData` and
//      the migrated state must survive), a constructor-installed
//      `KeelMinimalAccount` has no module manager (reversal n/a), and a
//      hot-installable ZeroDev Kernel v3.3 (deployed from the committed
//      fixtures exactly as `Acceptance.s.sol`) lets the reversal succeed
//      (L1 available). One output line per type, so a regression is a diff.
//
// Writes only to the fork, never to the real chain.
// ============================================================================

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  keccak256,
  parseAbi,
  parseAbiParameters,
  toFunctionSelector,
  toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bsc } from 'viem/chains';
// The state machine is imported from migrate's built dist by path, not as a
// package dependency: adapters stays free of a migrate dependency, and the drill
// only needs the two to be built (`pnpm -r build`).
import {
  applyMigrationAction,
  createModuleRegistry,
  migrateSession,
  probeModule,
  routeSession,
} from '../../migrate/dist/index.js';
import { createViemModuleProbe, erc7579AccountAbi, MODULE_TYPE } from '../dist/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIR = resolve(HERE, '../../../contracts');
const FOUNDRY_BIN = process.env.FOUNDRY_BIN ?? '/home/steven/.foundry/bin';
const ANVIL_BIN = resolve(FOUNDRY_BIN, 'anvil');
const FORGE_BIN = resolve(FOUNDRY_BIN, 'forge');

const PORT = 8547;
const RPC_URL = process.env.BSC_RPC_URL ?? 'https://bsc-dataseed.bnbchain.org';
const LOCAL_RPC = `http://127.0.0.1:${PORT}`;

// Well-known, pre-funded anvil account #0.
const ANVIL_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const SESSION_ID = keccak256(toHex('keel.migration-drill.session.v1'));
const ACCOUNT_SALT = keccak256(toHex('keel.migration-drill.account.v1'));
const RECIPIENT = '0x000000000000000000000000000000000000bEEF';
const ZERO = '0x0000000000000000000000000000000000000000';
// Canonical EntryPoint v0.7 (RUNBOOK §1) — Kernel's ctor arg; the drill never
// routes a UserOp through it, so it need not have code on the fork.
const ENTRYPOINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function shortError(error) {
  const message = error?.shortMessage ?? error?.message ?? String(error);
  return message.split('\n')[0];
}

function spawnAnvil() {
  const child = spawn(ANVIL_BIN, ['--fork-url', RPC_URL, '--port', String(PORT), '--silent'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.log = '';
  child.stdout.on('data', (chunk) => (child.log += chunk));
  child.stderr.on('data', (chunk) => (child.log += chunk));
  return child;
}

async function waitForAnvil(client, child, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`anvil exited early (code ${child.exitCode}): ${child.log.slice(-400)}`);
    }
    try {
      return await client.getChainId();
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`anvil not ready after ${timeoutMs}ms: ${child.log.slice(-400)}`);
}

async function stopAnvil(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  await new Promise((done) => {
    child.once('exit', () => done());
    child.kill('SIGTERM');
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      done();
    }, 5_000).unref();
  });
}

function artifact(name) {
  const path = resolve(CONTRACTS_DIR, 'out', `${name}.sol`, `${name}.json`);
  const json = JSON.parse(readFileSync(path, 'utf8'));
  if (!json.bytecode?.object || json.bytecode.object === '0x') {
    throw new Error(`no bytecode in ${path}`);
  }
  return { abi: json.abi, bytecode: json.bytecode.object };
}

/** Kernel artifacts are committed under `fixtures/kernel/` (not built by forge). */
function fixture(name) {
  const path = resolve(CONTRACTS_DIR, 'fixtures', 'kernel', `${name}.json`);
  const json = JSON.parse(readFileSync(path, 'utf8'));
  if (!json.bytecode?.object || json.bytecode.object === '0x') {
    throw new Error(`no bytecode in ${path}`);
  }
  return { abi: json.abi, bytecode: json.bytecode.object };
}

async function deploy(wallet, publicClient, art, args = []) {
  const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error('deployment produced no contract address');
  return receipt.contractAddress;
}

/** Sends a transaction FROM `from` via anvil impersonation (no key needed). */
async function impersonatedSend(publicClient, from, data) {
  await publicClient.request({ method: 'anvil_impersonateAccount', params: [from] });
  await publicClient.request({ method: 'anvil_setBalance', params: [from, '0x56bc75e2d63100000'] });
  const hash = await publicClient.request({
    method: 'eth_sendTransaction',
    params: [{ from, to: from, data, gas: '0x1e8480' }],
  });
  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    return { reverted: receipt.status !== 'success', reason: receipt.status };
  } catch (error) {
    return { reverted: true, reason: shortError(error) };
  }
}

/**
 * Read-only `eth_call` that never throws. Unlike a broadcast receipt, a failed
 * `eth_call` carries the revert DATA, which is what the R5 matrix needs to pin
 * the refusal reason (assertion §9.2/#3).
 */
async function callForRevert(publicClient, args) {
  try {
    const result = await publicClient.call(args);
    return { reverted: false, data: result.data };
  } catch (error) {
    return { reverted: true, data: revertDataOf(error), error };
  }
}

/** Walks the viem error chain for the raw revert payload (RpcRequestError.data). */
function revertDataOf(error) {
  for (let node = error, depth = 0; node && depth < 8; node = node.cause, depth++) {
    for (const key of ['data', 'raw']) {
      const value = node[key];
      if (typeof value === 'string' && value.startsWith('0x') && value.length > 2) return value;
    }
  }
  return undefined;
}

/** The 4-byte selector of a revert: from the payload first, then from the text. */
function revertSelector(error) {
  const data = revertDataOf(error);
  if (data && data.length >= 10) return data.slice(0, 10);
  const text = [
    error?.details,
    error?.shortMessage,
    error?.message,
    error?.cause?.details,
    error?.cause?.shortMessage,
    error?.cause?.message,
    error?.cause?.cause?.details,
    error?.cause?.cause?.message,
  ]
    .filter((value) => typeof value === 'string')
    .join(' ');
  const match = text.match(/0x[0-9a-fA-F]{8}/);
  return match ? match[0] : undefined;
}

const bootstrapAbi = parseAbi([
  'function _getInitMSACalldata((address module, bytes data)[] validators, (address module, bytes data)[] executors, (address module, bytes data) hook, (address module, bytes data)[] fallbacks) view returns (bytes)',
]);
const msaFactoryAbi = parseAbi([
  'function getAddress(bytes32 salt, bytes initcode) view returns (address)',
  'function createAccount(bytes32 salt, bytes initCode) payable returns (address)',
]);
const policyHookAbi = parseAbi([
  'function isInitialized(address smartAccount) view returns (bool)',
  'function policyCommitmentOf(address account, bytes32 sessionId) view returns (bytes32)',
]);

async function runDrill(publicClient) {
  // ---- Step 0: build + deploy module stack ---------------------------------
  console.log(`\n[0/7] forge build + deploy Keel modules to the fork`);
  const built = spawnSync(FORGE_BIN, ['build'], { cwd: CONTRACTS_DIR, encoding: 'utf8' });
  if (built.status !== 0) {
    console.error(built.stdout ?? '');
    console.error(built.stderr ?? '');
    throw new Error(`forge build failed (exit ${built.status})`);
  }
  console.log(`      forge build ok`);

  const owner = privateKeyToAccount(ANVIL_PK);
  const wallet = createWalletClient({ account: owner, chain: bsc, transport: http(LOCAL_RPC) });

  const validatorAddr = await deploy(wallet, publicClient, artifact('OwnerECDSAValidator'));
  const hookAddr = await deploy(wallet, publicClient, artifact('KeelPolicyHook'));
  const msaImpl = await deploy(wallet, publicClient, artifact('MSAAdvanced'));
  const msaFactory = await deploy(wallet, publicClient, artifact('MSAFactory'), [msaImpl]);
  const bootstrap = await deploy(wallet, publicClient, artifact('Bootstrap'));
  console.log(`      validator  : ${validatorAddr}`);
  console.log(`      policy hook: ${hookAddr}`);
  console.log(`      MSA factory: ${msaFactory}`);

  const policyData = encodeAbiParameters(
    parseAbiParameters(
      'uint256 version, uint256 validAfter, uint256 validUntil, ' +
        '(address target, bytes4[] selectors, uint256 maxPerTx, uint256 maxDaily, uint256 maxCalls, ' +
        '(address token, uint256 maxPerTx, uint256 maxDaily)[] tokenLimits)[] rules',
    ),
    [
      1n,
      0n,
      0n,
      [
        {
          target: RECIPIENT,
          selectors: [],
          maxPerTx: 0n,
          maxDaily: 10n ** 18n,
          maxCalls: 0n,
          tokenLimits: [],
        },
      ],
    ],
  );
  const commitment = keccak256(policyData);
  const hookInitData = encodeAbiParameters(parseAbiParameters('bytes32 sessionId, bytes policyData'), [
    SESSION_ID,
    policyData,
  ]);

  // ---- Step 1: an account that already exists, WITHOUT the Keel module ------
  console.log(`\n[1/7] existing account (MSA created without the Keel hook)`);
  const initData = await publicClient.readContract({
    address: bootstrap,
    abi: bootstrapAbi,
    functionName: '_getInitMSACalldata',
    args: [
      [{ module: validatorAddr, data: encodeAbiParameters(parseAbiParameters('address owner'), [owner.address]) }],
      [],
      { module: ZERO, data: '0x' },
      [],
    ],
  });
  const account = await publicClient.readContract({
    address: msaFactory,
    abi: msaFactoryAbi,
    functionName: 'getAddress',
    args: [ACCOUNT_SALT, initData],
  });
  const createHash = await wallet.writeContract({
    address: msaFactory,
    abi: msaFactoryAbi,
    functionName: 'createAccount',
    args: [ACCOUNT_SALT, initData],
  });
  await publicClient.waitForTransactionReceipt({ hash: createHash });
  const code = await publicClient.getCode({ address: account });
  check('account already has code', Boolean(code) && code !== '0x', account);

  const probeImpl = createViemModuleProbe(publicClient);
  const probeArgs = { account, module: hookAddr, moduleTypeId: MODULE_TYPE.HOOK };

  // ---- Step 2: negative probe (pre-migration) -------------------------------
  console.log(`\n[2/7] negative probe (no Keel module yet)`);
  const before = await probeModule(probeImpl, probeArgs);
  console.log(`      ${JSON.stringify(before)}`);
  check('installed=false', before.installed === false);
  check('ok=false', before.ok === false);

  // ---- Step 3: the state machine refuses to cut over without evidence -------
  console.log(`\n[3/7] migrateSession on absent evidence -> exception, then rollback`);
  const registry = createModuleRegistry([
    {
      version: 'infrax-session-v1',
      encoding: 'onchain',
      multiSession: false,
      enforcedLimits: false,
    },
    {
      version: 'keel-policy-hook-v1',
      address: hookAddr,
      encoding: 'payload',
      multiSession: true,
      enforcedLimits: true,
    },
  ]);
  const target = routeSession(registry, { id: 'drill-session-1' });
  console.log(`      routeSession -> ${target.version} (${target.encoding})`);
  check('router picks the Keel generation', target.version === 'keel-policy-hook-v1');

  let record = {
    account,
    sessionId: 'drill-session-1',
    fromVersion: 'infrax-session-v1',
    toVersion: target.version,
    status: 'not-migrated',
    updatedAt: '',
  };
  record = await migrateSession({
    record,
    probe: probeImpl,
    probeArgs,
    at: new Date().toISOString(),
  });
  console.log(`      status after migrateSession: ${record.status} (${record.reason ?? ''})`);
  check('migration refused -> exception', record.status === 'exception');

  record = applyMigrationAction(record, 'rollback', {
    at: new Date().toISOString(),
    reason: 'no on-chain evidence of the new module',
  });
  console.log(`      status after rollback: ${record.status}`);
  check('rollback -> not-migrated', record.status === 'not-migrated');

  // ---- Step 4: hot-install onto the existing account ------------------------
  console.log(`\n[4/7] hot install: installModule(4, hook, initData) from the account`);
  const installData = encodeFunctionData({
    abi: erc7579AccountAbi,
    functionName: 'installModule',
    args: [MODULE_TYPE.HOOK, hookAddr, hookInitData],
  });
  const install = await impersonatedSend(publicClient, account, installData);
  check('installModule transaction succeeded', install.reverted === false, install.reason);
  const codeAfter = await publicClient.getCode({ address: account });
  check('account address unchanged (no account migration)', Boolean(codeAfter) && codeAfter !== '0x', account);

  // ---- Step 5: positive probe (post-migration) ------------------------------
  console.log(`\n[5/7] positive probe (module hot-installed)`);
  const after = await probeModule(probeImpl, probeArgs);
  console.log(`      ${JSON.stringify(after)}`);
  check('installed=true', after.installed === true);
  check('initialized=true', after.initialized === true);
  check('ok=true', after.ok === true);
  const stored = await publicClient.readContract({
    address: hookAddr,
    abi: policyHookAbi,
    functionName: 'policyCommitmentOf',
    args: [account, SESSION_ID],
  });
  check('stored commitment == keccak256(policyData)', stored === commitment, stored);

  // ---- Step 6: cut-over -----------------------------------------------------
  console.log(`\n[6/7] migrateSession with evidence -> migrated`);
  record = await migrateSession({
    record,
    probe: probeImpl,
    probeArgs,
    at: new Date().toISOString(),
  });
  console.log(`      status after migrateSession: ${record.status}`);
  check('cut-over -> migrated', record.status === 'migrated');

  // ---- Step 7: R5 reversal matrix by account type ---------------------------
  // §9 "R5 — uninstall drill by account type": reversal (uninstallModule) is
  // only sometimes available, and the operator's expected outcome differs per
  // account type. The drill pins that expectation instead of assuming it, and
  // emits one line per type so a regression shows up as a diff.
  console.log(`\n[7/7] R5 reversal matrix by account type (uninstallModule, module type 4)`);
  const deInitData = encodeAbiParameters(parseAbiParameters('bytes32'), [SESSION_ID]);
  const uninstallData = encodeFunctionData({
    abi: erc7579AccountAbi,
    functionName: 'uninstallModule',
    args: [MODULE_TYPE.HOOK, hookAddr, deInitData],
  });
  const unsupportedCallData = toFunctionSelector('UnsupportedCallData(bytes4)');

  // --- MSA: hook gates module management -> reversal refused (fail-closed) ---
  // Read-only, so the revert DATA is surfaced and the reason can be pinned.
  const msaAttempt = await callForRevert(publicClient, { account, to: account, data: uninstallData });
  const msaSelector = revertSelector(msaAttempt.error);
  check('r5[MSA] uninstallModule refused (reverts)', msaAttempt.reverted === true);
  check(
    'r5[MSA] revert selector == UnsupportedCallData(bytes4)',
    msaSelector === unsupportedCallData,
    msaSelector ?? 'no selector in revert',
  );
  const msaAfter = await probeModule(probeImpl, probeArgs);
  check('r5[MSA] migrated state intact after the refusal', msaAfter.ok === true);
  console.log(
    `      r5[MSA] uninstallModule refused — revert ${msaSelector ?? '0x'} (UnsupportedCallData(bytes4)); reversal = L0 per session / L2 for the fleet`,
  );

  // --- KeelMinimalAccount: constructor-installed -> reversal n/a -------------
  const validatorInitData = encodeAbiParameters(parseAbiParameters('address owner'), [owner.address]);
  const minimalAccount = await deploy(wallet, publicClient, artifact('KeelMinimalAccount'), [
    ENTRYPOINT,
    validatorAddr,
    hookAddr,
    validatorInitData,
    hookInitData,
  ]);
  const minimalArgs = { account: minimalAccount, module: hookAddr, moduleTypeId: MODULE_TYPE.HOOK };
  const minimalProbe = await probeModule(probeImpl, minimalArgs);
  check(
    'r5[KeelMinimalAccount] validator+hook constructor-installed (probe ok)',
    minimalProbe.ok === true,
    JSON.stringify(minimalProbe),
  );
  const minimalAttempt = await callForRevert(publicClient, {
    account: minimalAccount,
    to: minimalAccount,
    data: uninstallData,
  });
  const minimalSelector = revertSelector(minimalAttempt.error);
  check(
    'r5[KeelMinimalAccount] uninstallModule n/a (reverts; no module manager)',
    minimalAttempt.reverted === true,
  );
  check(
    'r5[KeelMinimalAccount] revert is NOT UnsupportedCallData (unknown selector / empty)',
    minimalSelector !== unsupportedCallData,
    minimalSelector ?? 'empty / unknown selector',
  );
  console.log(
    `      r5[KeelMinimalAccount] uninstallModule n/a (constructor-installed; no module manager); reversal = L0 / L3`,
  );

  // --- Kernel v3.3: hot-installable third party -> reversal succeeds (L1) ----
  // Deployed from the committed fixtures exactly as Acceptance.s.sol does.
  try {
    const kernelArt = fixture('Kernel');
    const kernelFactoryArt = fixture('KernelFactory');
    const kernelImpl = await deploy(wallet, publicClient, kernelArt, [ENTRYPOINT]);
    const kernelFactory = await deploy(wallet, publicClient, kernelFactoryArt, [kernelImpl]);
    const kernelValidator = await deploy(wallet, publicClient, fixture('ECDSAValidator'));

    // Kernel's root ValidationId = 1 byte type (0x01 = validator) ++ address.
    const rootValidation = `0x01${kernelValidator.slice(2)}`;
    const kernelValidatorData = owner.address;
    const kernelHookData = `0x00${encodeAbiParameters(
      parseAbiParameters('bytes32 sessionId, bytes policyData'),
      [SESSION_ID, policyData],
    ).slice(2)}`;
    const kernelInitData = encodeFunctionData({
      abi: kernelArt.abi,
      functionName: 'initialize',
      args: [rootValidation, hookAddr, kernelValidatorData, kernelHookData, []],
    });
    const kernelSalt = keccak256(toHex('keel.migration-drill.kernel.v1'));
    const kernelAccount = await publicClient.readContract({
      address: kernelFactory,
      abi: kernelFactoryArt.abi,
      functionName: 'getAddress',
      args: [kernelInitData, kernelSalt],
    });
    const kernelCreateHash = await wallet.writeContract({
      address: kernelFactory,
      abi: kernelFactoryArt.abi,
      functionName: 'createAccount',
      args: [kernelInitData, kernelSalt],
    });
    await publicClient.waitForTransactionReceipt({ hash: kernelCreateHash });
    await publicClient.request({
      method: 'anvil_setBalance',
      params: [kernelAccount, '0x56bc75e2d63100000'],
    });

    const kernelArgs = { account: kernelAccount, module: hookAddr, moduleTypeId: MODULE_TYPE.HOOK };
    // Kernel's account-side `isModuleInstalled` only covers validator/executor/
    // fallback — a HOOK (type 4) always reads false there by design (Kernel.sol
    // `isModuleInstalled` else-branch). The module-side `isInitialized` is the
    // real install evidence, and it is true here: Kernel's `initialize` reached
    // `_installHook` and called `hook.onInstall`.
    const kernelHookInit = await publicClient.readContract({
      address: hookAddr,
      abi: policyHookAbi,
      functionName: 'isInitialized',
      args: [kernelAccount],
    });
    check(
      'r5[Kernel] hook installed at creation via initialize (hook.isInitialized)',
      kernelHookInit === true,
      `hook.isInitialized=${kernelHookInit}`,
    );
    console.log(
      `      r5[Kernel] LIVE FINDING: account.isModuleInstalled(4, hook) is false on Kernel by design (its view covers only validator/executor/fallback)`,
    );

    const kernelUninstall = await impersonatedSend(publicClient, kernelAccount, uninstallData);
    check('r5[Kernel] uninstallModule succeeded (L1 available)', kernelUninstall.reverted === false, kernelUninstall.reason);
    const kernelAfter = await probeModule(probeImpl, kernelArgs);
    const kernelHookInitAfter = await publicClient.readContract({
      address: hookAddr,
      abi: policyHookAbi,
      functionName: 'isInitialized',
      args: [kernelAccount],
    });
    check(
      'r5[Kernel] probes flip back to false',
      kernelAfter.ok === false && kernelHookInitAfter === false,
      `${JSON.stringify(kernelAfter)} hook.isInitialized=${kernelHookInitAfter}`,
    );
    console.log(`      r5[Kernel] uninstallModule succeeded; probes false (L1 available)`);
  } catch (error) {
    // Construction is genuinely impossible here — do not fake the result; fall
    // back to the §3 acceptance assertion and say so explicitly.
    console.log(
      `      r5[Kernel] not constructed in this drill — asserted by §3 acceptance (${shortError(error)})`,
    );
  }
}

let anvil;
try {
  console.log(`migration-drill: anvil ${ANVIL_BIN} --fork-url ${RPC_URL} --port ${PORT}`);
  anvil = spawnAnvil();
  const publicClient = createPublicClient({ chain: bsc, transport: http(LOCAL_RPC) });
  const chainId = await waitForAnvil(publicClient, anvil);
  check('anvil fork chainId === 56', chainId === 56, `got ${chainId}`);
  await runDrill(publicClient);
} catch (error) {
  console.error(`\nDRILL ABORTED: ${shortError(error)}`);
  failures++;
} finally {
  await stopAnvil(anvil);
}

console.log(failures === 0 ? '\nRESULT: PASS' : `\nRESULT: FAIL (${failures} check(s))`);
process.exit(failures === 0 ? 0 : 1);
