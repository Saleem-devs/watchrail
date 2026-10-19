import { describe, expect, it } from 'vitest';
import {
  presentInvitation,
  presentMember,
  presentOrganization,
} from './organizations.presenter.js';

describe('organization response presenters', () => {
  it('allow-lists organization fields', () => {
    const input = {
      id: 'org-id',
      name: 'Watchrail',
      slug: 'watchrail',
      createdAt: new Date('2026-10-19T00:00:00.000Z'),
      secret: 'not-public',
    };
    expect(presentOrganization(input)).toEqual({
      id: 'org-id',
      name: 'Watchrail',
      slug: 'watchrail',
      createdAt: '2026-10-19T00:00:00.000Z',
    });
  });

  it('limits member user fields to name and email', () => {
    const member = {
      id: 'member-id',
      userId: 'user-id',
      role: 'viewer',
      createdAt: '2026-10-19T00:00:00.000Z',
      user: { name: 'Member', email: 'member@example.test', secret: 'private' },
    };
    expect(presentMember(member)).toEqual({
      id: 'member-id',
      userId: 'user-id',
      role: 'viewer',
      createdAt: '2026-10-19T00:00:00.000Z',
      user: { name: 'Member', email: 'member@example.test' },
    });
  });

  it('excludes invitation internal metadata', () => {
    const invitation = {
      id: 'invitation-id',
      email: 'member@example.test',
      role: 'viewer',
      status: 'pending',
      expiresAt: new Date('2026-11-01T00:00:00.000Z'),
      token: 'private',
    };
    expect(presentInvitation(invitation)).toEqual({
      id: 'invitation-id',
      email: 'member@example.test',
      role: 'viewer',
      status: 'pending',
      expiresAt: '2026-11-01T00:00:00.000Z',
    });
  });
});
