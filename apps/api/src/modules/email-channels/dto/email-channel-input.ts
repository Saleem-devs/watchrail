import { z } from 'zod';

export const emailChannelRoutingSchema = z
  .object({
    allMonitors: z.boolean().default(false),
    monitorIds: z.array(z.uuid()).max(500),
    notifyOnIncident: z.boolean(),
    notifyOnRecovery: z.boolean(),
  })
  .strict();

export const createEmailChannelSchema = z
  .object({
    projectId: z.uuid(),
    name: z.string(),
    recipientEmails: z.array(z.string()).min(1).max(20),
    enabled: z.boolean().optional(),
    routing: emailChannelRoutingSchema,
  })
  .strict();

export const updateEmailChannelSchema = z
  .object({
    name: z.string(),
    recipientEmails: z.array(z.string()).min(1).max(20),
    routing: emailChannelRoutingSchema,
  })
  .strict();

export const setEmailChannelEnabledSchema = z.object({ enabled: z.boolean() }).strict();

export const emailDeliveryQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

export type CreateEmailChannelInput = z.infer<typeof createEmailChannelSchema>;
export type UpdateEmailChannelInput = z.infer<typeof updateEmailChannelSchema>;
export type SetEmailChannelEnabledInput = z.infer<typeof setEmailChannelEnabledSchema>;
export type EmailDeliveryQuery = z.infer<typeof emailDeliveryQuerySchema>;
