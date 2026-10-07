import { SettlementError, type Caip2, type SettlementReceipt } from './types.js';

/**
 * ERC-8183 (https://eips.ethereum.org/EIPS/eip-8183) — Agentic Commerce: a job
 * with an escrowed budget and a single evaluator who attests completion.
 *
 * State machine: `Open → Funded → Submitted → Completed | Rejected | Expired`,
 * with a dispute detour: `Funded | Submitted → Disputed → Completed | Rejected`.
 * This module models the lifecycle the spec fixes — the legal transitions and
 * *who* may trigger each one — as a pure reducer, so an orchestrator can
 * validate an action (or fold on-chain events) without a chain client.
 *
 * Disputes compose with that machine rather than bypass it: only a party may
 * raise one, only the arbiter may resolve it, and the resolution is an explicit
 * `release` (→ `Completed`) or `refund` (→ `Rejected`). A job in `Disputed` has
 * no path to `complete`/`reject`/`claimRefund`, so arbitration cannot be skipped.
 *
 * The spec's `hook` and `optParams` are deliberately absent: hooks are an
 * optional extension whose callbacks are a chain concern, not core state.
 */

export type EscrowJobStatus =
  | 'Open'
  | 'Funded'
  | 'Submitted'
  | 'Disputed'
  | 'Completed'
  | 'Rejected'
  | 'Expired';

export type EscrowJobAction =
  | 'setProvider'
  | 'setBudget'
  | 'fund'
  | 'submit'
  | 'complete'
  | 'reject'
  | 'raiseDispute'
  | 'resolveDispute'
  | 'claimRefund';

export type EscrowRole = 'client' | 'provider' | 'evaluator' | 'arbiter';

/** How arbitration settles a disputed escrow. */
export type EscrowResolution = 'release' | 'refund';

/** `provider` is unset until `setProvider`; the spec uses `address(0)`. */
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface EscrowJob {
  id: string;
  client: string;
  provider: string;
  evaluator: string;
  /** Third party who resolves disputes; unset until configured. */
  arbiter?: string;
  description: string;
  /** Atomic units of the escrowed ERC-20. */
  budget: bigint;
  /** Unix seconds; anyone may refund once `now >= expiredAt`. */
  expiredAt: number;
  status: EscrowJobStatus;
  hook?: string;
  /** `submit` payload — a hash/CID/commitment to the delivered work. */
  deliverable?: string;
  /** Attestation reason carried by `complete` / `reject` / `resolveDispute`. */
  reason?: string;
  /** Why a party raised the dispute; set by `raiseDispute`. */
  disputeReason?: string;
  /** How arbitration settled the job; set by `resolveDispute`. */
  resolution?: EscrowResolution;
}

const TRANSITIONS: Readonly<Record<EscrowJobStatus, readonly EscrowJobAction[]>> = {
  Open: ['setProvider', 'setBudget', 'fund', 'reject'],
  Funded: ['submit', 'reject', 'raiseDispute', 'claimRefund'],
  Submitted: ['complete', 'reject', 'raiseDispute', 'claimRefund'],
  Disputed: ['resolveDispute'],
  Completed: [],
  Rejected: [],
  Expired: [],
};

const TERMINAL: readonly EscrowJobStatus[] = ['Completed', 'Rejected', 'Expired'];

export function isTerminalJobStatus(status: EscrowJobStatus): boolean {
  return TERMINAL.includes(status);
}

export function isProviderSet(job: EscrowJob): boolean {
  const provider = job.provider.toLowerCase();
  return provider !== '' && provider !== ZERO_ADDRESS;
}

export function isArbiterSet(job: EscrowJob): boolean {
  const arbiter = (job.arbiter ?? '').toLowerCase();
  return arbiter !== '' && arbiter !== ZERO_ADDRESS;
}

