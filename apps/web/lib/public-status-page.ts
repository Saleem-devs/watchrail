import type { PublicStatusPageProjectionV1 } from '@watchrail/domain';
import { cache } from 'react';

interface PublicStatusPageResponse {
  data: PublicStatusPageProjectionV1;
}

export class PublicStatusPageUnavailableError extends Error {
  constructor(readonly status: number) {
    super('The public status page is temporarily unavailable.');
    this.name = 'PublicStatusPageUnavailableError';
  }
}

export const loadPublicStatusPage = cache(
  async (slug: string): Promise<PublicStatusPageProjectionV1 | null> => {
    const apiUrl = process.env.API_URL ?? 'http://localhost:4000';
    const token =
      process.env.PUBLIC_STATUS_PAGE_INTERNAL_TOKEN ??
      (process.env.NODE_ENV === 'production'
        ? undefined
        : 'watchrail-development-status-page-token');
    if (!token) throw new PublicStatusPageUnavailableError(503);
    const response = await fetch(
      `${apiUrl}/api/internal/status-pages/${encodeURIComponent(slug)}`,
      {
        cache: 'no-store',
        headers: { 'x-watchrail-internal-token': token },
      },
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new PublicStatusPageUnavailableError(response.status);
    const body = (await response.json()) as PublicStatusPageResponse;
    if (!body.data || body.data.contractVersion !== 1)
      throw new PublicStatusPageUnavailableError(502);
    return body.data;
  },
);
