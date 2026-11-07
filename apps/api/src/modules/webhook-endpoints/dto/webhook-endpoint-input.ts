import { z } from 'zod';

const signingSecretUpdateSchema = z.union([
  z.object({ retain: z.literal(true) }).strict(),
  z.object({ value: z.string() }).strict(),
]);

export const webhookEndpointRoutingSchema = z
  .object({
    allMonitors: z.boolean().default(false),
    monitorIds: z.array(z.uuid()).max(500),
    notifyOnIncident: z.boolean(),
    notifyOnRecovery: z.boolean(),
  })
  .strict();

export const createWebhookEndpointSchema = z
  .object({
    name: z.string(),
    url: z.string(),
    signingSecret: z.string(),
    enabled: z.boolean().optional(),
    projectId: z.uuid().optional(),
    routing: webhookEndpointRoutingSchema.optional(),
  })
  .strict();

export const updateWebhookEndpointSettingsSchema = z
  .object({
    name: z.string(),
    url: z.string(),
    signingSecret: signingSecretUpdateSchema,
  })
  .strict();

export const updateWebhookEndpointConfigurationSchema = z
  .object({
    name: z.string(),
    url: z.string(),
    signingSecret: signingSecretUpdateSchema,
    routing: webhookEndpointRoutingSchema,
  })
  .strict();

export const setWebhookEndpointEnabledSchema = z.object({ enabled: z.boolean() }).strict();

export const updateWebhookEndpointRoutingSchema = webhookEndpointRoutingSchema;

export type CreateWebhookEndpointInput = z.infer<typeof createWebhookEndpointSchema>;
export type UpdateWebhookEndpointSettingsInput = z.infer<
  typeof updateWebhookEndpointSettingsSchema
>;
export type UpdateWebhookEndpointConfigurationInput = z.infer<
  typeof updateWebhookEndpointConfigurationSchema
>;
export type SetWebhookEndpointEnabledInput = z.infer<typeof setWebhookEndpointEnabledSchema>;
export type UpdateWebhookEndpointRoutingInput = z.infer<typeof updateWebhookEndpointRoutingSchema>;
