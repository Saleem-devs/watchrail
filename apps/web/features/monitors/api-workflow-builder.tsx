'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { Controller, useFieldArray, useForm, useWatch, type Control } from 'react-hook-form';
import { Button } from '../../components/ui/button';
import { Checkbox, Input, Select, Textarea } from '../../components/ui/form-control';
import { HTTP_METHODS } from './http-method-options';
import {
  ASSERTION_MAX_COUNT,
  newAssertionRow,
  operatorNeedsTarget,
  responseAssertionRows,
  serializeResponseAssertions,
  type AssertionOperator,
  type AssertionSource,
  type RedactedResponseAssertionConfiguration,
  type ResponseAssertionRow,
} from './response-assertions';
import type { ApiWorkflowConfiguration, ApiWorkflowStepConfiguration } from './types';

const MAXIMUM_STEPS = 10;
const MAXIMUM_EXECUTION_SECONDS = 90;
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

interface WorkflowHeaderFormValue {
  rowId: string;
  name: string;
  value: string;
  sensitive: boolean;
  retain: boolean;
}

interface WorkflowBodyFieldFormValue {
  rowId: string;
  name: string;
  value: string;
}

interface WorkflowExtractionFormValue {
  rowId: string;
  variable: string;
  selector: string;
  sensitive: boolean;
}

interface WorkflowStepFormValue {
  id: string;
  name: string;
  url: string;
  method: string;
  timeoutSeconds: number;
  followRedirects: boolean;
  statusPolicyMode: 'ANY_2XX' | 'EXACT';
  statusCodes: string;
  tlsEnabled: boolean;
  tlsDays: 1 | 2 | 3 | 7 | 14 | 30 | 60;
  headers: WorkflowHeaderFormValue[];
  bodyType: 'NONE' | 'JSON' | 'FORM_URLENCODED' | 'RAW';
  bodyValue: string;
  bodyContentType: string;
  bodyFields: WorkflowBodyFieldFormValue[];
  bodyRetain: boolean;
  assertions: ResponseAssertionRow[];
  extractions: WorkflowExtractionFormValue[];
}

interface WorkflowFormValue {
  steps: WorkflowStepFormValue[];
}

