import type { UseFormRegisterReturn } from 'react-hook-form';
import { Checkbox } from '../../components/ui/form-control';
import type { NotificationMonitor } from './types';

export type NotificationMonitorScopeValue = 'PROJECT' | 'MONITORS';

export function NotificationMonitorScope({
  monitors,
  scope,
  selectedMonitorIds,
  scopeRegistration,
  monitorRegistration,
  error,
}: {
  monitors: NotificationMonitor[];
  scope: NotificationMonitorScopeValue;
  selectedMonitorIds: string[];
  scopeRegistration: UseFormRegisterReturn;
  monitorRegistration: UseFormRegisterReturn;
  error?: string | undefined;
}) {
  return (
    <section className="border-t border-rail-border px-5 py-5 sm:px-6">
      <h2 className="m-0 text-sm font-semibold text-rail-text">Monitor scope</h2>
      <p className="mt-1 mb-0 text-xs leading-5 text-rail-muted">
        Send through this channel for every monitor in the project or only selected services.
      </p>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <ScopeChoice
          value="PROJECT"
          label="Entire project"
          description="Includes monitors added later"
          registration={scopeRegistration}
        />
        <ScopeChoice
          value="MONITORS"
          label="Selected monitors"
          description="Only the services chosen below"
          registration={scopeRegistration}
        />
      </div>
      {scope === 'MONITORS' ? (
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
                <Checkbox value={monitor.id} {...monitorRegistration} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-rail-text">
                    {monitor.name}
                  </span>
                  <span className="block text-xs text-rail-muted">
                    {monitor.type === 'API_WORKFLOW' ? 'API workflow' : monitor.type} ·{' '}
                    {monitor.lifecycleState === 'ENABLED' ? 'Active' : 'Paused'}
                  </span>
                </span>
              </label>
            ))
          )}
          <p className="m-0 border-t border-rail-border px-4 py-2 text-xs text-rail-muted">
            {selectedMonitorIds.length} selected
          </p>
        </div>
      ) : null}
      {error ? (
        <p className="mt-2 mb-0 text-xs text-rail-danger" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function ScopeChoice({
  value,
  label,
  description,
  registration,
}: {
  value: NotificationMonitorScopeValue;
  label: string;
  description: string;
  registration: UseFormRegisterReturn;
}) {
  return (
    <label className="flex min-h-16 cursor-pointer items-start gap-3 rounded-rail-control border border-rail-border bg-rail-input px-4 py-3 has-[:checked]:border-rail-selected-border has-[:checked]:bg-rail-selected">
      <input
        type="radio"
        value={value}
        className="mt-0.5 size-4 cursor-pointer accent-rail-accent"
        {...registration}
      />
      <span>
        <span className="block text-sm font-medium text-rail-text">{label}</span>
        <span className="mt-0.5 block text-xs leading-5 text-rail-muted">{description}</span>
      </span>
    </label>
  );
}
