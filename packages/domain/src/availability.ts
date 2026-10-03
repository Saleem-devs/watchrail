import type { CheckRoundTrigger } from './check-round.js';
import { classifyScheduledObservation, type IncidentObservationInput } from './incident.js';
import type { MonitorLifecycleState } from './monitor.js';

export const AVAILABILITY_WINDOW_STATES = [
  'AVAILABLE',
  'UNAVAILABLE',
  'UNKNOWN',
  'EXCLUDED',
] as const;
export type AvailabilityWindowState = (typeof AVAILABILITY_WINDOW_STATES)[number];

export interface AvailabilityObservationInput extends IncidentObservationInput {
  trigger: CheckRoundTrigger;
}

export interface AvailabilityDurations {
  availableMs: number;
  unavailableMs: number;
  unknownMs: number;
  excludedMs: number;
}

export interface OrderedRoundKey {
  createdAt: Date;
  roundId: string;
}

export function classifyAvailabilityObservation(
  input: AvailabilityObservationInput,
): AvailabilityWindowState | null {
  if (input.trigger === 'MANUAL') return null;
  const observation = classifyScheduledObservation(input);
  return observation === 'HEALTHY'
    ? 'AVAILABLE'
    : observation === 'UNHEALTHY'
      ? 'UNAVAILABLE'
      : 'UNKNOWN';
}

export function availabilityStateForLifecycle(
  state: MonitorLifecycleState,
): AvailabilityWindowState {
  return state === 'ENABLED' ? 'UNKNOWN' : 'EXCLUDED';
}

export function isRoundNewer(
  candidate: OrderedRoundKey,
  watermark: OrderedRoundKey | null,
): boolean {
  if (!watermark) return true;
  const difference = candidate.createdAt.getTime() - watermark.createdAt.getTime();
  return difference > 0 || (difference === 0 && candidate.roundId > watermark.roundId);
}

export function deriveAvailabilityMetrics(durations: AvailabilityDurations) {
  for (const [name, value] of Object.entries(durations)) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
  const knownMs = durations.availableMs + durations.unavailableMs;
  const eligibleMs = knownMs + durations.unknownMs;
  return {
    uptimePercent: knownMs === 0 ? null : (durations.availableMs / knownMs) * 100,
    coveragePercent: eligibleMs === 0 ? null : (knownMs / eligibleMs) * 100,
    knownMs,
    eligibleMs,
  };
}

export function utcDayStart(value: Date): Date {
  assertValidDate(value, 'value');
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

export function nextUtcDayStart(value: Date): Date {
  const start = utcDayStart(value);
  start.setUTCDate(start.getUTCDate() + 1);
  return start;
}

export function intersectMeasurementWindow(
  requestedStart: Date,
  requestedEnd: Date,
  trackingStartedAt: Date,
) {
  for (const [name, value] of Object.entries({ requestedStart, requestedEnd, trackingStartedAt }))
    assertValidDate(value, name);
  if (requestedEnd <= requestedStart) throw new RangeError('Requested window must be positive.');
  const start = new Date(Math.max(requestedStart.getTime(), trackingStartedAt.getTime()));
  return start < requestedEnd ? { start, end: new Date(requestedEnd) } : null;
}

function assertValidDate(value: Date, name: string): void {
  if (Number.isNaN(value.getTime())) throw new RangeError(`${name} must be a valid date.`);
}
