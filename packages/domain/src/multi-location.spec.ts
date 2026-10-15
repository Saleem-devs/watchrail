import { describe, expect, it } from 'vitest';
import {
  aggregateRegionOutcomes,
  chooseConfirmationAgent,
  classifyProbeObservation,
  createMultiLocationRoundSnapshot,
  deriveMultiLocationIncidentDirective,
  evaluateRoundFinalization,
  expireRegionalEvaluation,
  initialRegionalEvaluation,
  normalizeLocationSnapshot,
  reduceRegionalEvidence,
  type MultiLocationRoundSnapshotV1,
  type ProbeObservationV1,
  type RegionalEvaluationV1,
  type RegionalExecutionEvidenceV1,
  type RegionalTerminalOutcome,
} from './multi-location.js';

const createdAt = '2026-10-15T12:00:00.000Z';
const beforeDeadline = '2026-10-15T12:00:30.000Z';
const deadlineAt = '2026-10-15T12:02:00.000Z';
const atDeadline = '2026-10-15T12:02:00.000Z';
const afterDeadline = '2026-10-15T12:02:01.000Z';

function location(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function snapshot(count = 3): MultiLocationRoundSnapshotV1 {
  return createMultiLocationRoundSnapshot({
    contractVersion: 1,
    roundId: 'round-1',
    organizationId: 'org-1',
    monitorId: 'monitor-1',
    configurationVersionId: 'configuration-1',
    trigger: 'SCHEDULED',
    locations: Array.from({ length: count }, (_, index) => location(index + 1)),
    aggregationPolicyVersion: 1,
    confirmationPolicyVersion: 1,
    createdAt,
    deadlineAt,
  });
}

function observation(
  outcome: ProbeObservationV1['outcome'],
  assertionOutcome: ProbeObservationV1['assertionOutcome'] = 'PASS',
  reason = outcome === 'PASS'
    ? 'COMPLETED'
    : outcome === 'FAIL'
      ? 'UNEXPECTED_STATUS'
      : 'INTERNAL_ERROR',
): ProbeObservationV1 {
  return { outcome, assertionOutcome, reason };
}

function execution(
  id: string,
  outcome: ProbeObservationV1['outcome'],
  acceptedAt = '2026-10-15T12:00:05.000Z',
  agentId = 'agent-a',
): RegionalExecutionEvidenceV1 {
  return { executionId: id, agentId, acceptedAt, observation: observation(outcome) };
}

function accepted(
  state: RegionalEvaluationV1,
  item: RegionalExecutionEvidenceV1,
): RegionalEvaluationV1 {
  const decision = reduceRegionalEvidence({
    state,
    execution: item,
    createdAt,
    deadlineAt,
    roundCompleted: false,
  });
  expect(decision.disposition).toBe('ACCEPTED');
  return decision.state;
}

function terminalVote(locationId: string, vote: RegionalTerminalOutcome): RegionalEvaluationV1 {
  const primary = accepted(
    initialRegionalEvaluation(locationId),
    execution(`${locationId}-primary`, vote === 'CONFIRMED_FAIL' ? 'FAIL' : vote),
  );
  if (vote !== 'CONFIRMED_FAIL') return primary;
  return accepted(
    primary,
    execution(`${locationId}-confirm`, 'FAIL', '2026-10-15T12:00:06.000Z', 'agent-b'),
  );
}

function expectedOutcome(votes: readonly RegionalTerminalOutcome[]) {
  const q = Math.floor(votes.length / 2) + 1;
  const p = votes.filter((x) => x === 'PASS').length;
  const f = votes.filter((x) => x === 'CONFIRMED_FAIL').length;
  return f >= q ? 'DOWN' : p > 0 && f > 0 ? 'DEGRADED' : p >= q && f === 0 ? 'UP' : 'UNKNOWN';
}

describe('Slice 11.1 immutable location snapshots', () => {
  it('canonicalizes ordering and freezes the snapshot and selected locations', () => {
    const input = { ...snapshot(3), locations: [location(3).toUpperCase(), 'local', location(1)] };
    const result = createMultiLocationRoundSnapshot(input);
    expect(result.locations).toEqual([location(1), location(3), 'local']);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.locations)).toBe(true);
  });

  it('rejects empty, malformed, duplicated and case-equivalent location identities', () => {
    expect(() => normalizeLocationSnapshot([])).toThrow();
    expect(() => normalizeLocationSnapshot([location(1), location(1).toUpperCase()])).toThrow();
    expect(() => normalizeLocationSnapshot(['LOCAL'])).toThrow();
    expect(() => normalizeLocationSnapshot(['private-ip-1'])).toThrow();
    expect(() => normalizeLocationSnapshot([location(1), null])).toThrow();
  });

  it('captures locations independently of later configuration edits', () => {
    const original = snapshot(2);
    const updatedLocations = [...original.locations, location(3)];
    const updated = createMultiLocationRoundSnapshot({
      ...original,
      configurationVersionId: 'configuration-2',
      locations: updatedLocations,
    });
    expect(original.locations).toEqual([location(1), location(2)]);
    expect(updated.locations).toEqual([location(1), location(2), location(3)]);
    expect(original.configurationVersionId).toBe('configuration-1');
  });

  it('requires an ordered deadline and supported policy versions', () => {
    expect(() =>
      createMultiLocationRoundSnapshot({ ...snapshot(), deadlineAt: createdAt }),
    ).toThrow();
    expect(() =>
      createMultiLocationRoundSnapshot({ ...snapshot(), aggregationPolicyVersion: 2 as 1 }),
    ).toThrow();
    expect(() =>
      createMultiLocationRoundSnapshot({ ...snapshot(), confirmationPolicyVersion: 2 as 1 }),
    ).toThrow();
  });
});

