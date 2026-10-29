import { z } from 'zod';

const optionalSearchTerm = z
  .string()
  .trim()
  .max(160)
  .optional()
  .transform((value) => value || undefined);

export const monitorListQuerySchema = z
  .object({
    name: optionalSearchTerm,
    state: z.enum(['operational', 'attention', 'paused', 'pending']).optional(),
    location: optionalSearchTerm,
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(10).max(100).optional(),
  })
  .strict();

export type MonitorListQuery = z.infer<typeof monitorListQuerySchema>;
