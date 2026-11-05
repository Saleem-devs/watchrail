'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { AppShell } from '../../components/app-shell';
import { actionClassName, Button } from '../../components/ui/button';
import { Checkbox, Input } from '../../components/ui/form-control';
import { PageHeader } from '../../components/ui/page-header';
import {
  createWebhookChannel,
  findWebhookChannel,
  listNotificationMonitors,
  NotificationRequestError,
  updateWebhookChannel,
} from './notification-api';
import type { NotificationMonitor, WebhookChannel } from './types';

interface ChannelFormValues {
  name: string;
  url: string;
  signingSecret: string;
  monitorIds: string[];
  notifyOnIncident: boolean;
  notifyOnRecovery: boolean;
}

export function WebhookChannelFormPage({
  projectId,
  endpointId,
}: {
  projectId: string;
  endpointId?: string;
}) {
  const router = useRouter();
  const [monitors, setMonitors] = useState<NotificationMonitor[]>([]);
  const [channel, setChannel] = useState<WebhookChannel | undefined>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const listPath = `/projects/${projectId}/notifications`;
  const formId = 'webhook-channel-form';

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      listNotificationMonitors(projectId),
      endpointId ? findWebhookChannel(endpointId) : Promise.resolve(undefined),
    ])
      .then(([nextMonitors, nextChannel]) => {
        if (cancelled) return;
        if (nextChannel && nextChannel.projectId !== projectId)
          throw new Error('This webhook channel does not belong to the selected project.');
        setMonitors(nextMonitors);
        setChannel(nextChannel);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(messageFor(error, 'Could not load this webhook channel.'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [endpointId, projectId]);

  const editing = Boolean(endpointId);
  return (
    <AppShell page="notifications" projectId={projectId}>
      <main id="main-content" data-watchrail-workspace className="w-full min-w-0 pb-16">
        <PageHeader
          backLink={{ href: listPath, label: 'Back to notifications' }}
          title={editing ? 'Edit webhook channel' : 'Add webhook channel'}
          description="Configure a signed destination and choose which project incidents it receives."
          actions={
            !loading && !loadError ? (
              <>
                <Link href={listPath} className={actionClassName({ variant: 'quiet' })}>
                  Cancel
                </Link>
                <Button form={formId} type="submit" variant="primary" className="px-5">
                  {editing ? 'Save changes' : 'Add webhook'}
                </Button>
              </>
            ) : undefined
          }
        />

        {loading ? (
          <FormPageLoading />
        ) : loadError ? (
          <div className="mt-6 rounded-rail-panel border border-rail-border bg-rail-raised px-5 py-8">
            <p className="m-0 text-sm text-rail-subtle" role="alert">
              {loadError}
            </p>
            <Link
              href={listPath}
              className={actionClassName({ variant: 'secondary', className: 'mt-4' })}
            >
              Return to notifications
            </Link>
          </div>
        ) : editing && !channel ? (
          <div className="mt-6 rounded-rail-panel border border-rail-border bg-rail-raised px-5 py-8">
            <p className="m-0 text-sm text-rail-subtle" role="alert">
              This webhook channel is unavailable.
            </p>
          </div>
        ) : (
          <WebhookChannelForm
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

export function WebhookChannelForm({
  formId,
  projectId,
  monitors,
  channel,
  onSaved,
}: {
  formId: string;
  projectId: string;
  monitors: NotificationMonitor[];
  channel?: WebhookChannel;
  onSaved: (channel: WebhookChannel) => void;
}) {
  const {
    register,
    handleSubmit,
    control,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ChannelFormValues>({
    defaultValues: {
      name: channel?.name ?? '',
      url: channel?.url ?? '',
      signingSecret: '',
      monitorIds: channel?.routing.monitorIds ?? [],
      notifyOnIncident: channel?.routing.notifyOnIncident ?? true,
      notifyOnRecovery: channel?.routing.notifyOnRecovery ?? true,
    },
  });
  const notifyOnIncident = useWatch({ control, name: 'notifyOnIncident' });
  const notifyOnRecovery = useWatch({ control, name: 'notifyOnRecovery' });
  const monitorIds = useWatch({ control, name: 'monitorIds' });

  return (
    <form
      id={formId}
      aria-label={channel ? 'Edit webhook channel' : 'Add webhook channel'}
      className="mt-6 grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_18rem]"
      noValidate
      aria-busy={isSubmitting}
      onSubmit={handleSubmit(async (values) => {
        if (!values.notifyOnIncident && !values.notifyOnRecovery) {
          setError('notifyOnIncident', { message: 'Choose at least one event to deliver.' });
          return;
        }
        try {
          const routing = {
            monitorIds: values.monitorIds,
            notifyOnIncident: values.notifyOnIncident,
            notifyOnRecovery: values.notifyOnRecovery,
          };
          const saved = channel
            ? await updateWebhookChannel(channel.id, {
                name: values.name,
                url: values.url,
                signingSecret: values.signingSecret
                  ? { value: values.signingSecret }
                  : { retain: true },
                routing,
              })
            : await createWebhookChannel({
                projectId,
                name: values.name,
                url: values.url,
                signingSecret: values.signingSecret,
                enabled: true,
                routing,
              });
          onSaved(saved);
        } catch (error) {
          applyServerErrors(error, setError);
        }
      })}
    >
      <div className="overflow-hidden rounded-rail-panel border border-rail-border bg-rail-raised">
        <section className="border-b border-rail-border px-5 py-5 sm:px-6">
          <h2 className="m-0 text-sm font-semibold text-rail-text">Destination</h2>
          <p className="mt-1 mb-0 text-xs leading-5 text-rail-muted">
            Watchrail signs every incident request before sending it to this endpoint.
          </p>
          <div className="mt-5 grid gap-5 sm:grid-cols-2">
            <Field label="Channel name" error={errors.name?.message}>
              <Input
                autoFocus
                aria-invalid={Boolean(errors.name)}
                placeholder="Operations webhook"
                {...register('name', { required: 'Enter a channel name.' })}
              />
            </Field>
            <Field label="Endpoint URL" error={errors.url?.message}>
              <Input
                type="url"
                inputMode="url"
                autoComplete="url"
                spellCheck={false}
                aria-invalid={Boolean(errors.url)}
                placeholder="https://hooks.ops.company/watchrail"
                {...register('url', { required: 'Enter an HTTPS endpoint URL.' })}
              />
            </Field>
            <Field
              className="sm:col-span-2"
              label={channel ? 'Replace signing secret' : 'Signing secret'}
              error={errors.signingSecret?.message}
              hint={
                channel
                  ? 'Leave blank to keep the encrypted value. Enter a new value to rotate it.'
                  : 'Use at least 16 characters. The value cannot be viewed after saving.'
              }
            >
              <Input
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                aria-invalid={Boolean(errors.signingSecret)}
                placeholder={channel ? 'Encrypted value retained' : 'Enter a strong signing secret'}
                {...register('signingSecret', {
                  validate: (value) =>
                    Boolean(channel) || value.length >= 16 || 'Use at least 16 characters.',
                })}
              />
            </Field>
          </div>
        </section>

        <fieldset className="m-0 border-0 px-5 py-5 sm:px-6">
          <legend className="p-0 text-sm font-semibold text-rail-text">Events</legend>
          <p className="mt-1 mb-0 text-xs leading-5 text-rail-muted">
            Choose which confirmed incident transitions are delivered to this channel.
          </p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <ChoiceRow
              label="Incident opened"
              description="Send after Watchrail confirms that a monitor is down."
            >
              <Checkbox {...register('notifyOnIncident')} />
            </ChoiceRow>
            <ChoiceRow
              label="Incident resolved"
              description="Send when a confirmed incident returns to healthy."
            >
              <Checkbox {...register('notifyOnRecovery')} />
            </ChoiceRow>
          </div>
          {errors.notifyOnIncident?.message ? (
            <p className="mt-2 mb-0 text-xs text-rail-danger" role="alert">
              {errors.notifyOnIncident.message}
            </p>
          ) : !notifyOnIncident && notifyOnRecovery ? (
            <p className="mt-2 mb-0 text-xs text-rail-muted">
              Recovery events will arrive without a matching incident-open event on this channel.
            </p>
          ) : null}
        </fieldset>

        {errors.root?.message ? (
          <p className="mx-5 mt-0 mb-5 text-sm text-rail-danger sm:mx-6" role="alert">
            {errors.root.message}
          </p>
        ) : null}
      </div>

      <aside
        className="overflow-hidden rounded-rail-panel border border-rail-border bg-rail-raised"
        aria-label="Monitor routing"
      >
        <div className="border-b border-rail-border px-5 py-4">
          <h2 className="m-0 text-sm font-semibold text-rail-text">Monitor routing</h2>
          <p className="mt-1 mb-0 text-xs leading-5 text-rail-muted">
            Select the project monitors allowed to use this channel.
          </p>
        </div>
        <fieldset className="m-0 border-0 p-0">
          <legend className="sr-only">Routed monitors</legend>
          {monitors.length === 0 ? (
            <p className="m-0 px-5 py-5 text-sm leading-6 text-rail-muted">
              This project has no monitors yet.
            </p>
          ) : (
            <div className="max-h-80 overflow-y-auto">
              {monitors.map((monitor) => (
                <label
                  key={monitor.id}
                  className="flex min-h-14 cursor-pointer items-center gap-3 border-b border-rail-border px-5 py-2.5 last:border-b-0 hover:bg-rail-hover"
                >
                  <Checkbox value={monitor.id} {...register('monitorIds')} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-rail-text">
                      {monitor.name}
                    </span>
                    <span className="block text-xs leading-5 text-rail-muted">
                      {monitor.type === 'API_WORKFLOW' ? 'API workflow' : monitor.type} ·{' '}
                      {monitor.lifecycleState === 'ENABLED' ? 'Active' : 'Paused'}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
        <p className="m-0 border-t border-rail-border px-5 py-3 text-xs text-rail-muted">
          {monitorIds.length} selected
        </p>
      </aside>
    </form>
  );
}

function ChoiceRow({
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

function Field({
  label,
  error,
  hint,
  className,
  children,
}: {
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
  className?: string | undefined;
  children: ReactNode;
}) {
  return (
    <label
      className={`grid min-w-0 gap-1.5 text-xs font-medium text-rail-subtle ${className ?? ''}`}
    >
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

function FormPageLoading() {
  return (
    <div className="mt-6 grid animate-pulse gap-6 xl:grid-cols-[minmax(0,1fr)_18rem]" role="status">
      <div className="h-80 rounded-rail-panel bg-rail-raised" />
      <div className="h-72 rounded-rail-panel bg-rail-raised" />
      <span className="sr-only">Loading webhook channel…</span>
    </div>
  );
}

function applyServerErrors(
  error: unknown,
  setError: ReturnType<typeof useForm<ChannelFormValues>>['setError'],
) {
  if (error instanceof NotificationRequestError && error.details.fields) {
    const fields = error.details.fields;
    for (const field of ['name', 'url', 'signingSecret'] as const) {
      const message = fields[field]?.[0];
      if (message) setError(field, { message });
    }
    const routingMessage = fields.routing?.[0] ?? fields.monitorIds?.[0] ?? fields.projectId?.[0];
    if (routingMessage) setError('root', { message: routingMessage });
    if (
      Object.keys(fields).some(
        (field) =>
          !['name', 'url', 'signingSecret', 'routing', 'monitorIds', 'projectId'].includes(field),
      )
    )
      setError('root', { message: error.message });
    return;
  }
  setError('root', { message: messageFor(error, 'Could not save the webhook channel.') });
}

function messageFor(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
