import { createHash } from 'node:crypto';
import { STATUS_PAGE_CACHE_POLICY, type PublicStatusPageProjectionV1 } from '@watchrail/domain';

export const PUBLIC_STATUS_PAGE_CACHE_CONTROL =
  `public, max-age=${STATUS_PAGE_CACHE_POLICY.maxAgeSeconds}, ` +
  `stale-while-revalidate=${STATUS_PAGE_CACHE_POLICY.staleWhileRevalidateSeconds}`;

export const PUBLIC_STATUS_PAGE_NO_STORE = 'no-store';

/** Hashes only the approved stable public fields; generatedAt is intentionally excluded. */
export function createPublicStatusPageEtag(page: PublicStatusPageProjectionV1): string {
  const stableProjection = {
    contractVersion: page.contractVersion,
    name: page.name,
    slug: page.slug,
    status: page.status,
    components: page.components,
    activeIncidents: page.activeIncidents,
    resolvedIncidents: page.resolvedIncidents,
  };
  const digest = createHash('sha256').update(JSON.stringify(stableProjection)).digest('base64url');
  return `W/"${digest}"`;
}

export function ifNoneMatchMatches(value: string | undefined, etag: string): boolean {
  if (!value) return false;
  return value.split(',').some((candidate) => {
    const normalized = candidate.trim();
    return normalized === '*' || withoutWeakPrefix(normalized) === withoutWeakPrefix(etag);
  });
}

function withoutWeakPrefix(value: string): string {
  return value.startsWith('W/') ? value.slice(2) : value;
}
