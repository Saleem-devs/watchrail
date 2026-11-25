import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatusPageDomainPanel } from './status-page-domain-panel';
const state = {
  cnameTarget: 'domains.watchrail.dev',
  ownershipVerified: true,
  routingVerified: true,
  httpsReady: false,
  domain: { hostname: 'status.example.com', verificationToken: 'challenge', lastCheckedAt: null },
};
afterEach(() => vi.unstubAllGlobals());
describe('custom domain readiness presentation', () => {
  it('does not call a DNS-verified domain Ready until HTTPS succeeds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ data: state }))),
    );
    render(<StatusPageDomainPanel pageId="page" published />);
    expect(await screen.findByText('Setup pending')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open page' })).not.toBeInTheDocument();
    expect(screen.getByText('Secure page not verified')).toBeInTheDocument();
    expect(screen.getAllByText('watchrail-verification=challenge').length).toBeGreaterThan(0);
  });
  it('provides the custom HTTPS link only when Ready', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ data: { ...state, httpsReady: true } }))),
    );
    render(<StatusPageDomainPanel pageId="page" published />);
    expect(await screen.findByRole('link', { name: 'Open page' })).toHaveAttribute(
      'href',
      'https://status.example.com',
    );
  });
  it('immediately removes Ready when the page is unpublished', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ data: { ...state, httpsReady: true } }))),
    );
    render(<StatusPageDomainPanel pageId="page" published={false} />);
    expect(await screen.findByText('Page unpublished')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open page' })).not.toBeInTheDocument();
  });
});