/**
 * Who may trigger an action given the job's current status. `reject` moves
 * between roles: the client rejects while `Open`, the evaluator afterwards.
 *
 * A dispute may be raised by any party to the job (client, provider or
 * evaluator) but resolved only by the arbiter — that separation is what makes
 * arbitration meaningful rather than a party ruling on its own case.
 */
export function allowedActors(job: EscrowJob, action: EscrowJobAction): readonly EscrowRole[] | 'anyone' {
  switch (action) {
    case 'setProvider':
      return ['client'];
    case 'setBudget':
      return ['client', 'provider'];
    case 'fund':
      return ['client'];
    case 'submit':
      return ['provider'];
    case 'complete':
      return ['evaluator'];
    case 'reject':
      return job.status === 'Open' ? ['client'] : ['evaluator'];
    case 'raiseDispute':
      return ['client', 'provider', 'evaluator'];
    case 'resolveDispute':
      return ['arbiter'];
    case 'claimRefund':
      return 'anyone';
  }
}

function addressOf(job: EscrowJob, role: EscrowRole): string {
  if (role === 'client') return job.client;
  if (role === 'provider') return job.provider;
  if (role === 'arbiter') return job.arbiter ?? '';
  return job.evaluator;
}

function actorAllowed(job: EscrowJob, action: EscrowJobAction, actor: string): boolean {
  const actors = allowedActors(job, action);
  if (actors === 'anyone') return true;
  const address = actor.toLowerCase();
  return actors.some((role) => addressOf(job, role).toLowerCase() === address);
}

export function canApplyJobAction(job: EscrowJob, action: EscrowJobAction, actor: string): boolean {
  return TRANSITIONS[job.status].includes(action) && actorAllowed(job, action, actor);
}

export interface EscrowActionInput {
  actor: string;
  /** Unix seconds; required for `claimRefund`, which is time-gated. */
  now?: number;
  /** `setProvider`. */
  provider?: string;
  /** `setBudget` — atomic units. */
  amount?: bigint;
  /** `fund` — the budget the client is willing to escrow (front-run guard). */
  expectedBudget?: bigint;
  /** `submit`. */
  deliverable?: string;
  /** `complete` / `reject` / `raiseDispute` / `resolveDispute`. */
  reason?: string;
  /** `resolveDispute` — release the escrow to the provider, or refund the client. */
  outcome?: EscrowResolution;
}

function requireAddress(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new SettlementError('missing-field', `${field} must be a non-empty address`);
  }
  return value;
}

/**
 * Applies one action, returning the next job state. Pure: the caller decides
 * whether the job is local state or a projection of on-chain events.
 */
