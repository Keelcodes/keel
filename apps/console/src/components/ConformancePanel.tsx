import { useQuery } from '@tanstack/react-query';
import { useAccount, usePublicClient } from 'wagmi';
import { chainName, explorerAddressUrl, shortAddress } from '../chains.js';
import { conformanceTargetFromEnv, loadConformance, type ConformanceClient } from '../data.js';

/**
 * Runs the ERC-7579 suite against the connected account on the active chain. The
 * subject defaults to the deployed `KeelPolicyHook` (module type 4), so the panel
 * works with no configuration.
 */
export function ConformancePanel() {
  const { address, chainId, isConnected } = useAccount();
  const client = usePublicClient();
  const target = conformanceTargetFromEnv();

  const ready = isConnected && address !== undefined && client !== undefined;

  const { data, isPending, error } = useQuery({
    queryKey: ['conformance', chainId, address, target.module, target.moduleTypeId.toString()],
    enabled: ready,
    queryFn: async () => {
      if (address === undefined || client === undefined) {
        throw new Error('connect a wallet first');
      }
      return loadConformance({
        // wagmi resolves its own viem instance; the reader only needs the
        // standard PublicClient surface, so bridge the duplicate here.
        client: client as unknown as ConformanceClient,
        account: address,
        module: target.module,
        moduleTypeId: target.moduleTypeId,
      });
    },
  });

  return (
    <section className="panel">
      <h2>Conformance</h2>
      <p className="muted">
        ERC-7579 suite run live against the connected account and{' '}
        <a
          href={explorerAddressUrl(chainId ?? 0, target.module) ?? '#'}
          target="_blank"
          rel="noreferrer"
        >
          <code>{shortAddress(target.module, 6)}</code>
        </a>{' '}
        on {chainId === undefined ? 'the active chain' : chainName(chainId)}.
      </p>

      {!isConnected ? <p className="empty">Connect a wallet to run the suite against its account.</p> : null}
      {isPending && ready ? <p className="muted">Running the suite…</p> : null}
      {error ? <p className="error">{error.message}</p> : null}

      {data ? (
        <>
          <table>
            <thead>
              <tr>
                <th>Suite</th>
                <th>Subject</th>
                <th>Passed</th>
                <th>Failed</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{data.suite}</td>
                <td>
                  <code>{data.subject}</code>
                </td>
                <td>{data.passed}</td>
                <td>
                  {data.critical > 0 ? (
                    <span className="badge failed">
                      {data.failed} · {data.critical} critical
                    </span>
                  ) : (
                    <span className={data.failed > 0 ? 'badge pending' : 'badge active'}>{data.failed}</span>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
          <pre className="report">{data.report}</pre>
        </>
      ) : null}
    </section>
  );
}
