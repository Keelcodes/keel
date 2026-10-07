import { describe, expect, it } from 'vitest';
import {
  ZERO_ADDRESS,
  SettlementError,
  allowedActors,
  applyJobAction,
  canApplyJobAction,
  escrowOutcome,
  isArbiterSet,
  isProviderSet,
  isTerminalJobStatus,
  receiptFromEscrow,
  type EscrowJob,
} from './index.js';

const CLIENT = '0x1111111111111111111111111111111111111111';
const PROVIDER = '0x2222222222222222222222222222222222222222';
const EVALUATOR = '0x3333333333333333333333333333333333333333';
const STRANGER = '0x4444444444444444444444444444444444444444';
const ARBITER = '0x5555555555555555555555555555555555555555';

const EXPIRED_AT = 1_000;

function openJob(provider = PROVIDER): EscrowJob {
  return {
    id: 'job-1',
    client: CLIENT,
    provider,
    evaluator: EVALUATOR,
    description: 'summarise a dataset',
    budget: 0n,
    expiredAt: EXPIRED_AT,
    status: 'Open',
  };
}

/** Open -> setBudget -> fund -> submit -> complete. */
function completedJob(): EscrowJob {
  let job = openJob();
  job = applyJobAction(job, 'setBudget', { actor: CLIENT, amount: 5_000_000n });
  job = applyJobAction(job, 'fund', { actor: CLIENT, expectedBudget: 5_000_000n });
  job = applyJobAction(job, 'submit', { actor: PROVIDER, deliverable: '0xdeliverable' });
  return applyJobAction(job, 'complete', { actor: EVALUATOR, reason: '0xapproved' });
}

describe('provider setup', () => {
  it('lets the client set a provider on an open job', () => {
    const job = applyJobAction(openJob(ZERO_ADDRESS), 'setProvider', { actor: CLIENT, provider: PROVIDER });
    expect(job.provider).toBe(PROVIDER);
    expect(isProviderSet(job)).toBe(true);
  });

  it('refuses a second provider or a non-client caller', () => {
    expect(() => applyJobAction(openJob(), 'setProvider', { actor: CLIENT, provider: STRANGER })).toThrow(
      /already has a provider/,
    );
    expect(() =>
      applyJobAction(openJob(ZERO_ADDRESS), 'setProvider', { actor: PROVIDER, provider: PROVIDER }),
    ).toThrow(/not allowed for/);
  });
});

describe('budget and funding', () => {
  it('accepts a budget from client or provider, then escrows it', () => {
    let job = applyJobAction(openJob(), 'setBudget', { actor: PROVIDER, amount: 100n });
    job = applyJobAction(job, 'fund', { actor: CLIENT, expectedBudget: 100n });
    expect(job.status).toBe('Funded');
  });

  it('will not fund without a provider', () => {
    let job = applyJobAction(openJob(ZERO_ADDRESS), 'setBudget', { actor: CLIENT, amount: 100n });
    expect(() => applyJobAction(job, 'fund', { actor: CLIENT, expectedBudget: 100n })).toThrow(
      /no provider to fund/,
    );
  });

  it('guards against a budget front-run', () => {
    const job = applyJobAction(openJob(), 'setBudget', { actor: CLIENT, amount: 100n });
    expect(() => applyJobAction(job, 'fund', { actor: CLIENT, expectedBudget: 101n })).toThrow(
      /expectedBudget does not match/,
    );
  });

  it('needs a positive budget', () => {
    expect(() => applyJobAction(openJob(), 'setBudget', { actor: CLIENT, amount: 0n })).toThrow(
      /needs a positive budget/,
    );
  });
});