export function applyJobAction(
  job: EscrowJob,
  action: EscrowJobAction,
  input: EscrowActionInput,
): EscrowJob {
  if (!TRANSITIONS[job.status].includes(action)) {
    throw new SettlementError('invalid-transition', `job ${job.id} is ${job.status}; cannot ${action}`);
  }
  if (!actorAllowed(job, action, input.actor)) {
    throw new SettlementError(
      'unauthorized-actor',
      `${action} is not allowed for ${input.actor} on job ${job.id} (${job.status})`,
    );
  }

  switch (action) {
    case 'setProvider': {
      if (isProviderSet(job)) {
        throw new SettlementError('precondition-failed', `job ${job.id} already has a provider`);
      }
      return { ...job, provider: requireAddress(input.provider, 'provider') };
    }
    case 'setBudget': {
      if (input.amount === undefined || input.amount <= 0n) {
        throw new SettlementError('precondition-failed', `job ${job.id} needs a positive budget`);
      }
      return { ...job, budget: input.amount };
    }
    case 'fund': {
      if (!isProviderSet(job)) {
        throw new SettlementError('precondition-failed', `job ${job.id} has no provider to fund`);
      }
      if (job.budget <= 0n) {
        throw new SettlementError('precondition-failed', `job ${job.id} has no budget to fund`);
      }
      if (input.expectedBudget === undefined || input.expectedBudget !== job.budget) {
        throw new SettlementError(
          'precondition-failed',
          `fund expectedBudget does not match job ${job.id} budget ${job.budget.toString()}`,
        );
      }
      return { ...job, status: 'Funded' };
    }
    case 'submit': {
      const deliverable = input.deliverable;
      if (typeof deliverable !== 'string' || deliverable === '') {
        throw new SettlementError('missing-field', `submit needs a deliverable`);
      }
      return { ...job, status: 'Submitted', deliverable };
    }
    case 'complete':
      return input.reason === undefined
        ? { ...job, status: 'Completed' }
        : { ...job, status: 'Completed', reason: input.reason };
    case 'reject':
      return input.reason === undefined
        ? { ...job, status: 'Rejected' }
        : { ...job, status: 'Rejected', reason: input.reason };
    case 'raiseDispute': {
      // Nothing to arbitrate unless someone is empowered to resolve it.
      if (!isArbiterSet(job)) {
        throw new SettlementError('precondition-failed', `job ${job.id} has no arbiter to resolve a dispute`);
      }
      if (typeof input.reason !== 'string' || input.reason === '') {
        throw new SettlementError('missing-field', 'raiseDispute needs a reason');
      }
      return { ...job, status: 'Disputed', disputeReason: input.reason };
    }
    case 'resolveDispute': {
      const outcome = input.outcome;
      if (outcome !== 'release' && outcome !== 'refund') {
        throw new SettlementError('missing-field', 'resolveDispute needs an outcome of release or refund');
      }
      const resolved: EscrowJob = {
        ...job,
        status: outcome === 'release' ? 'Completed' : 'Rejected',
        resolution: outcome,
      };
      return input.reason === undefined ? resolved : { ...resolved, reason: input.reason };
    }
    case 'claimRefund': {
      if (input.now === undefined || input.now < job.expiredAt) {
        throw new SettlementError('precondition-failed', `job ${job.id} has not expired`);
      }
      return { ...job, status: 'Expired' };
    }
  }
}

/**
 * How escrow moves on a terminal status: released to the provider on
 * `Completed`, refunded to the client on `Rejected` / `Expired`.
 *
 * A dispute resolved to `release` lands on `Completed` and one resolved to
 * `refund` lands on `Rejected`, so the outcome of arbitration is read here just
 * like any other settlement. `Disputed` itself moves nothing — it is not
 * terminal.
 */
export function escrowOutcome(status: EscrowJobStatus): 'release' | 'refund' | 'none' {
  if (status === 'Completed') return 'release';
  if (status === 'Rejected' || status === 'Expired') return 'refund';
  return 'none';
}

export interface EscrowReceiptArgs {
  network: Caip2;
  asset: string;
  /** ISO-8601 timestamp of settlement. */
  settledAt: string;
  transaction?: string;
}

/**
 * Receipt for a completed job — the escrow released to the provider. A dispute
 * resolved to `release` yields the same receipt; its `proof.resolution` records
 * that the release came via arbitration rather than the evaluator's attestation.
 */
export function receiptFromEscrow(job: EscrowJob, args: EscrowReceiptArgs): SettlementReceipt {
  if (job.status !== 'Completed') {
    throw new SettlementError(
      'unsuccessful-settlement',
      `job ${job.id} is ${job.status}, not Completed`,
    );
  }

  return {
    id: args.transaction ?? `${job.id}@${args.settledAt}`,
    protocol: 'erc8183',
    network: args.network,
    asset: args.asset,
    amount: job.budget,
    payer: job.client,
    payee: job.provider,
    transaction: args.transaction,
    settledAt: args.settledAt,
    intentId: job.id,
    proof: {
      jobId: job.id,
      deliverable: job.deliverable,
      reason: job.reason,
      resolution: job.resolution,
      disputeReason: job.disputeReason,
    },
  };
}
