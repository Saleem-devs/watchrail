export const INCIDENT_REMINDER_MIN_DELAY_MINUTES = 5;
export const INCIDENT_REMINDER_MAX_DELAY_MINUTES = 7 * 24 * 60;
export const INCIDENT_REMINDER_MAX_STEPS = 3;

export interface IncidentReminderPolicy {
  delaysMinutes: number[];
}

export class IncidentReminderPolicyInputError extends Error {
  constructor(readonly fields: { delaysMinutes?: string[] }) {
    super('Incident reminder policy is invalid.');
    this.name = 'IncidentReminderPolicyInputError';
  }
}

export function parseIncidentReminderPolicy(value: unknown): IncidentReminderPolicy {
  const input = isRecord(value) ? value : {};
  const delays: unknown[] | null = Array.isArray(input.delaysMinutes) ? input.delaysMinutes : null;
  if (!delays) {
    throw new IncidentReminderPolicyInputError({
      delaysMinutes: ['Provide a reminder schedule.'],
    });
  }
  if (delays.length > INCIDENT_REMINDER_MAX_STEPS) {
    throw new IncidentReminderPolicyInputError({
      delaysMinutes: [`Configure no more than ${INCIDENT_REMINDER_MAX_STEPS} reminders.`],
    });
  }
  const numericDelays = delays.map((delay) => (typeof delay === 'number' ? delay : Number.NaN));
  if (
    numericDelays.some(
      (delay) =>
        !Number.isSafeInteger(delay) ||
        delay < INCIDENT_REMINDER_MIN_DELAY_MINUTES ||
        delay > INCIDENT_REMINDER_MAX_DELAY_MINUTES,
    )
  ) {
    throw new IncidentReminderPolicyInputError({
      delaysMinutes: [
        `Use whole minutes from ${INCIDENT_REMINDER_MIN_DELAY_MINUTES} to ${INCIDENT_REMINDER_MAX_DELAY_MINUTES}.`,
      ],
    });
  }
  if (numericDelays.some((delay, index) => index > 0 && delay <= (numericDelays[index - 1] ?? 0))) {
    throw new IncidentReminderPolicyInputError({
      delaysMinutes: ['Each reminder must occur later than the previous reminder.'],
    });
  }
  return { delaysMinutes: [...numericDelays] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