describe('submit and evaluate', () => {
  it('lets only the provider submit', () => {
    const funded = applyJobAction(
      applyJobAction(openJob(), 'setBudget', { actor: CLIENT, amount: 100n }),
      'fund',
      { actor: CLIENT, expectedBudget: 100n },
    );
    expect(() => applyJobAction(funded, 'submit', { actor: CLIENT, deliverable: '0xwork' })).toThrow(
      /not allowed for/,
    );
    const submitted = applyJobAction(funded, 'submit', { actor: PROVIDER, deliverable: '0xwork' });
    expect(submitted.status).toBe('Submitted');
    expect(submitted.deliverable).toBe('0xwork');
  });

  it('lets only the evaluator complete a submitted job', () => {
    let job = applyJobAction(openJob(), 'setBudget', { actor: CLIENT, amount: 100n });
    job = applyJobAction(job, 'fund', { actor: CLIENT, expectedBudget: 100n });
    job = applyJobAction(job, 'submit', { actor: PROVIDER, deliverable: '0xwork' });

    expect(() => applyJobAction(job, 'complete', { actor: CLIENT })).toThrow(/not allowed for/);
    expect(applyJobAction(job, 'complete', { actor: EVALUATOR }).status).toBe('Completed');
  });

  it('refuses to complete a job that is not submitted', () => {
    const open = openJob();
    expect(() => applyJobAction(open, 'complete', { actor: EVALUATOR })).toThrow(/is Open; cannot complete/);
  });
});

describe('rejection', () => {
  it('lets the client reject while open', () => {
    expect(allowedActors(openJob(), 'reject')).toEqual(['client']);
    expect(applyJobAction(openJob(), 'reject', { actor: CLIENT }).status).toBe('Rejected');
  });

  it('lets the evaluator reject once funded', () => {
    const funded = applyJobAction(
      applyJobAction(openJob(), 'setBudget', { actor: CLIENT, amount: 100n }),
      'fund',
      { actor: CLIENT, expectedBudget: 100n },
    );
    expect(allowedActors(funded, 'reject')).toEqual(['evaluator']);
    expect(applyJobAction(funded, 'reject', { actor: EVALUATOR, reason: '0xbad' }).status).toBe('Rejected');
    expect(() => applyJobAction(funded, 'reject', { actor: PROVIDER })).toThrow(/not allowed for/);
  });
});

describe('refund after expiry', () => {
  const funded = applyJobAction(
    applyJobAction(openJob(), 'setBudget', { actor: CLIENT, amount: 100n }),
    'fund',
    { actor: CLIENT, expectedBudget: 100n },
  );

  it('is open to anyone once the job has expired', () => {
    expect(allowedActors(funded, 'claimRefund')).toBe('anyone');
    const expired = applyJobAction(funded, 'claimRefund', { actor: STRANGER, now: EXPIRED_AT });
    expect(expired.status).toBe('Expired');
  });

  it('is rejected before expiry', () => {
    expect(() => applyJobAction(funded, 'claimRefund', { actor: CLIENT, now: EXPIRED_AT - 1 })).toThrow(
      /has not expired/,
    );
  });

  it('cannot be called on a terminal job', () => {
    expect(() => applyJobAction(completedJob(), 'claimRefund', { actor: STRANGER, now: EXPIRED_AT })).toThrow(
      /is Completed; cannot claimRefund/,
    );
  });
});

describe('terminal states and outcomes', () => {
  it('classifies terminal statuses', () => {
    expect(isTerminalJobStatus('Completed')).toBe(true);
    expect(isTerminalJobStatus('Expired')).toBe(true);
    expect(isTerminalJobStatus('Funded')).toBe(false);
  });

  it('releases on completion and refunds otherwise', () => {
    expect(escrowOutcome('Completed')).toBe('release');
    expect(escrowOutcome('Rejected')).toBe('refund');
    expect(escrowOutcome('Expired')).toBe('refund');
    expect(escrowOutcome('Submitted')).toBe('none');
  });

  it('blocks every action once terminal', () => {
    const completed = completedJob();
    expect(canApplyJobAction(completed, 'submit', PROVIDER)).toBe(false);
    expect(() => applyJobAction(completed, 'submit', { actor: PROVIDER, deliverable: '0xmore' })).toThrow(
      SettlementError,
    );
  });

  it('handles a client that is also the evaluator', () => {
    const dual: EscrowJob = { ...openJob(), evaluator: CLIENT };
    let job = applyJobAction(dual, 'setBudget', { actor: CLIENT, amount: 100n });
    job = applyJobAction(job, 'fund', { actor: CLIENT, expectedBudget: 100n });
    job = applyJobAction(job, 'submit', { actor: PROVIDER, deliverable: '0xwork' });
    expect(applyJobAction(job, 'complete', { actor: CLIENT }).status).toBe('Completed');
  });
});

