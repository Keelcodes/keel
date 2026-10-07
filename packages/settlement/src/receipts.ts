import { SettlementError, type PaymentIntent, type SettlementReceipt } from './types.js';
import { verifyRequirement, type X402Requirements, type X402SettlementResponse } from './x402.js';

/**
 * Turns a protocol response into a {@link SettlementReceipt}.
 *
 * Both builders are deliberately strict: a receipt is evidence, so it is only
 * produced once the payment demonstrably succeeded *and* the terms still match
 * the intent. A "successful" settlement of the wrong amount is still wrong.
 */

export interface X402ReceiptArgs {
  intent: PaymentIntent;
  requirement: X402Requirements;
  response: X402SettlementResponse;
  /** ISO-8601 timestamp of settlement. */
  settledAt: string;
}

export function receiptFromX402(args: X402ReceiptArgs): SettlementReceipt {
  const { intent, requirement, response } = args;
  if (!response.success) {
    throw new SettlementError(
      'unsuccessful-settlement',
      `x402 settlement failed: ${response.errorReason ?? 'no reason given'}`,
    );
  }
  // Re-check after the fact: this response is what the receipt attests to.
  verifyRequirement(requirement, intent);

  return {
    id: response.transaction ?? `${intent.id}@${args.settledAt}`,
    protocol: 'x402',
    network: intent.network,
    asset: intent.asset,
    amount: intent.amount,
    payer: response.payer ?? intent.payer,
    payee: intent.payee,
    transaction: response.transaction,
    settledAt: args.settledAt,
    intentId: intent.id,
    proof: { requirement, response },
  };
}

export interface MppReceiptArgs {
  intent: PaymentIntent;
  /** The `Payment-Receipt` header value, kept verbatim as the proof. */
  receipt: string;
  settledAt: string;
}

export function receiptFromMpp(args: MppReceiptArgs): SettlementReceipt {
  const token = args.receipt.trim();
  if (token === '') {
    throw new SettlementError('missing-field', 'MPP settlement returned an empty Payment-Receipt');
  }

  return {
    // The receipt value identifies the settlement, so re-delivering the same
    // receipt surfaces as a duplicate rather than a second, phantom payment.
    id: token,
    protocol: 'mpp',
    network: args.intent.network,
    asset: args.intent.asset,
    amount: args.intent.amount,
    payer: args.intent.payer,
    payee: args.intent.payee,
    settledAt: args.settledAt,
    intentId: args.intent.id,
    proof: { receipt: token },
  };
}
