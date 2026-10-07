import { describe, expect, it, vi } from 'vitest';
import {
  WebhookDispatcher,
  matchesWebhook,
  webhookEventFromLedgerEvent,
  type WebhookEvent,
  type WebhookRequest,
  type WebhookResponse,
  type WebhookSubscription,
} from './index.js';
import type { LedgerEvent } from './index.js';

const CLOCK = () => new Date('2026-01-01T00:00:00.000Z'); // 1767225600s

const RECEIPT_EVENT: LedgerEvent = {
  kind: 'receipt',
  at: '2026-01-01T00:00:00.000Z',
  receipt: {
    id: '0xtx',
    protocol: 'x402',
    network: 'eip155:8453',
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    amount: 10_000n,
    payer: '0x1111111111111111111111111111111111111111',
    payee: '0x2222222222222222222222222222222222222222',
    settledAt: '2026-01-01T00:00:00.000Z',
    intentId: 'intent-1',
  },
};

const WEBHOOK_EVENT = webhookEventFromLedgerEvent(RECEIPT_EVENT);

function okTransport(responses: Array<number | Error>) {
  const requests: WebhookRequest[] = [];
  let call = 0;
  const transport = vi.fn(async (request: WebhookRequest): Promise<WebhookResponse> => {
    requests.push(request);
    const outcome = responses[Math.min(call, responses.length - 1)] ?? 200;
    call += 1;
    if (outcome instanceof Error) throw outcome;
    return { status: outcome };
  });
  return { transport, requests };
}

function dispatcher(responses: Array<number | Error>, overrides: Partial<ConstructorParameters<typeof WebhookDispatcher>[0]> = {}) {
  const { transport, requests } = okTransport(responses);
  const sleep = vi.fn(async () => {});
  const instance = new WebhookDispatcher({ transport, clock: CLOCK, sleep, maxAttempts: 3, ...overrides });
  return { instance, requests, transport, sleep };
}

const SUB: WebhookSubscription = { id: 'sub-1', url: 'https://hook.example.com/settle' };

describe('webhookEventFromLedgerEvent', () => {
  it('normalises a receipt into a settlement.succeeded event with a stable id', () => {
    expect(WEBHOOK_EVENT).toEqual({
      id: 'settlement.succeeded:0xtx',
      type: 'settlement.succeeded',
      at: '2026-01-01T00:00:00.000Z',
      protocol: 'x402',
      data: (RECEIPT_EVENT as Extract<LedgerEvent, { kind: 'receipt' }>).receipt,
    });
  });

  it('normalises every ledger event kind', () => {
    const intent = webhookEventFromLedgerEvent({
      kind: 'intent',
      at: 't0',
      intent: {
        id: 'intent-1',
        protocol: 'mpp',
        network: 'eip155:8453',
        asset: 'native',
        amount: 1n,
        payer: 'a',
        payee: 'b',
      },
    });
    expect(intent.type).toBe('intent.created');
    expect(intent.protocol).toBe('mpp');
    expect(intent.id).toBe('intent.created:intent-1');

    const failure = webhookEventFromLedgerEvent({ kind: 'failure', at: 't2', intentId: 'intent-1', reason: 'boom' });
    expect(failure.type).toBe('settlement.failed');
    expect(failure.data).toEqual({ intentId: 'intent-1', reason: 'boom' });
    expect(failure.protocol).toBeUndefined();

    const entry = webhookEventFromLedgerEvent({
      kind: 'entry',
      at: 't3',
      entry: { account: 'acct', network: 'eip155:8453', asset: 'native', amount: 5n },
    });
    expect(entry.type).toBe('ledger.entry');
    expect(entry.id).toBe('ledger.entry:acct@t3');
  });
});

describe('matchesWebhook', () => {
  it('filters by active flag, event type and protocol', () => {
    expect(matchesWebhook(SUB, WEBHOOK_EVENT)).toBe(true);
    expect(matchesWebhook({ ...SUB, active: false }, WEBHOOK_EVENT)).toBe(false);
    expect(matchesWebhook({ ...SUB, events: ['intent.created'] }, WEBHOOK_EVENT)).toBe(false);
    expect(matchesWebhook({ ...SUB, events: ['settlement.succeeded'] }, WEBHOOK_EVENT)).toBe(true);
    expect(matchesWebhook({ ...SUB, protocols: ['mpp'] }, WEBHOOK_EVENT)).toBe(false);
    expect(matchesWebhook({ ...SUB, protocols: ['x402'] }, WEBHOOK_EVENT)).toBe(true);
  });

  it('drops protocol-less events when a subscription filters by protocol', () => {
    const failure = webhookEventFromLedgerEvent({ kind: 'failure', at: 't', intentId: 'i', reason: 'r' });
    expect(matchesWebhook({ ...SUB, protocols: ['x402'] }, failure)).toBe(false);
  });
});

