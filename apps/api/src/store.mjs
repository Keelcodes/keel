/**
 * Console backend storage — a session index, a settlement ledger and telemetry
 * counters, kept in one JSON file.
 *
 * This is the reference `SessionStore` the plan calls for (§6.3): no tenant
 * dimension and no private keys, unlike infraX's multi-tenant store, which stays
 * private. It is deliberately dependency-free so it runs anywhere Node runs and
 * ships as the minimal self-hosted counterpart to the hosted service.
 *
 * Writes go through on every mutation (write-to-temp then rename, so a crash
 * never leaves a half-written file). One process owns the file; the service is
 * single-instance by design.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Bumped when the on-disk shape changes. */
export const STORE_VERSION = 1;

/** Telemetry counters the metrics collector reads. */
export const TELEMETRY_KINDS = Object.freeze(['conformance.run', 'settlement.intent', 'docs.visit']);

/** Settlement protocols a ledger intent may carry. */
export const PROTOCOLS = Object.freeze(['x402', 'mpp', 'erc8183', 'a2a']);

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

/** True for a 20-byte hex chain address. */
export function isAddress(value) {
  return typeof value === 'string' && ADDRESS.test(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function emptyState() {
  return { version: STORE_VERSION, sessions: [], ledger: [], counters: {} };
}

function normalise(raw) {
  const state = raw && typeof raw === 'object' ? raw : {};
  return {
    version: STORE_VERSION,
    sessions: Array.isArray(state.sessions) ? state.sessions : [],
    ledger: Array.isArray(state.ledger) ? state.ledger : [],
    counters: state.counters && typeof state.counters === 'object' ? state.counters : {},
  };
}

/**
 * Opens the store, loading `file` if it exists. Passing no `file` keeps
 * everything in memory — what the tests use.
 */
export function createStore({ file } = {}) {
  let state = emptyState();
  if (file) {
    try {
      state = normalise(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      state = emptyState(); // first run, or an unreadable file: start clean
    }
  }

  function persist() {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = join(dirname(file), `.${Date.now()}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(tmp, file);
  }

  /** Sessions, optionally narrowed to one account. */
  function listSessions(account) {
    assert(account === undefined || account === null || isAddress(account), 'account must be an address');
    if (account) return state.sessions.filter((s) => s.account === account);
    return [...state.sessions];
  }

  /**
   * Inserts or replaces a session, keyed by `(account, sessionId)`. This is the
   * index the migration program backfills (`module_version`, §7.5 step 2); the
   * chain remains the source of truth for whether a session is live.
   */
  function upsertSession(input) {
    assert(isAddress(input?.account), 'account must be an address');
    assert(typeof input?.sessionId === 'string' && BYTES32.test(input.sessionId), 'sessionId must be bytes32');
    assert(
      typeof input?.moduleVersion === 'string' || typeof input?.moduleVersion === 'number',
      'moduleVersion is required',
    );

    const record = {
      account: input.account,
      sessionId: input.sessionId,
      moduleVersion: String(input.moduleVersion),
      validUntil: input.validUntil ?? null,
      maxPerTx: input.maxPerTx ?? null,
      maxDaily: input.maxDaily ?? null,
      status: input.status ?? 'active',
      updatedAt: new Date().toISOString(),
    };

    const at = state.sessions.findIndex(
      (s) => s.account === record.account && s.sessionId === record.sessionId,
    );
    if (at === -1) state.sessions.push(record);
    else state.sessions[at] = record;

    persist();
    return record;
  }

  /** Ledger entries, optionally narrowed to one account. Newest first. */
  function listLedger(account) {
    assert(account === undefined || account === null || isAddress(account), 'account must be an address');
    const rows = account ? state.ledger.filter((e) => e.account === account) : state.ledger;
    return [...rows].reverse();
  }

  /**
   * Appends a settlement intent. Recording one also advances the
   * `settlement.intent` telemetry counter, so the ledger is the single source
   * for that metric rather than a second, drift-prone counter.
   */
  function addIntent(input) {
    assert(isAddress(input?.account), 'account must be an address');
    assert(PROTOCOLS.includes(input?.protocol), `protocol must be one of ${PROTOCOLS.join(', ')}`);
    assert(typeof input?.amount === 'string' && input.amount.length > 0, 'amount must be a string');

    const entry = {
      id: `intent_${state.ledger.length + 1}`,
      account: input.account,
      protocol: input.protocol,
      amount: input.amount,
      asset: input.asset ?? null,
      status: input.status ?? 'pending',
      reference: input.reference ?? null,
      createdAt: new Date().toISOString(),
    };
    state.ledger.push(entry);
    increment('settlement.intent');
    persist();
    return entry;
  }

  /** Telemetry counters, plus the live ledger-derived intent total. */
  function counters() {
    return { ...state.counters, 'settlement.intent': state.ledger.length };
  }

  /** Advances one telemetry counter; unknown kinds are rejected. */
  function increment(kind, by = 1) {
    assert(TELEMETRY_KINDS.includes(kind), `unknown telemetry kind ${kind}`);
    assert(Number.isInteger(by) && by > 0, 'by must be a positive integer');
    state.counters[kind] = (state.counters[kind] ?? 0) + by;
    persist();
    return state.counters;
  }

  return { listSessions, upsertSession, listLedger, addIntent, counters, increment };
}
