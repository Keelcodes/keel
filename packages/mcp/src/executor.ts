import type { Call } from '@keelcodes/policy';
import type { CallExecutor } from './builtin.js';
import type { ExecutorConfig } from './config.js';

/**
 * The default {@link CallExecutor}: forwards an approved call to a Keel
 * executor endpoint and returns whatever JSON it answers with.
 *
 * The endpoint is *downstream of the gate* — the server only reaches it after
 * `@keelcodes/policy` has allowed the call — so a bundler, paymaster or
 * relayer can sit behind it without re-implementing the policy. `fetch` is
 * injected to keep the round-trip unit-testable without a network.
 */

export interface ExecutorRequest {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

/** The slice of `Response` this needs. */
export interface ExecutorResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type FetchLike = (url: string, init: ExecutorRequest) => Promise<ExecutorResponseLike>;

export function createHttpExecutor(
  config: ExecutorConfig,
  fetchImpl: FetchLike = defaultFetch,
): CallExecutor {
  return async (call: Call): Promise<Record<string, unknown>> => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (config.token !== undefined) headers.authorization = `Bearer ${config.token}`;

    const response = await fetchImpl(config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        target: call.target,
        value: call.value.toString(),
        data: call.data,
        selector: call.selector,
      }),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`executor returned HTTP ${response.status}: ${text.slice(0, 200)}`);
    }

    const payload = parseJson(text);
    return isObject(payload) ? payload : { result: payload };
  };
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

function parseJson(text: string): unknown {
  if (text.trim().length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
