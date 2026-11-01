import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AssertionDiagnostics, diagnosticFailureLabel } from './assertion-diagnostics';
import { ManualDiagnostic } from './monitor-evidence';
import { ResponseAssertionsField } from './response-assertions-field';
import {
  httpConfigurationTestFromForm,
  requiresStateChangingMethodConfirmation,
} from './monitor-form-serialization';
import { ConfigurationTestPanel } from './configuration-test-result';
import {
  responseAssertionRows,
  responseAssertionsFromForm,
  serializeResponseAssertions,
  type RedactedResponseAssertionConfiguration,
} from './response-assertions';

const configuredAssertions: RedactedResponseAssertionConfiguration = {
  contractVersion: 1,
  assertions: {
    headers: [
      {
        name: 'x-state',
        operator: 'equals',
        target: { sensitive: false, value: 'ready' },
      },
    ],
    textBody: [{ operator: 'contains', target: { sensitive: true, hasValue: true } }],
    jsonBody: [
      {
        selector: '$.healthy',
        operator: 'equals',
        target: { sensitive: false, value: { type: 'boolean', value: true } },
      },
    ],
  },
};

describe('response assertion configuration', () => {
  it('warns only before methods that can change target state', () => {
    expect(['POST', 'PUT', 'PATCH', 'DELETE'].every(requiresStateChangingMethodConfirmation)).toBe(
      true,
    );
    expect(['GET', 'HEAD', 'OPTIONS'].some(requiresStateChangingMethodConfirmation)).toBe(false);
  });

  it('serializes the complete unsaved HTTP configuration for transient testing', () => {
    const formData = new FormData();
    formData.set('url', 'https://api.example.com/jobs');
    formData.append('queryParameterName', 'verbose');
    formData.append('queryParameterValue', 'true');
    formData.set('method', 'POST');
    formData.set('timeoutSeconds', '8');
    formData.set('followRedirects', 'on');
    formData.set('statusPolicyMode', 'EXACT');
    formData.set('statusCodes', '200, 202');
    formData.set('requestBodyType', 'JSON');
    formData.set('requestBodyValue', '{"job":"sync"}');
    formData.set('tlsExpiryEnabled', 'on');
    formData.set('tlsExpiryDays', '14');
    formData.append('requestHeaderId', 'header-1');
    formData.append('requestHeaderName', 'Authorization');
    formData.append('requestHeaderValue', '');
    formData.append('requestHeaderHasStoredValue', 'true');
    formData.append('requestHeaderSensitive', 'header-1');
    formData.set('responseAssertions', JSON.stringify(responseAssertionRows(configuredAssertions)));

    expect(httpConfigurationTestFromForm(formData)).toEqual({
      httpSettings: {
        url: 'https://api.example.com/jobs?verbose=true',
        method: 'POST',
        timeoutMs: 8_000,
        followRedirects: true,
        requestBody: { type: 'JSON', value: '{"job":"sync"}' },
        tlsPolicy: { type: 'MINIMUM_VALIDITY', days: 14 },
      },
      statusPolicy: { type: 'EXACT', statusCodes: [200, 202] },
      requestHeaders: [{ name: 'Authorization', sensitive: true, retain: true }],
      assertions: serializeResponseAssertions(responseAssertionRows(configuredAssertions)),
    });
  });

  it('constructs and serializes header, text, and typed JSON assertions', () => {
    const rows = responseAssertionRows(configuredAssertions);
    expect(serializeResponseAssertions(rows)).toEqual({
      headers: [
        {
          name: 'x-state',
          operator: 'equals',
          target: { sensitive: false, value: 'ready' },
        },
      ],
      textBody: [{ operator: 'contains', target: { sensitive: true, retain: true } }],
      jsonBody: [
        {
          selector: '$.healthy',
          operator: 'equals',
          target: { sensitive: false, value: { type: 'boolean', value: true } },
        },
      ],
    });

    const formData = new FormData();
    formData.set('responseAssertions', JSON.stringify(rows));
    expect(responseAssertionsFromForm(formData)).toEqual(serializeResponseAssertions(rows));

    expect(
      serializeResponseAssertions([
        {
          ...rows[2]!,
          targetType: 'number',
          targetValue: '42.5',
        },
      ]).jsonBody[0],
    ).toMatchObject({ target: { value: { type: 'number', value: '42.5' } } });
  });

  it('retains a masked value until the user replaces it', () => {
    const [header] = responseAssertionRows({
      contractVersion: 1,
      assertions: {
        headers: [
          {
            name: 'authorization',
            operator: 'equals',
            target: { sensitive: true, hasValue: true },
          },
        ],
        textBody: [],
        jsonBody: [],
      },
    });
    expect(serializeResponseAssertions([header!]).headers[0]).toMatchObject({
      target: { sensitive: true, retain: true },
    });
    expect(
      serializeResponseAssertions([
        { ...header!, targetValue: 'replacement', retainSensitive: false },
      ]).headers[0],
    ).toMatchObject({ target: { sensitive: true, value: 'replacement' } });
  });

  it('prevents body assertions for HEAD and enforces the 32-assertion UI limit', () => {
    const full: RedactedResponseAssertionConfiguration = {
      contractVersion: 1,
      assertions: {
        headers: Array.from({ length: 32 }, (_, index) => ({
          name: `x-check-${index}`,
          operator: 'exists' as const,
        })),
        textBody: [],
        jsonBody: [],
      },
    };
    const { rerender } = render(
      <ResponseAssertionsField key="full" method="HEAD" initialConfiguration={full} />,
    );
    expect(screen.getByRole('button', { name: 'Add header' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add text' })).toBeDisabled();
    expect(screen.getByText('32/32')).toBeInTheDocument();

    rerender(
      <ResponseAssertionsField
        key="configured"
        method="HEAD"
        initialConfiguration={configuredAssertions}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('HEAD responses do not include a body');
  });

  it('separates transport, status-policy, and non-evaluated assertion outcomes in test results', () => {
    render(
      <ConfigurationTestPanel
        onDismiss={() => undefined}
        result={{
          result: {
            outcome: 'FAIL',
            stage: 'HTTP',
            reason: 'UNEXPECTED_STATUS',
            statusCode: 503,
            responseTimeMs: 18,
            attemptDurationMs: 20,
            checkedAt: '2026-10-31T20:00:00.000Z',
            redirects: [],
            assertionEvaluation: {
              contractVersion: 1,
              outcome: 'NOT_EVALUATED',
              diagnostics: [],
            },
          },
          signals: { transport: 'PASS', statusPolicy: 'FAIL', assertions: 'NOT_EVALUATED' },
          response: {
            headers: [{ name: 'set-cookie', values: ['[REDACTED]'], redacted: true }],
            withheldHeaderCount: 0,
            body: { state: 'UNAVAILABLE', reason: 'UNSUPPORTED_CONTENT_TYPE' },
          },
        }}
      />,
    );

    expect(screen.getByText('Transport').parentElement).toHaveTextContent(/pass/i);
    expect(screen.getByText('Status policy').parentElement).toHaveTextContent(/fail/i);
    expect(screen.getByText('Assertions').parentElement).toHaveTextContent(/not evaluated/i);
    expect(screen.getByText('[REDACTED]')).toBeInTheDocument();
    expect(screen.getByText(/not eligible for a safe text preview/i)).toBeInTheDocument();
  });

  it('summarizes non-evaluated assertions as indeterminate instead of passed', () => {
    render(
      <ConfigurationTestPanel
        onDismiss={() => undefined}
        result={{
          result: {
            outcome: 'PASS',
            stage: 'HTTP',
            reason: 'COMPLETED',
            statusCode: 200,
            responseTimeMs: 18,
            attemptDurationMs: 20,
            checkedAt: '2026-10-31T20:00:00.000Z',
            redirects: [],
            assertionEvaluation: {
              contractVersion: 1,
              outcome: 'NOT_EVALUATED',
              diagnostics: [],
            },
          },
          signals: { transport: 'PASS', statusPolicy: 'PASS', assertions: 'NOT_EVALUATED' },
          response: {
            headers: [],
            withheldHeaderCount: 0,
            body: { state: 'UNAVAILABLE', reason: 'BODY_READ_FAILED' },
          },
        }}
      />,
    );

    expect(screen.getByText('Configuration test').parentElement).toHaveTextContent(/unknown/i);
    expect(screen.getByText('Assertions').parentElement).toHaveTextContent(/not evaluated/i);
  });

  it('does not let disabled TLS monitoring downgrade a successful configuration test', () => {
    render(
      <ConfigurationTestPanel
        onDismiss={() => undefined}
        result={{
          result: {
            outcome: 'PASS',
            stage: 'HTTP',
            reason: 'COMPLETED',
            statusCode: 200,
            responseTimeMs: 18,
            attemptDurationMs: 20,
            checkedAt: '2026-10-31T20:00:00.000Z',
            redirects: [],
            assertionEvaluation: { contractVersion: 1, outcome: 'PASS', diagnostics: [] },
          },
          signals: {
            transport: 'PASS',
            statusPolicy: 'PASS',
            assertions: 'PASS',
            tlsCertificate: 'NOT_EVALUATED',
          },
          response: {
            headers: [],
            withheldHeaderCount: 0,
            body: { state: 'UNAVAILABLE', reason: 'NOT_CAPTURED' },
          },
        }}
      />,
    );

    expect(screen.getByText('Configuration test').parentElement).toHaveTextContent(/pass/i);
    expect(screen.getByText('TLS expiry').parentElement).toHaveTextContent(/not evaluated/i);
  });

  it('lets a user add a body assertion without exposing a separate test action', async () => {
    const user = userEvent.setup();
    render(<ResponseAssertionsField method="GET" />);
    await user.click(screen.getByRole('button', { name: 'Add JSON' }));
    expect(screen.getByText('JSON body')).toBeInTheDocument();
    expect(screen.getByLabelText('JSON selector')).toHaveValue('$.');
    expect(screen.queryByRole('button', { name: /test/i })).not.toBeInTheDocument();
  });
});

describe('assertion diagnostic presentation', () => {
  const failedEvaluation = {
    contractVersion: 1 as const,
    outcome: 'FAIL' as const,
    diagnostics: [
      {
        index: 0,
        source: 'JSON_BODY' as const,
        subject: '$.status',
        operator: 'equals' as const,
        outcome: 'FAIL' as const,
        reason: 'JSON_BODY_MISMATCH' as const,
      },
      {
        index: 1,
        source: 'TEXT_BODY' as const,
        subject: null,
        operator: 'contains' as const,
        outcome: 'NOT_EVALUATED' as const,
        reason: 'RESPONSE_UNAVAILABLE' as const,
      },
    ],
  };

  it('renders failed and non-evaluated evidence without expected values', () => {
    render(<AssertionDiagnostics evaluation={failedEvaluation} />);
    expect(screen.getByText('$.status')).toBeInTheDocument();
    expect(screen.getByText('response body')).toBeInTheDocument();
    expect(screen.getByText('Not evaluated')).toBeInTheDocument();
    expect(screen.getByText(/JSON BODY MISMATCH/i)).toBeInTheDocument();
    expect(screen.queryByText(/secret|ciphertext|expected value/i)).not.toBeInTheDocument();
  });

  it('distinguishes transport, HTTP, and assertion failures', () => {
    expect(
      diagnosticFailureLabel({
        outcome: 'UNKNOWN',
        stage: 'CONNECT',
        statusCode: null,
        assertionEvaluation: { contractVersion: 1, outcome: 'NOT_EVALUATED', diagnostics: [] },
      }),
    ).toMatch('Transport failure');
    expect(
      diagnosticFailureLabel({
        outcome: 'FAIL',
        stage: 'HTTP',
        statusCode: 503,
        assertionEvaluation: { contractVersion: 1, outcome: 'NOT_EVALUATED', diagnostics: [] },
      }),
    ).toMatch('HTTP response failed');
    expect(
      diagnosticFailureLabel({
        outcome: 'FAIL',
        stage: 'HTTP',
        statusCode: 200,
        assertionEvaluation: failedEvaluation,
      }),
    ).toBe('Response assertion failed');
  });

  it('presents certificate expiry as a policy failure after a successful HTTP response', () => {
    render(
      <ManualDiagnostic
        round={{
          id: 'certificate-expiry',
          monitorId: 'monitor',
          trigger: 'MANUAL',
          status: 'COMPLETED',
          assignmentStatus: 'COMPLETED',
          createdAt: '2026-10-31T12:00:00.000Z',
          result: {
            outcome: 'FAIL',
            stage: 'TLS',
            reason: 'CERTIFICATE_EXPIRING',
            statusCode: 200,
            responseTimeMs: 20,
            attemptDurationMs: 22,
            redirects: [],
            assertionEvaluation: { contractVersion: 1, outcome: 'PASS', diagnostics: [] },
            checkedAt: '2026-10-31T12:00:00.000Z',
          },
        }}
        error={undefined}
      />,
    );

    expect(screen.getByText('HTTP execution').parentElement).toHaveTextContent(/passed/i);
    expect(screen.getByText('Certificate expiry policy failed')).toBeInTheDocument();
    expect(screen.queryByText(/transport failure/i)).not.toBeInTheDocument();
  });

  it('presents assertion evidence for both single and multi-location results', () => {
    const { rerender } = render(
      <ManualDiagnostic
        round={{
          id: 'single',
          monitorId: 'monitor',
          trigger: 'MANUAL',
          status: 'COMPLETED',
          assignmentStatus: 'COMPLETED',
          createdAt: '2026-10-31T12:00:00.000Z',
          result: {
            outcome: 'PASS',
            stage: 'HTTP',
            reason: 'COMPLETED',
            statusCode: 200,
            responseTimeMs: 20,
            attemptDurationMs: 22,
            redirects: [],
            assertionEvaluation: failedEvaluation,
            checkedAt: '2026-10-31T12:00:00.000Z',
          },
        }}
        error={undefined}
      />,
    );
    expect(screen.getByText('Response assertion failed')).toBeInTheDocument();
    expect(screen.getAllByText('Passed').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Failed').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Unhealthy')).toHaveLength(2);

    rerender(
      <ManualDiagnostic
        round={{
          id: 'not-evaluated',
          monitorId: 'monitor',
          trigger: 'MANUAL',
          status: 'COMPLETED',
          assignmentStatus: 'COMPLETED',
          createdAt: '2026-10-31T12:00:00.000Z',
          result: {
            outcome: 'PASS',
            stage: 'HTTP',
            reason: 'COMPLETED',
            statusCode: 200,
            responseTimeMs: 20,
            attemptDurationMs: 22,
            redirects: [],
            assertionEvaluation: {
              contractVersion: 1,
              outcome: 'NOT_EVALUATED',
              diagnostics: [],
            },
            checkedAt: '2026-10-31T12:00:00.000Z',
          },
        }}
        error={undefined}
      />,
    );
    expect(screen.getAllByText('Not evaluated')).toHaveLength(1);
    expect(screen.getAllByText('Indeterminate')).toHaveLength(2);

    rerender(
      <ManualDiagnostic
        round={{
          id: 'multi',
          monitorId: 'monitor',
          trigger: 'MANUAL',
          status: 'COMPLETED',
          assignmentStatus: 'COMPLETED',
          createdAt: '2026-10-31T12:00:00.000Z',
          result: {
            kind: 'MULTI_LOCATION',
            outcome: 'DEGRADED',
            counts: { selected: 1, pass: 0, confirmedFail: 1, unknown: 0, conclusive: 1 },
            coverage: { numerator: 1, denominator: 1 },
            reachability: { numerator: 1, denominator: 1 },
            finalizedAt: '2026-10-31T12:00:00.000Z',
            regions: [
              {
                location: 'lagos',
                phase: 'TERMINAL',
                outcome: 'CONFIRMED_FAIL',
                terminalReason: 'CONFIRMED_FAILURE',
                executions: [
                  {
                    id: 'execution',
                    role: 'PRIMARY',
                    diagnosticSummary: {
                      stage: 'HTTP',
                      reason: 'COMPLETED',
                      statusCode: 200,
                      responseTimeMs: 20,
                      attemptDurationMs: 22,
                      checkedAt: '2026-10-31T12:00:00.000Z',
                      assertionEvaluation: failedEvaluation,
                    },
                  },
                ],
              },
            ],
          },
        }}
        error={undefined}
      />,
    );
    expect(screen.getByText('lagos')).toBeInTheDocument();
    expect(screen.getByText('$.status')).toBeInTheDocument();
  });
});
