import { SettlementError, type LedgerEvent, type Protocol } from './types.js';

/**
 * Multi-protocol webhook egress.
 *
 * Every rail in this package — x402, MPP, A2A's x402 extension, ERC-8183
 * escrow — folds into the same append-only {@link LedgerEvent} log, so outbound
 * notifications need only one normalised event shape. A {@link WebhookEvent}
 * is that shape; {@link WebhookDispatcher} matches it against subscriptions and
 * delivers it with retries and a per-delivery audit trail.
 *
 * Signing is a port, not baked in: the core carries no crypto dependency and
 * runs anywhere, so the host wires its own HMAC (`WebhookSigner`) — the same
 * way scheme payloads are left to the caller. A delivery is only signed when a
 * subscription carries a `secret` and a signer is configured.
 */

export type WebhookEventType =
  | 'intent.created'
  | 'settlement.succeeded'
  | 'settlement.failed'
  | 'ledger.entry';

/** The transport-neutral event a subscription receives. */
export interface WebhookEvent {
  /** Stable per source event — safe to use as an idempotency key. */
  id: string;
  type: WebhookEventType;
  /** ISO-8601, taken from the ledger event. */
  at: string;
  protocol?: Protocol;
  data: unknown;
}

/**
 * Normalises a ledger event into a webhook event. Ids are derived from the
 * source record so replaying the same log yields the same delivery ids.
 */
export function webhookEventFromLedgerEvent(event: LedgerEvent): WebhookEvent {
  switch (event.kind) {
    case 'intent':
      return {
        id: `intent.created:${event.intent.id}`,
        type: 'intent.created',
        at: event.at,
        protocol: event.intent.protocol,
        data: event.intent,
      };
    case 'receipt':
      return {
        id: `settlement.succeeded:${event.receipt.id}`,
        type: 'settlement.succeeded',
        at: event.at,
        protocol: event.receipt.protocol,
        data: event.receipt,
      };
    case 'failure':
      return {
        id: `settlement.failed:${event.intentId}@${event.at}`,
        type: 'settlement.failed',
        at: event.at,
        data: { intentId: event.intentId, reason: event.reason },
      };
    case 'entry':
      return {
        id: `ledger.entry:${event.entry.account}@${event.at}`,
        type: 'ledger.entry',
        at: event.at,
        data: event.entry,
      };
  }
}

export interface WebhookSubscription {
  id: string;
  url: string;
  /** Event types to receive; all when omitted. */
  events?: readonly WebhookEventType[];
  /** Restrict to these rails; events without a protocol are dropped. */
  protocols?: readonly Protocol[];
  /** Enables signing for this subscription. */
  secret?: string;
  /** Defaults to active. */
  active?: boolean;
}

export function matchesWebhook(subscription: WebhookSubscription, event: WebhookEvent): boolean {
  if (subscription.active === false) return false;
  if (subscription.events !== undefined && !subscription.events.includes(event.type)) return false;
  if (subscription.protocols !== undefined) {
    if (event.protocol === undefined) return false;
    if (!subscription.protocols.includes(event.protocol)) return false;
  }
  return true;
}

export interface WebhookRequest {
  subscriptionId: string;
  eventId: string;
  url: string;
  /** JSON body. */
  body: string;
  headers: Record<string, string>;
}

export interface WebhookResponse {
  status: number;
}

/** How a request actually leaves the process — `fetch`, a queue, a test double. */
export type WebhookTransport = (request: WebhookRequest) => Promise<WebhookResponse>;

export type WebhookSigner = (args: {
  secret: string;
  /** Unix seconds, also sent in `x-keel-timestamp`. */
  timestamp: string;
  body: string;
}) => string | Promise<string>;

export interface WebhookAttempt {
  attempt: number;
  at: string;
  status?: number;
  error?: string;
  ok: boolean;
}

export interface WebhookDelivery {
  subscriptionId: string;
  eventId: string;
  attempts: WebhookAttempt[];
  ok: boolean;
}

