import { z } from 'zod';

const componentSchema = z
  .object({
    displayName: z.string(),
    monitorId: z.uuid(),
    position: z.number().int(),
  })
  .strict();

export const createStatusPageSchema = z
  .object({
    name: z.string(),
    slug: z.string(),
    published: z.boolean().optional(),
    components: z.array(componentSchema),
  })
  .strict();

export const updateStatusPageSettingsSchema = z
  .object({
    name: z.string(),
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
