import { describe, expect, it, vi } from 'vitest';
import { OrganizationsService } from './organizations.service.js';

describe('organization invitation tenant boundary', () => {
  const context = {
    actorId: '11111111-1111-4111-8111-111111111111',
    organizationId: '22222222-2222-4222-8222-222222222222',
    authenticationType: 'SESSION' as const,
  };
  const invitationId = '33333333-3333-4333-8333-333333333333';
  const headers = new Headers();

  function setup(owned: boolean) {
    const cancelInvitation = vi.fn().mockResolvedValue(undefined);
    const supersedeInvitation = vi.fn().mockResolvedValue(undefined);
    const belongsToOrganization = vi.fn().mockResolvedValue(owned);
    const service = new OrganizationsService(
      { api: { cancelInvitation } } as never,
      {} as never,
      { supersedeInvitation } as never,
      { belongsToOrganization } as never,
    );
    return { service, cancelInvitation, supersedeInvitation, belongsToOrganization };
  }

  it('returns indistinguishable not-found errors without mutating a foreign invitation or outbox', async () => {
    const { service, cancelInvitation, supersedeInvitation, belongsToOrganization } = setup(false);
    await expect(service.revokeInvitation(context, headers, invitationId)).rejects.toMatchObject({
      status: 404,
      response: { code: 'INVITATION_NOT_FOUND', message: 'Invitation not found.' },
    });
    expect(belongsToOrganization).toHaveBeenCalledWith(context.organizationId, invitationId);
    expect(cancelInvitation).not.toHaveBeenCalled();
    expect(supersedeInvitation).not.toHaveBeenCalled();
  });

  it('retains Better Auth cancellation and outbox supersession for an owned invitation', async () => {
    const { service, cancelInvitation, supersedeInvitation } = setup(true);
    await service.revokeInvitation(context, headers, invitationId);
    expect(cancelInvitation).toHaveBeenCalledWith({
      body: { invitationId },
      headers,
    });
    expect(supersedeInvitation).toHaveBeenCalledWith(invitationId);
  });

  it('does not supersede the outbox if Better Auth refuses cancellation', async () => {
    const { service, cancelInvitation, supersedeInvitation } = setup(true);
    cancelInvitation.mockRejectedValueOnce(new Error('Better Auth rejected cancellation.'));
    await expect(service.revokeInvitation(context, headers, invitationId)).rejects.toThrow(
      'Better Auth rejected cancellation.',
    );
    expect(supersedeInvitation).not.toHaveBeenCalled();
  });
});
