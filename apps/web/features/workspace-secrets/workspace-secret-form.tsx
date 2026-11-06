'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useForm, type FieldValues, type Path, type UseFormSetError } from 'react-hook-form';
import { actionClassName, Button } from '../../components/ui/button';
import { Input, Textarea } from '../../components/ui/form-control';
import { PageHeader } from '../../components/ui/page-header';
import {
  createWorkspaceSecret,
  findWorkspaceSecret,
  rotateWorkspaceSecret,
  updateWorkspaceSecretDescription,
  WorkspaceSecretRequestError,
} from './workspace-secret-api';
import type { WorkspaceSecret } from './workspace-secret-types';

interface SecretFormValues {
  key: string;
  description: string;
  value: string;
}

export function WorkspaceSecretFormPage({ secretId }: { secretId?: string }) {
  const router = useRouter();
  const [secret, setSecret] = useState<WorkspaceSecret | undefined>();
  const [loading, setLoading] = useState(Boolean(secretId));
  const [loadError, setLoadError] = useState<string | null>(null);
  const listPath = '/settings/secrets';
  const formId = 'workspace-secret-form';

  useEffect(() => {
    if (!secretId) return;
    let cancelled = false;
    void findWorkspaceSecret(secretId)
      .then((nextSecret) => {
        if (cancelled) return;
        setSecret(nextSecret);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(messageFor(error, 'Could not load this workspace secret.'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [secretId]);

  const editing = Boolean(secretId);
  return (
    <main id="main-content" data-watchrail-workspace className="w-full min-w-0 pb-16">
      <PageHeader
        backLink={{ href: listPath, label: 'Back to secrets' }}
        title={
          editing
            ? secret
              ? `Edit ${secret.key}`
              : 'Edit workspace secret'
            : 'Add workspace secret'
        }
        description={
          editing
            ? 'Update its description or replace the encrypted value.'
            : 'Encrypt a credential once and reuse it without exposing the stored value.'
        }
        actions={
          !loading && !loadError && (!editing || secret) ? (
            <>
              <Link href={listPath} className={actionClassName({ variant: 'quiet' })}>
                Cancel
              </Link>
              <Button form={formId} type="submit" variant="primary" className="px-5">
                {editing ? 'Save changes' : 'Save secret'}
              </Button>
            </>
          ) : undefined
        }
      />

      {loading ? (
        <div className="mt-6 h-80 animate-pulse rounded-rail-panel bg-rail-raised" role="status">
          <span className="sr-only">Loading workspace secret…</span>
        </div>
      ) : loadError ? (
        <div className="mt-6 rounded-rail-panel border border-rail-border bg-rail-raised px-5 py-8">
          <p className="m-0 text-sm text-rail-subtle" role="alert">
            {loadError}
          </p>
          <Link
            href={listPath}
            className={actionClassName({ variant: 'secondary', className: 'mt-4' })}
          >
            Return to secrets
          </Link>
        </div>
      ) : editing && !secret ? (
        <div className="mt-6 rounded-rail-panel border border-rail-border bg-rail-raised px-5 py-8">
          <p className="m-0 text-sm text-rail-subtle" role="alert">
            This workspace secret is unavailable.
          </p>
        </div>
      ) : (
        <WorkspaceSecretForm
          formId={formId}
          {...(secret ? { secret } : {})}
          onSaved={() => {
            router.push(listPath);
            router.refresh();
          }}
        />
      )}
    </main>
  );
}

export function WorkspaceSecretForm({
  formId,
  secret,
  onSaved,
}: {
  formId: string;
  secret?: WorkspaceSecret;
  onSaved: (secret: WorkspaceSecret) => void;
}) {
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<SecretFormValues>({
    defaultValues: {
      key: secret?.key ?? '',
      description: secret?.description ?? '',
      value: '',
    },
  });

  return (
    <form
      id={formId}
      aria-label={secret ? 'Edit workspace secret' : 'Add workspace secret'}
      className="mt-6 overflow-hidden rounded-rail-panel border border-rail-border bg-rail-raised !p-0"
      noValidate
      aria-busy={isSubmitting}
      onSubmit={handleSubmit(async (values) => {
        try {
          if (!secret) {
            onSaved(
              await createWorkspaceSecret({
                key: values.key,
                description: nullableText(values.description),
                value: values.value,
              }),
            );
            return;
          }

          let updated = secret;
          const description = nullableText(values.description);
          if (description !== secret.description)
            updated = await updateWorkspaceSecretDescription(secret.id, description);
          if (values.value) updated = await rotateWorkspaceSecret(secret.id, values.value);
          onSaved(updated);
        } catch (error) {
          applyServerErrors(error, setError, ['key', 'description', 'value']);
        }
      })}
    >
      <section className="border-b border-rail-border px-5 py-5 sm:px-6">
        <h2 className="m-0 text-sm font-semibold text-rail-text">Secret details</h2>
        <p className="mt-1 mb-0 text-xs leading-5 text-rail-muted">
          Names and descriptions remain visible. Secret values are encrypted and never returned.
        </p>
        <div className="mt-5 grid gap-5 sm:grid-cols-2">
          <Field
            id="workspace-secret-key"
            label="Key"
            error={errors.key?.message}
            hint={
              secret
                ? 'Keys cannot be changed after creation.'
                : 'Use a name such as STRIPE_API_KEY.'
            }
          >
            <Input
              id="workspace-secret-key"
              autoFocus={!secret}
              autoComplete="off"
              spellCheck={false}
              readOnly={Boolean(secret)}
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
          <div id="replace-value">
            <Field
              id="workspace-secret-value"
              label={secret ? 'Replace secret value' : 'Secret value'}
              error={errors.value?.message}
              hint={
                secret
                  ? 'Leave blank to keep the current encrypted value.'
                  : '8 KB maximum. The value cannot be viewed after saving.'
              }
            >
              <Input
                id="workspace-secret-value"
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                aria-invalid={Boolean(errors.value)}
                placeholder={secret ? 'Encrypted value retained' : undefined}
                {...register('value', {
                  validate: (value) =>
                    Boolean(secret) || Boolean(value) || 'Enter the secret value.',
                })}
              />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field
              id="workspace-secret-description"
              label="Description"
              error={errors.description?.message}
              hint="Optional. Describe where this credential belongs, not its value."
            >
              <Textarea
                id="workspace-secret-description"
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
      </section>
      {errors.root?.message ? (
        <p className="m-0 px-5 py-4 text-sm text-rail-danger sm:px-6" role="alert">
          {errors.root.message}
        </p>
      ) : null}
    </form>
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
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-rail-subtle">
        {label}
      </label>
      {children}
      {error ? (
        <span className="text-xs font-normal text-rail-danger" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="text-xs font-normal leading-5 text-rail-muted">{hint}</span>
      ) : null}
    </div>
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