describe('WebhookDispatcher', () => {
  it('delivers to matching subscriptions only', async () => {
    const { instance, requests } = dispatcher([200]);
    const deliveries = await instance.dispatch(
      [
        SUB,
        { id: 'sub-2', url: 'https://hook.example.com/other', protocols: ['mpp'] },
      ],
      WEBHOOK_EVENT,
    );

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ subscriptionId: 'sub-1', ok: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(SUB.url);
  });

  it('sends the standard headers and a JSON body', async () => {
    const { instance, requests } = dispatcher([200]);
    await instance.dispatch([SUB], WEBHOOK_EVENT);

    const request = requests[0]!;
    expect(request.headers['content-type']).toBe('application/json');
    expect(request.headers['x-keel-event']).toBe('settlement.succeeded');
    expect(request.headers['x-keel-event-id']).toBe('settlement.succeeded:0xtx');
    expect(request.headers['x-keel-timestamp']).toBe('1767225600');
    expect(JSON.parse(request.body)).toMatchObject({ id: 'settlement.succeeded:0xtx' });
  });

  it('retries a non-2xx response until it succeeds', async () => {
    const { instance, transport, sleep } = dispatcher([500, 503, 200]);
    const [delivery] = await instance.dispatch([SUB], WEBHOOK_EVENT);

    expect(transport).toHaveBeenCalledTimes(3);
    expect(delivery!.ok).toBe(true);
    expect(delivery!.attempts.map((attempt) => attempt.status)).toEqual([500, 503, 200]);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxAttempts and records every attempt', async () => {
    const { instance, transport } = dispatcher([500, 500, 500]);
    const [delivery] = await instance.dispatch([SUB], WEBHOOK_EVENT);

    expect(transport).toHaveBeenCalledTimes(3);
    expect(delivery!.ok).toBe(false);
    expect(delivery!.attempts).toHaveLength(3);
    expect(delivery!.attempts.every((attempt) => attempt.status === 500)).toBe(true);
  });

  it('treats a thrown transport as a failed attempt and retries', async () => {
    const { instance, transport } = dispatcher([new Error('ECONNREFUSED'), 200]);
    const [delivery] = await instance.dispatch([SUB], WEBHOOK_EVENT);

    expect(transport).toHaveBeenCalledTimes(2);
    expect(delivery!.ok).toBe(true);
    expect(delivery!.attempts[0]).toMatchObject({ ok: false, error: 'ECONNREFUSED' });
  });

  it('signs the body when the subscription has a secret and a signer is set', async () => {
    const { instance, requests } = dispatcher([200], {
      signer: ({ secret, timestamp, body }) => `${secret}:${timestamp}:${body.length}`,
    });
    await instance.dispatch([{ ...SUB, secret: 'whsec_1' }], WEBHOOK_EVENT);

    const request = requests[0]!;
    expect(request.headers['x-keel-signature']).toBe(`t=1767225600,v1=whsec_1:1767225600:${request.body.length}`);
  });

  it('does not sign when there is no secret', async () => {
    const { instance, requests } = dispatcher([200], { signer: () => 'sig' });
    await instance.dispatch([SUB], WEBHOOK_EVENT);
    expect(requests[0]!.headers['x-keel-signature']).toBeUndefined();
  });

  it('merges extra headers from a function', async () => {
    const { instance, requests } = dispatcher([200], {
      headers: (event: WebhookEvent, subscription: WebhookSubscription) => ({
        'x-tenant': subscription.id,
        'x-at': event.at,
      }),
    });
    await instance.dispatch([SUB], WEBHOOK_EVENT);
    expect(requests[0]!.headers['x-tenant']).toBe('sub-1');
    expect(requests[0]!.headers['x-at']).toBe('2026-01-01T00:00:00.000Z');
  });
});
