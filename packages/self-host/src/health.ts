import type { RpcCall } from './rpc.js';

/** The chain is up and reporting the expected chain id. */
export async function checkChain(rpc: RpcCall, expectedChainId: number): Promise<boolean> {
  const raw = await rpc('eth_chainId');
  return typeof raw === 'string' && Number.parseInt(raw, 16) === expectedChainId;
}

/** The bundler is up and advertising at least one EntryPoint. */
export async function checkBundler(rpc: RpcCall): Promise<boolean> {
  const raw = await rpc('eth_supportedEntryPoints');
  return Array.isArray(raw) && raw.length > 0;
}

export interface StackReadiness {
  chain: boolean;
  bundler: boolean;
  ready: boolean;
  timedOut: boolean;
  elapsedMs: number;
}

export interface WaitForStackOptions {
  chain: RpcCall;
  bundler: RpcCall;
  chainId: number;
  /** Give up after this long. Defaults to 30s. */
  timeoutMs?: number;
  /** Delay between attempts. Defaults to 250ms. */
  intervalMs?: number;
  /** Clock, injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Sleep, injectable for tests. Defaults to a timer. */
  sleep?: (ms: number) => Promise<void>;
}

type TimerHost = { setTimeout?: (handler: () => void, ms: number) => unknown };

function defaultSleep(ms: number): Promise<void> {
  const setTimer = (globalThis as TimerHost).setTimeout;
  if (setTimer === undefined) {
    throw new Error('waitForStack: no timer available; pass options.sleep');
  }
  return new Promise((resolve) => {
    setTimer(() => resolve(), ms);
  });
}

async function safely(fn: () => Promise<boolean>): Promise<boolean> {
  try {
    return await fn();
  } catch {
    return false;
  }
}

/**
 * Polls the stack until the chain and the bundler are both up, or the timeout
 * elapses. A probe that throws counts as "not ready yet", so a stack that is
 * still booting never surfaces as an error.
 *
 * The paymaster is intentionally not polled: it forwards to the bundler, so
 * bundler readiness is the last thing to arrive.
 */
export async function waitForStack(options: WaitForStackOptions): Promise<StackReadiness> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 250;
  const startedAt = now();

  let chain = false;
  let bundler = false;

  while (!(chain && bundler)) {
    if (!chain) {
      chain = await safely(() => checkChain(options.chain, options.chainId));
    }
    if (chain && !bundler) {
      bundler = await safely(() => checkBundler(options.bundler));
    }
    if (chain && bundler) break;

    const elapsedMs = now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      return { chain, bundler, ready: false, timedOut: true, elapsedMs };
    }
    await sleep(intervalMs);
  }

  return { chain, bundler, ready: true, timedOut: false, elapsedMs: now() - startedAt };
}