describe('Slice 11.1 regional confirmation', () => {
  it('does not treat a first failure as confirmed', () => {
    const pending = accepted(initialRegionalEvaluation(location(1)), execution('first', 'FAIL'));
    expect(pending.phase).toBe('AWAITING_CONFIRMATION');
  });

  it.each([
    { primary: 'PASS' as const, confirm: null, expected: 'PASS' },
    { primary: 'UNKNOWN' as const, confirm: null, expected: 'UNKNOWN' },
    { primary: 'FAIL' as const, confirm: 'FAIL' as const, expected: 'CONFIRMED_FAIL' },
    { primary: 'FAIL' as const, confirm: 'PASS' as const, expected: 'PASS' },
    { primary: 'FAIL' as const, confirm: 'UNKNOWN' as const, expected: 'UNKNOWN' },
  ])('$primary followed by $confirm becomes $expected', ({ primary, confirm, expected }) => {
    let state = accepted(initialRegionalEvaluation(location(1)), execution('first', primary));
    if (confirm) state = accepted(state, execution('second', confirm, '2026-10-15T12:00:06.000Z'));
    expect(state.phase).toBe('TERMINAL');
    if (state.phase === 'TERMINAL') expect(state.outcome).toBe(expected);
  });

  it('does not confuse probe failures or prohibited destinations with target failures', () => {
    expect(classifyProbeObservation(observation('FAIL', 'PASS', 'INTERNAL_ERROR'))).toBe('UNKNOWN');
    expect(classifyProbeObservation(observation('FAIL', 'PASS', 'PROHIBITED_DESTINATION'))).toBe(
      'UNKNOWN',
    );
    expect(classifyProbeObservation(observation('PASS', 'FAIL'))).toBe('FAIL');
    expect(classifyProbeObservation(observation('PASS', 'NOT_EVALUATED'))).toBe('UNKNOWN');
    expect(classifyProbeObservation(observation('FAIL', 'NOT_EVALUATED', 'REQUEST_TIMEOUT'))).toBe(
      'FAIL',
    );
  });

  it('makes identical delivery replay idempotent, but rejects conflicting replay', () => {
    const first = execution('first', 'FAIL');
    const state = accepted(initialRegionalEvaluation(location(1)), first);
    const duplicate = reduceRegionalEvidence({
      state,
      execution: first,
      createdAt,
      deadlineAt,
      roundCompleted: false,
    });
    expect(duplicate).toMatchObject({ disposition: 'DUPLICATE', state });
    const conflict = reduceRegionalEvidence({
      state,
      execution: { ...first, agentId: 'other-agent' },
      createdAt,
      deadlineAt,
      roundCompleted: false,
    });
    expect(conflict).toMatchObject({ disposition: 'REJECTED', reason: 'CONFLICTING_REPLAY' });
    expect(state.phase).toBe('AWAITING_CONFIRMATION');
  });

  it('requires a distinct authoritative HTTP execution for confirmation', () => {
    const state = accepted(initialRegionalEvaluation(location(1)), execution('same-id', 'FAIL'));
    const replay = reduceRegionalEvidence({
      state,
      execution: execution('same-id', 'FAIL', '2026-10-15T12:00:06.000Z'),
      createdAt,
      deadlineAt,
      roundCompleted: false,
    });
    expect(replay).toMatchObject({ disposition: 'REJECTED', reason: 'CONFLICTING_REPLAY' });
    const wrongOrder = reduceRegionalEvidence({
      state,
      execution: execution('different', 'FAIL', '2026-10-15T12:00:04.000Z'),
      createdAt,
      deadlineAt,
      roundCompleted: false,
    });
    expect(wrongOrder).toMatchObject({
      disposition: 'REJECTED',
      reason: 'NON_MONOTONIC_ACCEPTANCE',
    });
  });

  it('prefers another healthy agent and uses original agent only as a fallback', () => {
    expect(
      chooseConfirmationAgent(location(1), 'a', [
        { agentId: 'a', locationId: location(1), healthy: true },
        { agentId: 'c', locationId: location(1), healthy: true },
        { agentId: 'b', locationId: location(1), healthy: true },
      ]),
    ).toBe('b');
    expect(
      chooseConfirmationAgent(location(1), 'a', [
        { agentId: 'a', locationId: location(1), healthy: true },
        { agentId: 'b', locationId: location(1), healthy: false },
      ]),
    ).toBe('a');
    expect(
      chooseConfirmationAgent(location(1), 'a', [
        { agentId: 'a', locationId: location(1), healthy: false },
        { agentId: 'b', locationId: location(1), healthy: false },
      ]),
    ).toBeNull();
    expect(
      chooseConfirmationAgent(location(1), 'a', [
        { agentId: 'foreign', locationId: location(2), healthy: true },
      ]),
    ).toBeNull();
    expect(
      chooseConfirmationAgent(location(1).toUpperCase(), 'a', [
        { agentId: 'b', locationId: location(1), healthy: true },
      ]),
    ).toBe('b');
    expect(() =>
      chooseConfirmationAgent(location(1), 'a', [
        { agentId: 'b', locationId: location(1), healthy: true },
        { agentId: 'b', locationId: location(1), healthy: true },
      ]),
    ).toThrow();
    expect(() =>
      chooseConfirmationAgent(location(1), 'a', [
        { agentId: 'b', locationId: 'not-a-location', healthy: true },
      ]),
    ).toThrow();
  });

  it('rejects evidence accepted before round creation', () => {
    const state = initialRegionalEvaluation(location(1));
    expect(
      reduceRegionalEvidence({
        state,
        execution: execution('pre-round', 'PASS', '2026-10-15T11:59:59.999Z'),
        createdAt,
        deadlineAt,
        roundCompleted: false,
      }),
    ).toMatchObject({ disposition: 'REJECTED', reason: 'BEFORE_ROUND_CREATION' });
  });

  it('does not accept new evidence at/after the deadline or after round completion', () => {
    const state = initialRegionalEvaluation(location(1));
    expect(
      reduceRegionalEvidence({
        state,
        execution: execution('late', 'PASS', atDeadline),
        createdAt,
        deadlineAt,
        roundCompleted: false,
      }),
    ).toMatchObject({ disposition: 'REJECTED', reason: 'DEADLINE_EXCEEDED' });
    expect(
      reduceRegionalEvidence({
        state,
        execution: execution('later', 'PASS', afterDeadline),
        createdAt,
        deadlineAt,
        roundCompleted: false,
      }),
    ).toMatchObject({ disposition: 'REJECTED', reason: 'DEADLINE_EXCEEDED' });
    expect(
      reduceRegionalEvidence({
        state,
        execution: execution('after-final', 'PASS'),
        createdAt,
        deadlineAt,
        roundCompleted: true,
      }),
    ).toMatchObject({ disposition: 'REJECTED', reason: 'ROUND_COMPLETED' });
    const first = execution('accepted', 'PASS');
    const terminal = accepted(state, first);
    expect(
      reduceRegionalEvidence({
        state: terminal,
        execution: first,
        createdAt,
        deadlineAt,
        roundCompleted: true,
      }).disposition,
    ).toBe('DUPLICATE');
    expect(
      reduceRegionalEvidence({
        state: terminal,
        execution: execution('new', 'PASS'),
        createdAt,
        deadlineAt,
        roundCompleted: false,
      }),
    ).toMatchObject({ disposition: 'REJECTED', reason: 'REGION_TERMINAL' });
  });
});

