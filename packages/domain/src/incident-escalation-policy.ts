export const INCIDENT_REMINDER_MIN_DELAY_MINUTES = 5;
export const INCIDENT_REMINDER_MAX_DELAY_MINUTES = 7 * 24 * 60;
export const INCIDENT_REMINDER_MAX_STEPS = 3;

export interface IncidentEscalationStep {
  delayMinutes: number;
  channelIds: string[] | null;
}

export interface IncidentEscalationPolicy {
  steps: IncidentEscalationStep[];
}

export class IncidentEscalationPolicyInputError extends Error {
  constructor(readonly fields: { steps?: string[] }) {
    super('Incident escalation policy is invalid.');
    this.name = 'IncidentEscalationPolicyInputError';
  }
}

export function parseIncidentEscalationPolicy(value: unknown): IncidentEscalationPolicy {
  const input = isRecord(value) ? value : {};
  const steps: unknown[] | null = Array.isArray(input.steps) ? input.steps : null;
  if (!steps) {
    throw new IncidentEscalationPolicyInputError({
      steps: ['Provide an escalation schedule.'],
    });
  }
  if (steps.length > INCIDENT_REMINDER_MAX_STEPS) {
    throw new IncidentEscalationPolicyInputError({
      steps: [`Configure no more than ${INCIDENT_REMINDER_MAX_STEPS} reminders.`],
    });
  }
  const parsedSteps = steps.map((step) => {
    if (!isRecord(step)) invalid('Each reminder must include a delay and channel routing.');
    const delayMinutes = step.delayMinutes;
    const channelIds = step.channelIds;
    if (
      typeof delayMinutes !== 'number' ||
      !Number.isSafeInteger(delayMinutes) ||
      delayMinutes < INCIDENT_REMINDER_MIN_DELAY_MINUTES ||
      delayMinutes > INCIDENT_REMINDER_MAX_DELAY_MINUTES
    ) {
      invalid(
        `Use whole-minute delays from ${INCIDENT_REMINDER_MIN_DELAY_MINUTES} to ${INCIDENT_REMINDER_MAX_DELAY_MINUTES}.`,
      );
    }
    if (channelIds !== null && !Array.isArray(channelIds)) {
      invalid('Choose all eligible channels or at least one specific channel.');
    }
    const parsedChannelIds = channelIds === null ? null : channelIds.map(parseChannelId);
    if (parsedChannelIds && parsedChannelIds.length === 0) {
      invalid('Choose at least one channel for a targeted reminder.');
    }
    if (parsedChannelIds && new Set(parsedChannelIds).size !== parsedChannelIds.length) {
      invalid('A reminder cannot target the same channel more than once.');
    }
    return { delayMinutes, channelIds: parsedChannelIds };
  });
  if (
    parsedSteps.some(
      (step, index) =>
        index > 0 && step.delayMinutes <= (parsedSteps[index - 1]?.delayMinutes ?? 0),
    )
  ) {
    invalid('Each reminder must occur later than the previous reminder.');
  }
  return { steps: parsedSteps };
}

function parseChannelId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    invalid('Every selected channel must have a valid identifier.');
  }
  return value.toLowerCase();
}

function invalid(message: string): never {
  throw new IncidentEscalationPolicyInputError({ steps: [message] });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
