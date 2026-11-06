'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import {
  Controller,
  useForm,
  useWatch,
  type UseFormRegisterReturn,
  type UseFormSetError,
} from 'react-hook-form';
import { AppShell } from '../../components/app-shell';
import { actionClassName, Button } from '../../components/ui/button';
import { Checkbox, Input, Select } from '../../components/ui/form-control';
import { PageHeader } from '../../components/ui/page-header';
import {
  createMaintenanceWindow,
  findMaintenanceWindow,
  listMaintenanceMonitors,
  MaintenanceWindowRequestError,
  updateMaintenanceWindow,
} from './maintenance-window-api';
import type { MaintenanceMonitor, MaintenanceWindow } from './types';

const weekdays = [
  ['1', 'Mon'],
  ['2', 'Tue'],
  ['3', 'Wed'],
  ['4', 'Thu'],
  ['5', 'Fri'],
  ['6', 'Sat'],
  ['0', 'Sun'],
] as const;

const supportedTimezones =
  typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
const timezones = ['UTC', ...supportedTimezones.filter((timezone) => timezone !== 'UTC')];

interface FormValues {
  name: string;
  scheduleType: 'ONE_TIME' | 'RECURRING';
  startsAt: string;
  endsAt: string;
  timezone: string;
  localTime: string;
  daysOfWeek: string[];
  durationMinutes: number;
  startsOn: string;
  endsOn: string;
  targetType: 'PROJECT' | 'MONITORS';
  monitorIds: string[];
  suppressNotifications: boolean;
  suppressIncidentCreation: boolean;
  excludeFromUptime: boolean;
  publishToStatusPage: boolean;
}

