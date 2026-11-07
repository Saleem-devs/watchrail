import { z } from 'zod';

export const slackChannelRoutingSchema = z
  .object({
    allMonitors: z.boolean().default(false),
    monitorIds: z.array(z.uuid()).max(500),
    notifyOnIncident: z.boolean(),
    notifyOnRecovery: z.boolean(),
  })
  .strict();

const webhookUrlUpdateSchema = z.union([
  z.object({ retain: z.literal(true) }).strict(),
  z.object({ value: z.string() }).strict(),
]);

export const createSlackChannelSchema = z
  .object({
    projectId: z.uuid(),
    name: z.string(),
    webhookUrl: z.string(),
    enabled: z.boolean().optional(),
    routing: slackChannelRoutingSchema,
  })
  .strict();

export const updateSlackChannelSchema = z
  .object({
    name: z.string(),
    webhookUrl: webhookUrlUpdateSchema,
    routing: slackChannelRoutingSchema,
  })
  .strict();

export const setSlackChannelEnabledSchema = z.object({ enabled: z.boolean() }).strict();
export const slackDeliveryQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(100).optional() })
  .strict();

export type CreateSlackChannelInput = z.infer<typeof createSlackChannelSchema>;
export type UpdateSlackChannelInput = z.infer<typeof updateSlackChannelSchema>;
export type SetSlackChannelEnabledInput = z.infer<typeof setSlackChannelEnabledSchema>;
export type SlackDeliveryQuery = z.infer<typeof slackDeliveryQuerySchema>;
