import { describe, expect, it } from 'vitest';
import {
  domainExpiryCreateSettingsFromForm,
  domainExpirySettingsFromForm,
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
