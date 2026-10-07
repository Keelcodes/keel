import { SettlementError, type Caip2, type PaymentIntent } from './types.js';

/**
 * Protocol-agnostic rail selection for fiat / stablecoin orchestration.
 *
 * A {@link PaymentIntent} says *what* the payer wants to move; a
 * {@link PaymentRail} says *how* it could move. This module is the glue between
 * the two: it filters a catalogue of rails down to the ones that can honour an
 * intent under a set of constraints, then picks one deterministically.
 *
 * Four rail kinds are modelled, none of which require a protocol codec here:
 *
 * - `x402` / `mpp` — HTTP payment handshakes whose codecs live in their own
 *   modules; routing only needs to know the rail can settle the terms.
 * - `chain` — a direct on-chain stablecoin transfer.
 * - `fiat` — a hosted checkout. The rail carries an **opaque** `checkout`
 *   handle; Keel never inspects it, and the hosted-checkout specifics (session
 *   creation, redirect, capture) are entirely host-side. No PSP is integrated
 *   and no dependency is added.
 *
 * Selection is pure and deterministic: same inputs, same rail. Ties are broken
 * by cost, then priority hint, then a fixed kind order, then rail id.
 */

/** The kinds of rail this layer can route across. */
export type RailKind = 'x402' | 'mpp' | 'chain' | 'fiat';

/** The stable order used as the final, documented kind tie-break. */
export const RAIL_KIND_ORDER: readonly RailKind[] = ['x402', 'mpp', 'chain', 'fiat'];

/** An asset a rail can settle, in its own denomination. */
export interface RailAsset {
  /**
   * Canonical reference: a token contract address (or `native`) for on-chain
   * rails, an ISO-4217 code (e.g. `usd`) for fiat rails.
   */
  address: string;
  /** Display ticker, e.g. `USDC` or `USD`. */
  symbol: string;
  /** Minor units per whole unit: 6 for USDC, 2 for USD. */
  decimals: number;
  /** Networks this asset is accepted on; defaults to the rail's `networks`. */
  networks?: readonly Caip2[];
}

/** A way an intent could be settled. Descriptors are data — no live client. */
export interface PaymentRail {
  kind: RailKind;
  /** Stable identifier, unique within a catalogue. */
  id: string;
  /** CAIP-2 networks this rail can settle on. */
  networks: readonly Caip2[];
  /** Assets this rail accepts. */
  assets: readonly RailAsset[];
  /** Opaque destination/payTo (a chain address, a merchant id, …). */
  payTo: string;
  /**
   * Opaque hosted-checkout handle. Required for `fiat` rails and ignored for
   * every other kind; its meaning is owned by the host's checkout integration.
   */
  checkout?: string;
  /** Extra fee the rail charges, in atomic units of the settled asset. */
  cost?: bigint;
  /** Tie-break hint after cost; lower wins. */
  priority?: number;
}

/** Constraints a payer applies on top of the intent. */
export interface RailConstraints {
  /** Only these rail kinds are acceptable. */
  kinds?: readonly RailKind[];
  /**
   * Only these networks are acceptable. The intent's own `network` must be one
   * of them, since a plan settles on the intent's network.
   */
  networks?: readonly Caip2[];
  /** Only these assets (address or symbol, case-insensitive) are acceptable. */
  assets?: readonly string[];
  /** Cap on `amount + cost`, in atomic units. */
  maxAmount?: bigint;
}

/** The concrete terms of a selected rail: what the host would actually pay. */
export interface RoutePlan {
  railId: string;
  kind: RailKind;
  network: Caip2;
  asset: RailAsset;
  /** Payment amount in atomic units. */
  amount: bigint;
  /** `amount` rendered against `asset.decimals`. */
  amountDecimal: string;
  /** Rail fee in atomic units. */
  cost: bigint;
  /** `amount + cost`. */
  total: bigint;
  payTo: string;
  /** Present only for `fiat` rails; opaque, host-defined. */
  checkoutHandle?: string;
}

export interface RailSelection {
  rail: PaymentRail;
  plan: RoutePlan;
}

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new SettlementError(
      'malformed-payload',
      `decimals must be a non-negative integer, got ${decimals}`,
    );
  }
}

const DECIMAL = /^\d+(\.\d+)?$/;

/**
 * Parses a human decimal amount into atomic units for `decimals` places, e.g.
 * `parseUnits('0.01', 6) === 10000n`.
 *
 * Hand-rolled on purpose rather than delegated to `viem`'s `parseUnits`. viem
 * rounds when the input carries more fractional digits than the asset supports
 * (`1.234` at 2dp yields `123n`), and its parsing rules have changed between
 * releases — inheriting either is a poor foundation for settlement arithmetic.
 * More fractional digits than the asset supports is an error here, not a silent
 * truncation: rounding someone's money is a bug, not a convenience.
 *
 * `rails.units.viem.test.ts` pins both the agreement on the accepted domain and
 * this intentional divergence, so neither can drift unnoticed.
 */
