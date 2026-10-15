import type { AggregateHealthState } from './status-page.js';

/**
 * Pure Slice 11 policy contract. No clock reads, I/O, persistence, queue operations,
 * incident writes, or changes to the Slice 10 executor are permitted in this module.
 *
 * All `acceptedAt` values MUST be server-authoritative acceptance timestamps. An
 * executionId identifies a distinct invocation of the HTTP engine, NOT a job
 * delivery, lease renewal, transport retry, or reissued lease of the same execution.
 * The persistence layer is responsible for enforcing both guarantees.
 */
export const MULTI_LOCATION_CONTRACT_VERSION = 1 as const;
export const MULTI_LOCATION_AGGREGATION_POLICY_VERSION = 1 as const;
export const MULTI_LOCATION_CONFIRMATION_POLICY_VERSION = 1 as const;
export const MULTI_LOCATION_ROUND_FINALIZATION_WINDOW_MS = 120_000 as const;
export const REGIONAL_TERMINAL_OUTCOMES = ['PASS', 'CONFIRMED_FAIL', 'UNKNOWN'] as const;

export type RegionalTerminalOutcome = (typeof REGIONAL_TERMINAL_OUTCOMES)[number];
export type ProbeObservationOutcome = 'PASS' | 'FAIL' | 'UNKNOWN';
export type ProbeAssertionOutcome = 'PASS' | 'FAIL' | 'NOT_EVALUATED';
export type ClassifiedProbeObservation = 'PASS' | 'FAIL' | 'UNKNOWN';

export interface ProbeObservationV1 {
  outcome: ProbeObservationOutcome;
  reason: string;
  assertionOutcome: ProbeAssertionOutcome;
}

export interface RegionalExecutionEvidenceV1 {
  /** Unique stable ID of a real HTTP engine execution (not the lease attempt ID). */
  executionId: string;
  agentId: string;
  /** Coordinator/database acceptance time; never trust the agent's checkedAt. */
  acceptedAt: string;
  observation: ProbeObservationV1;
}

export interface MultiLocationRoundSnapshotV1 {
  contractVersion: 1;
  roundId: string;
  organizationId: string;
  monitorId: string;
  configurationVersionId: string;
  trigger: 'MANUAL' | 'SCHEDULED';
  locations: readonly string[];
  aggregationPolicyVersion: 1;
  confirmationPolicyVersion: 1;
  createdAt: string;
  deadlineAt: string;
}

export type RegionalTerminalReason =
  | 'PRIMARY_PASS'
  | 'PRIMARY_UNKNOWN'
  | 'CONFIRMATION_PASS'
  | 'CONFIRMATION_UNKNOWN'
  | 'CONFIRMED_FAILURE'
  | 'ROUND_DEADLINE';

export type RegionalEvaluationV1 =
  | {
      phase: 'AWAITING_PRIMARY';
      locationId: string;
      primary: null;
      confirmation: null;
    }
  | {
      phase: 'AWAITING_CONFIRMATION';
      locationId: string;
      primary: RegionalExecutionEvidenceV1;
      confirmation: null;
    }
  | {
      phase: 'TERMINAL';
      locationId: string;
      outcome: RegionalTerminalOutcome;
      terminalReason: RegionalTerminalReason;
      primary: RegionalExecutionEvidenceV1 | null;
      confirmation: RegionalExecutionEvidenceV1 | null;
    };

export type RegionalReductionDecisionV1 =
  | { disposition: 'ACCEPTED'; state: RegionalEvaluationV1 }
  | { disposition: 'DUPLICATE'; state: RegionalEvaluationV1 }
  | {
      disposition: 'REJECTED';
      reason:
        | 'CONFLICTING_REPLAY'
        | 'ROUND_COMPLETED'
        | 'DEADLINE_EXCEEDED'
        | 'REGION_TERMINAL'
        | 'NON_MONOTONIC_ACCEPTANCE'
        | 'BEFORE_ROUND_CREATION';
      state: RegionalEvaluationV1;
    };

export interface RegionalReductionInputV1 {
  state: RegionalEvaluationV1;
  execution: RegionalExecutionEvidenceV1;
  createdAt: string;
  deadlineAt: string;
  /** Authoritative persisted logical-round completion, not regional completion. */
  roundCompleted: boolean;
}

