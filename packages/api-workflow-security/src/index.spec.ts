import { describe, expect, it, vi } from 'vitest';
import { EMPTY_ASSERTION_CONFIGURATION } from '@watchrail/domain';
import { resolveApiWorkflowConfigurationWithWorkspaceSecrets } from './index.js';

const context = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  monitorId: '22222222-2222-4222-8222-222222222222',
};
const keyrings = {
  headers: { activeKeyId: 'v1', keys: new Map([['v1', Buffer.alloc(32, 1)]]) },
  assertions: { activeKeyId: 'v1', keys: new Map([['v1', Buffer.alloc(32, 2)]]) },
};
const secretId = '33333333-3333-4333-8333-333333333333';

function step(id: string, requestBody: unknown) {
  return {
    id,
    name: id,
    url: `https://example.com/${id}`,
    method: 'POST',
    timeoutMs: 5_000,
    followRedirects: true,
    statusPolicy: { type: 'ANY_2XX' },
    tlsPolicy: { type: 'DISABLED' },
    requestHeaders: [],
    requestBody,
    assertions: EMPTY_ASSERTION_CONFIGURATION,
    extractions: [],
  };
}

describe('workflow workspace-secret resolution', () => {
  it('resolves body references only for execution and preserves the selected body type', async () => {
    const resolveSecret = vi.fn(() => Promise.resolve('token=abc&scope=read'));
    const resolved = await resolveApiWorkflowConfigurationWithWorkspaceSecrets(
      {
        contractVersion: 1,
        steps: [
          step('json_step', {
            type: 'JSON',
            sensitive: true,
            secretReference: { contractVersion: 1, secretId },
          }),
          step('form_step', {
            type: 'FORM_URLENCODED',
            sensitive: true,
            secretReference: { contractVersion: 1, secretId },
          }),
        ],
      },
      context,
      keyrings,
      resolveSecret,
    );

    expect(resolved.steps[0]?.requestBody).toEqual({
      type: 'JSON',
      value: 'token=abc&scope=read',
    });
    expect(resolved.steps[1]?.requestBody).toEqual({
      type: 'FORM_URLENCODED',
      fields: [
        { name: 'token', value: 'abc' },
        { name: 'scope', value: 'read' },
      ],
    });
    expect(resolveSecret).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(resolved)).not.toContain('secretReference');
  });
});
