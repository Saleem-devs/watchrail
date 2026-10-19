export interface OrganizationRecord {
  id: string;
  name: string;
  slug?: string | null;
  createdAt?: Date | string;
}

export interface MemberRecord {
  id: string;
  userId: string;
  role: string;
  createdAt?: Date | string;
  user?: { name: string; email: string };
}

export interface InvitationRecord {
  id: string;
  email: string;
  role?: string | null;
  status: string;
  expiresAt?: Date | string;
}

export function presentOrganization(org: OrganizationRecord) {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug ?? null,
    createdAt: toIso(org.createdAt),
  };
}

export function presentMember(member: MemberRecord) {
  return {
    id: member.id,
    userId: member.userId,
    role: member.role,
    createdAt: toIso(member.createdAt),
    ...(member.user ? { user: { name: member.user.name, email: member.user.email } } : {}),
  };
}

export function presentInvitation(invitation: InvitationRecord) {
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role ?? null,
    status: invitation.status,
    expiresAt: toIso(invitation.expiresAt),
  };
}

function toIso(value: Date | string | undefined | null): string {
  if (!value) return new Date().toISOString();
  return value instanceof Date ? value.toISOString() : value;
}
