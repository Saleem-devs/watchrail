'use client';

import { useId, useState, type FormEvent } from 'react';
import { Checkbox, Input, Select } from '../../components/ui/form-control';
import { Form } from '../../components/ui/form';
import { RequestHeadersField, type RequestHeaderFormValue } from './request-headers-field';
import { HTTP_METHODS } from './http-method-options';
import { endpointBaseUrl, QueryParametersField } from './query-parameters-field';
import { RequestBodyField, type RequestBodyValue } from './request-body-field';
import { ResponseAssertionsField } from './response-assertions-field';
import type { RedactedResponseAssertionConfiguration } from './response-assertions';
import type { FieldErrors, Monitor } from './types';
import type { ConfigurationTestResult } from './types';
import { ConfigurationTestPanel } from './configuration-test-result';

export interface MonitorFormValues {
  name: string;
  url: string;
  statusPolicy: Monitor['statusPolicy'];
  method: Monitor['method'];
  timeoutMs: number;
  followRedirects: boolean;
  locations: string[];
  lifecycleState: Monitor['lifecycleState'];
  requestHeaders?: RequestHeaderFormValue[];
  requestBody?: RequestBodyValue;
  assertions?: RedactedResponseAssertionConfiguration;
}

export function MonitorForm({
  mode,
  initialValues,
  errors,
  submitting,
  formId,
  onSubmit,
  testResult,
  testError,
  onDismissTest,
  onConfigurationChange,
}: {
  mode: 'create' | 'edit';
  initialValues?: MonitorFormValues;
  errors: FieldErrors;
  submitting: boolean;
  formId: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  testResult?: ConfigurationTestResult | undefined;
  testError?: string | undefined;
  onDismissTest: () => void;
  onConfigurationChange: () => void;
}) {
  const id = useId();
  const [policyMode, setPolicyMode] = useState<'ANY_2XX' | 'EXACT'>(
    initialValues?.statusPolicy.type ?? 'ANY_2XX',
  );
  const [method, setMethod] = useState(initialValues?.method ?? 'GET');
  const nameErrorId = `${id}-name-error`;
  const urlHelpId = `${id}-url-help`;
  const urlErrorId = `${id}-url-error`;
  const policyHelpId = `${id}-policy-help`;
  const policyErrorId = `${id}-policy-error`;

  return (
    <Form
      id={formId}
      className="min-w-0 p-0"
      onSubmit={onSubmit}
      onChange={onConfigurationChange}
      onClickCapture={(event) => {
        if (!(event.target instanceof Element)) return;
        const button = event.target.closest('button[type="button"]');
        if (button && button.getAttribute('role') !== 'combobox') onConfigurationChange();
      }}
      aria-busy={submitting}
      noValidate
    >
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="overflow-hidden rounded-rail-panel border border-rail-border bg-rail-raised">
          <section className="border-b border-rail-border px-5 py-5 sm:px-6">
            <h2 className="m-0 text-sm font-semibold text-rail-text">Endpoint</h2>
            <p className="mt-1 mb-0 text-xs leading-5 text-rail-muted">
              Name the service and provide the HTTP endpoint Watchrail should monitor.
            </p>
            <div className="mt-5 grid gap-5">
              <label
                className="grid gap-1.5 text-xs font-medium text-rail-subtle"
                htmlFor={`${id}-name`}
              >
                Monitor name
                <Input
                  id={`${id}-name`}
                  name="name"
                  type="text"
                  defaultValue={initialValues?.name}
                  placeholder="Production API"
                  maxLength={120}
                  autoComplete="off"
                  required
                  aria-describedby={errors.name ? nameErrorId : undefined}
                  aria-invalid={Boolean(errors.name)}
                />
                {errors.name ? (
                  <span className="font-normal text-rail-danger" id={nameErrorId}>
                    {errors.name[0]}
                  </span>
                ) : null}
              </label>

              <label
                className="grid gap-1.5 text-xs font-medium text-rail-subtle"
                htmlFor={`${id}-url`}
              >
                HTTP(S) URL
                <Input
                  id={`${id}-url`}
                  name="url"
                  type="url"
                  defaultValue={endpointBaseUrl(initialValues?.url)}
                  placeholder="https://status.watchrail.app/health"
                  inputMode="url"
                  autoComplete="url"
                  required
                  aria-describedby={errors.url ? urlErrorId : urlHelpId}
                  aria-invalid={Boolean(errors.url)}
                />
                {errors.url ? (
                  <span className="font-normal text-rail-danger" id={urlErrorId}>
                    {errors.url[0]}
                  </span>
                ) : (
                  <span className="font-normal leading-5 text-rail-muted" id={urlHelpId}>
                    Use a publicly reachable HTTP or HTTPS endpoint.
                  </span>
                )}
              </label>
            </div>
          </section>

          <QueryParametersField initialUrl={initialValues?.url} />

          <fieldset className="m-0 border-0 px-5 py-5 sm:px-6">
            <legend className="p-0 text-sm font-semibold text-rail-text">Expected response</legend>
            <p className="mt-1 mb-0 text-xs leading-5 text-rail-muted" id={policyHelpId}>
              Choose which HTTP responses count as an available service.
            </p>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              <label className="flex min-h-20 cursor-pointer items-start gap-3 rounded-rail-control border border-rail-border bg-rail-surface px-4 py-3 hover:border-rail-border-strong has-[:checked]:border-rail-accent has-[:checked]:bg-rail-accent/5">
                <Input
                  name="statusPolicyMode"
                  type="radio"
                  value="ANY_2XX"
                  checked={policyMode === 'ANY_2XX'}
                  onChange={() => setPolicyMode('ANY_2XX')}
                  aria-describedby={policyHelpId}
                  className="mt-0.5 size-4 shrink-0"
                />
                <span>
                  <strong className="block text-sm font-medium text-rail-text">
                    Any 2xx response
                  </strong>
                  <span className="mt-1 block text-xs leading-5 text-rail-muted">
                    Accept every successful HTTP response.
                  </span>
                </span>
              </label>
              <label className="flex min-h-20 cursor-pointer items-start gap-3 rounded-rail-control border border-rail-border bg-rail-surface px-4 py-3 hover:border-rail-border-strong has-[:checked]:border-rail-accent has-[:checked]:bg-rail-accent/5">
                <Input
                  name="statusPolicyMode"
                  type="radio"
                  value="EXACT"
                  checked={policyMode === 'EXACT'}
                  onChange={() => setPolicyMode('EXACT')}
                  aria-describedby={policyHelpId}
                  className="mt-0.5 size-4 shrink-0"
                />
                <span>
                  <strong className="block text-sm font-medium text-rail-text">
                    Specific status codes
                  </strong>
                  <span className="mt-1 block text-xs leading-5 text-rail-muted">
                    Accept only the codes you provide.
                  </span>
                </span>
              </label>
            </div>
            {policyMode === 'EXACT' ? (
              <label
                className="mt-4 grid max-w-sm gap-1.5 text-xs font-medium text-rail-subtle"
                htmlFor={`${id}-status-codes`}
              >
                Accepted status codes
                <Input
                  id={`${id}-status-codes`}
                  name="statusCodes"
                  type="text"
                  inputMode="numeric"
                  defaultValue={
                    initialValues?.statusPolicy.type === 'EXACT'
                      ? initialValues.statusPolicy.statusCodes.join(', ')
                      : ''
                  }
                  placeholder="200, 204"
                  required
                  aria-describedby={errors.statusPolicy ? policyErrorId : policyHelpId}
                  aria-invalid={Boolean(errors.statusPolicy)}
                />
                {errors.statusPolicy ? (
                  <span className="font-normal text-rail-danger" id={policyErrorId}>
                    {errors.statusPolicy[0]}
                  </span>
                ) : null}
              </label>
            ) : null}
          </fieldset>

          <RequestHeadersField
            initialHeaders={initialValues?.requestHeaders ?? []}
            {...(errors.requestHeaders?.[0] ? { error: errors.requestHeaders[0] } : {})}
          />
          <RequestBodyField
            method={method}
            initialBody={initialValues?.requestBody ?? { type: 'NONE' }}
            {...(errors.requestBody?.[0] ? { error: errors.requestBody[0] } : {})}
          />
          <ResponseAssertionsField
            method={method}
            {...(initialValues?.assertions
              ? { initialConfiguration: initialValues.assertions }
              : {})}
            {...(errors.assertions?.[0] ? { error: errors.assertions[0] } : {})}
          />
        </div>

        <aside
          className="overflow-hidden rounded-rail-panel border border-rail-border bg-rail-raised"
          aria-label="Initial monitor settings"
        >
          <div className="border-b border-rail-border px-5 py-4">
            <h2 className="m-0 text-sm font-semibold text-rail-text">
              {mode === 'create' ? 'Initial settings' : 'Monitor settings'}
            </h2>
            <p className="mt-1 mb-0 text-xs leading-5 text-rail-muted">
              {mode === 'create'
                ? 'Execution settings applied when this monitor is created.'
                : 'Current execution defaults for this monitor.'}
            </p>
          </div>
          <div className="grid gap-4 px-5 py-5">
            <label className="grid gap-1.5 text-xs font-medium text-rail-subtle">
              Method
              <Select
                name="method"
                value={method}
                onChange={(event) => setMethod(event.target.value)}
                aria-invalid={Boolean(errors.method)}
              >
                {HTTP_METHODS.map((httpMethod) => (
                  <option key={httpMethod} value={httpMethod}>
                    {httpMethod}
                  </option>
                ))}
              </Select>
              {errors.method ? (
                <span className="font-normal text-rail-danger">{errors.method[0]}</span>
              ) : null}
            </label>
            <label className="grid gap-1.5 text-xs font-medium text-rail-subtle">
              Timeout
              <div className="relative">
                <Input
                  name="timeoutSeconds"
                  type="number"
                  min="1"
                  max="30"
                  step="1"
                  defaultValue={(initialValues?.timeoutMs ?? 10_000) / 1_000}
                  required
                  aria-invalid={Boolean(errors.timeoutMs)}
                  className="pr-16"
                />
                <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-rail-muted">
                  seconds
                </span>
              </div>
              {errors.timeoutMs ? (
                <span className="font-normal text-rail-danger">{errors.timeoutMs[0]}</span>
              ) : null}
            </label>
            <label className="grid gap-1.5 text-xs font-medium text-rail-subtle">
              Location
              <Select
                name="location"
                defaultValue={initialValues?.locations[0] ?? 'local'}
                aria-invalid={Boolean(errors.locations)}
              >
                <option value="local">Local</option>
              </Select>
              {errors.locations ? (
                <span className="font-normal text-rail-danger">{errors.locations[0]}</span>
              ) : null}
            </label>
            <label className="grid gap-1.5 text-xs font-medium text-rail-subtle">
              Lifecycle
              <Select
                name="lifecycleState"
                defaultValue={initialValues?.lifecycleState ?? 'ENABLED'}
                aria-invalid={Boolean(errors.lifecycleState)}
              >
                <option value="ENABLED">Enabled</option>
                <option value="PAUSED">Paused</option>
              </Select>
              {errors.lifecycleState ? (
                <span className="font-normal text-rail-danger">{errors.lifecycleState[0]}</span>
              ) : null}
            </label>
            <label className="flex min-h-10 cursor-pointer items-center gap-2.5 rounded-rail-control border border-rail-border px-3 text-xs font-medium text-rail-subtle hover:border-rail-border-strong">
              <Checkbox
                name="followRedirects"
                defaultChecked={initialValues?.followRedirects ?? true}
                aria-invalid={Boolean(errors.followRedirects)}
              />
              Follow redirects
            </label>
            {errors.followRedirects ? (
              <span className="-mt-2 text-xs text-rail-danger">{errors.followRedirects[0]}</span>
            ) : null}
          </div>
        </aside>
      </div>
      <ConfigurationTestPanel result={testResult} error={testError} onDismiss={onDismissTest} />
    </Form>
  );
}
