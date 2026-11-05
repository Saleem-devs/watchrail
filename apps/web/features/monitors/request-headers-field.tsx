'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Checkbox, Input, Select } from '../../components/ui/form-control';
import { listWorkspaceSecrets } from '../workspace-secrets/workspace-secret-api';
import type { WorkspaceSecret } from '../workspace-secrets/workspace-secret-types';
import { WorkspaceSecretOptions } from '../workspace-secrets/workspace-secret-options';

export interface RequestHeaderFormValue {
  name: string;
  sensitive: boolean;
  value: string | null;
  hasValue: true;
  secretReference?: { contractVersion: 1; secretId: string };
}

interface RequestHeaderRow extends RequestHeaderFormValue {
  id: string;
  source: 'INLINE' | 'VAULT';
  secretId: string;
  requiresInlineReplacement: boolean;
}

export function RequestHeadersField({
  initialHeaders = [],
  error,
}: {
  initialHeaders?: readonly RequestHeaderFormValue[];
  error?: string | undefined;
}) {
  const [rows, setRows] = useState<RequestHeaderRow[]>(() =>
    initialHeaders.map((header, index) => ({
      ...header,
      id: `existing-${index}`,
      source: header.secretReference ? 'VAULT' : 'INLINE',
      secretId: header.secretReference?.secretId ?? '',
      requiresInlineReplacement: false,
    })),
  );
  const [secrets, setSecrets] = useState<WorkspaceSecret[]>([]);
  const [secretsLoaded, setSecretsLoaded] = useState(false);
  const [secretsUnavailable, setSecretsUnavailable] = useState(false);
  const nextId = useRef(initialHeaders.length);

  function loadSecrets() {
    if (secretsLoaded || secretsUnavailable) return;
    void listWorkspaceSecrets()
      .then((items) => setSecrets(items.filter((item) => item.status === 'ACTIVE')))
      .then(() => setSecretsLoaded(true))
      .catch(() => setSecretsUnavailable(true));
  }

  useEffect(() => {
    if (initialHeaders.some((header) => header.secretReference)) loadSecrets();
    // Initial references are immutable for this field instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function addHeader() {
    setRows((current) => [
      ...current,
      {
        id: `new-${nextId.current++}`,
        name: '',
        value: '',
        sensitive: false,
        hasValue: true,
        source: 'INLINE',
        secretId: '',
        requiresInlineReplacement: false,
      },
    ]);
  }

  return (
    <section className="border-t border-rail-border px-5 py-5 sm:px-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="m-0 text-sm font-semibold text-rail-text">Request headers</h2>
          <p className="mt-1 mb-0 text-xs leading-5 text-rail-muted">
            Add headers sent with every check. Sensitive values are encrypted at rest.
          </p>
        </div>
        <Button type="button" variant="quiet" onClick={addHeader} className="shrink-0">
          Add header
        </Button>
      </div>

      {rows.length > 0 ? (
        <div className="mt-4 grid gap-3">
          {rows.map((row) => (
            <div
              key={row.id}
              className="grid gap-3 rounded-rail-control border border-rail-border bg-rail-surface p-3 sm:grid-cols-[minmax(0,0.75fr)_10rem_minmax(0,1.25fr)_auto] sm:items-start"
            >
              <label className="grid gap-1.5 text-xs font-medium text-rail-subtle">
                Header name
                <Input
                  name="requestHeaderName"
                  defaultValue={row.name}
                  placeholder="Authorization"
                  autoComplete="off"
                  required
                />
              </label>
              <label className="grid gap-1.5 text-xs font-medium text-rail-subtle">
                Value source
                <Select
                  value={row.source}
                  onChange={(event) => {
                    const source = event.target.value as 'INLINE' | 'VAULT';
                    if (source === 'VAULT') loadSecrets();
                    setRows((current) =>
                      current.map((candidate) =>
                        candidate.id === row.id
                          ? {
                              ...candidate,
                              source,
                              value: source === 'INLINE' ? '' : null,
                              secretId: '',
                              sensitive: source === 'VAULT' || candidate.sensitive,
                              requiresInlineReplacement:
                                candidate.source === 'VAULT' && source === 'INLINE',
                            }
                          : candidate,
                      ),
                    );
                  }}
                  aria-label={`Value source for ${row.name || 'header'}`}
                >
                  <option value="INLINE">This monitor</option>
                  <option value="VAULT">Workspace secret</option>
                </Select>
              </label>
              <label className="grid gap-1.5 text-xs font-medium text-rail-subtle">
                {row.source === 'VAULT' ? 'Workspace secret' : 'Value'}
                {row.source === 'VAULT' ? (
                  <Select
                    value={row.secretId}
                    onChange={(event) =>
                      setRows((current) =>
                        current.map((candidate) =>
                          candidate.id === row.id
                            ? { ...candidate, secretId: event.target.value }
                            : candidate,
                        ),
                      )
                    }
                    required
                    aria-label={`Workspace secret for ${row.name || 'header'}`}
                  >
                    <WorkspaceSecretOptions loaded={secretsLoaded} secrets={secrets} />
                  </Select>
                ) : (
                  <span className="grid gap-1.5">
                    <Input
                      name="requestHeaderValue"
                      type={row.sensitive ? 'password' : 'text'}
                      defaultValue={row.value ?? ''}
                      placeholder={
                        row.requiresInlineReplacement
                          ? 'Enter a replacement value'
                          : row.value === null
                            ? 'Stored securely — leave blank to retain'
                            : 'Value'
                      }
                      autoComplete="off"
                      required={row.requiresInlineReplacement}
                    />
                    {row.requiresInlineReplacement ? (
                      <span className="text-[11px] leading-4 font-normal text-rail-muted">
                        Enter a new value to replace the workspace secret.
                      </span>
                    ) : null}
                  </span>
                )}
                {row.source === 'VAULT' ? (
                  <input type="hidden" name="requestHeaderValue" value="" />
                ) : null}
              </label>
              <div className="flex min-h-10 items-center gap-2 pt-5 sm:justify-end">
                <label
                  className={`flex min-h-10 items-center gap-2 text-xs font-medium text-rail-subtle ${row.source === 'VAULT' ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
                >
                  <Checkbox
                    name="requestHeaderSensitive"
                    value={row.id}
                    defaultChecked={row.sensitive}
                    disabled={row.source === 'VAULT'}
                    onChange={(event) =>
                      setRows((current) =>
                        current.map((candidate) =>
                          candidate.id === row.id
                            ? { ...candidate, sensitive: event.target.checked }
                            : candidate,
                        ),
                      )
                    }
                    className="size-4"
                  />
                  Secret
                </label>
                <button
                  type="button"
                  className="grid size-10 place-items-center rounded-rail-control text-rail-muted transition-colors hover:bg-rail-hover hover:text-rail-text"
                  aria-label={`Remove ${row.name || 'header'}`}
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
                <input type="hidden" name="requestHeaderId" value={row.id} />
                <input type="hidden" name="requestHeaderSource" value={row.source} />
                <input type="hidden" name="requestHeaderSecretId" value={row.secretId} />
                <input
                  type="hidden"
                  name="requestHeaderHasStoredValue"
                  value={row.value === null ? 'true' : 'false'}
                />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-4 mb-0 rounded-rail-control border border-dashed border-rail-border px-4 py-3 text-xs text-rail-muted">
          No custom headers. Watchrail will send standard HTTP headers only.
        </p>
      )}

      {error ? <p className="mt-3 mb-0 text-xs text-rail-danger">{error}</p> : null}
      {secretsUnavailable ? (
        <p className="mt-3 mb-0 text-xs text-rail-danger" role="alert">
          Workspace secrets could not be loaded. Inline values remain available.
        </p>
      ) : null}
    </section>
  );
}
