import { z } from 'zod';

const signingSecretUpdateSchema = z.union([
  z.object({ retain: z.literal(true) }).strict(),
  z.object({ value: z.string() }).strict(),
]);

export const createWebhookEndpointSchema = z
  .object({
    name: z.string(),
    url: z.string(),
    signingSecret: z.string(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const updateWebhookEndpointSettingsSchema = z
  .object({
    name: z.string(),
    url: z.string(),
    signingSecret: signingSecretUpdateSchema,
  })
  .strict();

export const setWebhookEndpointEnabledSchema = z.object({ enabled: z.boolean() }).strict();

export type CreateWebhookEndpointInput = z.infer<typeof createWebhookEndpointSchema>;
export type UpdateWebhookEndpointSettingsInput = z.infer<
  typeof updateWebhookEndpointSettingsSchema
>;
export type SetWebhookEndpointEnabledInput = z.infer<typeof setWebhookEndpointEnabledSchema>;
