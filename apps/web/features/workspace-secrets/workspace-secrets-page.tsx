'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useForm, type FieldValues, type Path, type UseFormSetError } from 'react-hook-form';
import { Button } from '../../components/ui/button';
import { ConfirmationDialog } from '../../components/ui/confirmation-dialog';
import { Checkbox, Input, Textarea } from '../../components/ui/form-control';
import {
  archiveWorkspaceSecret,
  createWorkspaceSecret,
  listWorkspaceSecretAuditEvents,
  listWorkspaceSecrets,
  rotateWorkspaceSecret,
  updateWorkspaceSecretDescription,
  WorkspaceSecretRequestError,
} from './workspace-secret-api';
import type {
  WorkspaceSecret,
  WorkspaceSecretAuditAction,
  WorkspaceSecretAuditEvent,
} from './workspace-secret-types';

type Editor =
  | { kind: 'create' }
  | { kind: 'rotate'; secret: WorkspaceSecret }
  | { kind: 'description'; secret: WorkspaceSecret }
  | null;

interface CreateSecretValues {
  key: string;
  description: string;
  value: string;
}

interface SecretValueValues {
  value: string;
}

interface DescriptionValues {
  description: string;
}

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

const auditLabels: Record<WorkspaceSecretAuditAction, string> = {
  CREATED: 'Created',
  DESCRIPTION_UPDATED: 'Description updated',
  ROTATED: 'Value rotated',
  ARCHIVED: 'Archived',
};

