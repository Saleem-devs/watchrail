import { describe, expect, it } from 'vitest';
import {
  createInvitationSchema,
  transferOwnershipSchema,
  updateMemberRoleSchema,
  updateOrganizationSchema,
} from './organization-input.js';

describe('organization request DTOs', () => {
  it('accepts settings, transfer, member role and invitation inputs', () => {
    expect(updateOrganizationSchema.parse({ name: 'Watchrail', slug: 'watchrail' })).toEqual({
      name: 'Watchrail',
      slug: 'watchrail',
    });
    expect(transferOwnershipSchema.safeParse({ userId: 'user-id' }).success).toBe(true);
    expect(updateMemberRoleSchema.safeParse({ role: 'editor' }).success).toBe(true);
    expect(
      createInvitationSchema.safeParse({ email: 'person@example.test', role: 'viewer' }).success,
    ).toBe(true);
  });

  it('rejects unknown properties, untrusted tenant IDs and wrong types', () => {
    expect(updateOrganizationSchema.safeParse({ organizationId: 'foreign' }).success).toBe(false);
    expect(updateOrganizationSchema.safeParse({ name: 12 }).success).toBe(false);
    expect(transferOwnershipSchema.safeParse({ userId: null }).success).toBe(false);
    expect(updateMemberRoleSchema.safeParse({ role: ['owner'] }).success).toBe(false);
    expect(createInvitationSchema.safeParse({ email: 42, role: 'viewer' }).success).toBe(false);
    expect(
      createInvitationSchema.safeParse({
        email: 'person@example.test',
        role: 'viewer',
        organizationId: 'foreign',
      }).success,
    ).toBe(false);
  });
});
