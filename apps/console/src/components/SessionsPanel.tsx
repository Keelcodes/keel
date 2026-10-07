import { useQuery } from '@tanstack/react-query';
import { useAccount, usePublicClient } from 'wagmi';
import { KEEL_POLICY_HOOK, chainName, explorerAddressUrl, shortAddress } from '../chains.js';
import { readSessions, type HookReader, type OnChainSession } from '../hook.js';

function formatWindow(value: bigint): string {
  if (value === 0n) return 'no bound';
  return new Date(Number(value) * 1000).toISOString().slice(0, 10);
}

function etaOf(session: OnChainSession): string {
  return `${formatWindow(session.validAfter)} → ${formatWindow(session.validUntil)}`;
}

/**
 * Sessions installed for the connected account, read straight off
 * `KeelPolicyHook` on the active chain. Status is derived from the validity
 * window at read time; a revoked session is uninstalled, so it never appears.
 */
export function SessionsPanel() {
  const { address, chainId, isConnected } = useAccount();
  const client = usePublicClient();

  const ready = isConnected && address !== undefined && client !== undefined;

  const { data, isPending, isFetching, error, refetch } = useQuery({
    queryKey: ['sessions', chainId, address],
    enabled: ready,
    staleTime: 15_000,
    refetchInterval: 30_000,
    queryFn: async () => {
      if (address === undefined || client === undefined) {
        throw new Error('connect a wallet first');
      }
      // wagmi resolves its own viem instance; the reader only needs the standard
      // readContract surface, so bridge the two at this seam.
      return readSessions(client as unknown as HookReader, address);
    },
  });

  return (
    <section className="panel">
      <div className="panel__head">
        <h2>Sessions</h2>
        {ready ? (
          <button className="btn btn--ghost btn--sm" onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
        ) : null}
      </div>
      <p className="muted">
        Installed on <code>KeelPolicyHook</code> for the connected account.{' '}
        {chainId === undefined ? null : `${chainName(chainId)} · `}
        <a href={explorerAddressUrl(chainId ?? 0, KEEL_POLICY_HOOK) ?? '#'} target="_blank" rel="noreferrer">
          {shortAddress(KEEL_POLICY_HOOK, 6)}
        </a>
      </p>

      {!isConnected ? <p className="empty">Connect a wallet to read the sessions it owns.</p> : null}
      {isPending && ready ? <p className="muted">Reading sessions…</p> : null}
      {error ? <p className="error">{error.message}</p> : null}

      {data !== undefined && data.length === 0 ? (
        <p className="empty">
          No sessions installed for this account on {chainId === undefined ? 'this chain' : chainName(chainId)}.
        </p>
      ) : null}

      {data !== undefined && data.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Session</th>
              <th>Status</th>
              <th>Valid</th>
              <th>Rules</th>
              <th>Targets</th>
              <th>Commitment</th>
            </tr>
          </thead>
          <tbody>
            {data.map((session) => (
              <tr key={session.id}>
                <td>
                  <code>{shortAddress(session.id, 6)}</code>
                </td>
                <td>
                  <span className={`badge ${session.status}`}>{session.status}</span>
                </td>
                <td className="nowrap">{etaOf(session)}</td>
                <td>{session.ruleCount}</td>
                <td>
                  {session.targets.length === 0
                    ? '—'
                    : session.targets.map((target) => (
                        <code key={target} className="target">
                          {shortAddress(target, 4)}
                        </code>
                      ))}
                </td>
                <td>
                  <code>{shortAddress(session.commitment, 6)}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