export function MaintenanceWindowFormPage({
  projectId,
  maintenanceWindowId,
}: {
  projectId: string;
  maintenanceWindowId?: string;
}) {
  const router = useRouter();
  const [monitors, setMonitors] = useState<MaintenanceMonitor[]>([]);
  const [window, setWindow] = useState<MaintenanceWindow | undefined>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const listPath = `/projects/${projectId}/maintenance`;
  const formId = 'maintenance-window-form';
  const editing = Boolean(maintenanceWindowId);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      listMaintenanceMonitors(projectId),
      maintenanceWindowId
        ? findMaintenanceWindow(projectId, maintenanceWindowId)
        : Promise.resolve(undefined),
    ])
      .then(([nextMonitors, nextWindow]) => {
        if (cancelled) return;
        setMonitors(nextMonitors);
        setWindow(nextWindow);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(messageFor(error, 'Could not load maintenance settings.'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [maintenanceWindowId, projectId]);

  return (
    <AppShell page="maintenance" projectId={projectId}>
      <main id="main-content" data-watchrail-workspace className="w-full min-w-0 pb-16">
        <PageHeader
          backLink={{ href: listPath, label: 'Back to maintenance' }}
          title={editing ? 'Edit maintenance window' : 'Schedule maintenance'}
          description="Define when planned work applies and how Watchrail treats alerts, incidents, uptime, and public status."
          actions={
            !loading && !loadError && (!editing || window) ? (
              <>
                <Link href={listPath} className={actionClassName({ variant: 'quiet' })}>
                  Cancel
                </Link>
                <Button form={formId} type="submit" variant="primary" className="px-5">
                  {editing ? 'Save changes' : 'Schedule maintenance'}
                </Button>
              </>
            ) : undefined
          }
        />

        {loading ? (
          <div className="mt-6 h-96 animate-pulse rounded-rail-panel bg-rail-raised" role="status">
            <span className="sr-only">Loading maintenance configuration…</span>
          </div>
        ) : loadError ? (
          <FormErrorState message={loadError} href={listPath} />
        ) : editing && !window ? (
          <FormErrorState message="This maintenance window is unavailable." href={listPath} />
        ) : (
          <MaintenanceWindowForm
            formId={formId}
            projectId={projectId}
            monitors={monitors}
            {...(window ? { window } : {})}
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

export function MaintenanceWindowForm({
  formId,
  projectId,
  monitors,
  window,
  onSaved,
}: {
  formId: string;
  projectId: string;
  monitors: MaintenanceMonitor[];
  window?: MaintenanceWindow;
  onSaved: (window: MaintenanceWindow) => void;
}) {
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ defaultValues: defaultValues(window) });
  const scheduleType = useWatch({ control, name: 'scheduleType' });
  const targetType = useWatch({ control, name: 'targetType' });
  const selectedMonitors = useWatch({ control, name: 'monitorIds' });

  return (
    <form
      id={formId}
      className="mt-6 grid items-start gap-6 !p-0 xl:grid-cols-[minmax(0,1fr)_19rem]"
      noValidate
      aria-busy={isSubmitting}
      onSubmit={handleSubmit(async (values) => {
        if (values.scheduleType === 'RECURRING' && values.daysOfWeek.length === 0) {
          setError('daysOfWeek', { message: 'Choose at least one weekday.' });
          return;
        }
        if (values.targetType === 'MONITORS' && values.monitorIds.length === 0) {
          setError('monitorIds', { message: 'Choose at least one monitor.' });
          return;
        }
        if (
          !values.suppressNotifications &&
          !values.suppressIncidentCreation &&
          !values.excludeFromUptime &&
          !values.publishToStatusPage
        ) {
          setError('excludeFromUptime', { message: 'Enable at least one maintenance behavior.' });
          return;
        }
        try {
          const payload = serialize(values);
          const saved = window
            ? await updateMaintenanceWindow(projectId, window.id, payload)
            : await createMaintenanceWindow(projectId, payload);
          onSaved(saved);
        } catch (error) {
          applyServerErrors(error, setError);
        }
      })}
    >
      <div className="overflow-hidden rounded-rail-panel border border-rail-border bg-rail-raised">
        <section className="border-b border-rail-border px-5 py-5 sm:px-6">
          <h2 className="m-0 text-sm font-semibold text-rail-text">Window details</h2>
          <p className="mt-1 mb-0 text-xs leading-5 text-rail-muted">
            Give operators a clear name and choose whether this happens once or repeats.
          </p>
          <div className="mt-5">
            <Field label="Name" error={errors.name?.message}>
              <Input
                autoFocus
                aria-invalid={Boolean(errors.name)}
                placeholder="Database maintenance"
                {...register('name', {
                  required: 'Enter a maintenance window name.',
                  maxLength: { value: 100, message: 'Use no more than 100 characters.' },
                })}
              />
            </Field>
          </div>
          <fieldset className="mt-5 border-0 p-0">
            <legend className="mb-2 text-sm font-medium text-rail-subtle">Schedule</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              <RadioChoice
                value="ONE_TIME"
                label="One-time"
                description="A single planned interval"
                register={register('scheduleType')}
              />
              <RadioChoice
                value="RECURRING"
                label="Recurring"
                description="Selected days in one timezone"
                register={register('scheduleType')}
              />
            </div>
          </fieldset>
          {scheduleType === 'ONE_TIME' ? (
            <div className="mt-5 grid gap-5 sm:grid-cols-2">
              <Field label="Starts" error={errors.startsAt?.message}>
                <Input
                  type="datetime-local"
                  aria-invalid={Boolean(errors.startsAt)}
                  {...register('startsAt', { required: 'Choose a start date and time.' })}
                />
              </Field>
              <Field label="Ends" error={errors.endsAt?.message}>
                <Input
                  type="datetime-local"
                  aria-invalid={Boolean(errors.endsAt)}
                  {...register('endsAt', {
                    required: 'Choose an end date and time.',
                    validate: (value, values) =>
                      new Date(value) > new Date(values.startsAt) || 'End after the start time.',
                  })}
                />
              </Field>
            </div>
          ) : (
            <div className="mt-5 grid gap-5 sm:grid-cols-2">
              <Field label="Timezone" error={errors.timezone?.message}>
                <Controller
                  control={control}
                  name="timezone"
                  rules={{ required: 'Choose a timezone.' }}
                  render={({ field }) => (
                    <Select {...field} aria-invalid={Boolean(errors.timezone)}>
                      {timezones.map((timezone) => (
                        <option key={timezone} value={timezone}>
                          {timezone}
                        </option>
                      ))}
                    </Select>
                  )}
                />
              </Field>
              <Field label="Start time" error={errors.localTime?.message}>
                <Input
                  type="time"
                  aria-invalid={Boolean(errors.localTime)}
                  {...register('localTime', { required: 'Choose a local start time.' })}
                />
              </Field>
              <Field label="Starts on" error={errors.startsOn?.message}>
                <Input
                  type="date"
                  aria-invalid={Boolean(errors.startsOn)}
                  {...register('startsOn', { required: 'Choose the first date.' })}
                />
              </Field>
              <Field label="Ends on" hint="Optional">
                <Input type="date" {...register('endsOn')} />
              </Field>
              <Field label="Duration" error={errors.durationMinutes?.message} hint="Minutes">
                <Input
                  type="number"
                  min={1}
                  max={10_080}
                  aria-invalid={Boolean(errors.durationMinutes)}
                  {...register('durationMinutes', {
                    valueAsNumber: true,
                    min: { value: 1, message: 'Use at least 1 minute.' },
                    max: { value: 10_080, message: 'Use no more than 7 days.' },
                  })}
                />
              </Field>
              <fieldset className="border-0 p-0 sm:col-span-2">
                <legend className="mb-2 text-sm font-medium text-rail-subtle">Repeats on</legend>
                <div className="flex flex-wrap gap-2">
                  {weekdays.map(([value, label]) => (
                    <label
                      key={value}
                      className="flex min-h-9 cursor-pointer items-center gap-2 rounded-rail-control border border-rail-border bg-rail-input px-3 text-xs font-medium text-rail-subtle has-[:checked]:border-rail-selected-border has-[:checked]:bg-rail-selected has-[:checked]:text-rail-text"
                    >
                      <Checkbox value={value} {...register('daysOfWeek')} />
                      {label}
                    </label>
                  ))}
                </div>
                {errors.daysOfWeek ? (
                  <p className="mt-2 mb-0 text-xs text-rail-danger" role="alert">
                    {errors.daysOfWeek.message}
                  </p>
                ) : null}
              </fieldset>
            </div>
          )}
        </section>

        <section className="px-5 py-5 sm:px-6">
          <h2 className="m-0 text-sm font-semibold text-rail-text">Monitor scope</h2>
          <p className="mt-1 mb-0 text-xs leading-5 text-rail-muted">
            Apply the window to every monitor in this project or choose specific services.
          </p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <RadioChoice
              value="PROJECT"
              label="Entire project"
              description="Includes monitors added later"
              register={register('targetType')}
            />
            <RadioChoice
              value="MONITORS"
              label="Selected monitors"
              description="Only the services chosen below"
              register={register('targetType')}
            />
          </div>
          {targetType === 'MONITORS' ? (
            <div className="mt-4 overflow-hidden rounded-rail-control border border-rail-border">
              {monitors.length === 0 ? (
                <p className="m-0 px-4 py-4 text-sm text-rail-muted">
                  This project has no monitors to select.
                </p>
              ) : (
                monitors.map((monitor) => (
                  <label
                    key={monitor.id}
                    className="flex min-h-12 cursor-pointer items-center gap-3 border-b border-rail-border px-4 last:border-b-0 hover:bg-rail-hover"
                  >
                    <Checkbox value={monitor.id} {...register('monitorIds')} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-rail-text">
                        {monitor.name}
                      </span>
                      <span className="block text-xs text-rail-muted">
                        {monitor.type.replace('_', ' ')} ·{' '}
                        {monitor.lifecycleState === 'ENABLED' ? 'Active' : 'Paused'}
                      </span>
                    </span>
                  </label>
                ))
              )}
              <p className="m-0 border-t border-rail-border px-4 py-2 text-xs text-rail-muted">
                {selectedMonitors.length} selected
              </p>
            </div>
          ) : null}
          {errors.monitorIds ? (
            <p className="mt-2 mb-0 text-xs text-rail-danger" role="alert">
              {errors.monitorIds.message}
            </p>
          ) : null}
        </section>
      </div>

      <aside className="overflow-hidden rounded-rail-panel border border-rail-border bg-rail-raised">
        <div className="border-b border-rail-border px-5 py-4">
          <h2 className="m-0 text-sm font-semibold text-rail-text">During maintenance</h2>
          <p className="mt-1 mb-0 text-xs leading-5 text-rail-muted">
            Checks keep running. Choose how their results are treated.
          </p>
        </div>
        <div className="divide-y divide-rail-border">
          <EffectChoice
            label="Suppress notifications"
            description="Do not deliver incident or recovery messages."
            checkbox={<Checkbox {...register('suppressNotifications')} />}
          />
          <EffectChoice
            label="Prevent new incidents"
            description="Keep existing incidents visible and allow recovery."
            checkbox={<Checkbox {...register('suppressIncidentCreation')} />}
          />
          <EffectChoice
            label="Exclude from uptime"
            description="Remove the exact interval from uptime calculations."
            checkbox={<Checkbox {...register('excludeFromUptime')} />}
          />
          <EffectChoice
            label="Publish on status pages"
            description="Show planned maintenance for affected components."
            checkbox={<Checkbox {...register('publishToStatusPage')} />}
          />
        </div>
        {errors.excludeFromUptime ? (
          <p
            className="m-0 border-t border-rail-border px-5 py-3 text-xs text-rail-danger"
            role="alert"
          >
            {errors.excludeFromUptime.message}
          </p>
        ) : null}
        {errors.root ? (
          <p
            className="m-0 border-t border-rail-border px-5 py-3 text-xs text-rail-danger"
            role="alert"
          >
            {errors.root.message}
          </p>
        ) : null}
      </aside>
    </form>
  );
}

function defaultValues(window?: MaintenanceWindow): FormValues {
  const now = new Date();
  const later = new Date(now.getTime() + 60 * 60 * 1_000);
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1_000);
  return {
    name: window?.name ?? '',
    scheduleType: window?.schedule.type ?? 'ONE_TIME',
    startsAt:
      window?.schedule.type === 'ONE_TIME'
        ? localDateTime(window.schedule.startsAt)
        : localDateTime(later.toISOString()),
    endsAt:
      window?.schedule.type === 'ONE_TIME'
        ? localDateTime(window.schedule.endsAt)
        : localDateTime(new Date(later.getTime() + 60 * 60 * 1_000).toISOString()),
    timezone: window?.schedule.type === 'RECURRING' ? window.schedule.timezone : 'UTC',
    localTime: window?.schedule.type === 'RECURRING' ? window.schedule.localTime : '02:00',
    daysOfWeek:
      window?.schedule.type === 'RECURRING'
        ? window.schedule.daysOfWeek.map(String)
        : ['1', '2', '3', '4', '5'],
    durationMinutes: window?.schedule.type === 'RECURRING' ? window.schedule.durationMinutes : 60,
    startsOn:
      window?.schedule.type === 'RECURRING'
        ? window.schedule.startsOn
        : tomorrow.toISOString().slice(0, 10),
    endsOn: window?.schedule.type === 'RECURRING' ? (window.schedule.endsOn ?? '') : '',
    targetType: window?.target.type ?? 'PROJECT',
    monitorIds: window?.target.type === 'MONITORS' ? window.target.monitorIds : [],
    suppressNotifications: window?.effects.suppressNotifications ?? true,
    suppressIncidentCreation: window?.effects.suppressIncidentCreation ?? true,
    excludeFromUptime: window?.effects.excludeFromUptime ?? true,
    publishToStatusPage: window?.effects.publishToStatusPage ?? false,
  };
}

function serialize(values: FormValues) {
  return {
    name: values.name.trim(),
    schedule:
      values.scheduleType === 'ONE_TIME'
        ? {
            type: 'ONE_TIME' as const,
            startsAt: new Date(values.startsAt).toISOString(),
            endsAt: new Date(values.endsAt).toISOString(),
          }
        : {
            type: 'RECURRING' as const,
            timezone: values.timezone,
            localTime: values.localTime,
            daysOfWeek: values.daysOfWeek.map(Number).sort((left, right) => left - right),
            durationMinutes: values.durationMinutes,
            startsOn: values.startsOn,
            endsOn: values.endsOn || null,
          },
    target:
      values.targetType === 'PROJECT'
        ? ({ type: 'PROJECT' } as const)
        : ({ type: 'MONITORS', monitorIds: values.monitorIds } as const),
    effects: {
      suppressNotifications: values.suppressNotifications,
      suppressIncidentCreation: values.suppressIncidentCreation,
      excludeFromUptime: values.excludeFromUptime,
      publishToStatusPage: values.publishToStatusPage,
    },
  };
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
    <label className="grid gap-1.5 text-sm font-medium text-rail-subtle">
      <span className="flex items-center justify-between gap-3">
        {label}
        {hint ? <span className="text-xs font-normal text-rail-muted">{hint}</span> : null}
      </span>
      {children}
      {error ? (
        <span className="text-xs font-normal text-rail-danger" role="alert">
          {error}
        </span>
      ) : null}
    </label>
  );
}

function RadioChoice({
  value,
  label,
  description,
  register,
}: {
  value: string;
  label: string;
  description: string;
  register: UseFormRegisterReturn;
}) {
  return (
    <label className="flex min-h-16 cursor-pointer items-start gap-3 rounded-rail-control border border-rail-border bg-rail-input px-4 py-3 has-[:checked]:border-rail-selected-border has-[:checked]:bg-rail-selected">
      <input
        type="radio"
        value={value}
        className="mt-0.5 size-4 cursor-pointer accent-rail-accent"
        {...register}
      />
      <span>
        <span className="block text-sm font-medium text-rail-text">{label}</span>
        <span className="mt-0.5 block text-xs leading-5 text-rail-muted">{description}</span>
      </span>
    </label>
  );
}

function EffectChoice({
  label,
  description,
  checkbox,
}: {
  label: string;
  description: string;
  checkbox: ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 px-5 py-4 hover:bg-rail-hover">
      <span className="mt-0.5">{checkbox}</span>
      <span>
        <span className="block text-sm font-medium text-rail-text">{label}</span>
        <span className="mt-1 block text-xs leading-5 text-rail-muted">{description}</span>
      </span>
    </label>
  );
}

function FormErrorState({ message, href }: { message: string; href: string }) {
  return (
    <div className="mt-6 rounded-rail-panel border border-rail-border bg-rail-raised px-5 py-8">
      <p className="m-0 text-sm text-rail-subtle" role="alert">
        {message}
      </p>
      <Link href={href} className={actionClassName({ variant: 'secondary', className: 'mt-4' })}>
        Return to maintenance
      </Link>
    </div>
  );
}

function localDateTime(value: string) {
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function messageFor(error: unknown, fallback: string) {
  return error instanceof MaintenanceWindowRequestError ? error.message : fallback;
}

function applyServerErrors(error: unknown, setError: UseFormSetError<FormValues>) {
  if (error instanceof MaintenanceWindowRequestError) {
    const aliases: Record<string, keyof FormValues> = {
      name: 'name',
      startsAt: 'startsAt',
      endsAt: 'endsAt',
      timezone: 'timezone',
      localTime: 'localTime',
      daysOfWeek: 'daysOfWeek',
      durationMinutes: 'durationMinutes',
      startsOn: 'startsOn',
      endsOn: 'endsOn',
      monitorIds: 'monitorIds',
      effects: 'excludeFromUptime',
    };
    let applied = false;
    for (const [field, messages] of Object.entries(error.details.fields ?? {})) {
      const target = aliases[field];
      if (target && messages[0]) {
        setError(target, { type: 'server', message: messages[0] });
        applied = true;
      }
    }
    if (!applied) setError('root', { type: 'server', message: error.message });
    return;
  }
  setError('root', { type: 'server', message: 'The maintenance window could not be saved.' });
}
