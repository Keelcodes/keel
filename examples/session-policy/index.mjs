// Session policies.
//
// Issues a scoped grant on an account, dry-runs a batch of calls against it
// before signing, then rotates it. The normalised policy and its commitment
// hash are exactly what the on-chain KeelPolicyHook recomputes, so the
// off-chain pre-check and on-chain enforcement cannot disagree about what the
// policy means.
//
// Imported from the package's built entry point so the example runs from a
// checkout after `pnpm build`, with no workspace install. In your own project
// this is `import { ... } from '@keelcodes/policy'`.
import {
  InMemorySessionStore,
  ZERO_USAGE,
  issueSession,
  listSessions,
  rotateSession,
  simulateCalls,
  toCall,
} from '../../packages/policy/dist/index.js';

const OWNER = '0x000000000000000000000000000000000000beef';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // USDC on Base
const MERCHANT = '0x0000000000000000000000000000000000deadbeef';
const DAY = 24n * 3600n;

// ERC-20 `transfer(address,uint256)` calldata. Keel reads the amount straight
// out of this so the policy can bound token movements, not just call counts.
const word = (value) => value.toString(16).padStart(64, '0');
const transfer = (to, amount) => `0xa9059cbb${to.slice(2).toLowerCase().padStart(64, '0')}${word(amount)}`;

const now = BigInt(Math.floor(Date.now() / 1000));

// The policy is authored once and reused: a session stores its normalised form.
const policy = {
  validUntil: now + DAY,
  rules: [
    {
      target: USDC,
      selectors: ['0xa9059cbb'], // transfer(address,uint256)
      tokenLimits: [{ token: USDC, maxPerTx: 10_000_000n, maxDaily: 50_000_000n }],
      maxCalls: 200,
    },
  ],
};

const store = new InMemorySessionStore();
const session = await issueSession(store, { account: OWNER, now, policy });

console.log(`session    ${session.id.slice(0, 10)}… on ${session.account}`);
console.log(`commitment ${session.commitment}`);

// Dry-run before signing: usage is folded rule by rule, so a batch that only
// breaches the cap *together* is caught locally with a precise reason — no paid
// bundler round-trip that ends in a validation failure.
const batch = [
  toCall({ target: USDC, data: transfer(MERCHANT, 5_000_000n) }), // 5 USDC
  toCall({ target: USDC, data: transfer(MERCHANT, 4_000_000n) }), // 4 USDC
  toCall({ target: USDC, data: transfer(MERCHANT, 11_000_000n) }), // 11 USDC → over the 10 per-call cap
];

const dryRun = simulateCalls(session.policy, { now, usage: [ZERO_USAGE] }, batch);
console.log(`dry-run    allowed=${dryRun.allowed} reason=${dryRun.decision.reason ?? 'none'}`);

// Rotate: issue a successor and revoke the predecessor in one step, cross-linking
// the two. This is the off-chain half of the module migration in docs/RUNBOOK.md §9.
const { previous, next } = await rotateSession(store, session.id, { now: now + 60n, policy });
console.log(`rotated    ${previous.id.slice(0, 10)}… → ${next.id.slice(0, 10)}…`);

const views = await listSessions(store, OWNER, now + 60n);
console.log('lifecycle  ' + views.map((view) => `${view.id.slice(0, 10)}…:${view.status}`).join(', '));
