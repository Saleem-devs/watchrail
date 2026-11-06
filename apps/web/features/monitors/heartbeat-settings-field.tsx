'use client';

import { useId, useState } from 'react';
import { Checkbox, Input, Select } from '../../components/ui/form-control';
import type { FieldErrors, HeartbeatMonitorSettings } from './types';

const DEFAULT_SETTINGS: HeartbeatMonitorSettings = {
  schedule: { type: 'INTERVAL', intervalSeconds: 300, graceSeconds: 60 },
  maximumRuntimeSeconds: null,
};

export function HeartbeatSettingsField({
  initialSettings = DEFAULT_SETTINGS,
  errors,
}: {
  initialSettings?: HeartbeatMonitorSettings;
  errors: FieldErrors;
}) {
  const id = useId();
  const [scheduleType, setScheduleType] = useState(initialSettings.schedule.type);
  const [runtimeEnabled, setRuntimeEnabled] = useState(
    initialSettings.maximumRuntimeSeconds !== null,
  );

  return (
    <section className="border-t border-rail-border px-5 py-5 sm:px-6">
      <h2 className="m-0 text-sm font-semibold text-rail-text">Expected signal</h2>
      <p className="mt-1 mb-0 max-w-2xl text-xs leading-5 text-rail-muted">
        Define when the job should report. Watchrail opens an incident after the grace period
        passes.
      </p>

      <div className="mt-5 grid gap-5">
        <div
          className={
            scheduleType === 'INTERVAL'
              ? 'grid gap-4 sm:grid-cols-2'
              : 'grid max-w-sm gap-4'
          }
        >
          <label className="grid gap-1.5 text-xs font-medium text-rail-subtle">
            Schedule type
            <Select
              name="heartbeatScheduleType"
              value={scheduleType}
              onChange={(event) => setScheduleType(event.target.value as 'INTERVAL' | 'CRON')}
              aria-invalid={Boolean(errors.schedule)}
            >
              <option value="INTERVAL">Fixed interval</option>
              <option value="CRON">Cron schedule</option>
            </Select>
            {errors.schedule ? (
              <span className="font-normal text-rail-danger">{errors.schedule[0]}</span>
            ) : null}
          </label>

          {scheduleType === 'INTERVAL' ? (
            <label
              className="grid gap-1.5 text-xs font-medium text-rail-subtle"
              htmlFor={`${id}-interval`}
            >
              Expected every
              <div className="relative">
                <Input
                  id={`${id}-interval`}
                  name="heartbeatIntervalMinutes"
                  type="number"
                  min="1"
                  max="43200"
                  step="1"
                  defaultValue={
                    initialSettings.schedule.type === 'INTERVAL'
                      ? initialSettings.schedule.intervalSeconds / 60
                      : 5
                  }
                  required
                  className="pr-16"
                  aria-invalid={Boolean(errors.intervalSeconds)}
                />
                <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-rail-muted">
                  minutes
                </span>
              </div>
              {errors.intervalSeconds ? (
                <span className="font-normal text-rail-danger">{errors.intervalSeconds[0]}</span>
              ) : null}
            </label>
          ) : null}
        </div>

        {scheduleType === 'CRON' ? (
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,0.55fr)]">
            <label
              className="grid gap-1.5 text-xs font-medium text-rail-subtle"
              htmlFor={`${id}-cron`}
            >
              Cron expression
              <Input
                id={`${id}-cron`}
                name="heartbeatCronExpression"
                type="text"
                defaultValue={
                  initialSettings.schedule.type === 'CRON'
                    ? initialSettings.schedule.expression
                    : '0 2 * * *'
                }
                placeholder="0 2 * * *"
                autoComplete="off"
                spellCheck={false}
                required
                aria-invalid={Boolean(errors.expression)}
              />
              {errors.expression ? (
                <span className="font-normal text-rail-danger">{errors.expression[0]}</span>
              ) : (
                <span className="font-normal leading-5 text-rail-muted">
                  Five fields: minute, hour, day, month, weekday.
                </span>
              )}
            </label>
            <label
              className="grid content-start gap-1.5 text-xs font-medium text-rail-subtle"
              htmlFor={`${id}-timezone`}
            >
              Time zone
              <Input
                id={`${id}-timezone`}
                name="heartbeatTimezone"
                type="text"
                defaultValue={
                  initialSettings.schedule.type === 'CRON'
                    ? initialSettings.schedule.timezone
                    : 'UTC'
                }
                placeholder="UTC"
                autoComplete="off"
                required
                aria-invalid={Boolean(errors.timezone)}
              />
              {errors.timezone ? (
                <span className="font-normal text-rail-danger">{errors.timezone[0]}</span>
              ) : null}
            </label>
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <label
            className="grid gap-1.5 text-xs font-medium text-rail-subtle"
            htmlFor={`${id}-grace`}
          >
            Grace period
            <div className="relative">
              <Input
                id={`${id}-grace`}
                name="heartbeatGraceMinutes"
                type="number"
                min="0"
                max="10080"
                step="1"
                defaultValue={initialSettings.schedule.graceSeconds / 60}
                required
                className="pr-16"
                aria-invalid={Boolean(errors.graceSeconds)}
              />
              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-rail-muted">
                minutes
              </span>
            </div>
            {errors.graceSeconds ? (
              <span className="font-normal text-rail-danger">{errors.graceSeconds[0]}</span>
            ) : (
              <span className="font-normal leading-5 text-rail-muted">
                Extra time before a late signal becomes an incident.
              </span>
            )}
          </label>

          <div className="grid content-start gap-1.5 text-xs font-medium text-rail-subtle">
            <span>Run duration</span>
            <label className="flex min-h-10 cursor-pointer items-center gap-2.5 rounded-rail-control border border-rail-border px-3 text-xs font-medium text-rail-subtle hover:border-rail-border-strong">
              <Checkbox
                name="heartbeatRuntimeEnabled"
                checked={runtimeEnabled}
                onChange={(event) => setRuntimeEnabled(event.target.checked)}
              />
              Enforce maximum runtime
            </label>
            <span className="font-normal leading-5 text-rail-muted">
              Alert when a started run exceeds its allowed duration.
            </span>
            {runtimeEnabled ? (
              <label
                className="mt-2 grid gap-1.5 text-xs font-medium text-rail-subtle"
                htmlFor={`${id}-runtime`}
              >
                Maximum runtime
                <div className="relative">
                  <Input
                    id={`${id}-runtime`}
                    name="heartbeatMaximumRuntimeMinutes"
                    type="number"
                    min="1"
                    max="10080"
                    step="1"
                    defaultValue={(initialSettings.maximumRuntimeSeconds ?? 3600) / 60}
                    required
                    className="pr-16"
                    aria-invalid={Boolean(errors.maximumRuntimeSeconds)}
                  />
                  <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-rail-muted">
                    minutes
                  </span>
                </div>
              </label>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