export function parseUnits(value: string, decimals: number): bigint {
  assertDecimals(decimals);
  if (typeof value !== 'string' || !DECIMAL.test(value)) {
    throw new SettlementError('malformed-payload', `${JSON.stringify(value)} is not a decimal amount`);
  }
  const [whole = '0', fraction = ''] = value.split('.');
  if (fraction.length > decimals) {
    throw new SettlementError(
      'malformed-payload',
      `${value} has more than ${decimals} decimal places`,
    );
  }
  return BigInt(whole + fraction.padEnd(decimals, '0'));
}

/**
 * Renders atomic units as a human decimal amount, trimming trailing zeros so
 * that `parseUnits(formatUnits(n, d), d) === n` round-trips exactly.
 */
export function formatUnits(value: bigint, decimals: number): string {
  assertDecimals(decimals);
  if (decimals === 0) return value.toString();
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  const rendered = fraction === '' ? whole : `${whole}.${fraction}`;
  return negative ? `-${rendered}` : rendered;
}

function matchesAsset(asset: RailAsset, ref: string): boolean {
  return (
    asset.address.toLowerCase() === ref.toLowerCase() ||
    asset.symbol.toLowerCase() === ref.toLowerCase()
  );
}

function findAsset(rail: PaymentRail, network: Caip2, ref: string): RailAsset | undefined {
  return rail.assets.find(
    (candidate) =>
      (candidate.networks ?? rail.networks).includes(network) && matchesAsset(candidate, ref),
  );
}

/**
 * Resolves the asset descriptor for `assetRef` on `network`, proving the rail
 * accepts it there. Throws a `requirement-mismatch` rather than routing a
 * payment the rail cannot actually settle.
 */
export function resolveRailAsset(rail: PaymentRail, network: Caip2, assetRef: string): RailAsset {
  const asset = findAsset(rail, network, assetRef);
  if (asset === undefined) {
    throw new SettlementError(
      'requirement-mismatch',
      `rail ${rail.id} does not accept ${JSON.stringify(assetRef)} on ${network}`,
    );
  }
  return asset;
}

function isEligible(rail: PaymentRail, intent: PaymentIntent, constraints: RailConstraints): boolean {
  if (constraints.kinds !== undefined && !constraints.kinds.includes(rail.kind)) return false;
  // The plan settles on the intent's network, so it must be an allowed one.
  if (constraints.networks !== undefined && !constraints.networks.includes(intent.network)) return false;
  if (!rail.networks.includes(intent.network)) return false;

  const asset = findAsset(rail, intent.network, intent.asset);
  if (asset === undefined) return false;
  if (
    constraints.assets !== undefined &&
    !constraints.assets.some((ref) => matchesAsset(asset, ref))
  ) {
    return false;
  }

  if (rail.kind === 'fiat' && (rail.checkout === undefined || rail.checkout === '')) return false;
  if (constraints.maxAmount !== undefined && intent.amount + (rail.cost ?? 0n) > constraints.maxAmount) {
    return false;
  }
  return true;
}

/**
 * Total order used for the deterministic pick: cheapest `cost`, then lowest
 * `priority`, then {@link RAIL_KIND_ORDER}, then lexicographic `id`.
 */
function compareRails(a: PaymentRail, b: PaymentRail): number {
  const costA = a.cost ?? 0n;
  const costB = b.cost ?? 0n;
  if (costA !== costB) return costA < costB ? -1 : 1;

  const priorityA = a.priority ?? 0;
  const priorityB = b.priority ?? 0;
  if (priorityA !== priorityB) return priorityA - priorityB;

  const kindA = RAIL_KIND_ORDER.indexOf(a.kind);
  const kindB = RAIL_KIND_ORDER.indexOf(b.kind);
  if (kindA !== kindB) return kindA - kindB;

  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function describeConstraints(constraints: RailConstraints): string {
  return JSON.stringify(constraints, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

/**
 * Picks the cheapest eligible rail for an intent and materialises the plan.
 *
 * Throws `no-acceptable-requirement` when nothing can satisfy the intent and
 * constraints — never returns a "best effort" pick, because silently routing a
 * payment on terms the payer did not accept is how an agent overpays.
 */
export function selectRail(
  rails: readonly PaymentRail[],
  intent: PaymentIntent,
  constraints: RailConstraints = {},
): RailSelection {
  const eligible = rails.filter((rail) => isEligible(rail, intent, constraints));
  if (eligible.length === 0) {
    throw new SettlementError(
      'no-acceptable-requirement',
      `no rail can settle intent ${intent.id} (${intent.amount.toString()} ${intent.asset} on ${intent.network}) under ${describeConstraints(constraints)}`,
    );
  }

  const rail = eligible.reduce((best, candidate) =>
    compareRails(candidate, best) < 0 ? candidate : best,
  );
  const asset = resolveRailAsset(rail, intent.network, intent.asset);
  const cost = rail.cost ?? 0n;

  const plan: RoutePlan = {
    railId: rail.id,
    kind: rail.kind,
    network: intent.network,
    asset,
    amount: intent.amount,
    amountDecimal: formatUnits(intent.amount, asset.decimals),
    cost,
    total: intent.amount + cost,
    payTo: rail.payTo,
  };
  if (rail.checkout !== undefined) plan.checkoutHandle = rail.checkout;

  return { rail, plan };
}
