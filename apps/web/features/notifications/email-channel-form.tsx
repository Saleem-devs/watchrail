'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { AppShell } from '../../components/app-shell';
import { actionClassName, Button } from '../../components/ui/button';
import { Checkbox, Input, Textarea } from '../../components/ui/form-control';
import { PageHeader } from '../../components/ui/page-header';
import {
  createEmailChannel,
  findEmailChannel,
  listNotificationMonitors,
  NotificationRequestError,
  updateEmailChannel,
} from './notification-api';
import {
  NotificationMonitorScope,
  type NotificationMonitorScopeValue,
} from './notification-monitor-scope';
import type { EmailChannel, NotificationMonitor } from './types';

interface EmailChannelFormValues {
  name: string;
  recipients: string;
  monitorScope: NotificationMonitorScopeValue;
  monitorIds: string[];
  notifyOnIncident: boolean;
  notifyOnRecovery: boolean;
}

export function EmailChannelFormPage({
  projectId,
  channelId,
}: {
  projectId: string;
  channelId?: string;
}) {
  const router = useRouter();
  const [monitors, setMonitors] = useState<NotificationMonitor[]>([]);
  const [channel, setChannel] = useState<EmailChannel>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const listPath = `/projects/${projectId}/notifications`;
  const formId = 'email-channel-form';

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      listNotificationMonitors(projectId),
      channelId ? findEmailChannel(channelId) : Promise.resolve(undefined),
    ])
      .then(([nextMonitors, nextChannel]) => {
        if (cancelled) return;
        if (nextChannel && nextChannel.projectId !== projectId)
          throw new Error('This email channel does not belong to the selected project.');
        setMonitors(nextMonitors);
        setChannel(nextChannel);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(messageFor(error, 'Could not load this email channel.'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [channelId, projectId]);

  const editing = Boolean(channelId);
  return (
    <AppShell page="notifications" projectId={projectId}>
      <main id="main-content" data-watchrail-workspace className="w-full min-w-0 pb-16">
        <PageHeader
          backLink={{ href: listPath, label: 'Back to notifications' }}
          title={editing ? 'Edit email channel' : 'Add email channel'}
          description="Choose the recipients and monitors for confirmed incident email alerts."
          actions={
            !loading && !loadError ? (
              <>
                <Link href={listPath} className={actionClassName({ variant: 'quiet' })}>
                  Cancel
                </Link>
                <Button form={formId} type="submit" variant="primary" className="px-5">
                  {editing ? 'Save changes' : 'Add email channel'}
                </Button>
              </>
            ) : undefined
          }
        />
        {loading ? (
          <div
            className="mt-6 grid animate-pulse gap-6 xl:grid-cols-[minmax(0,1fr)_18rem]"
            role="status"
          >
            <div className="h-80 rounded-rail-panel bg-rail-raised" />
            <div className="h-72 rounded-rail-panel bg-rail-raised" />
            <span className="sr-only">Loading email channel…</span>
          </div>
        ) : loadError ? (
          <div className="mt-6 rounded-rail-panel border border-rail-border bg-rail-raised px-5 py-8">
            <p className="m-0 text-sm text-rail-subtle" role="alert">
              {loadError}
            </p>
          </div>
        ) : editing && !channel ? (
          <p className="mt-6 text-sm text-rail-subtle" role="alert">
            This email channel is unavailable.
          </p>
        ) : (
          <EmailChannelForm
            formId={formId}
            projectId={projectId}
            monitors={monitors}
            {...(channel ? { channel } : {})}
            onSaved={() => {
              router.push(listPath);
              router.refresh();
            }}
          />
        )}
      </main>
    </AppShell>
  );
}

export function EmailChannelForm({
  formId,
  projectId,
  monitors,
  channel,
  onSaved,
}: {
  formId: string;
  projectId: string;
  monitors: NotificationMonitor[];
  channel?: EmailChannel;
  onSaved: (channel: EmailChannel) => void;
}) {
  const {
    register,
    handleSubmit,
    control,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<EmailChannelFormValues>({
    defaultValues: {
      name: channel?.name ?? '',
      recipients: channel?.recipientEmails.join('\n') ?? '',
      monitorScope: channel ? (channel.routing.allMonitors ? 'PROJECT' : 'MONITORS') : 'PROJECT',
      monitorIds: channel?.routing.monitorIds ?? [],
      notifyOnIncident: channel?.routing.notifyOnIncident ?? true,
      notifyOnRecovery: channel?.routing.notifyOnRecovery ?? true,
    },
  });
  const monitorIds = useWatch({ control, name: 'monitorIds' });
  const monitorScope = useWatch({ control, name: 'monitorScope' });
  const notifyOnIncident = useWatch({ control, name: 'notifyOnIncident' });
  const notifyOnRecovery = useWatch({ control, name: 'notifyOnRecovery' });

  return (
    <form
      id={formId}
      className="mt-6 !p-0"
      noValidate
      aria-busy={isSubmitting}
      onSubmit={handleSubmit(async (values) => {
        if (!values.notifyOnIncident && !values.notifyOnRecovery) {
          setError('notifyOnIncident', { message: 'Choose at least one event to deliver.' });
          return;
        }
        if (values.monitorScope === 'MONITORS' && values.monitorIds.length === 0) {
          setError('monitorIds', { message: 'Choose at least one monitor.' });
          return;
        }
        const recipientEmails = parseRecipientLines(values.recipients);
        if (recipientEmails.length < 1 || recipientEmails.length > 20) {
          setError('recipients', { message: 'Enter 1 to 20 recipient email addresses.' });
          return;
        }
        try {
          const input = {
            name: values.name,
            recipientEmails,
            routing: {
              allMonitors: values.monitorScope === 'PROJECT',
              monitorIds: values.monitorScope === 'PROJECT' ? [] : values.monitorIds,
              notifyOnIncident: values.notifyOnIncident,
              notifyOnRecovery: values.notifyOnRecovery,
            },
          };
          const saved = channel
            ? await updateEmailChannel(channel.id, input)
            : await createEmailChannel({ ...input, projectId, enabled: true });
          onSaved(saved);
        } catch (error) {
          applyServerErrors(error, setError);
        }
      })}
    >
      <div className="overflow-hidden rounded-rail-panel border border-rail-border bg-rail-raised">
        <section className="px-5 py-5 sm:px-6">
          <h2 className="m-0 text-sm font-semibold text-rail-text">Recipients</h2>
          <p className="mt-1 mb-0 text-xs leading-5 text-rail-muted">
            Watchrail sends one notification to every address in this channel.
          </p>
          <div className="mt-5 grid gap-5">
            <Field label="Channel name" error={errors.name?.message}>
              <Input
                autoFocus
                placeholder="On-call team"
                aria-invalid={Boolean(errors.name)}
                {...register('name', { required: 'Enter a channel name.' })}
              />
            </Field>
            <Field
              label="Recipient emails"
              error={errors.recipients?.message}
              hint="Enter one address per line. Up to 20 recipients."
            >
              <Textarea
                className="min-h-28 resize-y py-2.5"
                autoComplete="email"
                spellCheck={false}
                placeholder={'alerts@example.com\noncall@example.com'}
                aria-invalid={Boolean(errors.recipients)}
                {...register('recipients', {
                  required: 'Enter at least one recipient email address.',
                  validate: (value) =>
                    parseRecipientLines(value).every((email) =>
                      /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email),
                    ) || 'Every line must contain a valid email address.',
                })}
              />
            </Field>
          </div>
        </section>

        <section className="border-t border-rail-border px-5 py-5 sm:px-6">
          <h2 className="m-0 text-sm font-semibold text-rail-text">Events</h2>
          <p className="mt-1 mb-0 text-xs leading-5 text-rail-muted">
            Choose which confirmed incident transitions are emailed.
          </p>
          <fieldset className="m-0 mt-4 border-0 p-0">
            <legend className="sr-only">Email notification events</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              <Choice
                label="Incident opened"
                description="Send after Watchrail confirms a failure."
              >
                <Checkbox {...register('notifyOnIncident')} />
              </Choice>
              <Choice label="Incident resolved" description="Send when the monitor recovers.">
                <Checkbox {...register('notifyOnRecovery')} />
              </Choice>
            </div>
          </fieldset>
          {errors.notifyOnIncident?.message ? (
            <p className="mt-2 mb-0 text-xs text-rail-danger" role="alert">
              {errors.notifyOnIncident.message}
            </p>
          ) : !notifyOnIncident && notifyOnRecovery ? (
            <p className="mt-2 mb-0 text-xs text-rail-muted">
              Recovery emails will arrive without a matching incident-open email.
            </p>
          ) : null}
        </section>
        <NotificationMonitorScope
          monitors={monitors}
          scope={monitorScope}
          selectedMonitorIds={monitorIds}
          scopeRegistration={register('monitorScope')}
          monitorRegistration={register('monitorIds')}
          error={errors.monitorIds?.message}
        />
        {errors.root?.message ? (
          <p className="mx-5 mt-0 mb-5 text-sm text-rail-danger sm:mx-6" role="alert">
            {errors.root.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}

function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
  children: ReactNode;
}) {
  return (
    <label className="grid min-w-0 gap-1.5 text-xs font-medium text-rail-subtle">
      {label}
      {children}
      {error ? (
        <span className="font-normal text-rail-danger" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="font-normal leading-5 text-rail-muted">{hint}</span>
      ) : null}
    </label>
  );
}

function Choice({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <label className="flex min-h-20 cursor-pointer items-start gap-3 rounded-rail-control border border-rail-border bg-rail-surface px-4 py-3 hover:border-rail-border-strong has-[:checked]:border-rail-accent has-[:checked]:bg-rail-accent/5">
      <span className="mt-0.5">{children}</span>
      <span>
        <strong className="block text-sm font-medium text-rail-text">{label}</strong>
        <span className="mt-1 block text-xs leading-5 text-rail-muted">{description}</span>
      </span>
    </label>
  );
}

function parseRecipientLines(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\n,]/u)
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

function applyServerErrors(
  error: unknown,
  setError: ReturnType<typeof useForm<EmailChannelFormValues>>['setError'],
) {
  if (error instanceof NotificationRequestError && error.details.fields) {
    const fields = error.details.fields;
    if (fields.name?.[0]) setError('name', { message: fields.name[0] });
    if (fields.recipientEmails?.[0]) setError('recipients', { message: fields.recipientEmails[0] });
    const routing = fields.routing?.[0] ?? fields.monitorIds?.[0] ?? fields.projectId?.[0];
    if (routing) setError('root', { message: routing });
    return;
  }
  setError('root', { message: messageFor(error, 'Could not save the email channel.') });
}

function messageFor(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
