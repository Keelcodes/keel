import { toCall, type Call } from '@keelcodes/policy';
import { describe, expect, it } from 'vitest';
import { createHttpExecutor, type ExecutorRequest, type FetchLike } from './executor.js';

const TARGET = '0x0000000000000000000000000000000000000001' as const;

function callOf(value = 0n): Call {
  return toCall({ target: TARGET, value });
}

interface Seen {
  url: string;
  init: ExecutorRequest;
}

function stub(seen: Seen[], body: string, ok = true, status = 200): FetchLike {
  return async (url, init) => {
    seen.push({ url, init });
    return { ok, status, text: async () => body };
  };
}

describe('createHttpExecutor', () => {
  it('POSTs the call as JSON and returns the parsed response', async () => {
    const seen: Seen[] = [];
    const executor = createHttpExecutor(
      { url: 'https://executor.keel.codes/relay' },
      stub(seen, JSON.stringify({ transactionHash: '0xabc' })),
    );

    const result = await executor(callOf(5n));

    expect(result).toEqual({ transactionHash: '0xabc' });
    expect(seen[0]!.url).toBe('https://executor.keel.codes/relay');
    expect(seen[0]!.init.method).toBe('POST');
    expect(seen[0]!.init.headers.authorization).toBeUndefined();
    const sent = JSON.parse(seen[0]!.init.body) as Record<string, unknown>;
    expect(sent.target).toBe(TARGET);
    expect(sent.value).toBe('5');
    expect(sent.data).toBe('0x');
  });

  it('sends the bearer token when configured', async () => {
    const seen: Seen[] = [];
    const executor = createHttpExecutor(
      { url: 'https://executor.keel.codes', token: 's3cret' },
      stub(seen, '{}'),
    );

    await executor(callOf());

    expect(seen[0]!.init.headers.authorization).toBe('Bearer s3cret');
  });

  it('wraps a non-object response instead of losing it', async () => {
    const executor = createHttpExecutor({ url: 'https://x.test' }, stub([], '42'));
    expect(await executor(callOf())).toEqual({ result: 42 });
  });

  it('treats an empty body as an empty outcome', async () => {
    const executor = createHttpExecutor({ url: 'https://x.test' }, stub([], ''));
    expect(await executor(callOf())).toEqual({});
  });

  it('throws on a non-2xx response, carrying the status', async () => {
    const executor = createHttpExecutor({ url: 'https://x.test' }, stub([], 'bad gateway', false, 502));
    await expect(executor(callOf())).rejects.toThrow(/HTTP 502.*bad gateway/);
  });
});
