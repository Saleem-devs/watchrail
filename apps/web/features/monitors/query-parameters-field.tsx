'use client';

import { useRef, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/form-control';

export interface QueryParameterFormValue {
  name: string;
  value: string;
}

interface QueryParameterRow extends QueryParameterFormValue {
  id: string;
}

export function QueryParametersField({ initialUrl }: { initialUrl?: string | undefined }) {
  const initialParameters = queryParametersFromUrl(initialUrl);
  const [rows, setRows] = useState<QueryParameterRow[]>(() =>
    initialParameters.map((parameter, index) => ({ ...parameter, id: `existing-${index}` })),
  );
  const nextId = useRef(initialParameters.length);

  function addParameter() {
    setRows((current) => [
      ...current,
      { id: `new-${nextId.current++}`, name: '', value: '' },
    ]);
  }

  return (
    <section className="border-t border-rail-border px-5 py-5 sm:px-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="m-0 text-sm font-semibold text-rail-text">Query parameters</h2>
          <p className="mt-1 mb-0 text-xs leading-5 text-rail-muted">
            Build the endpoint query string without manually encoding names or values.
          </p>
        </div>
        <Button type="button" variant="quiet" onClick={addParameter} className="shrink-0">
          Add parameter
        </Button>
      </div>

      {rows.length > 0 ? (
        <div className="mt-4 grid gap-3">
          {rows.map((row) => (
            <div
              key={row.id}
              className="grid gap-3 rounded-rail-control border border-rail-border bg-rail-surface p-3 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_auto] sm:items-end"
            >
              <label className="grid gap-1.5 text-xs font-medium text-rail-subtle">
                Name
                <Input
                  name="queryParameterName"
                  defaultValue={row.name}
                  placeholder="environment"
                  autoComplete="off"
                  required
                />
              </label>
              <label className="grid gap-1.5 text-xs font-medium text-rail-subtle">
                Value
                <Input
                  name="queryParameterValue"
                  defaultValue={row.value}
                  placeholder="production"
                  autoComplete="off"
                />
              </label>
              <button
                type="button"
                className="grid size-10 place-items-center rounded-rail-control text-rail-muted transition-colors hover:bg-rail-hover hover:text-rail-text"
                aria-label={`Remove ${row.name || 'query parameter'}`}
                onClick={() => setRows((current) => current.filter(({ id }) => id !== row.id))}
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
          ))}
        </div>
      ) : (
        <p className="mt-4 mb-0 rounded-rail-control border border-dashed border-rail-border px-4 py-3 text-xs text-rail-muted">
          No query parameters. The endpoint will be requested as entered above.
        </p>
      )}
    </section>
  );
}

export function endpointBaseUrl(value: string | undefined): string {
  if (!value) return '';
  try {
    const url = new URL(value);
    url.search = '';
    return url.toString();
  } catch {
    return value;
  }
}

function queryParametersFromUrl(value: string | undefined): QueryParameterFormValue[] {
  if (!value) return [];
  try {
    return [...new URL(value).searchParams.entries()].map(([name, parameterValue]) => ({
      name,
      value: parameterValue,
    }));
  } catch {
    return [];
  }
}
