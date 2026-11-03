import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiWorkflowBuilder } from './api-workflow-builder';
import { WorkflowDiagnostic } from './monitor-evidence';
import type { ApiWorkflowConfiguration, ApiWorkflowResult } from './types';

describe('API workflow builder', () => {
  it('constructs an ordered workflow and preserves encrypted edit values', async () => {
    const user = userEvent.setup();
    render(<ApiWorkflowBuilder initialConfiguration={workflowConfiguration()} />);

    const hidden = document.querySelector<HTMLInputElement>('input[name="apiWorkflow"]');
    expect(hidden).not.toBeNull();
    expect(JSON.parse(hidden!.value).steps[0]).toMatchObject({
      id: 'authenticate',
      requestHeaders: [{ name: 'authorization', sensitive: true, retain: true }],
      requestBody: { type: 'JSON', sensitive: true, retain: true },
      assertions: {
        textBody: [
          {
            operator: 'contains',
            target: { sensitive: true, retain: true },
          },
        ],
      },
    });

    await user.click(screen.getByRole('button', { name: 'Add request step' }));
    expect(JSON.parse(hidden!.value).steps).toHaveLength(3);

    await user.click(screen.getByRole('button', { name: /Authenticate/i }));
    await user.click(screen.getByRole('button', { name: 'Move step down' }));
    expect(JSON.parse(hidden!.value).steps.map((step: { id: string }) => step.id)).toEqual([
      'fetch-user',
      'authenticate',
      'step_3',
    ]);
  });

  it('shows the shared execution deadline before submission', async () => {
    const user = userEvent.setup();
    render(<ApiWorkflowBuilder />);
    const timeoutInputs = screen.getAllByLabelText('Step 1 timeout');

    await user.clear(timeoutInputs[0]!);
    await user.type(timeoutInputs[0]!, '60');
    await user.click(screen.getByRole('button', { name: /Fetch resource/i }));
    await user.clear(screen.getByLabelText('Step 2 timeout'));
    await user.type(screen.getByLabelText('Step 2 timeout'), '60');

    expect(
      screen.getByText(/Reduce step timeouts so the workflow stays within the 90-second/i),
    ).toBeInTheDocument();
  });
});

describe('workflow diagnostics', () => {
  it('distinguishes failed, indeterminate, and skipped steps without exposing values', () => {
    render(<WorkflowDiagnostic result={workflowResult()} label="Historical workflow evidence" />);

    expect(screen.getByText('Historical workflow evidence')).toBeInTheDocument();
    expect(screen.getByText('Authenticate')).toBeInTheDocument();
    expect(screen.getByText('Fetch user')).toBeInTheDocument();
    expect(screen.getByText(/Not executed · Previous Step Failed/i)).toBeInTheDocument();
    expect(screen.getAllByText('Failed').length).toBeGreaterThan(0);
    expect(screen.queryByText('secret-token-value')).not.toBeInTheDocument();
    expect(
      screen.getByText(/extracted values.*are not retained in workflow history/i),
    ).toBeInTheDocument();
  });
});

function workflowConfiguration(): ApiWorkflowConfiguration {
  return {
    contractVersion: 1,
    steps: [
      {
        id: 'authenticate',
        name: 'Authenticate',
        url: 'https://api.example.com/session',
        method: 'POST',
        timeoutMs: 7_000,
        followRedirects: true,
        statusPolicy: { type: 'ANY_2XX' },
        tlsPolicy: { type: 'DISABLED' },
        requestHeaders: [
          {
            name: 'authorization',
            sensitive: true,
            value: null,
            hasValue: true,
          },
        ],
        requestBody: { type: 'JSON', sensitive: true, hasValue: true },
        assertions: {
          contractVersion: 1,
          assertions: {
            headers: [],
            textBody: [
              {
                operator: 'contains',
                target: { sensitive: true, hasValue: true },
              },
            ],
            jsonBody: [],
          },
        },
        extractions: [{ variable: 'token', selector: '$.token', sensitive: true }],
      },
      {
        id: 'fetch-user',
        name: 'Fetch user',
        url: 'https://api.example.com/users/{{token}}',
        method: 'GET',
        timeoutMs: 5_000,
        followRedirects: true,
        statusPolicy: { type: 'ANY_2XX' },
        tlsPolicy: { type: 'DISABLED' },
        requestHeaders: [],
        requestBody: { type: 'NONE' },
        assertions: {
          contractVersion: 1,
          assertions: { headers: [], textBody: [], jsonBody: [] },
        },
        extractions: [],
      },
    ],
  };
}

function workflowResult(): ApiWorkflowResult {
  return {
    outcome: 'FAIL',
    stage: 'WORKFLOW',
    reason: 'STEP_FAILED',
    failedStepId: 'authenticate',
    checkedAt: '2026-11-04T09:00:00.000Z',
    attemptDurationMs: 412,
    steps: [
      {
        id: 'authenticate',
        name: 'Authenticate',
        position: 0,
        status: 'EXECUTED',
        result: {
          outcome: 'PASS',
          stage: 'HTTP',
          reason: 'COMPLETED',
          statusCode: 200,
          responseTimeMs: 388,
          attemptDurationMs: 400,
          redirectCount: 0,
          tlsCertificateCount: 1,
          checkedAt: '2026-11-04T09:00:00.000Z',
          assertionEvaluation: {
            contractVersion: 1,
            outcome: 'FAIL',
            diagnostics: [
              {
                index: 0,
                source: 'JSON_BODY',
                subject: '$.ok',
                operator: 'equals',
                outcome: 'FAIL',
                reason: 'JSON_BODY_MISMATCH',
              },
            ],
          },
        },
        extractions: [
          {
            variable: 'token',
            selector: '$.token',
            sensitive: true,
            outcome: 'NOT_EVALUATED',
            reason: 'BODY_UNAVAILABLE',
          },
        ],
      },
      {
        id: 'fetch-user',
        name: 'Fetch user',
        position: 1,
        status: 'SKIPPED',
        reason: 'PREVIOUS_STEP_FAILED',
      },
    ],
  };
}
