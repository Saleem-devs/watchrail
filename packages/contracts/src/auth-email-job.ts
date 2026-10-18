export const AUTH_EMAIL_QUEUE = 'watchrail-auth-email';
export const DELIVER_AUTH_EMAIL_JOB = 'deliver-auth-email';

export interface DeliverAuthEmailJobV1 {
  contractVersion: 1;
  messageId: string;
}

export function parseDeliverAuthEmailJob(value: unknown): DeliverAuthEmailJobV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid auth email job.');
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== 2 ||
    input['contractVersion'] !== 1 ||
    typeof input['messageId'] !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      input['messageId'],
    )
  )
    throw new Error('Invalid auth email job.');
  return { contractVersion: 1, messageId: input['messageId'] };
}
