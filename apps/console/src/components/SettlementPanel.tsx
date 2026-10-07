import { useQuery } from '@tanstack/react-query';
import { useAccount } from 'wagmi';
import { API_URL, loadLedger, type LedgerEntry } from '../api.js';
import { shortAddress } from '../chains.js';
import { ExternalIcon } from './icons.js';

const NPM = 'https://www.npmjs.com/package/@keelcodes/self-host';
const GITHUB = 'https://github.com/Keelcodes/keel/tree/main/packages/self-host';

function LedgerTable({ entries }: { entries: LedgerEntry[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Intent</th>
          <th>Protocol</th>
          <th>Amount</th>
          <th>Status</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => (
          <tr key={entry.id}>
            <td>
              <code>{shortAddress(entry.account as `0x${string}`, 4)}</code> · <code>{entry.id}</code>
            </td>
            <td>
              <code>{entry.protocol}</code>
            </td>
            <td>
              {entry.amount}
              {entry.asset === null ? '' : ` ${entry.asset}`}
            </td>
            <td>
              <span className={`badge ${entry.status}`}>{entry.status}</span>
            </td>
            <td className="nowrap">{entry.createdAt.slice(0, 10)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Settlement intents for the connected account, read from the self-hosted
 * backend ([`@keelcodes/api`](../../api)). Without `VITE_API_URL` there is no
 * ledger to read, so the panel reports that honestly instead of rendering
 * sample rows; the protocols Keel models are listed so the empty state still
 * explains what will appear once the service is wired in.
 */
export function SettlementPanel() {
  const { address, isConnected } = useAccount();

  const configured = API_URL !== undefined;
  const ready = configured && isConnected && address !== undefined;

  const { data, isPending, isFetching, error, refetch } = useQuery({
    queryKey: ['ledger', address],
    enabled: ready,
    staleTime: 15_000,
    refetchInterval: 30_000,
    queryFn: () => loadLedger(address as string),
  });

  return (
    <section className="panel">
      <div className="panel__head">
        <h2>Settlement</h2>
        {ready && data !== undefined && data.length > 0 ? (
          <button className="btn btn--ghost btn--sm" onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
        ) : (
          <span className={`badge ${configured ? 'active' : 'pending'}`}>
            {configured ? 'live' : 'not deployed'}
          </span>
        )}
      </div>

      {!configured ? (
        <>
          <p className="muted">
            Keel&rsquo;s settlement service is self-hosted and is not running on this deployment, so there
            are no ledger rows to show. Nothing here is seeded or simulated.
          </p>

          <ul className="protocol-list">
            <li>
              <code>x402</code>
              <span>HTTP payments: a resource answers 402 with requirements, the payer signs, a receipt settles it.</span>
            </li>
            <li>
              <code>MPP</code>
              <span>Machine payments protocol: challenges and credentials carry the intent to settlement.</span>
            </li>
            <li>
              <code>ERC-8183</code>
              <span>Escrow jobs: funds are released on a job outcome and folded into a receipt.</span>
            </li>
          </ul>

          <p className="muted">
            Run it yourself from <code>@keelcodes/self-host</code> — the model, endpoints and readiness probes
            for a local anvil + bundler + paymaster sandbox, plus the console backend.
          </p>
          <div className="row">
            <a className="btn btn--ghost btn--sm" href={NPM} target="_blank" rel="noreferrer">
              npm package <ExternalIcon />
            </a>
            <a className="btn btn--ghost btn--sm" href={GITHUB} target="_blank" rel="noreferrer">
              Source <ExternalIcon />
            </a>
          </div>
        </>
      ) : (
        <>
          <p className="muted">Settlement intents recorded by the self-hosted ledger for the connected account.</p>

          {!isConnected ? <p className="empty">Connect a wallet to read its settlement ledger.</p> : null}
          {isPending && ready ? <p className="muted">Reading the ledger…</p> : null}
          {error ? <p className="error">{error.message}</p> : null}

          {data !== undefined && data.length === 0 ? (
            <p className="empty">No settlement intents recorded for this account yet.</p>
          ) : null}

          {data !== undefined && data.length > 0 ? <LedgerTable entries={data} /> : null}
        </>
      )}
    </section>
  );
}
