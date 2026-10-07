import {
  SettlementError,
  type IntentStatus,
  type LedgerEntry,
  type LedgerEvent,
  type PaymentIntent,
  type Reconciliation,
  type SettlementReceipt,
} from './types.js';

export interface AssetRef {
  network: string;
  asset: string;
}

/**
 * An append-only reconciliation ledger.
 *
 * Nothing is stored mutably: intent status and balances are folded out of the
 * event log on demand, so the log is the single source of truth and can be
 * replayed or shipped anywhere. Receipt ids are deduplicated on append, which
 * makes a replayed settlement a loud error instead of a double count.
 */
export class Ledger {
  private readonly log: LedgerEvent[] = [];
  private readonly receiptsById = new Map<string, SettlementReceipt>();

  get events(): readonly LedgerEvent[] {
    return this.log;
  }

  append(event: LedgerEvent): void {
    if (event.kind === 'receipt') {
      if (this.receiptsById.has(event.receipt.id)) {
        throw new SettlementError(
          'duplicate-receipt',
          `receipt ${event.receipt.id} is already recorded`,
        );
      }
      this.receiptsById.set(event.receipt.id, event.receipt);
    }
    this.log.push(event);
  }

  intents(): PaymentIntent[] {
    return this.log.flatMap((event) => (event.kind === 'intent' ? [event.intent] : []));
  }

  intentOf(id: string): PaymentIntent | undefined {
    return this.intents().find((intent) => intent.id === id);
  }

  receipts(): SettlementReceipt[] {
    return [...this.receiptsById.values()];
  }

  entries(): LedgerEntry[] {
    return this.log.flatMap((event) => (event.kind === 'entry' ? [event.entry] : []));
  }

  receiptsOf(intentId: string): SettlementReceipt[] {
    return this.receipts().filter((receipt) => receipt.intentId === intentId);
  }

  /** The latest lifecycle event for an intent decides its status. */
  statusOf(intentId: string): IntentStatus {
    let status: IntentStatus | undefined;
    for (const event of this.log) {
      if (event.kind === 'intent' && event.intent.id === intentId) status = 'pending';
      else if (event.kind === 'receipt' && event.receipt.intentId === intentId) status = 'settled';
      else if (event.kind === 'failure' && event.intentId === intentId) status = 'failed';
    }
    if (status === undefined) {
      throw new SettlementError('unknown-intent', `no intent ${intentId} in the ledger`);
    }
    return status;
  }

  /** Signed sum of `entry` movements — credits positive, debits negative. */
  balanceOf(account: string, ref: AssetRef): bigint {
    return this.entries()
      .filter(
        (entry) =>
          entry.account === account &&
          entry.network === ref.network &&
          entry.asset.toLowerCase() === ref.asset.toLowerCase(),
      )
      .reduce((total, entry) => total + entry.amount, 0n);
  }

  /** Every event touching an intent, in append order. */
  trail(intentId: string): LedgerEvent[] {
    return this.log.filter((event) => {
      switch (event.kind) {
        case 'intent':
          return event.intent.id === intentId;
        case 'receipt':
          return event.receipt.intentId === intentId;
        case 'failure':
          return event.intentId === intentId;
        case 'entry':
          return event.entry.reference === intentId;
      }
    });
  }

  /**
   * Cross-checks intents against receipts. Three failure modes are worth
   * surfacing on their own: money that never arrived, receipts for intents the
   * ledger never saw, and an intent paid twice.
   */
  reconcile(): Reconciliation {
    const intents = new Set<string>();
    for (const event of this.log) {
      if (event.kind === 'intent') intents.add(event.intent.id);
    }

    const byIntent = new Map<string, string[]>();
    const orphans: string[] = [];
    for (const receipt of this.receipts()) {
      const intentId = receipt.intentId;
      if (intentId === undefined || !intents.has(intentId)) {
        orphans.push(receipt.id);
        continue;
      }
      const ids = byIntent.get(intentId) ?? [];
      ids.push(receipt.id);
      byIntent.set(intentId, ids);
    }

    const doubleSettled = [...byIntent.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([intentId]) => intentId);
    const unsettled = [...intents].filter((intentId) => !byIntent.has(intentId));

    return {
      unsettled,
      orphans,
      doubleSettled,
      ok: unsettled.length === 0 && orphans.length === 0 && doubleSettled.length === 0,
    };
  }
}
