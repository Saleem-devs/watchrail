import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadPublicStatusPage, PublicStatusPageUnavailableError } from './public-status-page';

describe('loadPublicStatusPage', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses the internal server token and disables the Next data cache', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            data: {
              contractVersion: 1,
              name: 'Acme',
              slug: 'loader-success',
              status: 'OPERATIONAL',
              components: [],
              activeIncidents: [],
              resolvedIncidents: [],
              generatedAt: '2026-10-10T00:00:00.000Z',
            },
          }),
          { status: 200 },
        ),
      );
    await expect(loadPublicStatusPage('loader-success')).resolves.toMatchObject({ name: 'Acme' });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/internal/status-pages/loader-success'),
      expect.objectContaining({
        cache: 'no-store',
        headers: expect.objectContaining({ 'x-watchrail-internal-token': expect.any(String) }),
      }),
    );
  });

  it('distinguishes not found from transient failure', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 429 }));
    await expect(loadPublicStatusPage('loader-missing')).resolves.toBeNull();
    await expect(loadPublicStatusPage('loader-throttled')).rejects.toBeInstanceOf(
      PublicStatusPageUnavailableError,
    );
  });
});