describe('receiptFromEscrow', () => {
  it('attests a completed job as an ERC-8183 receipt', () => {
    const receipt = receiptFromEscrow(completedJob(), {
      network: 'eip155:56',
      asset: '0x55d398326f99059fF775485246999027B3197955',
      settledAt: '2026-01-01T00:10:00.000Z',
      transaction: '0xjobs',
    });
    expect(receipt.protocol).toBe('erc8183');
    expect(receipt.amount).toBe(5_000_000n);
    expect(receipt.payer).toBe(CLIENT);
    expect(receipt.payee).toBe(PROVIDER);
    expect(receipt.transaction).toBe('0xjobs');
    expect(receipt.proof).toMatchObject({ jobId: 'job-1', deliverable: '0xdeliverable' });
  });

  it('refuses to attest a job that has not completed', () => {
    expect(() =>
      receiptFromEscrow(openJob(), {
        network: 'eip155:56',
        asset: '0x55d398326f99059fF775485246999027B3197955',
        settledAt: '2026-01-01T00:10:00.000Z',
      }),
    ).toThrow(/is Open, not Completed/);
  });
});

/** A funded (or submitted) job with an arbiter configured. */
function arbiterJob(status: 'Funded' | 'Submitted' = 'Funded'): EscrowJob {
  let job: EscrowJob = { ...openJob(), arbiter: ARBITER };
  job = applyJobAction(job, 'setBudget', { actor: CLIENT, amount: 5_000_000n });
  job = applyJobAction(job, 'fund', { actor: CLIENT, expectedBudget: 5_000_000n });
  if (status === 'Submitted') {
    job = applyJobAction(job, 'submit', { actor: PROVIDER, deliverable: '0xwork' });
  }
  return job;
}

function disputedJob(status: 'Funded' | 'Submitted' = 'Funded'): EscrowJob {
  return applyJobAction(arbiterJob(status), 'raiseDispute', { actor: CLIENT, reason: '0xdispute' });
}

describe('arbiter role', () => {
  it('detects whether an arbiter is configured', () => {
    expect(isArbiterSet(openJob())).toBe(false);
    expect(isArbiterSet({ ...openJob(), arbiter: ZERO_ADDRESS })).toBe(false);
    expect(isArbiterSet({ ...openJob(), arbiter: ARBITER })).toBe(true);
  });
});

describe('raising a dispute', () => {
  it('lets a party raise a dispute and records the reason', () => {
    expect(allowedActors(arbiterJob(), 'raiseDispute')).toEqual(['client', 'provider', 'evaluator']);
    const disputed = applyJobAction(arbiterJob(), 'raiseDispute', {
      actor: PROVIDER,
      reason: '0xnotdelivered',
    });
    expect(disputed.status).toBe('Disputed');
    expect(disputed.disputeReason).toBe('0xnotdelivered');
    expect(isTerminalJobStatus('Disputed')).toBe(false);
  });

  it('refuses a stranger', () => {
    expect(() =>
      applyJobAction(arbiterJob(), 'raiseDispute', { actor: STRANGER, reason: '0xnope' }),
    ).toThrow(/not allowed for/);
  });

  it('needs an arbiter and a reason', () => {
    expect(() =>
      applyJobAction(openJob(), 'raiseDispute', { actor: CLIENT, reason: '0xnope' }),
    ).toThrow(/is Open; cannot raiseDispute/);
    const fundedNoArbiter = applyJobAction(
      applyJobAction(openJob(), 'setBudget', { actor: CLIENT, amount: 100n }),
      'fund',
      { actor: CLIENT, expectedBudget: 100n },
    );
    expect(() =>
      applyJobAction(fundedNoArbiter, 'raiseDispute', { actor: CLIENT, reason: '0xnope' }),
    ).toThrow(/no arbiter/);
    expect(() => applyJobAction(arbiterJob(), 'raiseDispute', { actor: CLIENT })).toThrow(
      /needs a reason/,
    );
  });

  it('may be raised from Funded or Submitted', () => {
    expect(disputedJob('Funded').status).toBe('Disputed');
    expect(disputedJob('Submitted').status).toBe('Disputed');
  });
});

