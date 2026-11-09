import { describe, expect, it } from 'vitest';
import {
  KEYWORD_LIMITS,
  KeywordMonitorInputError,
  parseKeywordMonitorSettings,
} from './keyword.js';

describe('keyword monitor settings', () => {
  it('normalizes the URL while preserving the literal keyword exactly', () => {
    expect(
      parseKeywordMonitorSettings({
        url: ' https://example.com/status ',
        keyword: '  Service Online  ',
        match: 'NOT_CONTAINS',
        timeoutMs: 5_000,
        followRedirects: false,
      }),
    ).toEqual({
      url: 'https://example.com/status',
      keyword: '  Service Online  ',
      match: 'NOT_CONTAINS',
      timeoutMs: 5_000,
      followRedirects: false,
    });
  });

  it.each(['a.b', '[error]', 'Case Sensitive', ' café ', 'line one\nline two'])(
    'preserves literal keyword input %j without regex, case, whitespace, or Unicode normalization',
    (keyword) => {
      expect(
        parseKeywordMonitorSettings({
          url: 'https://example.com',
          keyword,
          match: 'CONTAINS',
          timeoutMs: 10_000,
          followRedirects: true,
        }).keyword,
      ).toBe(keyword);
    },
  );

  it('rejects non-HTTP targets, embedded credentials, and missing rules', () => {
    for (const url of ['file:///etc/passwd', 'https://user:pass@example.com']) {
      expect(() =>
        parseKeywordMonitorSettings({
          url,
          keyword: 'ready',
          match: 'CONTAINS',
          timeoutMs: 10_000,
          followRedirects: true,
        }),
      ).toThrow(KeywordMonitorInputError);
    }

    expect(() =>
      parseKeywordMonitorSettings({
        url: 'https://example.com',
        keyword: '   ',
        match: 'SOMETHING_ELSE',
        timeoutMs: 10_000,
        followRedirects: true,
      }),
    ).toThrow(KeywordMonitorInputError);
  });

  it('bounds the literal and timeout', () => {
    expect(() =>
      parseKeywordMonitorSettings({
        url: 'https://example.com',
        keyword: 'x'.repeat(KEYWORD_LIMITS.maximumLength + 1),
        match: 'CONTAINS',
        timeoutMs: KEYWORD_LIMITS.maximumTimeoutMs + 1,
        followRedirects: true,
      }),
    ).toThrow(KeywordMonitorInputError);
  });
});
