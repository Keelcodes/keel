// Settlement reconciliation.
//
// Records a payment intent, settles it with a receipt plus a balance movement,
// and reconciles the ledger. The ledger is an append-only event log: status and
// balances are folded out of it on demand, and a replayed receipt is a loud
// error instead of a silent double count.
//
// Imported from the package's built entry point so the example runs from a
// checkout after `pnpm build`, with no workspace install. In your own project
// this is `import { Ledger } from '@keelcodes/settlement'`.
import { Ledger } from '../../packages/settlement/dist/index.js';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // USDC on Base
const PAYER = '0x000000000000000000000000000000000000Beef';
const PAYEE = '0x00000000000000000000000000000000DeaDBeef';
const NETWORK = 'eip155:8453'; // Base (CAIP-2)

const ledger = new Ledger();
const at = new Date().toISOString();

const intent = {
  id: 'order-42',
  protocol: 'x402',
  network: NETWORK,
  asset: USDC,
  amount: 1_500_000n, // 1.5 USDC
  payer: PAYER,
  payee: PAYEE,
  reference: 'invoice-42',
};

ledger.append({ kind: 'intent', at, intent });
console.log(`status     ${ledger.statusOf(intent.id)}`); // pending

const receipt = {
  id: `0x${'ab'.repeat(32)}`, // the on-chain tx hash, where the protocol provides one
  protocol: 'x402',
  network: NETWORK,
  asset: USDC,
  amount: intent.amount,
  payer: PAYER,
  payee: PAYEE,
  transaction: `0x${'ab'.repeat(32)}`,
  settledAt: at,
  intentId: intent.id,
};

ledger.append({ kind: 'receipt', at, receipt });
ledger.append({
  kind: 'entry',
  at,
  entry: { account: PAYEE, network: NETWORK, asset: USDC, amount: intent.amount, reference: intent.id },
});
console.log(`status     ${ledger.statusOf(intent.id)}`); // settled

const balance = ledger.balanceOf(PAYEE, { network: NETWORK, asset: USDC });
console.log(`balance    ${balance} (payee, atomic USDC)`);

// A second intent that never settles: reconcile surfaces it as outstanding
// rather than letting it disappear, and marks the run as not-ok.
ledger.append({
  kind: 'intent',
  at,
  intent: { ...intent, id: 'order-43', reference: 'invoice-43' },
});

const report = ledger.reconcile();
console.log(`reconcile  ok=${report.ok} unsettled=[${report.unsettled.join(', ')}] orphans=[${report.orphans.join(', ')}]`);

// Replaying the same receipt is rejected, not silently double-counted.
try {
  ledger.append({ kind: 'receipt', at, receipt });
} catch (error) {
  console.log(`replay     rejected: ${error.code} — ${error.message}`);
}
