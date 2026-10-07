/**
 * The console's optional backend client ([`@keelcodes/api`](../../api)).
 *
 * Two things the chain cannot answer come from here: the settlement ledger, and
 * the module version a session belongs to. When `VITE_API_URL` is unset the
 * console stays chain-only — the settlement panel keeps its "not deployed" empty
 * state rather than inventing rows.
 */

/** The backend base URL, or `undefined` when the console runs chain-only. */
export const API_URL: string | undefined = (() => {
  const raw = import.meta.env.VITE_API_URL;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim().replace(/\/$/, '') : undefined;
})();

/** One settlement intent as the ledger stores it. */
export interface LedgerEntry {
  id: string;
  account: string;
  protocol: string;
  amount: string;
  asset: string | null;
  status: string;
  reference: string | null;
  createdAt: string;
}

/** Reads the settlement ledger for one account. Empty when no backend is set. */
export async function loadLedger(account: string, signal?: AbortSignal): Promise<LedgerEntry[]> {
  if (API_URL === undefined) return [];
  const res = await fetch(`${API_URL}/settlement/ledger?account=${account}`, { signal });
  if (!res.ok) throw new Error(`ledger request failed: HTTP ${res.status}`);
  const body = (await res.json()) as { entries?: LedgerEntry[] };
  return body.entries ?? [];
}