export function ApiWorkflowBuilder({
  initialConfiguration,
  error,
}: {
  initialConfiguration?: ApiWorkflowConfiguration;
  error?: string;
}) {
  const defaults = useMemo(
    () => ({
      steps: initialConfiguration?.steps.map(stepToFormValue) ?? [
        newStep(1, 'Authenticate'),
        newStep(2, 'Fetch resource'),
      ],
    }),
    [initialConfiguration],
  );
  const { control, register, setValue, getValues } = useForm<WorkflowFormValue>({
    defaultValues: defaults,
    mode: 'onChange',
  });
  const { fields, append, remove, move } = useFieldArray({ control, name: 'steps' });
  const steps = useWatch({ control, name: 'steps' });
  const [activeIndex, setActiveIndex] = useState(0);

  const totalTimeout = steps.reduce((total, step) => total + Number(step.timeoutSeconds || 0), 0);
  const serialized = useMemo(() => serializeWorkflow(steps), [steps]);

  function addStep() {
    if (fields.length >= MAXIMUM_STEPS) return;
    const nextNumber = nextStepNumber(getValues('steps'));
    append(newStep(nextNumber, `Step ${nextNumber}`));
    setActiveIndex(fields.length);
  }

  function removeStep(index: number) {
    if (fields.length <= 2) return;
    remove(index);
    setActiveIndex((current) => Math.min(current, fields.length - 2));
  }

  function reorderStep(index: number, direction: -1 | 1) {
    const destination = index + direction;
    if (destination < 0 || destination >= fields.length) return;
    move(index, destination);
    setActiveIndex(destination);
  }

  return (
    <section aria-labelledby="workflow-builder-title">
      <div className="border-b border-rail-border px-5 py-5 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="m-0 text-sm font-semibold text-rail-text" id="workflow-builder-title">
                Workflow steps
              </h2>
              <span className="text-xs tabular-nums text-rail-muted">
                {fields.length}/{MAXIMUM_STEPS}
              </span>
            </div>
            <p className="mt-1 mb-0 max-w-2xl text-xs leading-5 text-rail-muted">
              Run ordered HTTP requests and capture JSON values for later steps. Extracted values
              exist only for this execution and are never shown in history.
            </p>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="compact"
            disabled={fields.length >= MAXIMUM_STEPS}
            onClick={addStep}
          >
            Add step
          </Button>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-rail-border pt-3 text-xs">
          <span className="text-rail-muted">
            Total timeout{' '}
            <strong
              className={
                totalTimeout > MAXIMUM_EXECUTION_SECONDS ? 'text-rail-danger' : 'text-rail-text'
              }
            >
              {totalTimeout}s / {MAXIMUM_EXECUTION_SECONDS}s
            </strong>
          </span>
          <span className="text-rail-muted">
            Variables may be used in paths, queries, headers, and bodies.
          </span>
        </div>
        {totalTimeout > MAXIMUM_EXECUTION_SECONDS ? (
          <p className="mt-3 mb-0 text-xs text-rail-danger" role="alert">
            Reduce step timeouts so the workflow stays within the 90-second execution deadline.
          </p>
        ) : null}
        {error ? (
          <p className="mt-3 mb-0 text-xs leading-5 text-rail-danger" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <div className="grid min-w-0 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <nav
          className="border-b border-rail-border bg-rail-sidebar/45 p-3 lg:border-r lg:border-b-0"
          aria-label="Workflow steps"
        >
          <ol className="m-0 grid list-none gap-1 p-0">
            {fields.map((field, index) => {
              const step = steps[index];
              const selected = index === activeIndex;
              return (
                <li key={field.id} className="relative pl-5">
                  {index < fields.length - 1 ? (
                    <span
                      aria-hidden="true"
                      className="absolute top-8 bottom-[-0.5rem] left-[0.62rem] w-px bg-rail-border-strong"
                    />
                  ) : null}
                  <span
                    aria-hidden="true"
                    className={`absolute top-3.5 left-1 grid size-3 place-items-center rounded-full border ${
                      selected
                        ? 'border-rail-accent bg-rail-accent'
                        : 'border-rail-border-strong bg-rail-sidebar'
                    }`}
                  />
                  <button
                    type="button"
                    aria-current={selected ? 'step' : undefined}
                    onClick={() => setActiveIndex(index)}
                    className={`relative flex min-h-11 w-full cursor-pointer items-center justify-between gap-3 rounded-rail-control px-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rail-accent ${
                      selected
                        ? 'bg-rail-selected text-rail-text after:absolute after:right-3 after:bottom-0 after:left-3 after:h-px after:bg-rail-accent'
                        : 'text-rail-subtle hover:bg-rail-hover hover:text-rail-text'
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-semibold">
                        {step?.name.trim() || `Step ${index + 1}`}
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] text-rail-muted">
                        {step?.method || 'GET'} · {step?.url || 'URL not set'}
                      </span>
                    </span>
                    <span className="shrink-0 text-[11px] tabular-nums text-rail-muted">
                      {index + 1}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          <Button
            type="button"
            variant="quiet"
            size="compact"
            className="mt-3 w-full justify-center"
            disabled={fields.length >= MAXIMUM_STEPS}
            onClick={addStep}
          >
            Add request step
          </Button>
        </nav>

        {fields[activeIndex] ? (
          <StepEditor
            key={fields[activeIndex].id}
            control={control}
            register={register}
            setValue={setValue}
            index={activeIndex}
            stepCount={fields.length}
            onMove={reorderStep}
            onRemove={removeStep}
          />
        ) : null}
      </div>
      <input type="hidden" name="apiWorkflow" value={JSON.stringify(serialized)} readOnly />
    </section>
  );
}

function StepEditor({
  control,
  register,
  setValue,
  index,
  stepCount,
  onMove,
  onRemove,
}: {
  control: Control<WorkflowFormValue>;
  register: ReturnType<typeof useForm<WorkflowFormValue>>['register'];
  setValue: ReturnType<typeof useForm<WorkflowFormValue>>['setValue'];
  index: number;
  stepCount: number;
  onMove: (index: number, direction: -1 | 1) => void;
  onRemove: (index: number) => void;
}) {
  const step = useWatch({ control, name: `steps.${index}` });
  const headers = useFieldArray({ control, name: `steps.${index}.headers` });
  const bodyFields = useFieldArray({ control, name: `steps.${index}.bodyFields` });
  const extractions = useFieldArray({ control, name: `steps.${index}.extractions` });
  const assertions = step.assertions;
  const canSendBody = BODY_METHODS.has(step.method);

  function setAssertions(next: ResponseAssertionRow[]) {
    setValue(`steps.${index}.assertions`, next, { shouldDirty: true, shouldValidate: true });
  }

  function addAssertion(source: AssertionSource) {
    if (
      assertions.length >= ASSERTION_MAX_COUNT ||
      (step.method === 'HEAD' && source !== 'HEADER')
    ) {
      return;
    }
    setAssertions([...assertions, newAssertionRow(`${Date.now()}-${assertions.length}`, source)]);
  }

  function updateAssertion(rowIndex: number, patch: Partial<ResponseAssertionRow>) {
    setAssertions(
      assertions.map((assertion, currentIndex) =>
        currentIndex === rowIndex ? { ...assertion, ...patch } : assertion,
      ),
    );
  }

  return (
    <div className="min-w-0">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-rail-border px-5 py-4 sm:px-6">
        <div className="min-w-0">
          <p className="m-0 text-[11px] font-medium text-rail-muted">Step {index + 1}</p>
          <h3 className="mt-0.5 mb-0 truncate text-base font-semibold text-rail-text">
            {step.name.trim() || 'Untitled request'}
          </h3>
        </div>
        <div className="flex items-center gap-1">
          <IconButton label="Move step up" disabled={index === 0} onClick={() => onMove(index, -1)}>
            <path d="m5 10 3-3 3 3" />
          </IconButton>
          <IconButton
            label="Move step down"
            disabled={index === stepCount - 1}
            onClick={() => onMove(index, 1)}
          >
            <path d="m5 6 3 3 3-3" />
          </IconButton>
          <IconButton
            label="Remove step"
            danger
            disabled={stepCount <= 2}
            onClick={() => onRemove(index)}
          >
            <path d="M3 4.5h10M6 4.5V3h4v1.5M5 6l.5 7h5l.5-7" />
          </IconButton>
        </div>
      </header>

      <section className="border-b border-rail-border px-5 py-5 sm:px-6">
        <h4 className="m-0 text-sm font-semibold text-rail-text">Request</h4>
        <div className="mt-4 grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
          <label className="grid gap-1.5 text-xs font-medium text-rail-subtle">
            Step name
            <Input {...register(`steps.${index}.name`)} maxLength={120} required />
          </label>
          <label className="grid gap-1.5 text-xs font-medium text-rail-subtle">
            Step ID
            <Input
              {...register(`steps.${index}.id`)}
              pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,63}"
              maxLength={64}
              required
              className="font-mono text-xs"
            />
          </label>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-[8rem_minmax(0,1fr)_8rem]">
          <label className="grid gap-1.5 text-xs font-medium text-rail-subtle">
            Method
            <Controller
              control={control}
              name={`steps.${index}.method`}
              render={({ field }) => (
                <Select value={field.value} onChange={field.onChange}>
                  {HTTP_METHODS.map((method) => (
                    <option key={method} value={method}>
                      {method}
                    </option>
                  ))}
                </Select>
              )}
            />
          </label>
          <label className="grid gap-1.5 text-xs font-medium text-rail-subtle">
            HTTP(S) URL
            <Input
              {...register(`steps.${index}.url`)}
              type="text"
              inputMode="url"
              placeholder="https://api.watchrail.app/users/{{user_id}}"
              maxLength={2048}
              required
              spellCheck={false}
            />
          </label>
          <label className="grid gap-1.5 text-xs font-medium text-rail-subtle">
            Timeout
            <div className="relative">
              <Input
                {...register(`steps.${index}.timeoutSeconds`, { valueAsNumber: true })}
                aria-label={`Step ${index + 1} timeout`}
                type="number"
                min={1}
                max={30}
                step={1}
                className="pr-9 tabular-nums"
                required
              />
              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-rail-muted">
                s
              </span>
            </div>
          </label>
        </div>
        <p className="mt-2 mb-0 text-xs leading-5 text-rail-muted">
          Variables use <code className="font-mono text-rail-subtle">{'{{variable_name}}'}</code>{' '}
          and may reference only values captured by earlier steps. The URL origin cannot contain a
          variable.
        </p>
      </section>

      <section className="border-b border-rail-border px-5 py-5 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h4 className="m-0 text-sm font-semibold text-rail-text">Request headers</h4>
            <p className="mt-1 mb-0 text-xs leading-5 text-rail-muted">
              Secret values are encrypted and remain masked after save.
            </p>
          </div>
          <Button
            type="button"
            variant="quiet"
            size="compact"
            onClick={() =>
              headers.append({
                rowId: `${Date.now()}`,
                name: '',
                value: '',
                sensitive: false,
                retain: false,
              })
            }
          >
            Add header
          </Button>
        </div>
        {headers.fields.length ? (
          <div className="mt-4 grid gap-2">
            {headers.fields.map((header, headerIndex) => (
              <div
                className="grid gap-2 rounded-rail-control border border-rail-border bg-rail-surface p-3 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_auto]"
                key={header.id}
              >
                <Input
                  {...register(`steps.${index}.headers.${headerIndex}.name`)}
                  placeholder="authorization"
                  aria-label={`Step ${index + 1} header ${headerIndex + 1} name`}
                  required
                />
                <Input
                  {...register(`steps.${index}.headers.${headerIndex}.value`)}
                  type={step.headers[headerIndex]?.sensitive ? 'password' : 'text'}
                  placeholder={
                    step.headers[headerIndex]?.retain
                      ? 'Stored securely — leave blank to retain'
                      : 'Header value'
                  }
                  aria-label={`Step ${index + 1} header ${headerIndex + 1} value`}
                  autoComplete="off"
                />
                <IconButton
                  label={`Remove header ${headerIndex + 1}`}
                  onClick={() => headers.remove(headerIndex)}
                >
                  <path d="M3 4.5h10M6 4.5V3h4v1.5M5 6l.5 7h5l.5-7" />
                </IconButton>
                <label className="flex min-h-8 cursor-pointer items-center gap-2 text-xs text-rail-muted sm:col-span-3">
                  <Controller
                    control={control}
                    name={`steps.${index}.headers.${headerIndex}.sensitive`}
                    render={({ field }) => (
                      <Checkbox
                        checked={field.value}
                        onChange={(event) => field.onChange(event.target.checked)}
                      />
                    )}
                  />
                  Store this value as a secret
                </label>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState>No custom headers. Watchrail sends standard HTTP headers only.</EmptyState>
        )}
      </section>

      <section className="border-b border-rail-border px-5 py-5 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h4 className="m-0 text-sm font-semibold text-rail-text">Request body</h4>
            <p className="mt-1 mb-0 text-xs leading-5 text-rail-muted">
              Workflow request bodies are encrypted at rest and never returned after save.
            </p>
          </div>
          <Controller
            control={control}
            name={`steps.${index}.bodyType`}
            render={({ field }) => (
              <Select
                value={canSendBody ? field.value : 'NONE'}
                disabled={!canSendBody}
                onChange={field.onChange}
                controlSize="compact"
                className="w-44"
                aria-label={`Step ${index + 1} request body type`}
              >
                <option value="NONE">No body</option>
                <option value="JSON">JSON</option>
                <option value="FORM_URLENCODED">Form URL encoded</option>
                <option value="RAW">Raw</option>
              </Select>
            )}
          />
        </div>
        {!canSendBody ? (
          <p className="mt-3 mb-0 text-xs text-rail-muted">
            {step.method} requests do not send a body.
          </p>
        ) : step.bodyRetain && step.bodyType !== 'NONE' ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-rail-control border border-rail-border bg-rail-surface px-4 py-3">
            <div>
              <strong className="block text-xs font-semibold text-rail-text">
                Stored {step.bodyType.toLowerCase()} body
              </strong>
              <span className="mt-1 block text-xs text-rail-muted">
                Leave it unchanged, or replace it with a new encrypted value.
              </span>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="compact"
              onClick={() => setValue(`steps.${index}.bodyRetain`, false, { shouldDirty: true })}
            >
              Replace body
            </Button>
          </div>
        ) : step.bodyType === 'JSON' ? (
          <Textarea
            {...register(`steps.${index}.bodyValue`)}
            rows={7}
            required
            spellCheck={false}
            placeholder={'{\n  "email": "{{email}}"\n}'}
            className="mt-4 resize-y font-mono text-xs leading-5"
          />
        ) : step.bodyType === 'RAW' ? (
          <div className="mt-4 grid gap-3">
            <Input
              {...register(`steps.${index}.bodyContentType`)}
              placeholder="text/plain"
              required
              aria-label={`Step ${index + 1} body content type`}
            />
            <Textarea
              {...register(`steps.${index}.bodyValue`)}
              rows={6}
              required
              className="resize-y font-mono text-xs leading-5"
            />
          </div>
        ) : step.bodyType === 'FORM_URLENCODED' ? (
          <div className="mt-4 grid gap-2">
            {bodyFields.fields.map((field, fieldIndex) => (
              <div
                key={field.id}
                className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2"
              >
                <Input
                  {...register(`steps.${index}.bodyFields.${fieldIndex}.name`)}
                  placeholder="Field"
                  required
                />
                <Input
                  {...register(`steps.${index}.bodyFields.${fieldIndex}.value`)}
                  placeholder="Value"
                  required
                />
                <IconButton
                  label={`Remove form field ${fieldIndex + 1}`}
                  onClick={() => bodyFields.remove(fieldIndex)}
                >
                  <path d="M4 8h8" />
                </IconButton>
              </div>
            ))}
            <Button
              type="button"
              variant="quiet"
              size="compact"
              className="mt-1 w-fit"
              onClick={() => bodyFields.append({ rowId: `${Date.now()}`, name: '', value: '' })}
            >
              Add field
            </Button>
          </div>
        ) : null}
      </section>

      <section className="border-b border-rail-border px-5 py-5 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h4 className="m-0 text-sm font-semibold text-rail-text">Response assertions</h4>
              <span className="text-xs tabular-nums text-rail-muted">
                {assertions.length}/{ASSERTION_MAX_COUNT}
              </span>
            </div>
            <p className="mt-1 mb-0 text-xs leading-5 text-rail-muted">
              Verify headers or response content before later steps run.
            </p>
          </div>
          <div className="flex flex-wrap gap-1">
            <Button
              type="button"
              variant="quiet"
              size="compact"
              disabled={assertions.length >= ASSERTION_MAX_COUNT}
              onClick={() => addAssertion('HEADER')}
            >
              Add header
            </Button>
            <Button
              type="button"
              variant="quiet"
              size="compact"
              disabled={assertions.length >= ASSERTION_MAX_COUNT || step.method === 'HEAD'}
              onClick={() => addAssertion('TEXT_BODY')}
            >
              Add text
            </Button>
            <Button
              type="button"
              variant="quiet"
              size="compact"
              disabled={assertions.length >= ASSERTION_MAX_COUNT || step.method === 'HEAD'}
              onClick={() => addAssertion('JSON_BODY')}
            >
              Add JSON
            </Button>
          </div>
        </div>
        {assertions.length ? (
          <div className="mt-4 grid gap-2">
            {assertions.map((assertion, assertionIndex) => (
              <WorkflowAssertionRow
                key={assertion.id}
                row={assertion}
                index={assertionIndex}
                onChange={(patch) => updateAssertion(assertionIndex, patch)}
                onRemove={() =>
                  setAssertions(assertions.filter((_, itemIndex) => itemIndex !== assertionIndex))
                }
              />
            ))}
          </div>
        ) : (
          <EmptyState>
            No response assertions. This step uses transport and status policy only.
          </EmptyState>
        )}
      </section>

      <section className="border-b border-rail-border px-5 py-5 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h4 className="m-0 text-sm font-semibold text-rail-text">Variable extraction</h4>
            <p className="mt-1 mb-0 text-xs leading-5 text-rail-muted">
              Capture typed scalar JSON values for later steps. Sensitive values never appear in
              evidence.
            </p>
          </div>
          <Button
            type="button"
            variant="quiet"
            size="compact"
            disabled={extractions.fields.length >= 16}
            onClick={() =>
              extractions.append({
                rowId: `${Date.now()}`,
                variable: '',
                selector: '$.',
                sensitive: true,
              })
            }
          >
            Add extraction
          </Button>
        </div>
        {extractions.fields.length ? (
          <div className="mt-4 grid gap-2">
            {extractions.fields.map((extraction, extractionIndex) => (
              <div
                key={extraction.id}
                className="grid gap-2 rounded-rail-control border border-rail-border bg-rail-surface p-3 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_auto]"
              >
                <Input
                  {...register(`steps.${index}.extractions.${extractionIndex}.variable`)}
                  pattern="[A-Za-z_][A-Za-z0-9_]{0,63}"
                  placeholder="token"
                  required
                  aria-label={`Extraction ${extractionIndex + 1} variable`}
                  className="font-mono text-xs"
                />
                <Input
                  {...register(`steps.${index}.extractions.${extractionIndex}.selector`)}
                  placeholder="$.data.token"
                  required
                  aria-label={`Extraction ${extractionIndex + 1} JSON selector`}
                  className="font-mono text-xs"
                />
                <IconButton
                  label={`Remove extraction ${extractionIndex + 1}`}
                  onClick={() => extractions.remove(extractionIndex)}
                >
                  <path d="M3 4.5h10M6 4.5V3h4v1.5M5 6l.5 7h5l.5-7" />
                </IconButton>
                <label className="flex min-h-8 cursor-pointer items-center gap-2 text-xs text-rail-muted sm:col-span-3">
                  <Controller
                    control={control}
                    name={`steps.${index}.extractions.${extractionIndex}.sensitive`}
                    render={({ field }) => (
                      <Checkbox
                        checked={field.value}
                        onChange={(event) => field.onChange(event.target.checked)}
                      />
                    )}
                  />
                  Treat captured value as sensitive
                </label>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState>
            No values captured. Later steps can use only literal configuration.
          </EmptyState>
        )}
      </section>

      <section className="px-5 py-5 sm:px-6">
        <h4 className="m-0 text-sm font-semibold text-rail-text">Response and transport policy</h4>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <label className="grid gap-1.5 text-xs font-medium text-rail-subtle">
            Accepted response
            <Controller
              control={control}
              name={`steps.${index}.statusPolicyMode`}
              render={({ field }) => (
                <Select value={field.value} onChange={field.onChange}>
                  <option value="ANY_2XX">Any 2xx response</option>
                  <option value="EXACT">Specific status codes</option>
                </Select>
              )}
            />
          </label>
          {step.statusPolicyMode === 'EXACT' ? (
            <label className="grid gap-1.5 text-xs font-medium text-rail-subtle">
              Status codes
              <Input
                {...register(`steps.${index}.statusCodes`)}
                placeholder="200, 201"
                required
                inputMode="numeric"
              />
            </label>
          ) : null}
          <label className="grid gap-1.5 text-xs font-medium text-rail-subtle">
            TLS certificate
            <Controller
              control={control}
              name={`steps.${index}.tlsEnabled`}
              render={({ field }) => (
                <Select
                  value={field.value ? 'ENABLED' : 'DISABLED'}
                  onChange={(event) => field.onChange(event.target.value === 'ENABLED')}
                >
                  <option value="DISABLED">Do not evaluate expiry</option>
                  <option value="ENABLED">Require minimum validity</option>
                </Select>
              )}
            />
          </label>
          {step.tlsEnabled ? (
            <label className="grid gap-1.5 text-xs font-medium text-rail-subtle">
              Minimum validity
              <Controller
                control={control}
                name={`steps.${index}.tlsDays`}
                render={({ field }) => (
                  <Select
                    value={String(field.value)}
                    onChange={(event) => field.onChange(Number(event.target.value))}
                  >
                    {[1, 2, 3, 7, 14, 30, 60].map((days) => (
                      <option key={days} value={days}>
                        {days} days
                      </option>
                    ))}
                  </Select>
                )}
              />
            </label>
          ) : null}
        </div>
        <label className="mt-4 flex min-h-10 cursor-pointer items-center gap-2.5 rounded-rail-control border border-rail-border px-3 text-xs font-medium text-rail-subtle hover:border-rail-border-strong">
          <Controller
            control={control}
            name={`steps.${index}.followRedirects`}
            render={({ field }) => (
              <Checkbox
                checked={field.value}
                onChange={(event) => field.onChange(event.target.checked)}
              />
            )}
          />
          Follow redirects for this step
        </label>
      </section>
    </div>
  );
}

function WorkflowAssertionRow({
  row,
  index,
  onChange,
  onRemove,
}: {
  row: ResponseAssertionRow;
  index: number;
  onChange: (patch: Partial<ResponseAssertionRow>) => void;
  onRemove: () => void;
}) {
  const operators: Record<AssertionSource, AssertionOperator[]> = {
    HEADER: ['exists', 'does_not_exist', 'equals', 'not_equals', 'contains', 'not_contains'],
    TEXT_BODY: ['equals', 'not_equals', 'contains', 'not_contains'],
    JSON_BODY: ['exists', 'does_not_exist', 'equals', 'not_equals'],
  };
  return (
    <div className="grid gap-2 rounded-rail-control border border-rail-border bg-rail-surface p-3 md:grid-cols-[8rem_minmax(0,1fr)_10rem_minmax(0,1fr)_auto]">
      <Select
        value={row.source}
        onChange={(event) =>
          onChange(newAssertionRow(row.id, event.target.value as AssertionSource))
        }
        aria-label={`Assertion ${index + 1} source`}
      >
        <option value="HEADER">Header</option>
        <option value="TEXT_BODY">Text body</option>
        <option value="JSON_BODY">JSON body</option>
      </Select>
      {row.source === 'TEXT_BODY' ? (
        <div className="flex min-h-10 items-center rounded-rail-control border border-rail-border bg-rail-header px-3 text-xs text-rail-muted">
          Response body
        </div>
      ) : (
        <Input
          value={row.subject}
          onChange={(event) => onChange({ subject: event.target.value, retainSensitive: false })}
          placeholder={row.source === 'HEADER' ? 'content-type' : '$.status'}
          aria-label={`Assertion ${index + 1} subject`}
          required
        />
      )}
      <Select
        value={row.operator}
        onChange={(event) =>
          onChange({ operator: event.target.value as AssertionOperator, retainSensitive: false })
        }
        aria-label={`Assertion ${index + 1} operator`}
      >
        {operators[row.source].map((operator) => (
          <option key={operator} value={operator}>
            {operator.replaceAll('_', ' ')}
          </option>
        ))}
      </Select>
      {operatorNeedsTarget(row.operator) ? (
        <div className="grid gap-2">
          {row.source === 'JSON_BODY' ? (
            <Select
              value={row.targetType}
              onChange={(event) =>
                onChange({
                  targetType: event.target.value as ResponseAssertionRow['targetType'],
                  targetValue: event.target.value === 'boolean' ? 'true' : '',
                  retainSensitive: false,
                })
              }
              aria-label={`Assertion ${index + 1} target type`}
            >
              <option value="string">String</option>
              <option value="number">Number</option>
              <option value="boolean">Boolean</option>
              <option value="null">Null</option>
            </Select>
          ) : null}
          {row.targetType !== 'null' ? (
            row.source === 'JSON_BODY' && row.targetType === 'boolean' ? (
              <Select
                value={row.targetValue || 'true'}
                onChange={(event) =>
                  onChange({ targetValue: event.target.value, retainSensitive: false })
                }
                aria-label={`Assertion ${index + 1} expected value`}
              >
                <option value="true">true</option>
                <option value="false">false</option>
              </Select>
            ) : (
              <Input
                type={row.sensitive ? 'password' : 'text'}
                value={row.targetValue}
                onChange={(event) =>
                  onChange({ targetValue: event.target.value, retainSensitive: false })
                }
                placeholder={
                  row.retainSensitive ? 'Stored securely — leave blank to retain' : 'Expected value'
                }
                aria-label={`Assertion ${index + 1} expected value`}
              />
            )
          ) : null}
          {row.targetType !== 'null' ? (
            <label className="flex min-h-7 cursor-pointer items-center gap-2 text-xs text-rail-muted">
              <Checkbox
                checked={row.sensitive}
                onChange={(event) =>
                  onChange({ sensitive: event.target.checked, retainSensitive: false })
                }
              />
              Secret
            </label>
          ) : null}
        </div>
      ) : (
        <div className="flex min-h-10 items-center rounded-rail-control border border-dashed border-rail-border px-3 text-xs text-rail-muted">
          No value
        </div>
      )}
      <IconButton label={`Remove assertion ${index + 1}`} onClick={onRemove}>
        <path d="M3 4.5h10M6 4.5V3h4v1.5M5 6l.5 7h5l.5-7" />
      </IconButton>
    </div>
  );
}

function IconButton({
  label,
  disabled,
  danger = false,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`grid size-9 shrink-0 cursor-pointer place-items-center rounded-rail-control border border-rail-border bg-rail-surface transition-colors hover:border-rail-border-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rail-accent disabled:cursor-not-allowed disabled:opacity-40 ${danger ? 'text-rail-muted hover:text-rail-danger' : 'text-rail-subtle hover:text-rail-text'}`}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="size-4"
      >
        {children}
      </svg>
    </button>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <p className="mt-4 mb-0 rounded-rail-control border border-dashed border-rail-border px-4 py-3 text-xs leading-5 text-rail-muted">
      {children}
    </p>
  );
}

function newStep(number: number, name: string): WorkflowStepFormValue {
  return {
    id: `step_${number}`,
    name,
    url: '',
    method: number === 1 ? 'POST' : 'GET',
    timeoutSeconds: 10,
    followRedirects: true,
    statusPolicyMode: 'ANY_2XX',
    statusCodes: '',
    tlsEnabled: false,
    tlsDays: 14,
    headers: [],
    bodyType: number === 1 ? 'JSON' : 'NONE',
    bodyValue: number === 1 ? '{\n  \n}' : '',
    bodyContentType: 'text/plain',
    bodyFields: [{ rowId: 'initial', name: '', value: '' }],
    bodyRetain: false,
    assertions: [],
    extractions: [],
  };
}

function stepToFormValue(step: ApiWorkflowStepConfiguration, index: number): WorkflowStepFormValue {
  const body = step.requestBody;
  const bodyProtected = body.type !== 'NONE' && ('hasValue' in body || 'retain' in body);
  return {
    id: step.id,
    name: step.name,
    url: step.url,
    method: step.method,
    timeoutSeconds: step.timeoutMs / 1_000,
    followRedirects: step.followRedirects,
    statusPolicyMode: step.statusPolicy.type,
    statusCodes: step.statusPolicy.type === 'EXACT' ? step.statusPolicy.statusCodes.join(', ') : '',
    tlsEnabled: step.tlsPolicy.type === 'MINIMUM_VALIDITY',
    tlsDays: step.tlsPolicy.type === 'MINIMUM_VALIDITY' ? step.tlsPolicy.days : 14,
    headers: step.requestHeaders.map((header, headerIndex) => ({
      rowId: `${index}-${headerIndex}`,
      name: header.name,
      value: 'value' in header ? (header.value ?? '') : '',
      sensitive: header.sensitive,
      retain: header.sensitive && (('hasValue' in header && header.hasValue) || 'retain' in header),
    })),
    bodyType: body.type,
    bodyValue: body.type !== 'NONE' && !bodyProtected && 'value' in body ? body.value : '',
    bodyContentType: body.type === 'RAW' && !bodyProtected ? body.contentType : 'text/plain',
    bodyFields:
      body.type === 'FORM_URLENCODED' && !bodyProtected
        ? body.fields.map((field, fieldIndex) => ({ rowId: `${index}-${fieldIndex}`, ...field }))
        : [{ rowId: 'initial', name: '', value: '' }],
    bodyRetain: bodyProtected,
    assertions: responseAssertionRows(step.assertions as RedactedResponseAssertionConfiguration),
    extractions: step.extractions.map((extraction, extractionIndex) => ({
      rowId: `${index}-${extractionIndex}`,
      ...extraction,
    })),
  };
}

function serializeWorkflow(steps: WorkflowStepFormValue[]): ApiWorkflowConfiguration {
  return {
    contractVersion: 1,
    steps: steps.map((step) => ({
      id: step.id,
      name: step.name,
      url: step.url,
      method: step.method,
      timeoutMs: Number(step.timeoutSeconds) * 1_000,
      followRedirects: step.followRedirects,
      statusPolicy:
        step.statusPolicyMode === 'EXACT'
          ? {
              type: 'EXACT',
              statusCodes: step.statusCodes
                .split(',')
                .map((value) => Number(value.trim()))
                .filter(Number.isInteger),
            }
          : { type: 'ANY_2XX' },
      tlsPolicy: step.tlsEnabled
        ? { type: 'MINIMUM_VALIDITY', days: step.tlsDays }
        : { type: 'DISABLED' },
      requestHeaders: step.headers.map((header) =>
        header.sensitive && header.retain && header.value === ''
          ? { name: header.name, sensitive: true, retain: true }
          : { name: header.name, sensitive: header.sensitive, value: header.value },
      ),
      requestBody: serializeRequestBody(step),
      assertions: serializeResponseAssertions(step.assertions),
      extractions: step.extractions.map(({ variable, selector, sensitive }) => ({
        variable,
        selector,
        sensitive,
      })),
    })),
  };
}

function serializeRequestBody(
  step: WorkflowStepFormValue,
): ApiWorkflowStepConfiguration['requestBody'] {
  if (!BODY_METHODS.has(step.method) || step.bodyType === 'NONE') return { type: 'NONE' };
  if (step.bodyRetain) return { type: step.bodyType, sensitive: true, retain: true };
  if (step.bodyType === 'JSON') return { type: 'JSON', value: step.bodyValue };
  if (step.bodyType === 'RAW') {
    return { type: 'RAW', contentType: step.bodyContentType, value: step.bodyValue };
  }
  return {
    type: 'FORM_URLENCODED',
    fields: step.bodyFields.map(({ name, value }) => ({ name, value })),
  };
}

function nextStepNumber(steps: WorkflowStepFormValue[]): number {
  const used = new Set(steps.map((step) => step.id));
  let number = steps.length + 1;
  while (used.has(`step_${number}`)) number += 1;
  return number;
}
