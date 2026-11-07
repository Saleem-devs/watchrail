import { CronExpressionParser } from 'cron-parser';

export const MAINTENANCE_WINDOW_LIMITS = {
  maximumNameLength: 100,
  maximumTargetMonitors: 100,
  minimumDurationMinutes: 1,
  maximumDurationMinutes: 7 * 24 * 60,
} as const;

export const MAINTENANCE_WINDOW_ACTIONS = ['CREATED', 'UPDATED', 'ARCHIVED'] as const;
export type MaintenanceWindowAction = (typeof MAINTENANCE_WINDOW_ACTIONS)[number];

export interface MaintenanceWindowEffects {
  suppressNotifications: boolean;
  suppressIncidentCreation: boolean;
  excludeFromUptime: boolean;
  publishToStatusPage: boolean;
}

export type MaintenanceWindowTarget =
  { type: 'PROJECT' } | { type: 'MONITORS'; monitorIds: string[] };

export type MaintenanceWindowSchedule =
  | { type: 'ONE_TIME'; startsAt: string; endsAt: string }
  | {
      type: 'RECURRING';
      timezone: string;
      localTime: string;
      daysOfWeek: number[];
      durationMinutes: number;
      startsOn: string;
      endsOn: string | null;
    };

export interface MaintenanceWindowInput {
  name: string;
  schedule: MaintenanceWindowSchedule;
  target: MaintenanceWindowTarget;
  effects: MaintenanceWindowEffects;
}

export interface MaintenanceOccurrence {
  startsAt: Date;
  endsAt: Date;
}

export class MaintenanceWindowInputError extends Error {
  constructor(readonly fields: Record<string, string[]>) {
    super('Maintenance window configuration is invalid.');
    this.name = 'MaintenanceWindowInputError';
  }
}

export function parseMaintenanceWindowInput(value: unknown): MaintenanceWindowInput {
  const fields: Record<string, string[]> = {};
  if (!hasExactKeys(value, ['effects', 'name', 'schedule', 'target'])) {
    throw new MaintenanceWindowInputError({
      maintenanceWindow: ['Provide exactly name, schedule, target, and effects.'],
    });
  }
  const name = parseName(value.name, fields);
  const schedule = parseSchedule(value.schedule, fields);
  const target = parseTarget(value.target, fields);
  const effects = parseEffects(value.effects, fields);
  if (Object.keys(fields).length > 0) throw new MaintenanceWindowInputError(fields);
  return { name, schedule, target, effects };
}

export function maintenanceOccurrenceAt(
  schedule: MaintenanceWindowSchedule,
  at: Date,
): MaintenanceOccurrence | null {
  assertValidDate(at, 'at');
  if (schedule.type === 'ONE_TIME') {
    const occurrence = oneTimeOccurrence(schedule);
    return occurrence.startsAt <= at && at < occurrence.endsAt ? occurrence : null;
  }
  // cron-parser defines the recurring wall-clock contract used everywhere in Watchrail:
  // nonexistent spring-forward times move to the next valid local instant, while an
  // ambiguous fall-back wall time produces one occurrence at its earlier offset.
  // Point lookup deliberately derives from the same forward enumeration used by
  // uptime accounting so DST ambiguity cannot produce a second, contradictory event.
  const occurrences = maintenanceOccurrencesBetween(schedule, at, new Date(at.getTime() + 1));
  return (
    occurrences
      .filter((occurrence) => occurrence.startsAt <= at && at < occurrence.endsAt)
      .at(-1) ?? null
  );
}

export function maintenanceOccurrencesBetween(
  schedule: MaintenanceWindowSchedule,
  from: Date,
  to: Date,
): MaintenanceOccurrence[] {
  assertValidDate(from, 'from');
  assertValidDate(to, 'to');
  if (to <= from) return [];
  if (schedule.type === 'ONE_TIME') {
    const occurrence = oneTimeOccurrence(schedule);
    return overlaps(occurrence, from, to) ? [occurrence] : [];
  }

  const durationMs = schedule.durationMinutes * 60_000;
  // Search one complete recurrence cycle before the overlap boundary. Looking back only by
  // duration misses a spring-forward occurrence after cron-parser shifts its nonexistent wall
  // time forward: at 03:35 local, a shifted 02:30 occurrence may have started at 03:30 even
  // though the nominal cron time is already behind the iterator's current local time.
  const recurrenceCycleMs = 7 * 24 * 60 * 60_000;
  const iterator = CronExpressionParser.parse(cronExpression(schedule), {
    currentDate: new Date(from.getTime() - durationMs - recurrenceCycleMs - 1),
    endDate: to,
    tz: schedule.timezone,
  });
  const occurrences: MaintenanceOccurrence[] = [];
  for (;;) {
    let startsAt: Date;
    try {
      startsAt = iterator.next().toDate();
    } catch {
      break;
    }
    if (startsAt >= to) break;
    if (!recurringDateInRange(schedule, startsAt)) continue;
    const occurrence = { startsAt, endsAt: new Date(startsAt.getTime() + durationMs) };
    if (overlaps(occurrence, from, to)) occurrences.push(occurrence);
  }
  return occurrences;
}

