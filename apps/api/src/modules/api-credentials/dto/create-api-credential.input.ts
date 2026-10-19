import { z } from 'zod';
import { PERMISSIONS, type Permission } from '../../../permissions.js';

const permissionValues = Object.values(PERMISSIONS) as [Permission, ...Permission[]];

export const createApiCredentialSchema = z
  .object({
    name: z
      .string()
      .refine((value) => value.trim().length > 0 && value.length <= 120, {
        message: 'API credential name must contain 1 to 120 characters.',
      })
      .transform((value) => value.trim()),
    permissions: z.array(z.enum(permissionValues)).min(1).max(permissionValues.length),
    expiresAt: z.string().nullable().optional(),
  })
  .strict();

export type CreateApiCredentialInput = z.infer<typeof createApiCredentialSchema>;
