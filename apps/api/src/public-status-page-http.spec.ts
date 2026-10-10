import { describe, expect, it } from 'vitest';
import type { PublicStatusPageProjectionV1 } from '@watchrail/domain';
import {
  PUBLIC_STATUS_PAGE_CACHE_CONTROL,
  createPublicStatusPageEtag,
  ifNoneMatchMatches,
} from './public-status-page-http.js';

describe('public status page HTTP policy', () => {
  it('locks the exact 30/30 cache policy', () => {
    expect(PUBLIC_STATUS_PAGE_CACHE_CONTROL).toBe('public, max-age=30, stale-while-revalidate=30');
  });

  it('produces a stable ETag when only generatedAt changes', () => {
    const first = projection();
    expect(createPublicStatusPageEtag(first)).toBe(
      createPublicStatusPageEtag({ ...first, generatedAt: '2026-10-10T12:01:00.000Z' }),
    );
  });

  it('changes the ETag when an approved public field changes', () => {
    const first = projection();
    const changed = {
      ...first,
      status: 'MAJOR_OUTAGE' as const,
      components: [{ ...first.components[0]!, status: 'MAJOR_OUTAGE' as const }],
    };
    expect(createPublicStatusPageEtag(first)).not.toBe(createPublicStatusPageEtag(changed));
  });

  it('matches strong, weak, wildcard, and list validators', () => {
    const etag = createPublicStatusPageEtag(projection());
    expect(ifNoneMatchMatches(etag, etag)).toBe(true);
    expect(ifNoneMatchMatches(`W/${etag}`, etag)).toBe(true);
    expect(ifNoneMatchMatches('*', etag)).toBe(true);
    expect(ifNoneMatchMatches(`"other", ${etag}`, etag)).toBe(true);
    expect(ifNoneMatchMatches('"other"', etag)).toBe(false);
  });
});

function projection(): PublicStatusPageProjectionV1 {
  return {
    contractVersion: 1,
    name: 'Acme Status',
    slug: 'acme-status',
    status: 'OPERATIONAL',
    components: [
      { id: 'component-public-id', displayName: 'API', position: 0, status: 'OPERATIONAL' },
    ],
    activeIncidents: [],
    resolvedIncidents: [],
    generatedAt: '2026-10-10T12:00:00.000Z',
  };
}
