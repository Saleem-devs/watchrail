import { describe, expect, it } from 'vitest';
import {
  domainExpiryCreateSettingsFromForm,
  domainExpirySettingsFromForm,
  icmpSettingsFromForm,
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