export interface AggregateRoundDecisionV1 {
  contractVersion: 1;
  roundId: string;
  configurationVersionId: string;
  aggregationPolicyVersion: 1;
  confirmationPolicyVersion: 1;
  outcome: AggregateHealthState;
  quorum: number;
  counts: Readonly<{
    selected: number;
    pass: number;
    confirmedFail: number;
    unknown: number;
    conclusive: number;
  }>;
  /** Rational counts avoid storing rounding-dependent percentages. */
  coverage: Readonly<{ numerator: number; denominator: number }>;
  reachability: Readonly<{ numerator: number; denominator: number }> | null;
  /** Includes the immutable evidence, ordered like the captured location snapshot. */
  regions: readonly Extract<RegionalEvaluationV1, { phase: 'TERMINAL' }>[];
}

export type RoundFinalizationDecisionV1 =
  | { state: 'ALREADY_FINALIZED' }
  | { state: 'WAIT'; pendingLocationIds: readonly string[] }
  | {
      state: 'FINALIZE';
      cause: 'ALL_REGIONS_TERMINAL' | 'DEADLINE_REACHED';
      finalizedAt: string;
      aggregate: AggregateRoundDecisionV1;
    };

export interface ConfirmationAgentV1 {
  agentId: string;
  locationId: string;
  /** Derived from the established location-scoped agent health policy. */
  healthy: boolean;
}

export type IncidentDirectiveV1 =
  | { type: 'DEFER_TO_SINGLE_LOCATION_POLICY' }
  | { type: 'NONE'; healthyRecoveryStreak: 0 }
  | { type: 'OPEN'; severity: 'DEGRADED' | 'DOWN'; healthyRecoveryStreak: 0 }
  | { type: 'ESCALATE'; severity: 'DOWN'; healthyRecoveryStreak: 0 }
  | { type: 'DEESCALATE'; severity: 'DEGRADED'; healthyRecoveryStreak: 0 }
  | { type: 'RECOVERING'; healthyRecoveryStreak: 1 }
  | { type: 'RESET_RECOVERY'; healthyRecoveryStreak: 0 }
  | { type: 'RESOLVE'; healthyRecoveryStreak: 0 };

