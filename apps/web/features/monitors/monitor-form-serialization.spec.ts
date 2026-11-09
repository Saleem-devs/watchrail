import { describe, expect, it } from 'vitest';
import {
  domainExpiryCreateSettingsFromForm,
  domainExpirySettingsFromForm,
  icmpSettingsFromForm,
  keywordConfigurationTestFromForm,
  keywordSettingsFromForm,
} from './monitor-form-serialization';

describe('domain expiry form serialization', () => {
  it('maps the warning threshold to the create contract without changing the edit contract', () => {
    const formData = new FormData();
    formData.set('domainName', 'example.com');
    formData.set('domainWarningDays', '14');
    formData.set('timeoutSeconds', '5');

    expect(domainExpiryCreateSettingsFromForm(formData)).toEqual({
      domainName: 'example.com',
      domainWarningDays: 14,
      timeoutMs: 5_000,
    });
    expect(domainExpirySettingsFromForm(formData)).toEqual({
      domainName: 'example.com',
      warningDays: 14,
      timeoutMs: 5_000,
    });
  });
});

describe('ICMP form serialization', () => {
  it('maps a ping host and timeout to the protocol-specific contract', () => {
    const formData = new FormData();
    formData.set('host', 'edge.example.com');
    formData.set('timeoutSeconds', '5');

    expect(icmpSettingsFromForm(formData)).toEqual({
      host: 'edge.example.com',
      timeoutMs: 5_000,
    });
  });
});

describe('keyword form serialization', () => {
  it('maps one literal rule to the shared HTTP assertion test contract', () => {
    const formData = new FormData();
    formData.set('url', 'https://example.com/status');
    formData.set('keyword', 'Service Online');
    formData.set('keywordMatch', 'NOT_CONTAINS');
    formData.set('timeoutSeconds', '8');
    formData.set('followRedirects', 'on');

    expect(keywordSettingsFromForm(formData)).toEqual({
      url: 'https://example.com/status',
      keyword: 'Service Online',
      match: 'NOT_CONTAINS',
      timeoutMs: 8_000,
      followRedirects: true,
    });
    expect(keywordConfigurationTestFromForm(formData)).toMatchObject({
      httpSettings: { method: 'GET', requestBody: { type: 'NONE' } },
      statusPolicy: { type: 'ANY_2XX' },
      assertions: {
        textBody: [
          {
            operator: 'not_contains',
            target: { value: 'Service Online', sensitive: false },
          },
        ],
      },
    });
  });

  it('normalizes CRLF and lone CR line endings before edit and test requests', () => {
    const formData = new FormData();
    formData.set('url', 'https://example.com/status');
    formData.set('keyword', 'maintenance\r\nwindow\rplanned');
    formData.set('keywordMatch', 'NOT_CONTAINS');
    formData.set('timeoutSeconds', '8');

    expect(keywordSettingsFromForm(formData).keyword).toBe(
      'maintenance\nwindow\nplanned',
    );
    expect(keywordConfigurationTestFromForm(formData)).toMatchObject({
      assertions: {
        textBody: [
          {
            operator: 'not_contains',
            target: { value: 'maintenance\nwindow\nplanned', sensitive: false },
          },
        ],
      },
    });
  });
});
