'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { actionClassName, Button } from '../../components/ui/button';
import { ConfirmationDialog } from '../../components/ui/confirmation-dialog';
import { Checkbox } from '../../components/ui/form-control';
import {
  archiveWorkspaceSecret,
  listWorkspaceSecretAuditEvents,
  listWorkspaceSecrets,
  WorkspaceSecretRequestError,
} from './workspace-secret-api';
import type {
  WorkspaceSecret,
  WorkspaceSecretAuditAction,
  WorkspaceSecretAuditEvent,
} from './workspace-secret-types';

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
        <Link
          href="/settings/secrets/new"
          className={actionClassName({
            variant: 'primary',
            className: 'shrink-0 whitespace-nowrap',
          })}
        >
          <PlusIcon />
          Add secret
        </Link>
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
              <Link
                href="/settings/secrets/new"
                className={actionClassName({ variant: 'secondary', size: 'compact' })}
              >
                Add the first secret
              </Link>
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
                  editHref={`/settings/secrets/${secret.id}/edit`}
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

function SecretRow({
  secret,
  editHref,
  onAudit,
  onArchive,
}: {
  secret: WorkspaceSecret;
  editHref: string;
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
            <Link
              href={editHref}
              className={actionClassName({ variant: 'secondary', size: 'compact' })}
            >
              Edit
            </Link>
            <Link
              href={`${editHref}#replace-value`}
              className={actionClassName({ variant: 'quiet', size: 'compact' })}
            >
              Rotate
            </Link>
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
  return <Plus className="size-4" strokeWidth={1.75} aria-hidden="true" />;
}
function CloseIcon() {
  return <X className="size-4" strokeWidth={1.75} aria-hidden="true" />;
}
function messageFor(error: unknown, fallback: string): string {
  return error instanceof WorkspaceSecretRequestError ? error.message : fallback;
}