describe('Slice 11.1 strict-majority aggregation', () => {
  it('exhaustively evaluates every terminal outcome combination for 1 to 7 locations', () => {
    const options = ['PASS', 'CONFIRMED_FAIL', 'UNKNOWN'] as const;
    for (let n = 1; n <= 7; n += 1) {
      const round = snapshot(n);
      for (let pattern = 0; pattern < 3 ** n; pattern += 1) {
        let remaining = pattern;
        const votes = Array.from({ length: n }, () => {
          const vote = options[remaining % 3]!;
          remaining = Math.floor(remaining / 3);
          return vote;
        });
        const states = votes.map((vote, i) => terminalVote(round.locations[i]!, vote));
        const actual = aggregateRegionOutcomes(round, states);
        const p = votes.filter((x) => x === 'PASS').length;
        const f = votes.filter((x) => x === 'CONFIRMED_FAIL').length;
        expect(actual.outcome).toBe(expectedOutcome(votes));
        expect(actual.quorum).toBe(Math.floor(n / 2) + 1);
        expect(actual.counts).toEqual({
          selected: n,
          pass: p,
          confirmedFail: f,
          unknown: n - p - f,
          conclusive: p + f,
        });
        expect(actual.coverage).toEqual({ numerator: p + f, denominator: n });
        expect(actual.reachability).toEqual(
          p + f === 0 ? null : { numerator: p, denominator: p + f },
        );
        expect(aggregateRegionOutcomes(round, [...states].reverse())).toEqual(actual);
      }
    }
  });

  it.each([
    { votes: ['PASS', 'UNKNOWN'], expected: 'UNKNOWN' },
    { votes: ['PASS', 'PASS'], expected: 'UP' },
    { votes: ['PASS', 'CONFIRMED_FAIL'], expected: 'DEGRADED' },
    { votes: ['CONFIRMED_FAIL', 'CONFIRMED_FAIL'], expected: 'DOWN' },
    { votes: ['CONFIRMED_FAIL', 'UNKNOWN'], expected: 'UNKNOWN' },
    { votes: ['PASS', 'PASS', 'UNKNOWN'], expected: 'UP' },
    { votes: ['PASS', 'CONFIRMED_FAIL', 'UNKNOWN'], expected: 'DEGRADED' },
    { votes: ['PASS', 'CONFIRMED_FAIL', 'CONFIRMED_FAIL'], expected: 'DOWN' },
    { votes: ['PASS', 'UNKNOWN', 'UNKNOWN'], expected: 'UNKNOWN' },
    { votes: ['CONFIRMED_FAIL', 'UNKNOWN', 'UNKNOWN'], expected: 'UNKNOWN' },
    { votes: ['PASS', 'PASS', 'UNKNOWN', 'UNKNOWN'], expected: 'UNKNOWN' },
    { votes: ['PASS', 'PASS', 'PASS', 'UNKNOWN'], expected: 'UP' },
    { votes: ['PASS', 'PASS', 'CONFIRMED_FAIL', 'UNKNOWN'], expected: 'DEGRADED' },
    { votes: ['PASS', 'CONFIRMED_FAIL', 'CONFIRMED_FAIL', 'UNKNOWN'], expected: 'DEGRADED' },
    { votes: ['CONFIRMED_FAIL', 'CONFIRMED_FAIL', 'CONFIRMED_FAIL', 'UNKNOWN'], expected: 'DOWN' },
  ] as const)('explicit quorum case $expected', ({ votes, expected }) => {
    const round = snapshot(votes.length);
    const regions = votes.map((vote, i) => terminalVote(round.locations[i]!, vote));
    expect(aggregateRegionOutcomes(round, regions).outcome).toBe(expected);
  });

  it('preserves confirmed minority failures even when the pass quorum exists', () => {
    const round = snapshot(5);
    const states = round.locations.map((id, i) =>
      terminalVote(id, i === 4 ? 'CONFIRMED_FAIL' : 'PASS'),
    );
    expect(aggregateRegionOutcomes(round, states).outcome).toBe('DEGRADED');
  });

  it('excludes unknown regions from reachability and reports no reachability without evidence', () => {
    const mixed = snapshot(3);
    expect(
      aggregateRegionOutcomes(mixed, [
        terminalVote(location(1), 'PASS'),
        terminalVote(location(2), 'CONFIRMED_FAIL'),
        terminalVote(location(3), 'UNKNOWN'),
      ]).reachability,
    ).toEqual({ numerator: 1, denominator: 2 });

    const unknown = snapshot(2);
    expect(
      aggregateRegionOutcomes(
        unknown,
        unknown.locations.map((id) => terminalVote(id, 'UNKNOWN')),
      ).reachability,
    ).toBeNull();
  });

  it('rejects any fabricated, duplicated, missing, unconfirmed, or late vote', () => {
    const round = snapshot(2);
    const states = round.locations.map((id) => terminalVote(id, 'PASS'));
    expect(() => aggregateRegionOutcomes(round, [states[0]!, states[0]!])).toThrow();
    expect(() => aggregateRegionOutcomes(round, [states[0]!])).toThrow();
    expect(() =>
      aggregateRegionOutcomes(round, [states[0]!, initialRegionalEvaluation(location(2))]),
    ).toThrow();
    const fakeFail: RegionalEvaluationV1 = {
      phase: 'TERMINAL',
      locationId: location(2),
      outcome: 'CONFIRMED_FAIL',
      terminalReason: 'CONFIRMED_FAILURE',
      primary: execution('just-one', 'FAIL'),
      confirmation: null,
    };
    expect(() => aggregateRegionOutcomes(round, [states[0]!, fakeFail])).toThrow();
    const fakeLate: RegionalEvaluationV1 = {
      ...states[1]!,
      primary: execution('late-id', 'PASS', afterDeadline),
    } as RegionalEvaluationV1;
    expect(() => aggregateRegionOutcomes(round, [states[0]!, fakeLate])).toThrow();
    const forgedSameId: RegionalEvaluationV1 = {
      phase: 'TERMINAL',
      locationId: location(2),
      outcome: 'CONFIRMED_FAIL',
      terminalReason: 'CONFIRMED_FAILURE',
      primary: execution('same', 'FAIL'),
      confirmation: execution('same', 'FAIL', '2026-10-15T12:00:06.000Z'),
    };
    expect(() => aggregateRegionOutcomes(round, [states[0]!, forgedSameId])).toThrow();
  });
});