export function mergeMaintenanceEffects(
  effects: readonly MaintenanceWindowEffects[],
): MaintenanceWindowEffects {
  return effects.reduce<MaintenanceWindowEffects>(
    (merged, effect) => ({
      suppressNotifications: merged.suppressNotifications || effect.suppressNotifications,
      suppressIncidentCreation: merged.suppressIncidentCreation || effect.suppressIncidentCreation,
      excludeFromUptime: merged.excludeFromUptime || effect.excludeFromUptime,
      publishToStatusPage: merged.publishToStatusPage || effect.publishToStatusPage,
    }),
    {
      suppressNotifications: false,
      suppressIncidentCreation: false,
      excludeFromUptime: false,
      publishToStatusPage: false,
    },
  );
}

function parseName(value: unknown, fields: Record<string, string[]>): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (name.length === 0 || name.length > MAINTENANCE_WINDOW_LIMITS.maximumNameLength) {
    fields.name = [`Use 1–${MAINTENANCE_WINDOW_LIMITS.maximumNameLength} characters for the name.`];
  }
  return name;
}

function parseSchedule(
  value: unknown,
  fields: Record<string, string[]>,
): MaintenanceWindowSchedule {
  if (!isRecord(value) || (value.type !== 'ONE_TIME' && value.type !== 'RECURRING')) {
    fields.schedule = ['Choose a one-time or recurring schedule.'];
    return fallbackSchedule();
  }
  if (value.type === 'ONE_TIME') {
    if (!hasExactKeys(value, ['endsAt', 'startsAt', 'type'])) {
      fields.schedule = ['One-time schedules contain type, startsAt, and endsAt.'];
      return fallbackSchedule();
    }
    const startsAt = parseIsoInstant(value.startsAt, 'startsAt', fields);
    const endsAt = parseIsoInstant(value.endsAt, 'endsAt', fields);
    if (startsAt && endsAt) {
      const durationMinutes = (Date.parse(endsAt) - Date.parse(startsAt)) / 60_000;
      if (
        durationMinutes < MAINTENANCE_WINDOW_LIMITS.minimumDurationMinutes ||
        durationMinutes > MAINTENANCE_WINDOW_LIMITS.maximumDurationMinutes
      ) {
        fields.endsAt = [
          `Window duration must be ${MAINTENANCE_WINDOW_LIMITS.minimumDurationMinutes}–${MAINTENANCE_WINDOW_LIMITS.maximumDurationMinutes} minutes.`,
        ];
      }
    }
    return { type: 'ONE_TIME', startsAt, endsAt };
  }

  if (
    !hasExactKeys(value, [
      'daysOfWeek',
      'durationMinutes',
      'endsOn',
      'localTime',
      'startsOn',
      'timezone',
      'type',
    ])
  ) {
    fields.schedule = [
      'Recurring schedules contain type, timezone, localTime, daysOfWeek, durationMinutes, startsOn, and endsOn.',
    ];
    return fallbackSchedule();
  }
  const timezone = typeof value.timezone === 'string' ? value.timezone.trim() : '';
  if (!isTimeZone(timezone)) fields.timezone = ['Choose a valid IANA time zone.'];
  const localTime = typeof value.localTime === 'string' ? value.localTime.trim() : '';
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(localTime)) {
    fields.localTime = ['Use a 24-hour time such as 02:30.'];
  }
  const daysOfWeek = parseDaysOfWeek(value.daysOfWeek, fields);
  const durationMinutes = parseDuration(value.durationMinutes, fields);
  const startsOn = parseDateOnly(value.startsOn, 'startsOn', fields);
  const endsOn = value.endsOn === null ? null : parseDateOnly(value.endsOn, 'endsOn', fields);
  if (startsOn && endsOn && endsOn < startsOn) {
    fields.endsOn = ['The recurrence end date must be on or after its start date.'];
  }
  return {
    type: 'RECURRING',
    timezone,
    localTime,
    daysOfWeek,
    durationMinutes,
    startsOn,
    endsOn,
  };
}

function parseTarget(value: unknown, fields: Record<string, string[]>): MaintenanceWindowTarget {
  if (!isRecord(value) || (value.type !== 'PROJECT' && value.type !== 'MONITORS')) {
    fields.target = ['Choose the entire project or selected monitors.'];
    return { type: 'PROJECT' };
  }
  if (value.type === 'PROJECT') {
    if (!hasExactKeys(value, ['type'])) fields.target = ['Project targets contain only type.'];
    return { type: 'PROJECT' };
  }
  if (!hasExactKeys(value, ['monitorIds', 'type']) || !Array.isArray(value.monitorIds)) {
    fields.monitorIds = ['Choose at least one monitor.'];
    return { type: 'MONITORS', monitorIds: [] };
  }
  const monitorIds = value.monitorIds.filter((id): id is string => typeof id === 'string');
  if (
    monitorIds.length !== value.monitorIds.length ||
    monitorIds.length === 0 ||
    monitorIds.length > MAINTENANCE_WINDOW_LIMITS.maximumTargetMonitors ||
    new Set(monitorIds).size !== monitorIds.length
  ) {
    fields.monitorIds = [
      `Choose 1–${MAINTENANCE_WINDOW_LIMITS.maximumTargetMonitors} unique monitors.`,
    ];
  }
  return { type: 'MONITORS', monitorIds };
}

