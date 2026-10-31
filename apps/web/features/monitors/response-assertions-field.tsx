'use client';

import { useId, useRef, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Input, Select } from '../../components/ui/form-control';
import {
  ASSERTION_MAX_COUNT,
  newAssertionRow,
  operatorNeedsTarget,
  responseAssertionRows,
  type AssertionOperator,
  type AssertionSource,
  type RedactedResponseAssertionConfiguration,
  type ResponseAssertionRow,
} from './response-assertions';

const SOURCE_LABELS: Record<AssertionSource, string> = {
  HEADER: 'Response header',
  TEXT_BODY: 'Text body',
  JSON_BODY: 'JSON body',
};

const OPERATORS: Record<AssertionSource, Array<{ value: AssertionOperator; label: string }>> = {
  HEADER: [
    { value: 'exists', label: 'exists' },
    { value: 'does_not_exist', label: 'does not exist' },
    { value: 'equals', label: 'equals' },
    { value: 'not_equals', label: 'does not equal' },
    { value: 'contains', label: 'contains' },
    { value: 'not_contains', label: 'does not contain' },
  ],
  TEXT_BODY: [
    { value: 'equals', label: 'equals' },
    { value: 'not_equals', label: 'does not equal' },
    { value: 'contains', label: 'contains' },
    { value: 'not_contains', label: 'does not contain' },
  ],
  JSON_BODY: [
    { value: 'exists', label: 'exists' },
    { value: 'does_not_exist', label: 'does not exist' },
    { value: 'equals', label: 'equals' },
    { value: 'not_equals', label: 'does not equal' },
  ],
};