export function WorkspaceSecretsPage() {
  const [secrets, setSecrets] = useState<WorkspaceSecret[]>([]);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor>(null);
  const [archiveTarget, setArchiveTarget] = useState<WorkspaceSecret | null>(null);
  const [auditSecret, setAuditSecret] = useState<WorkspaceSecret | null>(null);
  const [auditEvents, setAuditEvents] = useState<WorkspaceSecretAuditEvent[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      setSecrets(await listWorkspaceSecrets(includeArchived));
      setLoadError(null);
    } catch (error) {
      setLoadError(messageFor(error, 'Could not load workspace secrets.'));
    } finally {
      setLoading(false);
    }
  }, [includeArchived]);

  useEffect(() => {
    let cancelled = false;
    void listWorkspaceSecrets(includeArchived)
      .then((nextSecrets) => {
        if (cancelled) return;
        setSecrets(nextSecrets);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(messageFor(error, 'Could not load workspace secrets.'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [includeArchived]);

  const activeCount = useMemo(
    () => secrets.filter((secret) => secret.status === 'ACTIVE').length,
    [secrets],
  );
  const usedCount = useMemo(
    () => secrets.filter((secret) => secret.usageCount > 0).length,
    [secrets],
  );

  async function showAudit(secret: WorkspaceSecret) {
    setAuditSecret(secret);
    setAuditEvents([]);
    setAuditLoading(true);
    try {
      setAuditEvents(await listWorkspaceSecretAuditEvents(secret.id));
    } catch (error) {
      setNotice(messageFor(error, 'Could not load the secret history.'));
      setAuditSecret(null);
    } finally {
      setAuditLoading(false);
    }
  }

  async function archive() {
    if (!archiveTarget) return;
    try {
      await archiveWorkspaceSecret(archiveTarget.id);
      setNotice(`${archiveTarget.key} archived.`);
      setArchiveTarget(null);
      await load();
    } catch (error) {
      setNotice(messageFor(error, 'Could not archive the secret.'));
      setArchiveTarget(null);
    }
  }

  return (
    <main id="main-content" data-watchrail-workspace className="w-full min-w-0 pb-16">
      <header className="flex flex-col gap-4 border-b border-rail-border pt-8 pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-2xl">
          <h1 className="m-0 text-2xl font-semibold tracking-[-0.02em] text-rail-text">Secrets</h1>
          <p className="mt-1.5 mb-0 text-sm leading-6 text-rail-subtle">
            Encrypt credentials once, rotate them without exposing their values, and reuse them
            across workspace monitors.
          </p>
        </div>
        <Button
          variant="primary"
          className="shrink-0 whitespace-nowrap"
          onClick={() => setEditor({ kind: 'create' })}
        >
          <PlusIcon />
          Add secret
        </Button>
      </header>

      {notice ? (
        <div
          className="mt-5 flex items-start justify-between gap-4 rounded-rail-control border border-rail-border bg-rail-raised px-4 py-3 text-sm text-rail-subtle"
          role="status"
        >
          <span>{notice}</span>
          <button
            type="button"
            className="cursor-pointer appearance-none border-0 bg-transparent p-0 text-rail-muted hover:text-rail-text"
            onClick={() => setNotice(null)}
            aria-label="Dismiss message"
          >
            <CloseIcon />
          </button>
        </div>
      ) : null}

      {editor ? (
        <section className="mt-6 rounded-rail-panel border border-rail-border bg-rail-surface">
          {editor.kind === 'create' ? (
            <CreateSecretForm
              onCancel={() => setEditor(null)}
              onSaved={async (secret) => {
                setEditor(null);
                setNotice(`${secret.key} encrypted and saved.`);
                await load();
              }}
            />
          ) : editor.kind === 'rotate' ? (
            <RotateSecretForm
              secret={editor.secret}
              onCancel={() => setEditor(null)}
              onSaved={async (secret) => {
                setEditor(null);
                setNotice(`${secret.key} rotated to version ${secret.versionNumber}.`);
                await load();
              }}
            />
          ) : (
            <DescriptionForm
              secret={editor.secret}
              onCancel={() => setEditor(null)}
              onSaved={async (secret) => {
                setEditor(null);
                setNotice(`${secret.key} description updated.`);
                await load();
              }}
            />
          )}
        </section>
      ) : null}

      <section className="mt-8" aria-labelledby="secret-list-title">
        <div className="flex flex-wrap items-end justify-between gap-4 pb-4">
          <div>
            <h2 id="secret-list-title" className="m-0 text-base font-semibold text-rail-text">
              Workspace vault
            </h2>
            <p className="mt-1 mb-0 text-sm text-rail-muted">
              {activeCount} active · {usedCount} referenced
            </p>
          </div>
          <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-rail-subtle sm:min-h-9">
            <Checkbox
              checked={includeArchived}
              onChange={(event) => {
                setLoading(true);
                setLoadError(null);
                setIncludeArchived(event.target.checked);
              }}
            />
            Show archived
          </label>
        </div>

        <div className="overflow-hidden rounded-rail-panel border border-rail-border bg-rail-surface">
          {loading ? (
            <SecretListLoading />
          ) : loadError ? (
            <div className="flex min-h-40 flex-col items-start justify-center gap-3 px-5 py-8">
              <p className="m-0 text-sm text-rail-subtle">{loadError}</p>
              <Button
                size="compact"
                onClick={() => {
                  setLoading(true);
                  setLoadError(null);
                  void load();
                }}
              >
                Retry
              </Button>
            </div>
          ) : secrets.length === 0 ? (
            <div className="flex min-h-48 flex-col items-start justify-center px-5 py-8">
              <h3 className="m-0 text-sm font-semibold text-rail-text">No workspace secrets yet</h3>
              <p className="mt-1.5 mb-4 max-w-lg text-sm leading-6 text-rail-muted">
                Add the first credential here instead of copying it into every monitor
                configuration.
              </p>
              <Button
                variant="secondary"
                size="compact"
                onClick={() => setEditor({ kind: 'create' })}
              >
                Add the first secret
              </Button>
            </div>
          ) : (
            <div className="divide-y divide-rail-border">
              <div className="hidden grid-cols-[minmax(15rem,2fr)_minmax(8rem,1fr)_7rem_10rem_13rem] gap-4 px-5 py-3 text-xs text-rail-muted lg:grid">
                <span>Secret</span>
                <span>Usage</span>
                <span className="text-right">Version</span>
                <span className="text-right">Updated</span>
                <span>
                  <span className="sr-only">Actions</span>
                </span>
              </div>
              {secrets.map((secret) => (
                <SecretRow
                  key={secret.id}
                  secret={secret}
                  onEdit={() => setEditor({ kind: 'description', secret })}
                  onRotate={() => setEditor({ kind: 'rotate', secret })}
                  onAudit={() => void showAudit(secret)}
                  onArchive={() => setArchiveTarget(secret)}
                />
              ))}
            </div>
          )}
        </div>
      </section>

      {auditSecret ? (
        <AuditPanel
          secret={auditSecret}
          events={auditEvents}
          loading={auditLoading}
          onClose={() => setAuditSecret(null)}
        />
      ) : null}

      <ConfirmationDialog
        open={archiveTarget !== null}
        title={archiveTarget ? `Archive ${archiveTarget.key}?` : 'Archive secret?'}
        description={
          archiveTarget?.usageCount
            ? 'This secret is still referenced and cannot be archived until those references are removed.'
            : 'The encrypted versions and audit trail will be retained. The secret will no longer be available for new monitor references.'
        }
        confirmLabel="Archive secret"
        onCancel={() => setArchiveTarget(null)}
        onConfirm={() => void archive()}
      />
    </main>
  );
}

function CreateSecretForm({
  onCancel,
  onSaved,
}: {
  onCancel: () => void;
  onSaved: (secret: WorkspaceSecret) => Promise<void>;
}) {
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<CreateSecretValues>({ defaultValues: { key: '', description: '', value: '' } });
  return (
    <form
      onSubmit={handleSubmit(async (values) => {
        try {
          await onSaved(
            await createWorkspaceSecret({
              key: values.key,
              description: nullableText(values.description),
              value: values.value,
            }),
          );
        } catch (error) {
          applyServerErrors(error, setError, ['key', 'description', 'value']);
        }
      })}
    >
      <FormHeading
        title="Add workspace secret"
        description="The value is encrypted before storage and is never returned by the API."
        onCancel={onCancel}
      />
      <div className="grid gap-5 p-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <FormError message={errors.root?.message} />
        <Field
          id="workspace-secret-key"
          label="Key"
          error={errors.key?.message}
          hint="Use an environment-style name such as STRIPE_API_KEY."
        >
          <Input
            id="workspace-secret-key"
            aria-describedby="workspace-secret-key-help"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            aria-invalid={Boolean(errors.key)}
            {...register('key', {
              required: 'Enter a key.',
              pattern: {
                value: /^[A-Za-z][A-Za-z0-9_]{0,63}$/,
                message: 'Start with a letter and use only letters, numbers, and underscores.',
              },
            })}
          />
        </Field>
        <Field
          id="workspace-secret-value"
          label="Secret value"
          error={errors.value?.message}
          hint="8 KB maximum. The value cannot be viewed after saving."
        >
          <Input
            id="workspace-secret-value"
            aria-describedby="workspace-secret-value-help"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            aria-invalid={Boolean(errors.value)}
            {...register('value', { required: 'Enter the secret value.' })}
          />
        </Field>
        <div className="lg:col-span-2">
          <Field
            id="workspace-secret-description"
            label="Description"
            error={errors.description?.message}
            hint="Optional. Describe where this credential belongs, not its value."
          >
            <Textarea
              id="workspace-secret-description"
              aria-describedby="workspace-secret-description-help"
              rows={3}
              className="resize-y py-2.5"
              {...register('description', {
                maxLength: {
                  value: 240,
                  message: 'Keep the description to 240 characters or fewer.',
                },
              })}
            />
          </Field>
        </div>
      </div>
      <FormActions isSubmitting={isSubmitting} submitLabel="Save secret" onCancel={onCancel} />
    </form>
  );
}

function RotateSecretForm({
  secret,
  onCancel,
  onSaved,
}: {
  secret: WorkspaceSecret;
  onCancel: () => void;
  onSaved: (secret: WorkspaceSecret) => Promise<void>;
}) {
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<SecretValueValues>({ defaultValues: { value: '' } });
  return (
    <form
      onSubmit={handleSubmit(async ({ value }) => {
        try {
          await onSaved(await rotateWorkspaceSecret(secret.id, value));
        } catch (error) {
          applyServerErrors(error, setError, ['value']);
        }
      })}
    >
      <FormHeading
        title={`Rotate ${secret.key}`}
        description={`Replace the encrypted value. Existing references move to version ${secret.versionNumber + 1} automatically.`}
        onCancel={onCancel}
      />
      <div className="max-w-2xl p-5">
        <FormError message={errors.root?.message} />
        <Field
          id="workspace-secret-rotation-value"
          label="New secret value"
          error={errors.value?.message}
          hint="The previous version remains encrypted in the audit history."
        >
          <Input
            id="workspace-secret-rotation-value"
            aria-describedby="workspace-secret-rotation-value-help"
            autoFocus
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            aria-invalid={Boolean(errors.value)}
            {...register('value', { required: 'Enter the replacement value.' })}
          />
        </Field>
      </div>
      <FormActions isSubmitting={isSubmitting} submitLabel="Rotate secret" onCancel={onCancel} />
    </form>
  );
}

function DescriptionForm({
  secret,
  onCancel,
  onSaved,
}: {
  secret: WorkspaceSecret;
  onCancel: () => void;
  onSaved: (secret: WorkspaceSecret) => Promise<void>;
}) {
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<DescriptionValues>({ defaultValues: { description: secret.description ?? '' } });
  return (
    <form
      onSubmit={handleSubmit(async ({ description }) => {
        try {
          await onSaved(
            await updateWorkspaceSecretDescription(secret.id, nullableText(description)),
          );
        } catch (error) {
          applyServerErrors(error, setError, ['description']);
        }
      })}
    >
      <FormHeading
        title={`Edit ${secret.key}`}
        description="Descriptions help teammates choose the correct credential without revealing its value."
        onCancel={onCancel}
      />
      <div className="max-w-2xl p-5">
        <FormError message={errors.root?.message} />
        <Field
          id="workspace-secret-edit-description"
          label="Description"
          error={errors.description?.message}
        >
          <Textarea
            id="workspace-secret-edit-description"
            aria-describedby="workspace-secret-edit-description-help"
            autoFocus
            rows={3}
            className="resize-y py-2.5"
            {...register('description', {
              maxLength: {
                value: 240,
                message: 'Keep the description to 240 characters or fewer.',
              },
            })}
          />
        </Field>
      </div>
      <FormActions isSubmitting={isSubmitting} submitLabel="Save description" onCancel={onCancel} />
    </form>
  );
}

function SecretRow({
  secret,
  onEdit,
  onRotate,
  onAudit,
  onArchive,
}: {
  secret: WorkspaceSecret;
  onEdit: () => void;
  onRotate: () => void;
  onAudit: () => void;
  onArchive: () => void;
}) {
  return (
    <div className="grid gap-3 px-5 py-4 lg:grid-cols-[minmax(15rem,2fr)_minmax(8rem,1fr)_7rem_10rem_13rem] lg:items-center lg:gap-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <code className="truncate font-mono text-sm font-medium text-rail-text">
            {secret.key}
          </code>
          {secret.status === 'ARCHIVED' ? (
            <span className="rounded-[4px] border border-rail-border-strong px-1.5 py-0.5 text-[11px] text-rail-muted">
              Archived
            </span>
          ) : null}
        </div>
        <p className="mt-1 mb-0 truncate text-sm text-rail-muted">
          {secret.description ?? 'No description'}
        </p>
      </div>
      <p className="m-0 text-sm text-rail-subtle">
        <span className="font-medium text-rail-text tabular-nums">{secret.usageCount}</span>{' '}
        {secret.usageCount === 1 ? 'reference' : 'references'}
      </p>
      <p className="m-0 text-right font-mono text-sm text-rail-subtle">v{secret.versionNumber}</p>
      <time className="text-right text-sm text-rail-muted tabular-nums" dateTime={secret.updatedAt}>
        {dateFormatter.format(new Date(secret.updatedAt))}
      </time>
      <div className="flex flex-wrap justify-start gap-1 lg:justify-end">
        <Button variant="quiet" size="compact" onClick={onAudit}>
          History
        </Button>
        {secret.status === 'ACTIVE' ? (
          <>
            <Button variant="quiet" size="compact" onClick={onEdit}>
              Edit
            </Button>
            <Button variant="quiet" size="compact" onClick={onRotate}>
              Rotate
            </Button>
            <Button
              variant="quiet"
              size="compact"
              disabled={secret.usageCount > 0}
              title={secret.usageCount > 0 ? 'Remove references before archiving' : undefined}
              onClick={onArchive}
            >
              Archive
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}

function AuditPanel({
  secret,
  events,
  loading,
  onClose,
}: {
  secret: WorkspaceSecret;
  events: WorkspaceSecretAuditEvent[];
  loading: boolean;
  onClose: () => void;
}) {
  return (
    <section
      className="mt-8 rounded-rail-panel border border-rail-border bg-rail-surface"
      aria-labelledby="audit-title"
    >
      <div className="flex items-start justify-between gap-4 border-b border-rail-border px-5 py-4">
        <div>
          <h2 id="audit-title" className="m-0 text-base font-semibold text-rail-text">
            {secret.key} history
          </h2>
          <p className="mt-1 mb-0 text-sm text-rail-muted">
            Value changes are recorded without exposing encrypted data.
          </p>
        </div>
        <button
          type="button"
          className="grid size-10 cursor-pointer appearance-none place-items-center rounded-rail-control border-0 bg-transparent p-0 text-rail-muted hover:bg-rail-hover hover:text-rail-text"
          onClick={onClose}
          aria-label="Close secret history"
        >
          <CloseIcon />
        </button>
      </div>
      <div className="divide-y divide-rail-border">
        {loading ? (
          <p className="m-0 px-5 py-5 text-sm text-rail-muted">Loading history…</p>
        ) : (
          events.map((event) => (
            <div
              key={event.id}
              className="grid gap-1 px-5 py-3 text-sm sm:grid-cols-[1fr_8rem_12rem] sm:items-center"
            >
              <span className="font-medium text-rail-text">{auditLabels[event.action]}</span>
              <span className="font-mono text-rail-subtle">v{event.versionNumber}</span>
              <time
                className="text-rail-muted tabular-nums sm:text-right"
                dateTime={event.occurredAt}
              >
                {dateFormatter.format(new Date(event.occurredAt))}
              </time>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function FormHeading({
  title,
  description,
  onCancel,
}: {
  title: string;
  description: string;
  onCancel: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-rail-border px-5 py-4">
      <div>
        <h2 className="m-0 text-base font-semibold text-rail-text">{title}</h2>
        <p className="mt-1 mb-0 text-sm leading-6 text-rail-muted">{description}</p>
      </div>
      <button
        type="button"
        onClick={onCancel}
        className="grid size-10 shrink-0 cursor-pointer appearance-none place-items-center rounded-rail-control border-0 bg-transparent p-0 text-rail-muted hover:bg-rail-hover hover:text-rail-text"
        aria-label="Close form"
      >
        <CloseIcon />
      </button>
    </div>
  );
}

function FormActions({
  isSubmitting,
  submitLabel,
  onCancel,
}: {
  isSubmitting: boolean;
  submitLabel: string;
  onCancel: () => void;
}) {
  return (
    <div className="flex justify-end gap-2 border-t border-rail-border px-5 py-4">
      <Button variant="quiet" onClick={onCancel}>
        Cancel
      </Button>
      <Button type="submit" variant="primary" disabled={isSubmitting}>
        {isSubmitting ? 'Saving…' : submitLabel}
      </Button>
    </div>
  );
}

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-2">
      <label htmlFor={id} className="text-sm font-medium text-rail-text">
        {label}
      </label>
      {children}
      {error ? (
        <span id={`${id}-help`} className="text-xs font-normal text-rail-danger" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span id={`${id}-help`} className="text-xs font-normal leading-5 text-rail-muted">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

function FormError({ message }: { message?: string | undefined }) {
  return message ? (
    <p className="m-0 text-sm text-rail-danger lg:col-span-2" role="alert">
      {message}
    </p>
  ) : null;
}

function SecretListLoading() {
  return (
    <div className="divide-y divide-rail-border" aria-label="Loading workspace secrets">
      {[0, 1, 2].map((row) => (
        <div
          key={row}
          className="grid min-h-20 animate-pulse grid-cols-[2fr_1fr] items-center gap-6 px-5 py-4"
        >
          <div className="space-y-2">
            <span className="block h-4 w-40 rounded bg-rail-hover" />
            <span className="block h-3 w-64 max-w-full rounded bg-rail-hover" />
          </div>
          <span className="ml-auto block h-4 w-20 rounded bg-rail-hover" />
        </div>
      ))}
    </div>
  );
}

function PlusIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      className="size-4"
      aria-hidden="true"
    >
      <path d="M8 3v10M3 8h10" strokeLinecap="round" />
    </svg>
  );
}
function CloseIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className="size-4"
      aria-hidden="true"
    >
      <path d="m4 4 8 8m0-8-8 8" strokeLinecap="round" />
    </svg>
  );
}
function nullableText(value: string): string | null {
  const normalized = value.trim();
  return normalized === '' ? null : normalized;
}
function messageFor(error: unknown, fallback: string): string {
  return error instanceof WorkspaceSecretRequestError ? error.message : fallback;
}

function applyServerErrors<T extends FieldValues>(
  error: unknown,
  setError: UseFormSetError<T>,
  fields: Path<T>[],
) {
  if (error instanceof WorkspaceSecretRequestError) {
    let applied = false;
    for (const field of fields) {
      const message = error.details.fields?.[String(field)]?.[0];
      if (message) {
        setError(field, { type: 'server', message });
        applied = true;
      }
    }
    if (!applied) setError('root', { type: 'server', message: error.message });
    return;
  }
  setError('root', { type: 'server', message: 'The request could not be completed.' });
}
