import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createHandler } from '../src/server.mjs';
import { createStore } from '../src/store.mjs';

const ACCOUNT = `0x${'11'.repeat(20)}`;
const OTHER = `0x${'22'.repeat(20)}`;
const SESSION = `0x${'ab'.repeat(32)}`;

/** Starts a handler on an ephemeral port and returns its base URL. */
async function listen(handler) {
  const server = createHttpServer((req, res) => void handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

describe('@keelcodes/api', () => {
  let server;
  let base;

  before(async () => {
    ({ server, base } = await listen(createHandler({ store: createStore() })));
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  const post = (path, body, headers = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  it('reports health', async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, service: '@keelcodes/api' });
  });

  it('indexes a session and reads it back', async () => {
    const created = await post('/sessions', {
      account: ACCOUNT,
      sessionId: SESSION,
      moduleVersion: 'keel-policy@1',
    });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).session.moduleVersion, 'keel-policy@1');

    const listed = await fetch(`${base}/sessions?account=${ACCOUNT}`);
    const { sessions } = await listed.json();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].sessionId, SESSION);

    // Keyed by (account, sessionId): a second write replaces, never appends.
    await post('/sessions', { account: ACCOUNT, sessionId: SESSION, moduleVersion: 'keel-policy@2' });
    const again = await (await fetch(`${base}/sessions?account=${ACCOUNT}`)).json();
    assert.equal(again.sessions.length, 1);
    assert.equal(again.sessions[0].moduleVersion, 'keel-policy@2');
  });

  it('rejects a malformed session with 400', async () => {
    const res = await post('/sessions', { account: 'nope', sessionId: SESSION, moduleVersion: '1' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /account/);
  });

  it('records a settlement intent and counts it', async () => {
    const res = await post('/settlement/intents', {
      account: ACCOUNT,
      protocol: 'x402',
      amount: '1000000',
    });
    assert.equal(res.status, 201);

    const { entries } = await (await fetch(`${base}/settlement/ledger?account=${ACCOUNT}`)).json();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].protocol, 'x402');

    // The intent total is derived from the ledger, not a second counter.
    const { counters } = await (await fetch(`${base}/telemetry`)).json();
    assert.equal(counters['settlement.intent'], 1);
  });

  it('rejects an unknown protocol with 400', async () => {
    const res = await post('/settlement/intents', { account: ACCOUNT, protocol: 'cash', amount: '1' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /protocol/);
  });

  it('accepts a telemetry ping and rejects an unknown kind', async () => {
    assert.equal((await post('/telemetry', { kind: 'conformance.run' })).status, 202);

    const { counters } = await (await fetch(`${base}/telemetry`)).json();
    assert.equal(counters['conformance.run'], 1);

    const bad = await post('/telemetry', { kind: 'made.up' });
    assert.equal(bad.status, 400);
  });

  it('narrows the ledger by account', async () => {
    await post('/settlement/intents', { account: OTHER, protocol: 'mpp', amount: '2' });
    const { entries } = await (await fetch(`${base}/settlement/ledger?account=${OTHER}`)).json();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].account, OTHER);
  });

  it('404s an unknown route', async () => {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });
});

describe('@keelcodes/api auth', () => {
  let server;
  let base;

  before(async () => {
    ({ server, base } = await listen(createHandler({ store: createStore(), token: 's3cret' })));
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  it('keeps reads open but guards writes', async () => {
    assert.equal((await fetch(`${base}/sessions`)).status, 200);

    const denied = await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: ACCOUNT, sessionId: SESSION, moduleVersion: '1' }),
    });
    assert.equal(denied.status, 401);

    const allowed = await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-keel-token': 's3cret' },
      body: JSON.stringify({ account: ACCOUNT, sessionId: SESSION, moduleVersion: '1' }),
    });
    assert.equal(allowed.status, 201);
  });
});
