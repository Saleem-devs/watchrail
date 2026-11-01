'use client';

import { useId, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/form-control';

const MAX_EXPECTED_VALUES = 32;

export function DnsExpectedValuesField({
  initialValues = [],
  error,
}: {
  initialValues?: string[];
  error?: string;
}) {
  const id = useId();
  const [rows, setRows] = useState(() =>
    initialValues.length > 0
      ? initialValues.map((value, index) => ({ id: index + 1, value }))
      : [{ id: 1, value: '' }],
  );
  const [nextId, setNextId] = useState(rows.length + 1);

  function addRow(): void {
    if (rows.length >= MAX_EXPECTED_VALUES) return;
    setRows((current) => [...current, { id: nextId, value: '' }]);
    setNextId((current) => current + 1);
  }

  function removeRow(rowId: number): void {
    setRows((current) =>
      current.length === 1
        ? [{ id: current[0]?.id ?? rowId, value: '' }]
        : current.filter((row) => row.id !== rowId),
    );
  }

  function updateRow(rowId: number, value: string): void {
    setRows((current) => current.map((row) => (row.id === rowId ? { ...row, value } : row)));
  }

  return (
    <section className="border-t border-rail-border px-5 py-5 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="m-0 text-sm font-semibold text-rail-text">Expected answers</h2>
          <p className="mt-1 mb-0 max-w-2xl text-xs leading-5 text-rail-muted">
            Optional. Every value listed must be present in the DNS response. Leave this empty to
            check only that the record exists.
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="compact"
          disabled={rows.length >= MAX_EXPECTED_VALUES}
          onClick={addRow}
        >
          Add value
        </Button>
      </div>
      <div className="mt-4 grid gap-2">
        {rows.map((row, index) => (
          <div key={row.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
            <label className="sr-only" htmlFor={`${id}-expected-${row.id}`}>
              Expected DNS value {index + 1}
            </label>
            <Input
              id={`${id}-expected-${row.id}`}
              name="dnsExpectedValue"
              type="text"
              value={row.value}
              onChange={(event) => updateRow(row.id, event.target.value)}
              placeholder={index === 0 ? '203.0.113.10' : 'Another expected answer'}
              maxLength={512}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? `${id}-error` : undefined}
            />
            <Button
              type="button"
              variant="quiet"
              size="compact"
              aria-label={`Remove expected DNS value ${index + 1}`}
              onClick={() => removeRow(row.id)}
              className="size-10 px-0"
            >
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                className="size-4"
                aria-hidden="true"
              >
                <path d="M3.5 3.5l9 9m0-9-9 9" strokeLinecap="round" />
              </svg>
            </Button>
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs">
        {error ? (
          <span className="text-rail-danger" id={`${id}-error`}>
            {error}
          </span>
        ) : (
          <span className="text-rail-muted">
            Values are normalized for the selected record type.
          </span>
        )}
        <span className="ml-auto text-rail-muted tabular-nums">
          {rows.filter((row) => row.value.trim()).length}/{MAX_EXPECTED_VALUES}
        </span>
      </div>
    </section>
  );
}