describe('Slice 11.1 round finalization', () => {
  it('waits for all regional terminal outcomes despite an already-decided quorum', () => {
    const round = snapshot(3);
    const regions = [
      terminalVote(location(1), 'CONFIRMED_FAIL'),
      terminalVote(location(2), 'CONFIRMED_FAIL'),
      initialRegionalEvaluation(location(3)),
    ];
    expect(
      evaluateRoundFinalization({
        snapshot: round,
        regionalStates: regions,
        now: beforeDeadline,
        roundStatus: 'PENDING',
      }),
    ).toEqual({ state: 'WAIT', pendingLocationIds: [location(3)] });
    const at = evaluateRoundFinalization({
      snapshot: round,
      regionalStates: regions,
      now: atDeadline,
      roundStatus: 'PENDING',
    });
    expect(at).toMatchObject({
      state: 'FINALIZE',
      cause: 'DEADLINE_REACHED',
      aggregate: { outcome: 'DOWN', counts: { unknown: 1 } },
    });
    if (at.state === 'FINALIZE')
      expect(at.aggregate.regions[2]?.terminalReason).toBe('ROUND_DEADLINE');
  });

  it('finalizes before deadline only when every selected region is terminal', () => {
    const round = snapshot(3);
    const regions = [
      terminalVote(location(1), 'PASS'),
      terminalVote(location(2), 'PASS'),
      terminalVote(location(3), 'UNKNOWN'),
    ];
    const decision = evaluateRoundFinalization({
      snapshot: round,
      regionalStates: regions,
      now: beforeDeadline,
      roundStatus: 'PENDING',
    });
    expect(decision).toMatchObject({
      state: 'FINALIZE',
      cause: 'ALL_REGIONS_TERMINAL',
      aggregate: { outcome: 'UP' },
    });
  });

  it('turns missing primary or incomplete confirmation into UNKNOWN at the deadline', () => {
    const round = snapshot(3);
    const pendingConfirmation = accepted(
      initialRegionalEvaluation(location(2)),
      execution('failed', 'FAIL'),
    );
    const states = [
      terminalVote(location(1), 'PASS'),
      pendingConfirmation,
      initialRegionalEvaluation(location(3)),
    ];
    const ready = evaluateRoundFinalization({
      snapshot: round,
      regionalStates: states,
      now: atDeadline,
      roundStatus: 'PENDING',
    });
    expect(ready).toMatchObject({
      state: 'FINALIZE',
      aggregate: { outcome: 'UNKNOWN', counts: { unknown: 2 } },
    });
    expect(expireRegionalEvaluation(pendingConfirmation)).toMatchObject({
      phase: 'TERMINAL',
      outcome: 'UNKNOWN',
      terminalReason: 'ROUND_DEADLINE',
    });
  });

  it('does not recompute or republish an already finalized logical round', () => {
    const round = snapshot(1);
    const decision = evaluateRoundFinalization({
      snapshot: round,
      regionalStates: [terminalVote(location(1), 'PASS')],
      now: afterDeadline,
      roundStatus: 'COMPLETED',
    });
    expect(decision).toEqual({ state: 'ALREADY_FINALIZED' });
  });

  it('keeps no accepted evidence from a location with no capacity', () => {
    const state = expireRegionalEvaluation(initialRegionalEvaluation(location(1)));
    expect(state).toMatchObject({ outcome: 'UNKNOWN', primary: null, confirmation: null });
  });
});

