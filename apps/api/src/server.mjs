/**
 * The console backend — a tiny HTTP/JSON service the self-hosted console talks
 * to for the two things it cannot read from the chain: the session index (which
 * module version a session belongs to, §7.5) and the settlement ledger.
 *
 * Zero dependencies, so `node src/server.mjs` is the whole runtime. Writes are
 * guarded by `KEEL_API_TOKEN` when it is set; reads are open (the console is a
 * public page and everything it reads is already public on-chain or public
 * settlement data). CORS is limited to `KEEL_API_ORIGIN` when set.
 */

import { createServer as createHttpServer } from 'node:http';
import { createStore, PROTOCOLS, TELEMETRY_KINDS, isAddress } from './store.mjs';

const MAX_BODY = 1_000_000;

function send(res, status, body, origin) {
  const payload = JSON.stringify(body);
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  };
  if (origin) headers['access-control-allow-origin'] = origin;
  res.writeHead(status, headers);
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('payload too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('body must be valid JSON');
  }
}

/**
 * Builds the request handler. Exported separately from the listener so tests
 * can drive it without binding a port.
 */
export function createHandler({ store, token, origin = '*' }) {
  const readOnly = () => !token;
  const authorized = (req) => readOnly() || req.headers['x-keel-token'] === token;

  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const key = `${req.method} ${url.pathname}`;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type, x-keel-token',
      });
      return res.end();
    }

    try {
      if (key === 'GET /health') {
        return send(res, 200, { ok: true, service: '@keelcodes/api' }, origin);
      }

      if (key === 'GET /sessions') {
        return send(res, 200, { sessions: store.listSessions(url.searchParams.get('account')) }, origin);
      }

      if (key === 'GET /settlement/ledger') {
        return send(res, 200, { entries: store.listLedger(url.searchParams.get('account')) }, origin);
      }

      if (key === 'GET /telemetry') {
        return send(res, 200, { counters: store.counters() }, origin);
      }

      // Everything below mutates, so it needs the token when one is configured.
      if (!authorized(req)) {
        return send(res, 401, { error: 'unauthorized' }, origin);
      }

      if (key === 'POST /sessions') {
        return send(res, 201, { session: store.upsertSession(await readJson(req)) }, origin);
      }

      if (key === 'POST /settlement/intents') {
        return send(res, 201, { entry: store.addIntent(await readJson(req)) }, origin);
      }

      if (key === 'POST /telemetry') {
        const body = await readJson(req);
        if (!TELEMETRY_KINDS.includes(body?.kind)) {
          throw new Error(`kind must be one of ${TELEMETRY_KINDS.join(', ')}`);
        }
        return send(res, 202, { counters: store.increment(body.kind, body.by ?? 1) }, origin);
      }

      return send(res, 404, { error: `no route for ${key}` }, origin);
    } catch (error) {
      return send(res, 400, { error: error instanceof Error ? error.message : String(error) }, origin);
    }
  };
}

/** Wires the environment into a listening server. */
export function createServer(env = process.env) {
  const store = createStore({ file: env.KEEL_API_STORE });
  const handler = createHandler({
    store,
    token: env.KEEL_API_TOKEN,
    origin: env.KEEL_API_ORIGIN ?? '*',
  });
  return createHttpServer((req, res) => void handler(req, res));
}

// Re-exported so callers can validate without reaching into the store module.
export { PROTOCOLS, TELEMETRY_KINDS, isAddress };

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.KEEL_API_PORT ?? 8080);
  createServer().listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`@keelcodes/api listening on :${port}`);
  });
}
