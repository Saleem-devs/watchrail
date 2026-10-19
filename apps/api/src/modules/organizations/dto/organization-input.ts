import { z } from 'zod';

export const updateOrganizationSchema = z
  .object({
    name: z.string().optional(),
    slug: z.string().optional(),
  })
  .strict();

export const transferOwnershipSchema = z.object({ userId: z.string() }).strict();
export const updateMemberRoleSchema = z.object({ role: z.string() }).strict();
export const createInvitationSchema = z
  .object({
    email: z.string(),
    role: z.string(),
  })
  .strict();

export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;
export type TransferOwnershipInput = z.infer<typeof transferOwnershipSchema>;
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;
export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;