function parseEffects(value: unknown, fields: Record<string, string[]>): MaintenanceWindowEffects {
  const keys = [
    'excludeFromUptime',
    'publishToStatusPage',
    'suppressIncidentCreation',
    'suppressNotifications',
  ];
  if (!hasExactKeys(value, keys)) {
    fields.effects = ['Choose all four maintenance behaviors explicitly.'];
    return emptyEffects();
  }
  const effects = Object.fromEntries(
    keys.map((key) => [key, typeof value[key] === 'boolean' ? value[key] : false]),
  ) as unknown as MaintenanceWindowEffects;
  if (keys.some((key) => typeof value[key] !== 'boolean')) {
    fields.effects = ['Maintenance behaviors must be true or false.'];
  }
  if (!Object.values(effects).some(Boolean)) {
    fields.effects = ['Enable at least one maintenance behavior.'];
  }
  return effects;
}

function parseDaysOfWeek(value: unknown, fields: Record<string, string[]>): number[] {
  const days: unknown[] = Array.isArray(value) ? value : [];
  if (
    days.length === 0 ||
    days.length > 7 ||
    days.some((day) => !Number.isInteger(day) || Number(day) < 0 || Number(day) > 6) ||
    new Set(days).size !== days.length
  ) {
    fields.daysOfWeek = ['Choose one or more unique weekdays.'];
    return [1];
  }
  return days.map((day) => Number(day)).sort((left, right) => left - right);
}

function parseDuration(value: unknown, fields: Record<string, string[]>): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < MAINTENANCE_WINDOW_LIMITS.minimumDurationMinutes ||
    Number(value) > MAINTENANCE_WINDOW_LIMITS.maximumDurationMinutes
  ) {
    fields.durationMinutes = [
      `Use ${MAINTENANCE_WINDOW_LIMITS.minimumDurationMinutes}–${MAINTENANCE_WINDOW_LIMITS.maximumDurationMinutes} whole minutes.`,
    ];
    return MAINTENANCE_WINDOW_LIMITS.minimumDurationMinutes;
  }
  return Number(value);
}

function parseIsoInstant(value: unknown, field: string, fields: Record<string, string[]>): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    fields[field] = ['Use a valid ISO 8601 date and time.'];
    return new Date(0).toISOString();
  }
  return new Date(value).toISOString();
}

function parseDateOnly(value: unknown, field: string, fields: Record<string, string[]>): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    fields[field] = ['Use a date in YYYY-MM-DD format.'];
    return '1970-01-01';
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fields[field] = ['Use a real calendar date in YYYY-MM-DD format.'];
  }
  return value;
}

function cronExpression(schedule: Extract<MaintenanceWindowSchedule, { type: 'RECURRING' }>) {
  const [hour, minute] = schedule.localTime.split(':').map(Number);
  return `${minute} ${hour} * * ${schedule.daysOfWeek.join(',')}`;
}

function recurringDateInRange(
  schedule: Extract<MaintenanceWindowSchedule, { type: 'RECURRING' }>,
  startsAt: Date,
): boolean {
  const localDate = dateInTimeZone(startsAt, schedule.timezone);
  return (
    localDate >= schedule.startsOn && (schedule.endsOn === null || localDate <= schedule.endsOn)
  );
}

function dateInTimeZone(value: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function oneTimeOccurrence(
  schedule: Extract<MaintenanceWindowSchedule, { type: 'ONE_TIME' }>,
): MaintenanceOccurrence {
  return { startsAt: new Date(schedule.startsAt), endsAt: new Date(schedule.endsAt) };
}

function overlaps(occurrence: MaintenanceOccurrence, from: Date, to: Date): boolean {
  return occurrence.startsAt < to && occurrence.endsAt > from;
}

function fallbackSchedule(): MaintenanceWindowSchedule {
  return {
    type: 'ONE_TIME',
    startsAt: new Date(0).toISOString(),
    endsAt: new Date(60_000).toISOString(),
  };
}

function emptyEffects(): MaintenanceWindowEffects {
  return {
    suppressNotifications: false,
    suppressIncidentCreation: false,
    excludeFromUptime: false,
    publishToStatusPage: false,
  };
}

function isTimeZone(value: string): boolean {
  if (value.length === 0 || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function assertValidDate(value: Date, field: string): void {
  if (Number.isNaN(value.getTime())) throw new RangeError(`${field} must be a valid date.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys<T extends readonly string[]>(
  value: unknown,
  keys: T,
): value is Record<T[number], unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
