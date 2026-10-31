'use client';

import { useId, useState } from 'react';
import { Input, Select, Textarea } from '../../components/ui/form-control';

export type RequestBodyValue =
  | { type: 'NONE' }
  | { type: 'JSON'; value: string }
  | { type: 'FORM_URLENCODED'; fields: Array<{ name: string; value: string }> }
  | { type: 'RAW'; contentType: string; value: string };

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

export function RequestBodyField({
  method,
  initialBody = { type: 'NONE' },
  error,
}: {
  method: string;
  initialBody?: RequestBodyValue;
  error?: string;
}) {
  const id = useId();
  const enabled = BODY_METHODS.has(method);
  const [type, setType] = useState<RequestBodyValue['type']>(initialBody.type);
  const [rows, setRows] = useState(
    initialBody.type === 'FORM_URLENCODED' && initialBody.fields.length > 0
      ? initialBody.fields.map((field, index) => ({ ...field, id: `${index}` }))
      : [{ id: '0', name: '', value: '' }],
  );
  const effectiveType = enabled ? type : 'NONE';

  return (
    <section className="border-t border-rail-border px-5 py-5 sm:px-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="m-0 text-sm font-semibold text-rail-text">Request body</h2>
          <p className="mt-1 mb-0 text-xs leading-5 text-rail-muted">
            {enabled
              ? 'Send structured data with this HTTP request.'
              : `${method} requests do not send a body.`}
          </p>
        </div>
        <Select
          name="requestBodyType"
          value={effectiveType}
          disabled={!enabled}
          onChange={(event) => setType(event.target.value as RequestBodyValue['type'])}
          controlSize="compact"
          className="w-44"
          aria-label="Request body type"
        >
          <option value="NONE">No body</option>
          <option value="JSON">JSON</option>
          <option value="FORM_URLENCODED">Form URL encoded</option>
          <option value="RAW">Raw</option>
        </Select>
      </div>

      {effectiveType === 'JSON' ? (
        <Textarea
          name="requestBodyValue"
          defaultValue={initialBody.type === 'JSON' ? initialBody.value : '{\n  \n}'}
          rows={8}
          spellCheck={false}
          className="mt-4 resize-y font-mono text-xs leading-5"
          aria-invalid={Boolean(error)}
        />
      ) : null}

      {effectiveType === 'RAW' ? (
        <div className="mt-4 grid gap-3">
          <Input
            name="requestBodyContentType"
            defaultValue={initialBody.type === 'RAW' ? initialBody.contentType : 'text/plain'}
            placeholder="text/plain"
            aria-label="Request body content type"
          />
          <Textarea
            name="requestBodyValue"
            defaultValue={initialBody.type === 'RAW' ? initialBody.value : ''}
            rows={7}
            className="resize-y font-mono text-xs leading-5"
            aria-invalid={Boolean(error)}
          />
        </div>
      ) : null}

      {effectiveType === 'FORM_URLENCODED' ? (
        <div className="mt-4 grid gap-2">
          {rows.map((row) => (
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2" key={row.id}>
              <Input
                name="requestBodyFieldName"
                defaultValue={row.name}
                placeholder="Field"
                aria-label="Form field name"
              />
              <Input
                name="requestBodyFieldValue"
                defaultValue={row.value}
                placeholder="Value"
                aria-label="Form field value"
              />
              <button
                type="button"
                className="min-h-10 rounded-rail-control border border-rail-border px-3 text-xs text-rail-subtle hover:border-rail-border-strong hover:text-rail-text"
                onClick={() => setRows((current) => current.filter((item) => item.id !== row.id))}
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            className="mt-1 w-fit text-xs font-medium text-rail-accent hover:text-rail-accent-hover"
            onClick={() =>
              setRows((current) => [...current, { id: `${Date.now()}`, name: '', value: '' }])
            }
          >
            + Add field
          </button>
        </div>
      ) : null}

      {error ? (
        <p className="mt-2 mb-0 text-xs text-rail-danger" id={`${id}-error`}>
          {error}
        </p>
      ) : null}
    </section>
  );
}
