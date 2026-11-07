import { describe, expect, it } from 'vitest';
import {
  IncidentHistoryQueryError,
  parseIncidentHistoryQuery,
  parseOrganizationIncidentHistoryQuery,
} from './incident-read-repository.js';

describe('parseIncidentHistoryQuery', () => {
  it('defaults and accepts strict limits', () => {
    expect(parseIncidentHistoryQuery({})).toEqual({ limit: 25 });
    expect(parseIncidentHistoryQuery({ limit: '100' })).toEqual({ limit: 100 });
  });

  it.each([
    { limit: '0' },
    { limit: '101' },
    { limit: '1.5' },
    { limit: '01' },
    { cursor: 'invalid' },
    { status: 'OPEN' },
  ])('rejects invalid query %#', (query) => {
    expect(() => parseIncidentHistoryQuery(query)).toThrow(IncidentHistoryQueryError);
  });
});

describe('parseOrganizationIncidentHistoryQuery', () => {
  it('accepts strict status and severity filters', () => {
    expect(
      parseOrganizationIncidentHistoryQuery({
        page: '2',
        limit: '50',
        status: 'OPEN',
        severity: 'DOWN',
      }),
    ).toEqual({ page: 2, limit: 50, status: 'OPEN', severity: 'DOWN' });
  });

  it.each([{ severity: 'CRITICAL' }, { severity: 'down' }, { groupKey: 'availability:x' }])(
    'rejects an unsupported organization query %#',
    (query) => {
      expect(() => parseOrganizationIncidentHistoryQuery(query)).toThrow(IncidentHistoryQueryError);
    },
  );
});