export interface WebhookDispatcherOptions {
  transport: WebhookTransport;
  signer?: WebhookSigner;
  clock?: () => Date;
  /** Total tries per delivery. Defaults to 3. */
  maxAttempts?: number;
  /** Delay before the next attempt; defaults to exponential backoff. */
  backoffMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
  /** Static extra headers, or a function of the event/subscription. */
  headers?: Record<string, string> | ((event: WebhookEvent, subscription: WebhookSubscription) => Record<string, string>);
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * JSON encoding with `bigint` rendered as a decimal string. Ledger records carry
 * atomic-unit amounts as `bigint`, and `JSON.stringify` throws on those.
 */
function encodeBody(event: WebhookEvent): string {
  return JSON.stringify(
    {
      id: event.id,
      type: event.type,
      at: event.at,
      protocol: event.protocol,
      data: event.data,
    },
    (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
  );
}

/**
 * Fans a webhook event out to matching subscriptions and records what happened.
 *
 * A delivery is retried on a network throw or a non-2xx status, up to
 * `maxAttempts`; the returned {@link WebhookDelivery} keeps every attempt so a
 * consumer can audit or replay it.
 */
export class WebhookDispatcher {
  private readonly options: WebhookDispatcherOptions;

  constructor(options: WebhookDispatcherOptions) {
    this.options = options;
  }

  async dispatch(
    subscriptions: readonly WebhookSubscription[],
    event: WebhookEvent,
  ): Promise<WebhookDelivery[]> {
    const deliveries: WebhookDelivery[] = [];
    for (const subscription of subscriptions) {
      if (!matchesWebhook(subscription, event)) continue;
      deliveries.push(await this.deliver(subscription, event));
    }
    return deliveries;
  }

  private now(): Date {
    return this.options.clock?.() ?? new Date();
  }

  private backoff(attempt: number): number {
    if (this.options.backoffMs !== undefined) return this.options.backoffMs(attempt);
    return 250 * 2 ** (attempt - 1);
  }

  private sleep(ms: number): Promise<void> {
    if (this.options.sleep !== undefined) return this.options.sleep(ms);
    const schedule = (globalThis as { setTimeout?: (callback: () => void, ms: number) => unknown })
      .setTimeout;
    if (schedule === undefined) {
      throw new SettlementError('precondition-failed', 'no timer available; pass options.sleep');
    }
    return new Promise((resolve) => {
      schedule(() => resolve(), ms);
    });
  }

  private async buildHeaders(
    subscription: WebhookSubscription,
    event: WebhookEvent,
    body: string,
  ): Promise<Record<string, string>> {
    const timestamp = Math.floor(this.now().getTime() / 1000).toString();
    const extra =
      typeof this.options.headers === 'function'
        ? this.options.headers(event, subscription)
        : this.options.headers ?? {};

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-keel-event': event.type,
      'x-keel-event-id': event.id,
      'x-keel-timestamp': timestamp,
      ...extra,
    };

    if (this.options.signer !== undefined && subscription.secret !== undefined) {
      const value = await this.options.signer({ secret: subscription.secret, timestamp, body });
      headers['x-keel-signature'] = `t=${timestamp},v1=${value}`;
    }
    return headers;
  }

  private async deliver(
    subscription: WebhookSubscription,
    event: WebhookEvent,
  ): Promise<WebhookDelivery> {
    const maxAttempts = this.options.maxAttempts ?? 3;
    const body = encodeBody(event);
    const attempts: WebhookAttempt[] = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const at = this.now().toISOString();
      try {
        const headers = await this.buildHeaders(subscription, event, body);
        const response = await this.options.transport({
          subscriptionId: subscription.id,
          eventId: event.id,
          url: subscription.url,
          body,
          headers,
        });
        const ok = isSuccess(response.status);
        attempts.push({ attempt, at, status: response.status, ok });
        if (ok) return { subscriptionId: subscription.id, eventId: event.id, attempts, ok: true };
      } catch (error) {
        attempts.push({
          attempt,
          at,
          error: error instanceof Error ? error.message : String(error),
          ok: false,
        });
      }
      if (attempt < maxAttempts) await this.sleep(this.backoff(attempt));
    }

    return { subscriptionId: subscription.id, eventId: event.id, attempts, ok: false };
  }
}
