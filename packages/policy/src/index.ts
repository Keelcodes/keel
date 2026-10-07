/**
 * @keelcodes/policy
 *
 * Account-agnostic authorization policy for agent accounts: a declarative DSL,
 * a canonical commitment hash and an off-chain pre-check / simulation layer.
 *
 * The package is carrier-neutral. Today it is used off-chain to dry-run calls
 * before signing; the same normalised policy and commitment are what the
 * on-chain ERC-7579 hook module (Keel's carrier for on-chain enforcement)
 * recomputes and enforces, so the two layers cannot disagree about what a
 * policy means.
 *
 * @packageDocumentation
 */

export {
  INSTALL_ABI_PARAMETERS,
  POLICY_ABI_PARAMETERS,
  encodeInstallData,
  encodePolicy,
  policyCommitment,
} from './commitment.js';
export {
  CAPABILITY_VERSION,
  EnvelopeStatus,
  ZERO_ASSET,
  ZERO_CURSOR,
  advanceCursor,
  applyStatus,
  approvalsSatisfied,
  assertConservation,
  attenuate,
  canDraw,
  canSetStatus,
  capabilityCommitment,
  contestExpired,
  cursorCommitment,
  defaultResolution,
  effectiveStatus,
  encodeCapability,
  encodeCursor,
  envelopeId,
  isTerminal,
  normalizeCapability,
  openContest,
  remaining,
  withinCap,
} from './bounded.js';
export { ERC20_SELECTOR, readErc20Amount } from './erc20.js';
export { ZERO_USAGE, evaluateCall, simulateCalls, toCall } from './evaluate.js';
export { EnvelopeError, PolicyError, SessionError } from './errors.js';
export { normalizePolicy } from './normalize.js';
export {
  InMemorySessionStore,
  createSessionId,
  isSessionActive,
  issueSession,
  listSessions,
  revokeSession,
  rotateSession,
  sessionStatus,
} from './session.js';

export type { Erc20Read } from './erc20.js';
export type {
  ApprovalInput,
  Capability,
  CapabilityInput,
  ContestWindow,
  Cursor,
  DrawContext,
  DrawDecision,
  DrawDenyReason,
  Envelope,
  EnvelopeRef,
  TrustTier,
} from './bounded.js';
export type { SimulationResult } from './evaluate.js';
export type {
  IssueSessionInput,
  Rotation,
  RotateSessionInput,
  Session,
  SessionStatus,
  SessionStore,
  SessionView,
} from './session.js';
export type {
  Address,
  Call,
  Decision,
  DenyReason,
  Hex,
  Policy,
  PolicyInput,
  PolicyRule,
  PolicyRuleInput,
  PolicyState,
  RuleUsage,
  TokenLimit,
  TokenLimitInput,
} from './types.js';
export { POLICY_VERSION } from './types.js';
