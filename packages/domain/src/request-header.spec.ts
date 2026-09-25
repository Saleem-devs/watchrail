import { describe, expect, it } from 'vitest';
import {
  assertNoRetainedHeaders,
  normalizeRequestHeaderUpdates,
  RequestHeaderInputError,
} from './request-header.js';

describe('request header policy', () => {
  it('normalizes names and forces known credentials to be sensitive', () => {
    expect(
      normalizeRequestHeaderUpdates([
        { name: ' X-Environment ', sensitive: false, value: 'production' },
        { name: 'Authorization', sensitive: false, value: 'Bearer secret' },
      ]),
    ).toEqual([
      { name: 'x-environment', sensitive: false, value: 'production' },
      { name: 'authorization', sensitive: true, value: 'Bearer secret' },
    ]);
  });

  it.each(['Host', 'Content-Length', 'Connection', 'Proxy-Authorization', 'Expect'])(
    'rejects transport-controlled header %s',
    (name) => {
      expect(() =>
        normalizeRequestHeaderUpdates([{ name, sensitive: false, value: 'value' }]),
      ).toThrow(RequestHeaderInputError);
    },
  );

  it('rejects case-insensitive duplicates and control characters', () => {
    expect(() =>
      normalizeRequestHeaderUpdates([
        { name: 'X-Key', sensitive: false, value: 'one' },
        { name: 'x-key', sensitive: false, value: 'two' },
      ]),
    ).toThrow('Request headers are invalid.');
    expect(() =>
      normalizeRequestHeaderUpdates([{ name: 'x-key', sensitive: false, value: 'bad\r\nvalue' }]),
    ).toThrow('Request headers are invalid.');
  });

  it('allows explicit retention only outside monitor creation', () => {
    const headers = normalizeRequestHeaderUpdates([
      { name: 'authorization', sensitive: true, retain: true },
    ]);
    expect(headers).toEqual([{ name: 'authorization', sensitive: true, retain: true }]);
    expect(() => assertNoRetainedHeaders(headers)).toThrow(RequestHeaderInputError);
  });
});
