/**
 * Watchrail permission catalogue.
 *
 * Permissions follow the pattern `resource:action`.
 *
 * Authorization is enforced by WatchrailAuthGuard, which checks whether the
 * authenticated user's role in the active organization grants the required
 * permission. No role-name string comparisons are performed in controllers —
 * only permission checks.
 */

// ─── Resource / action pairs ──────────────────────────────────────────────────

export const PERMISSIONS = {
  // Projects
  PROJECT_READ: 'project:read',
  PROJECT_MANAGE: 'project:manage',

  // Monitors
  MONITOR_READ: 'monitor:read',
  MONITOR_CREATE: 'monitor:create',
  MONITOR_UPDATE: 'monitor:update',
  MONITOR_DELETE: 'monitor:delete',
  MONITOR_EXECUTE: 'monitor:execute',

  // Checks / history
  CHECK_READ: 'check:read',

  // Incidents
  INCIDENT_READ: 'incident:read',

  // Availability / uptime
  AVAILABILITY_READ: 'availability:read',

  // Probe management
  PROBE_READ: 'probe:read',
  PROBE_MANAGE: 'probe:manage',

  // Status pages
  STATUS_PAGE_READ: 'statusPage:read',
  STATUS_PAGE_MANAGE: 'statusPage:manage',

  // Webhooks
  WEBHOOK_READ: 'webhook:read',
  WEBHOOK_MANAGE: 'webhook:manage',

  // Notifications (read-only; delivery is worker-triggered)
  NOTIFICATION_READ: 'notification:read',

  // Members & invitations
  MEMBER_READ: 'member:read',
  MEMBER_INVITE: 'member:invite',
  MEMBER_REMOVE: 'member:remove',
  MEMBER_UPDATE_ROLE: 'member:updateRole',

  // Organization settings
  ORGANIZATION_READ: 'organization:read',
  ORGANIZATION_UPDATE: 'organization:update',
  ORGANIZATION_DELETE: 'organization:delete',
  ORGANIZATION_TRANSFER: 'organization:transfer',

  // API credentials
  API_KEY_READ: 'apiKey:read',
  API_KEY_MANAGE: 'apiKey:manage',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ORGANIZATION_ROLES = ['owner', 'admin', 'editor', 'viewer'] as const;

export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

// ─── Role definitions ─────────────────────────────────────────────────────────

import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements } from 'better-auth/plugins/organization/access';

const VIEWER_PERMISSIONS: Permission[] = [
  PERMISSIONS.PROJECT_READ,
  PERMISSIONS.MONITOR_READ,
  PERMISSIONS.CHECK_READ,
  PERMISSIONS.INCIDENT_READ,
  PERMISSIONS.AVAILABILITY_READ,
  PERMISSIONS.PROBE_READ,
  PERMISSIONS.STATUS_PAGE_READ,
  PERMISSIONS.WEBHOOK_READ,
  PERMISSIONS.NOTIFICATION_READ,
  PERMISSIONS.MEMBER_READ,
  PERMISSIONS.ORGANIZATION_READ,
  PERMISSIONS.API_KEY_READ,
];

const EDITOR_PERMISSIONS: Permission[] = [
  ...VIEWER_PERMISSIONS,
  PERMISSIONS.MONITOR_CREATE,
  PERMISSIONS.MONITOR_UPDATE,
  PERMISSIONS.MONITOR_EXECUTE,
  PERMISSIONS.PROJECT_MANAGE,
  PERMISSIONS.STATUS_PAGE_MANAGE,
  PERMISSIONS.WEBHOOK_MANAGE,
];

const ADMIN_PERMISSIONS: Permission[] = [
  ...EDITOR_PERMISSIONS,
  PERMISSIONS.MONITOR_DELETE,
  PERMISSIONS.PROBE_MANAGE,
  PERMISSIONS.MEMBER_INVITE,
  PERMISSIONS.MEMBER_REMOVE,
  PERMISSIONS.MEMBER_UPDATE_ROLE,
  PERMISSIONS.ORGANIZATION_UPDATE,
  PERMISSIONS.API_KEY_MANAGE,
];

const OWNER_PERMISSIONS: Permission[] = [
  ...ADMIN_PERMISSIONS,
  PERMISSIONS.ORGANIZATION_DELETE,
  PERMISSIONS.ORGANIZATION_TRANSFER,
];

export const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  owner: OWNER_PERMISSIONS,
  admin: ADMIN_PERMISSIONS,
  editor: EDITOR_PERMISSIONS,
  viewer: VIEWER_PERMISSIONS,
};

/**
 * Better Auth protects its own organization mutation endpoints separately
 * from Watchrail's controller guard. Keep those role names and capabilities
 * aligned with the Watchrail catalogue so an invitation cannot create a role
 * that Better Auth subsequently treats as unknown.
 */
export const organizationAccessControl = createAccessControl(defaultStatements);

export const organizationRoles = {
  owner: organizationAccessControl.newRole({
    organization: ['update', 'delete'],
    member: ['create', 'update', 'delete'],
    invitation: ['create', 'cancel'],
    team: ['create', 'update', 'delete'],
    ac: ['create', 'read', 'update', 'delete'],
  }),
  admin: organizationAccessControl.newRole({
    organization: ['update'],
    member: ['create', 'update', 'delete'],
    invitation: ['create', 'cancel'],
    team: ['create', 'update', 'delete'],
    ac: ['create', 'read', 'update', 'delete'],
  }),
  editor: organizationAccessControl.newRole({
    organization: [],
    member: [],
    invitation: [],
    team: [],
    ac: ['read'],
  }),
  viewer: organizationAccessControl.newRole({
    organization: [],
    member: [],
    invitation: [],
    team: [],
    ac: ['read'],
  }),
} as const;

/**
 * Returns true if the given role grants the given permission.
 */
export function hasPermission(role: string, permission: Permission): boolean {
  const granted = ROLE_PERMISSIONS[role];
  if (!granted) return false;
  return granted.includes(permission);
}

export function isOrganizationRole(value: string): value is OrganizationRole {
  return (ORGANIZATION_ROLES as readonly string[]).includes(value);
}
