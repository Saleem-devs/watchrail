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
import { TlsCertificatePolicyField } from './tls-certificate-policy-field';
import { DnsExpectedValuesField } from './dns-expected-values-field';

export interface MonitorFormValues {
  type: Monitor['type'];
  name: string;
  url: string;
  configuration: Monitor['configuration'];
  statusPolicy: Monitor['statusPolicy'];
  tlsPolicy?: Monitor['tlsPolicy'];
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
  onTypeChange,
  selectedType,
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
  onTypeChange?: (type: Monitor['type']) => void;
  selectedType?: Monitor['type'];
}) {
  const id = useId();
  const [policyMode, setPolicyMode] = useState<'ANY_2XX' | 'EXACT'>(
    initialValues?.statusPolicy.type ?? 'ANY_2XX',
  );
  const [method, setMethod] = useState(initialValues?.method ?? 'GET');
  const [monitorType, setMonitorType] = useState<Monitor['type']>(
    mode === 'create' ? (selectedType ?? 'HTTP') : (initialValues?.type ?? 'HTTP'),
  );
  const [httpsEndpoint, setHttpsEndpoint] = useState(
    (initialValues?.url ?? '').trim().toLowerCase().startsWith('https://'),
  );
  const nameErrorId = `${id}-name-error`;
  const urlHelpId = `${id}-url-help`;
  const urlErrorId = `${id}-url-error`;
  const policyHelpId = `${id}-policy-help`;
  const policyErrorId = `${id}-policy-error`;
  const hostHelpId = `${id}-host-help`;

  function selectMonitorType(type: Monitor['type']): void {
    setMonitorType(type);
    onTypeChange?.(type);
    onConfigurationChange();
  }

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
            <h2 className="m-0 text-sm font-semibold text-rail-text">Target</h2>
            <p className="mt-1 mb-0 text-xs leading-5 text-rail-muted">
              Name the service and provide the network target Watchrail should monitor.
            </p>
            <div className="mt-5 grid gap-5">
              {mode === 'create' ? (
                <fieldset className="m-0 grid gap-2 border-0 p-0">
                  <legend className="p-0 text-xs font-medium text-rail-subtle">Protocol</legend>
                  <div className="grid gap-2 sm:max-w-2xl sm:grid-cols-3">
                    {(['HTTP', 'TCP', 'DNS'] as const).map((type) => (
                      <button
                        key={type}
                        type="button"
                        aria-pressed={monitorType === type}
                        onClick={() => selectMonitorType(type)}
                        className="flex min-h-10 cursor-pointer items-center gap-2.5 rounded-rail-control border border-rail-border bg-rail-surface px-3 text-left text-sm font-medium text-rail-text hover:border-rail-border-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rail-accent aria-pressed:border-rail-accent aria-pressed:bg-rail-accent/5"
                      >
                        <span
                          aria-hidden="true"
                          className={`grid size-4 shrink-0 place-items-center rounded-full border ${
                            monitorType === type
                              ? 'border-rail-accent'
                              : 'border-rail-border-strong'
                          }`}
                        >
                          <span
                            className={`size-2 rounded-full bg-rail-accent ${
                              monitorType === type ? 'opacity-100' : 'opacity-0'
                            }`}
                          />
                        </span>
                        {type === 'HTTP'
                          ? 'HTTP endpoint'
                          : type === 'TCP'
                            ? 'TCP port'
                            : 'DNS record'}
                      </button>
                    ))}
                  </div>
                  <input type="hidden" name="monitorType" value={monitorType} />
                </fieldset>
              ) : (
                <input type="hidden" name="monitorType" value={monitorType} />
              )}
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

              {monitorType === 'HTTP' ? (
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
                    onChange={(event) =>
                      setHttpsEndpoint(
                        event.target.value.trim().toLowerCase().startsWith('https://'),
                      )
                    }
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
              ) : monitorType === 'TCP' ? (
                <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_9rem]">
                  <label
                    className="grid gap-1.5 text-xs font-medium text-rail-subtle"
                    htmlFor={`${id}-host`}
                  >
                    Hostname or IP address
                    <Input
                      id={`${id}-host`}
                      name="host"
                      type="text"
                      defaultValue={
                        initialValues?.configuration?.type === 'TCP'
                          ? initialValues.configuration.host
                          : ''
                      }
                      placeholder="database.internal"
                      autoComplete="off"
                      spellCheck={false}
                      required
                      aria-describedby={errors.host ? `${id}-host-error` : hostHelpId}
                      aria-invalid={Boolean(errors.host)}
                    />
                    {errors.host ? (
                      <span className="font-normal text-rail-danger" id={`${id}-host-error`}>
                        {errors.host[0]}
                      </span>
                    ) : (
                      <span className="font-normal leading-5 text-rail-muted" id={hostHelpId}>
                        Enter a host without a protocol, path, or credentials.
                      </span>
                    )}
                  </label>
                  <label
                    className="grid content-start gap-1.5 text-xs font-medium text-rail-subtle"
                    htmlFor={`${id}-port`}
                  >
                    Port
                    <Input
                      id={`${id}-port`}
                      name="port"
                      type="number"
                      min="1"
                      max="65535"
                      step="1"
                      defaultValue={
                        initialValues?.configuration?.type === 'TCP'
                          ? initialValues.configuration.port
                          : 443
                      }
                      inputMode="numeric"
                      required
                      aria-invalid={Boolean(errors.port)}
                    />
                    {errors.port ? (
                      <span className="font-normal text-rail-danger">{errors.port[0]}</span>
                    ) : null}
                  </label>
                </div>
              ) : (
                <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
                  <label
                    className="grid gap-1.5 text-xs font-medium text-rail-subtle"
                    htmlFor={`${id}-dns-name`}
                  >
                    DNS name
                    <Input
                      id={`${id}-dns-name`}
                      name="dnsName"
                      type="text"
                      defaultValue={
                        initialValues?.configuration?.type === 'DNS'
                          ? initialValues.configuration.name
                          : ''
                      }
                      placeholder="api.example.com"
                      autoComplete="off"
                      spellCheck={false}
                      required
                      aria-describedby={
                        errors.dnsName ? `${id}-dns-name-error` : `${id}-dns-name-help`
                      }
                      aria-invalid={Boolean(errors.dnsName)}
                    />
                    {errors.dnsName ? (
                      <span className="font-normal text-rail-danger" id={`${id}-dns-name-error`}>
                        {errors.dnsName[0]}
                      </span>
                    ) : (
                      <span
                        className="font-normal leading-5 text-rail-muted"
                        id={`${id}-dns-name-help`}
                      >
                        Enter a hostname without a protocol, path, or trailing dot.
                      </span>
                    )}
                  </label>
                  <label
                    className="grid content-start gap-1.5 text-xs font-medium text-rail-subtle"
                    htmlFor={`${id}-dns-record-type`}
                  >
                    Record type
                    <Select
                      id={`${id}-dns-record-type`}
                      name="dnsRecordType"
                      defaultValue={
                        initialValues?.configuration?.type === 'DNS'
                          ? initialValues.configuration.recordType
                          : 'A'
                      }
                      aria-invalid={Boolean(errors.dnsRecordType)}
                    >
                      {['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'].map((recordType) => (
                        <option key={recordType} value={recordType}>
                          {recordType}
                        </option>
                      ))}
                    </Select>
                    {errors.dnsRecordType ? (
                      <span className="font-normal text-rail-danger">
                        {errors.dnsRecordType[0]}
                      </span>
                    ) : null}
                  </label>
                </div>
              )}
            </div>
          </section>

          {monitorType === 'HTTP' ? (
            <>
              <QueryParametersField initialUrl={initialValues?.url} />

              <fieldset className="m-0 border-0 px-5 py-5 sm:px-6">
                <legend className="p-0 text-sm font-semibold text-rail-text">
                  Expected response
                </legend>
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

              <TlsCertificatePolicyField
                initialPolicy={initialValues?.tlsPolicy ?? { type: 'DISABLED' }}
                httpsEndpoint={httpsEndpoint}
                {...(errors.tlsPolicy?.[0] ? { error: errors.tlsPolicy[0] } : {})}
              />

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
            </>
          ) : monitorType === 'TCP' ? (
            <section className="px-5 py-5 sm:px-6">
              <h2 className="m-0 text-sm font-semibold text-rail-text">Connection check</h2>
              <p className="mt-1 mb-0 max-w-2xl text-xs leading-5 text-rail-muted">
                Watchrail resolves the target and measures how long a TCP connection takes to
                establish. It does not send application data after connecting.
              </p>
              {errors.tcpSettings ? (
                <p className="mt-3 mb-0 text-xs text-rail-danger">{errors.tcpSettings[0]}</p>
              ) : null}
            </section>
          ) : (
            <>
              <section className="px-5 py-5 sm:px-6">
                <h2 className="m-0 text-sm font-semibold text-rail-text">DNS lookup</h2>
                <p className="mt-1 mb-0 max-w-2xl text-xs leading-5 text-rail-muted">
                  Watchrail resolves the selected record type and measures the full lookup time.
                  Authoritative failures and answer mismatches affect monitor health.
                </p>
                {errors.dnsSettings ? (
                  <p className="mt-3 mb-0 text-xs text-rail-danger">{errors.dnsSettings[0]}</p>
                ) : null}
              </section>
              <DnsExpectedValuesField
                initialValues={
                  initialValues?.configuration.type === 'DNS'
                    ? initialValues.configuration.expectedValues
                    : []
                }
                {...(errors.dnsExpectedValues?.[0] ? { error: errors.dnsExpectedValues[0] } : {})}
              />
            </>
          )}
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
            {monitorType === 'HTTP' ? (
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
            ) : null}
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
            {monitorType === 'HTTP' ? (
              <label className="flex min-h-10 cursor-pointer items-center gap-2.5 rounded-rail-control border border-rail-border px-3 text-xs font-medium text-rail-subtle hover:border-rail-border-strong">
                <Checkbox
                  name="followRedirects"
                  defaultChecked={initialValues?.followRedirects ?? true}
                  aria-invalid={Boolean(errors.followRedirects)}
                />
                Follow redirects
              </label>
            ) : null}
            {monitorType === 'HTTP' && errors.followRedirects ? (
              <span className="-mt-2 text-xs text-rail-danger">{errors.followRedirects[0]}</span>
            ) : null}
          </div>
        </aside>
      </div>
      <ConfigurationTestPanel result={testResult} error={testError} onDismiss={onDismissTest} />
    </Form>
  );
}
