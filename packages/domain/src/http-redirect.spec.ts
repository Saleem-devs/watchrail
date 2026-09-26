import { describe, expect, it } from 'vitest';
import {
  HttpRedirectDiagnosticsInvariantError,
  formatHttpRedirectOrigin,
  parseHttpRedirectHops,
} from './http-redirect.js';

const validHop = {
  sequence: 1,
  statusCode: 302,
  source: { targetId: 1, origin: 'https://example.com:443' },
  destination: { targetId: 2, origin: 'https://status.example:443' },
  responseTimeMs: 12.5,
  headers: 'STRIPPED',
} as const;

describe('HTTP redirect diagnostics persistence contract', () => {
  it('parses and copies the exact safe shape', () => {
    expect(parseHttpRedirectHops([validHop])).toEqual([validHop]);
  });

  it('accepts different target identities on the same origin', () => {
    const secondHop = {
      ...validHop,
      sequence: 2,
      source: validHop.destination,
      destination: { targetId: 3, origin: 'https://status.example:443' },
    };

    expect(parseHttpRedirectHops([validHop, secondHop])).toEqual([validHop, secondHop]);
  });

  it.each([
    { ...validHop, rawLocation: '/secret' },
    { ...validHop, source: { ...validHop.source, pathname: '/secret' } },
    { ...validHop, destination: { ...validHop.destination, ip: '10.0.0.5' } },
    { ...validHop, sequence: 2 },
    { ...validHop, statusCode: 200 },
    { ...validHop, responseTimeMs: -1 },
    { ...validHop, headers: 'UNKNOWN' },
    { ...validHop, source: { targetId: 1, origin: 'https://example.com/private' } },
    { ...validHop, source: { targetId: 1, origin: 'https://example.com' } },
  ])('rejects unsafe or malformed stored diagnostics', (hop) => {
    expect(() => parseHttpRedirectHops([hop])).toThrow(HttpRedirectDiagnosticsInvariantError);
  });

  it('rejects one target identity mapped to different origins', () => {
    expect(() =>
      parseHttpRedirectHops([
        {
          ...validHop,
          destination: { targetId: 1, origin: 'https://status.example:443' },
        },
      ]),
    ).toThrow(HttpRedirectDiagnosticsInvariantError);
  });

  it('rejects a chain that does not continue from the followed destination', () => {
    expect(() =>
      parseHttpRedirectHops([
        validHop,
        {
          ...validHop,
          sequence: 2,
          source: { targetId: 3, origin: 'https://third.example:443' },
        },
      ]),
    ).toThrow(HttpRedirectDiagnosticsInvariantError);
  });

  it('rejects evidence after a NOT_SENT terminal hop', () => {
    expect(() =>
      parseHttpRedirectHops([
        { ...validHop, headers: 'NOT_SENT' },
        { ...validHop, sequence: 2, source: validHop.destination },
      ]),
    ).toThrow(HttpRedirectDiagnosticsInvariantError);
  });

  it('requires a null destination to be terminal and NOT_SENT', () => {
    expect(() => parseHttpRedirectHops([{ ...validHop, destination: null }])).toThrow(
      HttpRedirectDiagnosticsInvariantError,
    );
  });

  it('rejects more than six recorded redirect responses', () => {
    const hops = Array.from({ length: 7 }, (_, index) => ({
      ...validHop,
      sequence: index + 1,
      source: { targetId: index + 1, origin: 'https://example.com:443' },
      destination: { targetId: index + 2, origin: 'https://example.com:443' },
      headers: 'PRESERVED' as const,
    }));

    expect(() => parseHttpRedirectHops(hops)).toThrow(HttpRedirectDiagnosticsInvariantError);
  });

  it('formats effective ports and bracketed IPv6 deterministically', () => {
    expect(formatHttpRedirectOrigin(new URL('https://example.com/path'))).toBe(
      'https://example.com:443',
    );
    expect(formatHttpRedirectOrigin(new URL('http://[2001:db8::1]/path'))).toBe(
      'http://[2001:db8::1]:80',
    );
  });
});