export class MultiLocationContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MultiLocationContractError';
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Canonical location IDs are `local` or lowercase UUIDs; duplicates are errors. */
export function normalizeLocationSnapshot(locations: unknown): readonly string[] {
  if (!Array.isArray(locations) || locations.length === 0) {
    throw new MultiLocationContractError('Round locations must be a nonempty array.');
  }
  const normalized = locations.map((location: unknown) => {
    if (typeof location !== 'string' || (location !== 'local' && !UUID_PATTERN.test(location))) {
      throw new MultiLocationContractError('Round location identity is invalid.');
    }
    return location.toLowerCase();
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new MultiLocationContractError('Round location identities must be unique.');
  }
  return Object.freeze(normalized.sort());
}

export function createMultiLocationRoundSnapshot(
  input: MultiLocationRoundSnapshotV1,
): MultiLocationRoundSnapshotV1 {
  if (
    input.contractVersion !== MULTI_LOCATION_CONTRACT_VERSION ||
    input.aggregationPolicyVersion !== MULTI_LOCATION_AGGREGATION_POLICY_VERSION ||
    input.confirmationPolicyVersion !== MULTI_LOCATION_CONFIRMATION_POLICY_VERSION ||
    !['MANUAL', 'SCHEDULED'].includes(input.trigger) ||
    !nonempty(input.roundId) ||
    !nonempty(input.organizationId) ||
    !nonempty(input.monitorId) ||
    !nonempty(input.configurationVersionId)
  ) {
    throw new MultiLocationContractError('Round snapshot identity or policy is invalid.');
  }
  const created = timestamp(input.createdAt);
  const deadline = timestamp(input.deadlineAt);
  if (deadline <= created)
    throw new MultiLocationContractError('Round deadline must follow creation.');
  return Object.freeze({ ...input, locations: normalizeLocationSnapshot(input.locations) });
}

export function initialRegionalEvaluation(locationId: string): RegionalEvaluationV1 {
  if (normalizeLocationSnapshot([locationId]).length !== 1)
    throw new MultiLocationContractError('Invalid location.');
  return Object.freeze({
    phase: 'AWAITING_PRIMARY',
    locationId: locationId.toLowerCase(),
    primary: null,
    confirmation: null,
  });
}

/** Internal/probe uncertainty can never be promoted to an endpoint failure. */
export function classifyProbeObservation(
  observation: ProbeObservationV1,
): ClassifiedProbeObservation {
  if (
    !['PASS', 'FAIL', 'UNKNOWN'].includes(observation.outcome) ||
    !['PASS', 'FAIL', 'NOT_EVALUATED'].includes(observation.assertionOutcome) ||
    !nonempty(observation.reason)
  ) {
    throw new MultiLocationContractError('Execution observation is invalid.');
  }
  if (
    observation.reason === 'INTERNAL_ERROR' ||
    observation.reason === 'PROHIBITED_DESTINATION' ||
    observation.outcome === 'UNKNOWN'
  )
    return 'UNKNOWN';
  if (observation.outcome === 'FAIL' || observation.assertionOutcome === 'FAIL') return 'FAIL';
  if (observation.assertionOutcome === 'NOT_EVALUATED') return 'UNKNOWN';
  return 'PASS';
}

/** Prefer another healthy agent; safely fall back to the original agent. */
export function chooseConfirmationAgent(
  locationId: string,
  primaryAgentId: string,
  agents: readonly ConfirmationAgentV1[],
): string | null {
  const [canonicalLocationId] = normalizeLocationSnapshot([locationId]);
  if (!nonempty(primaryAgentId))
    throw new MultiLocationContractError('Primary agent ID is invalid.');
  const ids = new Set<string>();
  for (const agent of agents) {
    if (
      !nonempty(agent.agentId) ||
      typeof agent.healthy !== 'boolean' ||
      ids.has(agent.agentId) ||
      normalizeLocationSnapshot([agent.locationId]).length !== 1
    ) {
      throw new MultiLocationContractError('Confirmation candidate list is invalid.');
    }
    ids.add(agent.agentId);
  }
  const healthy = agents
    .filter((agent) => agent.healthy && agent.locationId.toLowerCase() === canonicalLocationId)
    .map((agent) => agent.agentId)
    .sort();
  return (
    healthy.find((id) => id !== primaryAgentId) ??
    (healthy.includes(primaryAgentId) ? primaryAgentId : null)
  );
}

/** A retry/duplicate of the same physical execution can never confirm failure. */
export function reduceRegionalEvidence(
  input: RegionalReductionInputV1,
): RegionalReductionDecisionV1 {
  const { state, execution } = input;
  if (!nonempty(execution.executionId) || !nonempty(execution.agentId)) {
    throw new MultiLocationContractError('Execution identity is invalid.');
  }
  const acceptedAt = timestamp(execution.acceptedAt);
  const created = timestamp(input.createdAt);
  const deadline = timestamp(input.deadlineAt);
  if (deadline <= created) throw new MultiLocationContractError('Invalid round deadline window.');
  const classified = classifyProbeObservation(execution.observation);
  const prior = [state.primary, state.confirmation].find(
    (item) => item?.executionId === execution.executionId,
  );
  if (prior) {
    return prior.agentId === execution.agentId &&
      prior.acceptedAt === execution.acceptedAt &&
      prior.observation.outcome === execution.observation.outcome &&
      prior.observation.reason === execution.observation.reason &&
      prior.observation.assertionOutcome === execution.observation.assertionOutcome
      ? { disposition: 'DUPLICATE', state }
      : { disposition: 'REJECTED', reason: 'CONFLICTING_REPLAY', state };
  }
  if (input.roundCompleted) return { disposition: 'REJECTED', reason: 'ROUND_COMPLETED', state };
  if (acceptedAt < created)
    return { disposition: 'REJECTED', reason: 'BEFORE_ROUND_CREATION', state };
  if (acceptedAt >= deadline)
    return { disposition: 'REJECTED', reason: 'DEADLINE_EXCEEDED', state };
  if (state.phase === 'TERMINAL')
    return { disposition: 'REJECTED', reason: 'REGION_TERMINAL', state };

  const evidence = freezeExecution(execution);
  if (state.phase === 'AWAITING_PRIMARY') {
    if (classified === 'FAIL') {
      return {
        disposition: 'ACCEPTED',
        state: Object.freeze({
          phase: 'AWAITING_CONFIRMATION',
          locationId: state.locationId,
          primary: evidence,
          confirmation: null,
        }),
      };
    }
    return {
      disposition: 'ACCEPTED',
      state: terminal(
        state.locationId,
        classified,
        classified === 'PASS' ? 'PRIMARY_PASS' : 'PRIMARY_UNKNOWN',
        evidence,
        null,
      ),
    };
  }
  if (acceptedAt < timestamp(state.primary.acceptedAt)) {
    return { disposition: 'REJECTED', reason: 'NON_MONOTONIC_ACCEPTANCE', state };
  }
  return {
    disposition: 'ACCEPTED',
    state: terminal(
      state.locationId,
      classified === 'FAIL' ? 'CONFIRMED_FAIL' : classified,
      classified === 'FAIL'
        ? 'CONFIRMED_FAILURE'
        : classified === 'PASS'
          ? 'CONFIRMATION_PASS'
          : 'CONFIRMATION_UNKNOWN',
      state.primary,
      evidence,
    ),
  };
}

/** Only the deadline resolver, not an agent, can create a deadline UNKNOWN. */
export function expireRegionalEvaluation(
  state: RegionalEvaluationV1,
): Extract<RegionalEvaluationV1, { phase: 'TERMINAL' }> {
  if (state.phase === 'TERMINAL') return state;
  return terminal(state.locationId, 'UNKNOWN', 'ROUND_DEADLINE', state.primary, null);
}

/** A finalized decision must include one terminal vote per captured location. */
export function aggregateRegionOutcomes(
  snapshot: MultiLocationRoundSnapshotV1,
  regionalStates: readonly RegionalEvaluationV1[],
): AggregateRoundDecisionV1 {
  const ordered = matchSnapshot(snapshot, regionalStates);
  if (ordered.some((state) => state.phase !== 'TERMINAL')) {
    throw new MultiLocationContractError('Cannot aggregate nonterminal regional evidence.');
  }
  const regions = ordered.map((state) => {
    validateRegionalState(snapshot, state);
    return terminal(
      state.locationId,
      (state as Extract<RegionalEvaluationV1, { phase: 'TERMINAL' }>).outcome,
      (state as Extract<RegionalEvaluationV1, { phase: 'TERMINAL' }>).terminalReason,
      state.primary && freezeExecution(state.primary),
      state.confirmation && freezeExecution(state.confirmation),
    );
  });
  const selected = snapshot.locations.length;
  const quorum = Math.floor(selected / 2) + 1;
  const pass = regions.filter((state) => state.outcome === 'PASS').length;
  const confirmedFail = regions.filter((state) => state.outcome === 'CONFIRMED_FAIL').length;
  const unknown = selected - pass - confirmedFail;
  const outcome: AggregateHealthState =
    confirmedFail >= quorum
      ? 'DOWN'
      : pass > 0 && confirmedFail > 0
        ? 'DEGRADED'
        : pass >= quorum && confirmedFail === 0
          ? 'UP'
          : 'UNKNOWN';
  const conclusive = pass + confirmedFail;
  return Object.freeze({
    contractVersion: 1,
    roundId: snapshot.roundId,
    configurationVersionId: snapshot.configurationVersionId,
    aggregationPolicyVersion: 1,
    confirmationPolicyVersion: 1,
    outcome,
    quorum,
    counts: Object.freeze({ selected, pass, confirmedFail, unknown, conclusive }),
    coverage: Object.freeze({ numerator: conclusive, denominator: selected }),
    reachability:
      conclusive === 0 ? null : Object.freeze({ numerator: pass, denominator: conclusive }),
    regions: Object.freeze(regions),
  });
}

/** All regions terminal OR the database deadline; never finalize merely on quorum. */
export function evaluateRoundFinalization(input: {
  snapshot: MultiLocationRoundSnapshotV1;
  regionalStates: readonly RegionalEvaluationV1[];
  now: string;
  roundStatus: 'PENDING' | 'COMPLETED';
}): RoundFinalizationDecisionV1 {
  if (input.roundStatus === 'COMPLETED') return { state: 'ALREADY_FINALIZED' };
  if (input.roundStatus !== 'PENDING')
    throw new MultiLocationContractError('Round status is invalid.');
  const ordered = matchSnapshot(input.snapshot, input.regionalStates);
  const now = timestamp(input.now);
  if (now < timestamp(input.snapshot.createdAt)) {
    throw new MultiLocationContractError('Evaluation time precedes round creation.');
  }
  for (const state of ordered) validateRegionalState(input.snapshot, state);
  const pending = ordered
    .filter((state) => state.phase !== 'TERMINAL')
    .map((state) => state.locationId);
  const deadlineReached = now >= timestamp(input.snapshot.deadlineAt);
  if (pending.length > 0 && !deadlineReached) {
    return { state: 'WAIT', pendingLocationIds: Object.freeze(pending) };
  }
  const terminalStates = deadlineReached ? ordered.map(expireRegionalEvaluation) : ordered;
  return Object.freeze({
    state: 'FINALIZE',
    cause: pending.length === 0 ? 'ALL_REGIONS_TERMINAL' : 'DEADLINE_REACHED',
    finalizedAt: input.now,
    aggregate: aggregateRegionOutcomes(input.snapshot, terminalStates),
  });
}

/**
 * Only multi-location finalized aggregates drive these directives. For one location,
 * defer unchanged to the existing three-consecutive-failures policy.
 * UNKNOWN holds the current incident/severity and never implies recovery.
 */
export function deriveMultiLocationIncidentDirective(input: {
  selectedLocations: number;
  outcome: AggregateHealthState;
  activeSeverity: 'DEGRADED' | 'DOWN' | null;
  healthyRecoveryStreak: 0 | 1;
}): IncidentDirectiveV1 {
  if (
    !Number.isSafeInteger(input.selectedLocations) ||
    input.selectedLocations < 1 ||
    !['UP', 'DEGRADED', 'DOWN', 'UNKNOWN'].includes(input.outcome) ||
    (input.activeSeverity !== null && !['DEGRADED', 'DOWN'].includes(input.activeSeverity)) ||
    (input.healthyRecoveryStreak !== 0 && input.healthyRecoveryStreak !== 1) ||
    (input.activeSeverity === null && input.healthyRecoveryStreak !== 0)
  ) {
    throw new MultiLocationContractError('Incident directive input is invalid.');
  }
  if (input.selectedLocations === 1) return { type: 'DEFER_TO_SINGLE_LOCATION_POLICY' };
  if (input.outcome === 'UNKNOWN') {
    return input.healthyRecoveryStreak === 1
      ? { type: 'RESET_RECOVERY', healthyRecoveryStreak: 0 }
      : { type: 'NONE', healthyRecoveryStreak: 0 };
  }
  if (input.outcome === 'UP') {
    if (!input.activeSeverity) return { type: 'NONE', healthyRecoveryStreak: 0 };
    return input.healthyRecoveryStreak === 0
      ? { type: 'RECOVERING', healthyRecoveryStreak: 1 }
      : { type: 'RESOLVE', healthyRecoveryStreak: 0 };
  }
  if (input.activeSeverity === null) {
    return { type: 'OPEN', severity: input.outcome, healthyRecoveryStreak: 0 };
  }
  if (input.activeSeverity === input.outcome) {
    return input.healthyRecoveryStreak === 1
      ? { type: 'RESET_RECOVERY', healthyRecoveryStreak: 0 }
      : { type: 'NONE', healthyRecoveryStreak: 0 };
  }
  return input.outcome === 'DOWN'
    ? { type: 'ESCALATE', severity: 'DOWN', healthyRecoveryStreak: 0 }
    : { type: 'DEESCALATE', severity: 'DEGRADED', healthyRecoveryStreak: 0 };
}

function matchSnapshot(
  snapshot: MultiLocationRoundSnapshotV1,
  regionalStates: readonly RegionalEvaluationV1[],
): RegionalEvaluationV1[] {
  if (
    snapshot.contractVersion !== 1 ||
    snapshot.aggregationPolicyVersion !== 1 ||
    snapshot.confirmationPolicyVersion !== 1
  ) {
    throw new MultiLocationContractError('Aggregation policy version is unsupported.');
  }
  const createdAt = timestamp(snapshot.createdAt);
  if (timestamp(snapshot.deadlineAt) <= createdAt) {
    throw new MultiLocationContractError('Round deadline must follow creation.');
  }
  const locations = normalizeLocationSnapshot(snapshot.locations);
  if (locations.join('\0') !== snapshot.locations.join('\0')) {
    throw new MultiLocationContractError('Round snapshot is not canonical.');
  }
  if (regionalStates.length !== locations.length) {
    throw new MultiLocationContractError(
      'Every captured location requires exactly one regional state.',
    );
  }
  const byLocation = new Map<string, RegionalEvaluationV1>();
  for (const state of regionalStates) {
    if (byLocation.has(state.locationId) || !locations.includes(state.locationId)) {
      throw new MultiLocationContractError('Regional state is duplicated or outside the snapshot.');
    }
    byLocation.set(state.locationId, state);
  }
  return locations.map((id) => {
    const state = byLocation.get(id);
    if (!state) throw new MultiLocationContractError('Regional evidence is missing.');
    return state;
  });
}

/** Defensive validation is mandatory even for externally reconstructed stored states. */
function validateRegionalState(
  snapshot: MultiLocationRoundSnapshotV1,
  state: RegionalEvaluationV1,
): void {
  if (!['AWAITING_PRIMARY', 'AWAITING_CONFIRMATION', 'TERMINAL'].includes(state.phase)) {
    throw new MultiLocationContractError('Regional phase is invalid.');
  }
  const primary = state.primary;
  const confirmation = state.confirmation;
  for (const item of [primary, confirmation]) {
    if (!item) continue;
    if (!nonempty(item.executionId) || !nonempty(item.agentId)) {
      throw new MultiLocationContractError('Regional execution identity is invalid.');
    }
    const time = timestamp(item.acceptedAt);
    if (time < timestamp(snapshot.createdAt) || time >= timestamp(snapshot.deadlineAt)) {
      throw new MultiLocationContractError(
        'Regional evidence lies outside the round acceptance window.',
      );
    }
    classifyProbeObservation(item.observation);
  }
  if (state.phase === 'AWAITING_PRIMARY') {
    if (primary || confirmation)
      throw new MultiLocationContractError('Primary-pending evidence is inconsistent.');
    return;
  }
  if (state.phase === 'AWAITING_CONFIRMATION') {
    if (!primary || confirmation || classifyProbeObservation(primary.observation) !== 'FAIL') {
      throw new MultiLocationContractError('Confirmation-pending evidence is inconsistent.');
    }
    return;
  }
  if (state.terminalReason === 'ROUND_DEADLINE') {
    if (
      state.outcome !== 'UNKNOWN' ||
      confirmation ||
      (primary !== null && classifyProbeObservation(primary.observation) !== 'FAIL')
    ) {
      throw new MultiLocationContractError('Deadline evidence is inconsistent.');
    }
    return;
  }
  if (!primary)
    throw new MultiLocationContractError('Terminal evidence is missing its primary execution.');
  const first = classifyProbeObservation(primary.observation);
  if (state.terminalReason === 'PRIMARY_PASS' || state.terminalReason === 'PRIMARY_UNKNOWN') {
    const expected = state.terminalReason === 'PRIMARY_PASS' ? 'PASS' : 'UNKNOWN';
    if (confirmation || first !== expected || state.outcome !== expected) {
      throw new MultiLocationContractError('Primary terminal evidence is inconsistent.');
    }
    return;
  }
  if (
    !confirmation ||
    confirmation.executionId === primary.executionId ||
    timestamp(confirmation.acceptedAt) < timestamp(primary.acceptedAt) ||
    first !== 'FAIL'
  ) {
    throw new MultiLocationContractError('Confirmation is not a distinct ordered execution.');
  }
  const second = classifyProbeObservation(confirmation.observation);
  const expected = second === 'FAIL' ? 'CONFIRMED_FAIL' : second;
  const expectedReason =
    second === 'FAIL'
      ? 'CONFIRMED_FAILURE'
      : second === 'PASS'
        ? 'CONFIRMATION_PASS'
        : 'CONFIRMATION_UNKNOWN';
  if (state.outcome !== expected || state.terminalReason !== expectedReason) {
    throw new MultiLocationContractError('Confirmation terminal evidence is inconsistent.');
  }
}

function terminal(
  locationId: string,
  outcome: RegionalTerminalOutcome,
  terminalReason: RegionalTerminalReason,
  primary: RegionalExecutionEvidenceV1 | null,
  confirmation: RegionalExecutionEvidenceV1 | null,
): Extract<RegionalEvaluationV1, { phase: 'TERMINAL' }> {
  return Object.freeze({
    phase: 'TERMINAL',
    locationId,
    outcome,
    terminalReason,
    primary,
    confirmation,
  });
}

function freezeExecution(execution: RegionalExecutionEvidenceV1): RegionalExecutionEvidenceV1 {
  return Object.freeze({ ...execution, observation: Object.freeze({ ...execution.observation }) });
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function timestamp(value: string): number {
  if (typeof value !== 'string') throw new MultiLocationContractError('Invalid timestamp.');
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new MultiLocationContractError('Timestamp must be canonical UTC ISO-8601.');
  }
  return parsed.getTime();
}