describe('Slice 11.1 incident-driving directives', () => {
  it('opens on first confirmed multi-location degradation or outage', () => {
    expect(
      deriveMultiLocationIncidentDirective({
        selectedLocations: 3,
        outcome: 'DEGRADED',
        activeSeverity: null,
        healthyRecoveryStreak: 0,
      }),
    ).toEqual({ type: 'OPEN', severity: 'DEGRADED', healthyRecoveryStreak: 0 });
    expect(
      deriveMultiLocationIncidentDirective({
        selectedLocations: 3,
        outcome: 'DOWN',
        activeSeverity: null,
        healthyRecoveryStreak: 0,
      }),
    ).toEqual({ type: 'OPEN', severity: 'DOWN', healthyRecoveryStreak: 0 });
  });

  it('maintains one incident across severity changes, uncertainty, and recovery', () => {
    expect(
      deriveMultiLocationIncidentDirective({
        selectedLocations: 3,
        outcome: 'DOWN',
        activeSeverity: 'DEGRADED',
        healthyRecoveryStreak: 0,
      }),
    ).toEqual({ type: 'ESCALATE', severity: 'DOWN', healthyRecoveryStreak: 0 });
    expect(
      deriveMultiLocationIncidentDirective({
        selectedLocations: 3,
        outcome: 'DEGRADED',
        activeSeverity: 'DOWN',
        healthyRecoveryStreak: 0,
      }),
    ).toEqual({ type: 'DEESCALATE', severity: 'DEGRADED', healthyRecoveryStreak: 0 });
    expect(
      deriveMultiLocationIncidentDirective({
        selectedLocations: 3,
        outcome: 'UNKNOWN',
        activeSeverity: 'DOWN',
        healthyRecoveryStreak: 0,
      }),
    ).toEqual({ type: 'NONE', healthyRecoveryStreak: 0 });
    expect(
      deriveMultiLocationIncidentDirective({
        selectedLocations: 3,
        outcome: 'UP',
        activeSeverity: null,
        healthyRecoveryStreak: 0,
      }),
    ).toEqual({ type: 'NONE', healthyRecoveryStreak: 0 });
    expect(
      deriveMultiLocationIncidentDirective({
        selectedLocations: 3,
        outcome: 'DEGRADED',
        activeSeverity: 'DEGRADED',
        healthyRecoveryStreak: 0,
      }),
    ).toEqual({ type: 'NONE', healthyRecoveryStreak: 0 });
  });

  it('defers single-location observations to the existing threshold policy', () => {
    for (const outcome of ['UP', 'DEGRADED', 'DOWN', 'UNKNOWN'] as const) {
      expect(
        deriveMultiLocationIncidentDirective({
          selectedLocations: 1,
          outcome,
          activeSeverity: null,
          healthyRecoveryStreak: 0,
        }),
      ).toEqual({ type: 'DEFER_TO_SINGLE_LOCATION_POLICY' });
    }
  });

  it('requires two consecutive qualifying healthy rounds to resolve an incident', () => {
    expect(
      deriveMultiLocationIncidentDirective({
        selectedLocations: 3,
        outcome: 'UP',
        activeSeverity: 'DOWN',
        healthyRecoveryStreak: 0,
      }),
    ).toEqual({ type: 'RECOVERING', healthyRecoveryStreak: 1 });
    expect(
      deriveMultiLocationIncidentDirective({
        selectedLocations: 3,
        outcome: 'UP',
        activeSeverity: 'DOWN',
        healthyRecoveryStreak: 1,
      }),
    ).toEqual({ type: 'RESOLVE', healthyRecoveryStreak: 0 });
  });

  it('resets interrupted recovery without resolving the active incident', () => {
    for (const outcome of ['UNKNOWN', 'DOWN'] as const) {
      expect(
        deriveMultiLocationIncidentDirective({
          selectedLocations: 3,
          outcome,
          activeSeverity: 'DOWN',
          healthyRecoveryStreak: 1,
        }),
      ).toEqual({ type: 'RESET_RECOVERY', healthyRecoveryStreak: 0 });
    }
  });

  it('rejects recovery progress when there is no active incident', () => {
    expect(() =>
      deriveMultiLocationIncidentDirective({
        selectedLocations: 3,
        outcome: 'UP',
        activeSeverity: null,
        healthyRecoveryStreak: 1,
      }),
    ).toThrow();
  });
});
