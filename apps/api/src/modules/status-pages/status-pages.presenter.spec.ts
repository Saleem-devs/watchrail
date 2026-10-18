import type { StatusPageRecord } from '@watchrail/db';
import { describe, expect, it } from 'vitest';
import { presentStatusPage } from './status-pages.presenter.js';

describe('presentStatusPage', () => {
  it('returns the authenticated API allow-list', () => {
    const record = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      organizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      name: 'Watchrail',
      slug: 'watchrail',
      published: true,
      components: [],
      createdAt: new Date('2026-10-19T00:00:00.000Z'),
      updatedAt: new Date('2026-10-19T00:01:00.000Z'),
    } satisfies StatusPageRecord;

    expect(presentStatusPage(record)).toEqual({
      id: record.id,
      name: 'Watchrail',
      slug: 'watchrail',
      published: true,
      components: [],
      createdAt: '2026-10-19T00:00:00.000Z',
      updatedAt: '2026-10-19T00:01:00.000Z',
    });
    expect(presentStatusPage(record)).not.toHaveProperty('organizationId');
  });
});
