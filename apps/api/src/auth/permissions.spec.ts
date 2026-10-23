import { describe, expect, it } from 'vitest';
import {
  ORGANIZATION_ROLES,
  PERMISSIONS,
  hasPermission,
  isOrganizationRole,
  organizationRoles,
} from './permissions.js';

describe('Watchrail organization permissions', () => {
  it('keeps every supported role recognized by both authorization layers', () => {
    expect(Object.keys(organizationRoles).sort()).toEqual([...ORGANIZATION_ROLES].sort());
    for (const role of ORGANIZATION_ROLES) expect(isOrganizationRole(role)).toBe(true);
    expect(isOrganizationRole('super-admin')).toBe(false);
  });

  it('grants viewers read-only access and rejects the legacy member role', () => {
    expect(hasPermission('viewer', PERMISSIONS.MONITOR_READ)).toBe(true);
    expect(hasPermission('viewer', PERMISSIONS.MONITOR_UPDATE)).toBe(false);
    expect(hasPermission('viewer', PERMISSIONS.MEMBER_INVITE)).toBe(false);
    expect(hasPermission('member', PERMISSIONS.MONITOR_READ)).toBe(false);
  });

  it('allows editors to operate monitors without administering membership', () => {
    expect(hasPermission('editor', PERMISSIONS.MONITOR_CREATE)).toBe(true);
    expect(hasPermission('editor', PERMISSIONS.MONITOR_EXECUTE)).toBe(true);
    expect(hasPermission('editor', PERMISSIONS.MEMBER_UPDATE_ROLE)).toBe(false);
    expect(hasPermission('editor', PERMISSIONS.ORGANIZATION_UPDATE)).toBe(false);
  });

  it('reserves destructive organization operations for owners', () => {
    expect(hasPermission('admin', PERMISSIONS.MEMBER_UPDATE_ROLE)).toBe(true);
    expect(hasPermission('admin', PERMISSIONS.ORGANIZATION_DELETE)).toBe(false);
    expect(hasPermission('owner', PERMISSIONS.ORGANIZATION_DELETE)).toBe(true);
    expect(hasPermission('owner', PERMISSIONS.ORGANIZATION_TRANSFER)).toBe(true);
  });

  it('fails closed for an unknown persisted role', () => {
    expect(hasPermission('unknown', PERMISSIONS.MONITOR_READ)).toBe(false);
  });
});
