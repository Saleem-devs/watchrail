import { z } from 'zod';

export const updateMonitorNameSchema = z
  .object({
    name: z.string().trim().min(1, 'Monitor name is required.').max(120),
  })
  .strict();

export type UpdateMonitorNameDto = z.infer<typeof updateMonitorNameSchema>;
