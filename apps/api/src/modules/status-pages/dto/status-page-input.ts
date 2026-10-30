import { z } from 'zod';

const componentSchema = z
  .object({
    displayName: z.string(),
    groupName: z.string().max(100).nullable().optional(),
    monitorId: z.uuid(),
    position: z.number().int(),
  })
  .strict();

const logoUrlSchema = z
  .string()
  .max(2048)
  .refine((value) => value.startsWith('/') || /^https?:\/\//u.test(value), {
    message: 'logoUrl must be an HTTP(S) URL or a root-relative path.',
  })
  .nullable();

export const createStatusPageSchema = z
  .object({
    name: z.string(),
    logoUrl: logoUrlSchema.optional(),
    slug: z.string(),
    published: z.boolean().optional(),
    components: z.array(componentSchema),
  })
  .strict();

export const updateStatusPageSettingsSchema = z
  .object({
    name: z.string(),
    logoUrl: logoUrlSchema.optional(),
    slug: z.string(),
  })
  .strict();

export const replaceStatusPageComponentsSchema = z
  .object({
    components: z.array(componentSchema),
  })
  .strict();

export const setStatusPagePublicationSchema = z
  .object({
    published: z.boolean(),
  })
  .strict();

export type CreateStatusPageInput = z.infer<typeof createStatusPageSchema>;
export type UpdateStatusPageSettingsInput = z.infer<typeof updateStatusPageSettingsSchema>;
export type ReplaceStatusPageComponentsInput = z.infer<typeof replaceStatusPageComponentsSchema>;
export type SetStatusPagePublicationInput = z.infer<typeof setStatusPagePublicationSchema>;
