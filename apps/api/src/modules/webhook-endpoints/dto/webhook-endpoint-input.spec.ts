import { describe, expect, it } from 'vitest';
import {
  createWebhookEndpointSchema,
  setWebhookEndpointEnabledSchema,
  updateWebhookEndpointSettingsSchema,
} from './webhook-endpoint-input.js';

describe('webhook settings DTO schemas', () => {
  it('accepts valid creation, secret retention, and secret rotation inputs', () => {
    expect(
      createWebhookEndpointSchema.safeParse({
        name: 'Operations',
        url: 'https://hooks.example.com',
        signingSecret: 'test-secret',
      }).success,
    ).toBe(true);

    const settings = {
      name: 'Operations',
      url: 'https://hooks.example.com',
    };
    expect(
      updateWebhookEndpointSettingsSchema.safeParse({
        ...settings,
        signingSecret: { retain: true },
      }).success,
    ).toBe(true);
    expect(
      updateWebhookEndpointSettingsSchema.safeParse({
        ...settings,
        signingSecret: { value: 'replacement-secret' },
      }).success,
    ).toBe(true);
  });

  it('rejects unsupported fields, malformed secret unions and non-boolean enabled input', () => {
    expect(
      createWebhookEndpointSchema.safeParse({
        name: 'Operations',
        url: 'https://hooks.example.com',
        signingSecret: 'test-secret',
        organizationId: 'attacker-controlled',
      }).success,
    ).toBe(false);
    expect(
      updateWebhookEndpointSettingsSchema.safeParse({
        name: 'Operations',
        url: 'https://hooks.example.com',
        signingSecret: { retain: true, value: 'unexpected' },
      }).success,
    ).toBe(false);
    expect(setWebhookEndpointEnabledSchema.safeParse({ enabled: 'false' }).success).toBe(false);
  });
});
