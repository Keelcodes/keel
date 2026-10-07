#!/usr/bin/env node
// ============================================================================
// fork-drill.mjs — a credential-free rehearsal of a session-module migration
// against a real BSC fork.
//
//   BSC_RPC_URL=<rpc> node scripts/fork-drill.mjs      # default: bsc-dataseed
//
// It starts a local anvil forking BSC (port 8546 — 8545 is commonly taken),
// validates the real Keel/BSC address book, builds and deploys Keel's own
// modules to the fork, then runs the two-sided migration probe from
// `createViemModuleProbe`:
//
//   1. address-book  — every real address in the book still has code.
//   2. deploy        — forge build + deploy validator / hook / minimal account.
//   3. positive      — a correctly installed hook reads
//                      { installed: true, initialized: true, ok: true }.
//   4. negative      — an uninstalled module reads installed: false.
//   5. legacy health — the real infraX session module is checked honestly for
//                      whether it implements isInitialized() (negative finding
//                      is reported, not failed).
//
// Writes only to the fork, never to the real chain.
// ============================================================================

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseAbiParameters,
  toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bsc } from 'viem/chains';
import { createViemModuleProbe } from '../dist/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIR = resolve(HERE, '../../../contracts');
const FOUNDRY_BIN = process.env.FOUNDRY_BIN ?? '/home/steven/.foundry/bin';
const ANVIL_BIN = resolve(FOUNDRY_BIN, 'anvil');
const FORGE_BIN = resolve(FOUNDRY_BIN, 'forge');

const PORT = 8546;
const RPC_URL = process.env.BSC_RPC_URL ?? 'https://bsc-dataseed.bnbchain.org';
const LOCAL_RPC = `http://127.0.0.1:${PORT}`;

// Well-known, pre-funded anvil account #0.
const ANVIL_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const SESSION_ID = keccak256(toHex('keel.fork-drill.session.v1'));
const RECIPIENT = '0x000000000000000000000000000000000000bEEF';
const HOOK_MODULE_TYPE = 4n;

// Real BSC deployments (from infraX chain-defaults). Step 1 asserts each still
// has code, so a re-org or a wrong RPC surfaces before the drill proceeds.
const ADDRESS_BOOK = {
  entryPoint: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
  kernelImplementation: '0xBAC849bB641841b44E965fB01A4Bf5F074f84b4D',
  kernelFactory: '0xaac5D4240AF87249B3f71BC8E4A2cae074A3E419',
  ecdsaValidator: '0x845ADb2C711129d4f3966735eD98a9F09fC4cE57',
  infraXSessionModule: '0x848E31AD136e0dC6d3EECca8fF6367610C52F725',
};

const moduleHealthAbi = parseAbi(['function isInitialized(address smartAccount) view returns (bool)']);

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

async function deploy(wallet, publicClient, art, args = []) {
  const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error('deployment produced no contract address');
  return receipt.contractAddress;
}

/** Mirrors `probeModule` from @keelcodes/migrate without importing it (adapters has no migrate dep). */
async function probe(probeImpl, args) {
  const installed = await probeImpl.isModuleInstalled(args);
  const initialized = installed ? await probeImpl.isModuleInitialized(args.module, args.account) : false;
  return { installed, initialized, ok: installed && initialized };
}

async function runDrill(publicClient) {
  // ---- Step 1: address book -------------------------------------------------
  console.log(`\n[1/5] address book (BSC real deployments, fork chainId ${await publicClient.getChainId()})`);
  for (const [name, address] of Object.entries(ADDRESS_BOOK)) {
    const code = await publicClient.getCode({ address });
    const hasCode = Boolean(code) && code !== '0x' && code !== undefined;
    check(`${name} ${address}`, hasCode, hasCode ? `${(code.length - 2) / 2} bytes` : 'no code on chain');
  }

  // ---- Step 2: build and deploy Keel modules --------------------------------
  console.log(`\n[2/5] forge build + deploy Keel modules to the fork`);
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
  const validatorInitData = encodeAbiParameters(parseAbiParameters('address owner'), [owner.address]);
  const hookInitData = encodeAbiParameters(parseAbiParameters('bytes32 sessionId, bytes policyData'), [
    SESSION_ID,
    policyData,
  ]);

  const accountAddr = await deploy(wallet, publicClient, artifact('KeelMinimalAccount'), [
    ADDRESS_BOOK.entryPoint,
    validatorAddr,
    hookAddr,
    validatorInitData,
    hookInitData,
  ]);
  console.log(`      validator       : ${validatorAddr}`);
  console.log(`      policy hook     : ${hookAddr}`);
  console.log(`      minimal account : ${accountAddr}`);
  check('KeelMinimalAccount deployed with code', (await publicClient.getCode({ address: accountAddr })) !== '0x');

  const probeImpl = createViemModuleProbe(publicClient);

  // ---- Step 3: positive two-sided probe -------------------------------------
  console.log(`\n[3/5] positive probe (installed hook, moduleTypeId=${HOOK_MODULE_TYPE})`);
  const positive = await probe(probeImpl, {
    account: accountAddr,
    module: hookAddr,
    moduleTypeId: HOOK_MODULE_TYPE,
  });
  console.log(`      ${JSON.stringify(positive)}`);
  check('installed=true', positive.installed === true);
  check('initialized=true', positive.initialized === true);
  check('ok=true', positive.ok === true);

  // ---- Step 4: negative probe -----------------------------------------------
  console.log(`\n[4/5] negative probe (uninstalled random module)`);
  const randomModule = getAddress(`0x${randomBytes(20).toString('hex')}`);
  const negative = await probe(probeImpl, {
    account: accountAddr,
    module: randomModule,
    moduleTypeId: HOOK_MODULE_TYPE,
  });
  console.log(`      ${randomModule} → ${JSON.stringify(negative)}`);
  check('installed=false', negative.installed === false);
  check('ok=false', negative.ok === false);

  // ---- Step 5: real legacy session module health ----------------------------
  console.log(`\n[5/5] legacy health: real infraXSessionModule ${ADDRESS_BOOK.infraXSessionModule}`);
  const legacyCode = await publicClient.getCode({ address: ADDRESS_BOOK.infraXSessionModule });
  const legacyHasCode = Boolean(legacyCode) && legacyCode !== '0x';
  check('infraXSessionModule has code', legacyHasCode, legacyHasCode ? `${(legacyCode.length - 2) / 2} bytes` : 'no code');
  let finding;
  try {
    const value = await publicClient.readContract({
      address: ADDRESS_BOOK.infraXSessionModule,
      abi: moduleHealthAbi,
      functionName: 'isInitialized',
      args: [accountAddr],
    });
    finding = `isInitialized() returned ${value} — the function is implemented`;
  } catch (error) {
    finding = `isInitialized() reverted / not implemented — ${shortError(error)}`;
  }
  // The probe itself must resolve this to false without throwing.
  const legacyProbe = await probeImpl.isModuleInitialized(ADDRESS_BOOK.infraXSessionModule, accountAddr);
  console.log(`      LIVE FINDING: ${finding}`);
  console.log(`      probe.isModuleInitialized(...) = ${legacyProbe} (never throws)`);
}

let anvil;
try {
  console.log(`fork-drill: anvil ${ANVIL_BIN} --fork-url ${RPC_URL} --port ${PORT}`);
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
