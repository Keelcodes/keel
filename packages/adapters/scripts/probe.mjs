#!/usr/bin/env node
// ============================================================================
// probe.mjs — the two-sided double probe for ONE account/module on a real chain.
//
//   node scripts/probe.mjs --chain 56 --account 0x… [--module 0x…] [--rpc <url>]
//
// Runs both halves from packages/adapters — `isModuleInstalled` on the account
// AND `isInitialized` on the module — and exits 0 only when both are true.
//
// Exit codes: 0 = ok; 1 = gate failed (a real not-ok reading); 2 = usage error;
// 3 = undecided (the RPC failed, so the module was never read — retry).
//
// This is RUNBOOK §4b made runnable per account, and the P2 / §2-preflight gate:
// `isModuleInstalled` alone is the silent-AA24 class of failure (the module is
// registered but the account does not actually route through it), so one probe
// is never enough. Runs read-only; no credentials.
//
// RPC resolution: `--rpc <url>`, else `KEEL_RPC_<chainId>` (the same secret the
// metrics workflow uses), else the chain's default public RPC.
// ============================================================================

import { createPublicClient, getAddress, http, isAddress } from 'viem';
import { base, bsc, mainnet } from 'viem/chains';
import { MODULE_TYPE, createViemModuleProbe } from '../dist/index.js';

const CHAINS = { 1: mainnet, 56: bsc, 8453: base };
const RPC_ENV = { 1: 'KEEL_RPC_1', 56: 'KEEL_RPC_56', 8453: 'KEEL_RPC_8453' };

// KeelPolicyHook — the same address on all three chains (RUNBOOK §1).
const DEFAULT_MODULE = '0x466b5DC3796D44b0B63FdF2d3bC7a8Ea371a891F';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? process.argv[index + 1] : fallback;
}

const chainId = Number(arg('chain', '56'));
const chain = CHAINS[chainId];
if (chain === undefined) {
  console.error(`unsupported --chain ${chainId} (use 1 | 56 | 8453)`);
  process.exit(2);
}

const account = arg('account');
if (account === undefined || !isAddress(account)) {
  console.error('--account <0x…> is required');
  process.exit(2);
}

let module;
try {
  module = getAddress(arg('module', DEFAULT_MODULE));
} catch {
  console.error(`--module is not a valid address: ${arg('module', DEFAULT_MODULE)}`);
  process.exit(2);
}

const rpc = arg('rpc', process.env[RPC_ENV[chainId]] ?? chain.rpcUrls.default.http[0]);
if (rpc === undefined) {
  console.error(`no RPC available: pass --rpc <url> or set ${RPC_ENV[chainId]}`);
  process.exit(2);
}

const client = createPublicClient({ chain, transport: http(rpc) });
const probe = createViemModuleProbe(client);

let installed = false;
let initialized = false;
try {
  installed = await probe.isModuleInstalled({ account, module, moduleTypeId: MODULE_TYPE.HOOK });
  initialized = installed ? await probe.isModuleInitialized(module, account) : false;
} catch (error) {
  // The probe only rethrows when the RPC itself failed (HTTP error, rate limit,
  // timeout) — a transient condition that says nothing about the module. Exit 3
  // ("undecided") is deliberately distinct from 1 ("gate failed") so a scripted
  // rollout retries instead of recording a false negative.
  console.error(`RPC error probing ${account} on ${module}: ${error.shortMessage ?? error.message}`);
  console.error('UNDECIDED — retry; this is not a gate failure.');
  process.exit(3);
}
const ok = installed && initialized;

console.log(
  JSON.stringify(
    { chainId, account, module, moduleTypeId: MODULE_TYPE.HOOK.toString(), installed, initialized, ok },
    null,
    2,
  ),
);
if (!installed && initialized) {
  // Kernel v3.3's `isModuleInstalled` view covers validators / executors /
  // fallbacks only, so for a hook it returns false *by design* even when the
  // hook is installed and enforcing (fork-verified, migration-drill §9 R5).
  // Read the pair, not just `ok`: corroborate with the hook's
  // `policyCommitmentOf(account, sessionId)` before treating this as a failure.
  console.log(
    'NOTE — module reports initialised while the account view reports not-installed; this is the Kernel-style view (module type 4 is not covered). Corroborate via policyCommitmentOf before calling it a failure.',
  );
}
console.log(
  ok
    ? 'OK — module is installed AND initialised'
    : 'NOT OK — do not cut traffic over (installed alone is the silent AA24-class failure)',
);
process.exit(ok ? 0 : 1);