export function ResponseAssertionsField({
  method,
  initialConfiguration,
  error,
}: {
  method: string;
  initialConfiguration?: RedactedResponseAssertionConfiguration;
  error?: string;
}) {
  const id = useId();
  const [rows, setRows] = useState<ResponseAssertionRow[]>(() =>
    responseAssertionRows(initialConfiguration),
  );
  const nextId = useRef(rows.length);
  const atLimit = rows.length >= ASSERTION_MAX_COUNT;
  const headHasBodyAssertions = method === 'HEAD' && rows.some((row) => row.source !== 'HEADER');

  function add(source: AssertionSource) {
    if (atLimit || (method === 'HEAD' && source !== 'HEADER')) return;
    setRows((current) => [...current, newAssertionRow(`new-${nextId.current++}`, source)]);
  }

  function update(rowId: string, patch: Partial<ResponseAssertionRow>) {
    setRows((current) => current.map((row) => (row.id === rowId ? { ...row, ...patch } : row)));
  }

  return (
    <section
      className="border-t border-rail-border px-5 py-5 sm:px-6"
      aria-labelledby={`${id}-title`}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="m-0 text-sm font-semibold text-rail-text" id={`${id}-title`}>
              Response assertions
            </h2>
            <span className="text-xs tabular-nums text-rail-muted">
              {rows.length}/{ASSERTION_MAX_COUNT}
            </span>
          </div>
          <p className="mt-1 mb-0 max-w-2xl text-xs leading-5 text-rail-muted">
            Verify response headers or selected body values after the HTTP status check passes.
            Expected values marked secret are encrypted and never shown again.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5" aria-label="Add response assertion">
          <Button
            type="button"
            variant="quiet"
            size="compact"
            disabled={atLimit}
            onClick={() => add('HEADER')}
          >
            Add header
          </Button>
          <Button
            type="button"
            variant="quiet"
            size="compact"
            disabled={atLimit || method === 'HEAD'}
            onClick={() => add('TEXT_BODY')}
          >
            Add text
          </Button>
          <Button
            type="button"
            variant="quiet"
            size="compact"
            disabled={atLimit || method === 'HEAD'}
            onClick={() => add('JSON_BODY')}
          >
            Add JSON
          </Button>
        </div>
      </div>

      {headHasBodyAssertions ? (
        <p
          className="mt-3 mb-0 rounded-rail-control border border-rail-warning/35 bg-rail-warning/5 px-3 py-2 text-xs leading-5 text-rail-warning"
          role="alert"
        >
          HEAD responses do not include a body. Remove text and JSON assertions or choose another
          method.
        </p>
      ) : null}

      {rows.length > 0 ? (
        <div className="mt-4 grid gap-3">
          {rows.map((row, index) => (
            <AssertionRow
              key={row.id}
              row={row}
              index={index}
              onUpdate={(patch) => update(row.id, patch)}
              onRemove={() =>
                setRows((current) => current.filter(({ id: rowId }) => rowId !== row.id))
              }
            />
          ))}
        </div>
      ) : (
        <p className="mt-4 mb-0 rounded-rail-control border border-dashed border-rail-border px-4 py-3 text-xs leading-5 text-rail-muted">
          No response assertions. Availability is determined by transport and HTTP status only.
        </p>
      )}

      <input type="hidden" name="responseAssertions" value={JSON.stringify(rows)} />
      {error ? (
        <p className="mt-3 mb-0 text-xs leading-5 text-rail-danger" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function AssertionRow({
  row,
  index,
  onUpdate,
  onRemove,
}: {
  row: ResponseAssertionRow;
  index: number;
  onUpdate: (patch: Partial<ResponseAssertionRow>) => void;
  onRemove: () => void;
}) {
  const needsTarget = operatorNeedsTarget(row.operator);
  return (
    <div className="rounded-rail-control border border-rail-border bg-rail-surface p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid size-5 shrink-0 place-items-center rounded-full border border-rail-border-strong text-[10px] font-semibold tabular-nums text-rail-muted">
            {index + 1}
          </span>
          <strong className="truncate text-xs font-semibold text-rail-subtle">
            {SOURCE_LABELS[row.source]}
          </strong>
        </div>
        <button
          type="button"
          className="grid size-10 shrink-0 place-items-center rounded-rail-control text-rail-muted transition-colors hover:bg-rail-hover hover:text-rail-text"
          aria-label={`Remove ${SOURCE_LABELS[row.source].toLowerCase()} assertion ${index + 1}`}
          onClick={onRemove}
        >
          <svg
            aria-hidden="true"
            className="size-4"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          >
            <path d="M5 5l10 10M15 5 5 15" />
          </svg>
        </button>
      </div>
      <div className="grid gap-3 md:grid-cols-[minmax(10rem,1fr)_minmax(10rem,0.8fr)_minmax(12rem,1.2fr)]">
        {row.source === 'TEXT_BODY' ? (
          <div className="grid content-start gap-1.5 text-xs font-medium text-rail-subtle">
            Subject
            <div className="flex min-h-10 items-center rounded-rail-control border border-rail-border bg-rail-header px-3 font-normal text-rail-muted">
              Response body
            </div>
          </div>
        ) : (
          <label className="grid gap-1.5 text-xs font-medium text-rail-subtle">
            {row.source === 'HEADER' ? 'Header name' : 'JSON selector'}
            <Input
              value={row.subject}
              onChange={(event) =>
                onUpdate({ subject: event.target.value, retainSensitive: false })
              }
              placeholder={row.source === 'HEADER' ? 'content-type' : '$.status'}
              autoComplete="off"
              maxLength={row.source === 'HEADER' ? 120 : 512}
              required
            />
          </label>
        )}
        <label className="grid gap-1.5 text-xs font-medium text-rail-subtle">
          Operator
          <Select
            value={row.operator}
            onChange={(event) =>
              onUpdate({
                operator: event.target.value as AssertionOperator,
                retainSensitive: false,
              })
            }
          >
            {OPERATORS[row.source].map((operator) => (
              <option key={operator.value} value={operator.value}>
                {operator.label}
              </option>
            ))}
          </Select>
        </label>
        {needsTarget ? (
          <TargetField row={row} onUpdate={onUpdate} />
        ) : (
          <div className="grid content-start gap-1.5 text-xs font-medium text-rail-subtle">
            Expected value
            <div className="flex min-h-10 items-center rounded-rail-control border border-dashed border-rail-border px-3 font-normal text-rail-muted">
              Not required
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TargetField({
  row,
  onUpdate,
}: {
  row: ResponseAssertionRow;
  onUpdate: (patch: Partial<ResponseAssertionRow>) => void;
}) {
  const isJson = row.source === 'JSON_BODY';
  const valueDisabled = isJson && row.targetType === 'null';
  return (
    <div className="grid gap-1.5 text-xs font-medium text-rail-subtle">
      <span>Expected value</span>
      <div className={`grid gap-2 ${isJson ? 'sm:grid-cols-[7.5rem_minmax(0,1fr)]' : ''}`}>
        {isJson ? (
          <Select
            aria-label="Expected JSON type"
            value={row.targetType}
            onChange={(event) =>
              onUpdate({
                targetType: event.target.value as ResponseAssertionRow['targetType'],
                targetValue: event.target.value === 'boolean' ? 'true' : '',
                retainSensitive: false,
              })
            }
          >
            <option value="string">String</option>
            <option value="number">Number</option>
            <option value="boolean">Boolean</option>
            <option value="null">Null</option>
          </Select>
        ) : null}
        {isJson && row.targetType === 'boolean' ? (
          <Select
            aria-label="Expected value"
            value={row.targetValue || 'true'}
            onChange={(event) =>
              onUpdate({ targetValue: event.target.value, retainSensitive: false })
            }
          >
            <option value="true">true</option>
            <option value="false">false</option>
          </Select>
        ) : (
          <Input
            aria-label="Expected value"
            type={row.sensitive ? 'password' : row.targetType === 'number' ? 'text' : 'text'}
            inputMode={row.targetType === 'number' ? 'decimal' : undefined}
            value={row.targetValue}
            disabled={valueDisabled}
            maxLength={4096}
            placeholder={
              row.retainSensitive && row.targetValue === ''
                ? 'Stored securely — leave blank to retain'
                : valueDisabled
                  ? 'No value'
                  : 'Expected value'
            }
            autoComplete="off"
            onChange={(event) =>
              onUpdate({ targetValue: event.target.value, retainSensitive: false })
            }
          />
        )}
      </div>
      <label className="mt-1 flex min-h-8 cursor-pointer items-center gap-2 font-normal text-rail-muted">
        <input
          type="checkbox"
          className="size-4"
          checked={row.sensitive}
          disabled={row.targetType === 'null'}
          onChange={(event) =>
            onUpdate({ sensitive: event.target.checked, retainSensitive: false })
          }
        />
        Store expected value as secret
      </label>
    </div>
  );
}
