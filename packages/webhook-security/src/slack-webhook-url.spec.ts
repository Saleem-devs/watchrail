import { describe, expect, it } from 'vitest';
import {
  decryptSlackWebhookUrl,
  encryptSlackWebhookUrl,
  parseSlackIncomingWebhookUrl,
  StoredSlackWebhookUrlResolutionError,
} from './slack-webhook-url.js';

const context = {
  organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  channelId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  versionNumber: 1,
};
const keyring = {
  activeKeyId: 'active',
  keys: new Map([['active', Buffer.alloc(32, 2)]]),
};
const url = [
  'https://hooks.slack.com',
  'services',
  'T00000000',
  'B00000000',
  'XXXXXXXXXXXXXXXXXXXXXXXX',
].join('/');

describe('Slack incoming webhook security', () => {
  it('accepts only canonical Slack incoming webhook destinations', () => {
    expect(parseSlackIncomingWebhookUrl(url)).toBe(url);
    for (const invalid of [
      'http://hooks.slack.com/services/T/B/token',
      'https://hooks.slack.com.evil.example/services/T/B/token',
      'https://user:pass@hooks.slack.com/services/T/B/token',
      'https://hooks.slack.com/services/T/B/token?leak=yes',
      'https://hooks.slack.com/services/T/B',
      'https://example.com/services/T/B/token',
    ])
      expect(() => parseSlackIncomingWebhookUrl(invalid)).toThrow(
        'Slack incoming webhook URL is invalid.',
      );
  });

  it('encrypts the full credential and binds it to organization, channel, and version', () => {
    const envelope = encryptSlackWebhookUrl(url, context, keyring);
    expect(JSON.stringify(envelope)).not.toContain(url);
    expect(decryptSlackWebhookUrl(envelope, context, keyring)).toBe(url);
    for (const changed of [
      { ...context, organizationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
      { ...context, channelId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
      { ...context, versionNumber: 2 },
    ])
      expect(() => decryptSlackWebhookUrl(envelope, changed, keyring)).toThrow(
        StoredSlackWebhookUrlResolutionError,
      );
  });
});