describe('arbitration', () => {
  it('lets only the arbiter resolve', () => {
    const disputed = disputedJob();
    expect(allowedActors(disputed, 'resolveDispute')).toEqual(['arbiter']);
    expect(() =>
      applyJobAction(disputed, 'resolveDispute', { actor: EVALUATOR, outcome: 'release' }),
    ).toThrow(/not allowed for/);
    expect(() =>
      applyJobAction(disputed, 'resolveDispute', { actor: CLIENT, outcome: 'refund' }),
    ).toThrow(/not allowed for/);
    expect(
      applyJobAction(disputed, 'resolveDispute', { actor: ARBITER, outcome: 'refund' }).status,
    ).toBe('Rejected');
  });

  it('resolves to release (provider) or refund (client)', () => {
    const released = applyJobAction(disputedJob(), 'resolveDispute', {
      actor: ARBITER,
      outcome: 'release',
      reason: '0xworkok',
    });
    expect(released.status).toBe('Completed');
    expect(released.resolution).toBe('release');
    expect(released.reason).toBe('0xworkok');
    expect(escrowOutcome(released.status)).toBe('release');

    const refunded = applyJobAction(disputedJob('Submitted'), 'resolveDispute', {
      actor: ARBITER,
      outcome: 'refund',
    });
    expect(refunded.status).toBe('Rejected');
    expect(refunded.resolution).toBe('refund');
    expect(escrowOutcome(refunded.status)).toBe('refund');
  });

  it('rejects an illegal resolution and an undisputed job', () => {
    const disputed = disputedJob();
    expect(() => applyJobAction(disputed, 'resolveDispute', { actor: ARBITER })).toThrow(
      /needs an outcome/,
    );
    expect(() =>
      applyJobAction(arbiterJob(), 'resolveDispute', { actor: ARBITER, outcome: 'release' }),
    ).toThrow(/is Funded; cannot resolveDispute/);
  });

  it('cannot be bypassed by completing, rejecting or refunding a disputed job', () => {
    const disputed = disputedJob();
    expect(canApplyJobAction(disputed, 'complete', EVALUATOR)).toBe(false);
    expect(() => applyJobAction(disputed, 'complete', { actor: EVALUATOR })).toThrow(
      /is Disputed; cannot complete/,
    );
    expect(() => applyJobAction(disputed, 'reject', { actor: EVALUATOR })).toThrow(
      /is Disputed; cannot reject/,
    );
    expect(() =>
      applyJobAction(disputed, 'claimRefund', { actor: STRANGER, now: EXPIRED_AT }),
    ).toThrow(/is Disputed; cannot claimRefund/);
    expect(() =>
      applyJobAction(disputed, 'raiseDispute', { actor: CLIENT, reason: '0xagain' }),
    ).toThrow(/is Disputed; cannot raiseDispute/);
    expect(escrowOutcome(disputed.status)).toBe('none');
  });

  it('attests a dispute resolved to release, and refuses one resolved to refund', () => {
    const released = applyJobAction(disputedJob('Submitted'), 'resolveDispute', {
      actor: ARBITER,
      outcome: 'release',
      reason: '0xworkok',
    });
    const receipt = receiptFromEscrow(released, {
      network: 'eip155:56',
      asset: '0x55d398326f99059fF775485246999027B3197955',
      settledAt: '2026-01-01T00:10:00.000Z',
    });
    expect(receipt.amount).toBe(5_000_000n);
    expect(receipt.proof).toMatchObject({ resolution: 'release', disputeReason: '0xdispute' });

    const refunded = applyJobAction(disputedJob(), 'resolveDispute', {
      actor: ARBITER,
      outcome: 'refund',
    });
    expect(() =>
      receiptFromEscrow(refunded, {
        network: 'eip155:56',
        asset: '0x55d398326f99059fF775485246999027B3197955',
        settledAt: '2026-01-01T00:10:00.000Z',
      }),
    ).toThrow(/is Rejected, not Completed/);
  });
});
