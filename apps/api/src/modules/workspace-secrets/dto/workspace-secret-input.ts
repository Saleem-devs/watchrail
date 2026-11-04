import { z } from 'zod';

export const createWorkspaceSecretSchema = z
  .object({
    key: z.string(),
    description: z.string().nullable().optional(),
    value: z.string(),
  })
  .strict();

export const updateWorkspaceSecretSchema = z
  .object({ description: z.string().nullable() })
  .strict();

export const rotateWorkspaceSecretSchema = z.object({ value: z.string() }).strict();

export const listWorkspaceSecretsQuerySchema = z
  .object({
    includeArchived: z.enum(['true', 'false']).optional(),
  })
  .strict();

export type CreateWorkspaceSecretInput = z.infer<typeof createWorkspaceSecretSchema>;
export type UpdateWorkspaceSecretInput = z.infer<typeof updateWorkspaceSecretSchema>;
export type RotateWorkspaceSecretInput = z.infer<typeof rotateWorkspaceSecretSchema>;
export type ListWorkspaceSecretsQuery = z.infer<typeof listWorkspaceSecretsQuerySchema>;
