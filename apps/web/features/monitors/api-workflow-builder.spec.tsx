import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiWorkflowBuilder } from './api-workflow-builder';
import { CheckHistory, ManualDiagnostic, WorkflowDiagnostic } from './monitor-evidence';
import type { ApiWorkflowConfiguration, ApiWorkflowResult, ManualRound } from './types';

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

  it('requires a replacement body when a retained body changes type', async () => {
    const user = userEvent.setup();
    render(<ApiWorkflowBuilder initialConfiguration={workflowConfiguration()} />);

    const hidden = document.querySelector<HTMLInputElement>('input[name="apiWorkflow"]');
    expect(JSON.parse(hidden!.value).steps[0].requestBody).toEqual({
      type: 'JSON',
      sensitive: true,
      retain: true,
    });

    const bodyType = screen.getByRole('combobox', { name: 'Step 1 request body type' });
    bodyType.focus();
    await user.keyboard('{Enter}');
    await user.click(screen.getByRole('option', { name: 'Raw' }));

    expect(screen.queryByText('Stored json body')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Step 1 body content type')).toBeInTheDocument();
    await waitFor(() =>
      expect(JSON.parse(hidden!.value).steps[0].requestBody).toEqual({
        type: 'RAW',
        contentType: 'text/plain',
        value: '',
      }),
    );
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

  it('presents missing single-location workflow evidence as indeterminate', () => {
    render(
      <ManualDiagnostic
        round={workflowRoundWithoutEvidence()}
        error={undefined}
        protocol="API_WORKFLOW"
      />,
    );

    expect(screen.getByText('Workflow step evidence unavailable')).toBeInTheDocument();
    expect(screen.getByText('Indeterminate')).toBeInTheDocument();
    expect(screen.queryByText('DNS lookup')).not.toBeInTheDocument();
    expect(screen.queryByText(/HTTP response unavailable/i)).not.toBeInTheDocument();
  });

  it('uses workflow-specific missing-evidence diagnostics in history', () => {
    const round = workflowRoundWithoutEvidence();
    render(
      <CheckHistory
        page={{ items: [round], nextCursor: null }}
        loading={false}
        onLoadMore={() => undefined}
        details={{ [round.id]: round }}
        expandedRoundIds={new Set([round.id])}
        loadingRoundIds={new Set()}
        onToggleRound={() => undefined}
        protocol="API_WORKFLOW"
      />,
    );

    expect(screen.getByText('Historical workflow evidence')).toBeInTheDocument();
    expect(screen.getByText('Workflow step evidence unavailable')).toBeInTheDocument();
    expect(screen.queryByText('DNS lookup')).not.toBeInTheDocument();
  });

  it('uses workflow-specific missing-evidence diagnostics for regional executions', () => {
    render(
      <ManualDiagnostic
        round={regionalWorkflowRoundWithoutEvidence()}
        error={undefined}
        protocol="API_WORKFLOW"
      />,
    );

    expect(screen.getByText('Primary workflow execution')).toBeInTheDocument();
    expect(screen.getByText('Workflow step evidence unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/HTTP response unavailable/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Response validation/i)).not.toBeInTheDocument();
  });
});

function workflowRoundWithoutEvidence(): ManualRound {
  return {
    id: 'workflow-round-no-evidence',
    monitorId: 'workflow-monitor',
    trigger: 'SCHEDULED',
    status: 'COMPLETED',
    assignmentStatus: 'COMPLETED',
    createdAt: '2026-11-04T09:00:00.000Z',
    result: {
      outcome: 'UNKNOWN',
      stage: 'WORKFLOW',
      reason: 'INTERNAL_ERROR',
      statusCode: null,
      responseTimeMs: null,
      attemptDurationMs: 12,
      redirects: [],
      checkedAt: '2026-11-04T09:00:00.000Z',
    },
  };
}

function regionalWorkflowRoundWithoutEvidence(): ManualRound {
  return {
    id: 'regional-workflow-round-no-evidence',
    monitorId: 'workflow-monitor',
    trigger: 'SCHEDULED',
    status: 'COMPLETED',
    assignmentStatus: 'COMPLETED',
    createdAt: '2026-11-04T09:00:00.000Z',
    result: {
      kind: 'MULTI_LOCATION',
      outcome: 'UNKNOWN',
      counts: {
        selected: 1,
        pass: 0,
        confirmedFail: 0,
        unknown: 1,
        conclusive: 0,
      },
      coverage: { numerator: 1, denominator: 1 },
      reachability: null,
      finalizedAt: '2026-11-04T09:00:00.000Z',
      regions: [
        {
          location: 'lagos',
          phase: 'FINALIZED',
          outcome: 'UNKNOWN',
          terminalReason: 'INTERNAL_ERROR',
          executions: [
            {
              id: 'execution-1',
              role: 'PRIMARY',
              diagnosticSummary: {
                stage: 'WORKFLOW',
                reason: 'INTERNAL_ERROR',
                statusCode: null,
                responseTimeMs: null,
                attemptDurationMs: 15,
                checkedAt: '2026-11-04T09:00:00.000Z',
              },
            },
          ],
        },
      ],
    },
  };
}

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
