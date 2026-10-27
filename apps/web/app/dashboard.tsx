'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AppShell } from '../components/app-shell';
import { MonitorOverview } from '../components/monitor-overview';
import { Button } from '../components/ui/button';
import { StatusBadge } from '../components/ui/status-badge';
import { OverviewDashboard } from '../features/overview/overview-dashboard';
import type { MonitorFilter } from '../features/monitors/filter-monitors';
import { DashboardHeader } from '../features/monitors/dashboard-header';
import {
  formatPercent,
  formatRatio,
  monitorStateLabel,
  monitorStatus,
  statusPolicyLabel,
  statusPolicyFromForm,
} from '../features/monitors/formatting';
import {
  ManualDiagnostic,
  IncidentSummary,
  IncidentHistory,
  CheckHistory,
} from '../features/monitors/monitor-evidence';
import type {
  ApiError,
  FieldErrors,
  Monitor,
  ProbeLocation,
  ManualRound,
  HistoryPage,
  IncidentHistoryPage,
  ResponseTimeOverview,
} from '../features/monitors/types';
import { filterMonitors } from '../features/monitors/filter-monitors';

const multiLocationUiEnabled = process.env.NEXT_PUBLIC_MULTI_LOCATION_EXECUTION_ENABLED === 'true';

type DashboardView = 'legacy' | 'overview' | 'monitors' | 'create' | 'detail';

export function Dashboard({
  view = 'legacy',
  monitorId,
}: {
  view?: DashboardView;
  monitorId?: string;
}) {
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [monitorQuery, setMonitorQuery] = useState('');
  const [monitorFilter, setMonitorFilter] = useState<MonitorFilter>('all');
  const [probeLocations, setProbeLocations] = useState<ProbeLocation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [updatingPolicyIds, setUpdatingPolicyIds] = useState<Set<string>>(() => new Set());
  const [updatingSettingsIds, setUpdatingSettingsIds] = useState<Set<string>>(() => new Set());
  const [loadError, setLoadError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [createdMonitor, setCreatedMonitor] = useState<Monitor>();
  const [manualRounds, setManualRounds] = useState<Record<string, ManualRound>>({});
  const [runningMonitorIds, setRunningMonitorIds] = useState<Set<string>>(() => new Set());
  const [runErrors, setRunErrors] = useState<Record<string, string>>({});
  const [history, setHistory] = useState<Record<string, HistoryPage>>({});
  const [visibleHistoryIds, setVisibleHistoryIds] = useState<Set<string>>(() => new Set());
  const [loadingHistoryIds, setLoadingHistoryIds] = useState<Set<string>>(() => new Set());
  const [historyDetails, setHistoryDetails] = useState<Record<string, ManualRound>>({});
  const [expandedHistoryRoundIds, setExpandedHistoryRoundIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [loadingHistoryRoundIds, setLoadingHistoryRoundIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [incidentHistory, setIncidentHistory] = useState<Record<string, IncidentHistoryPage>>({});
  const [visibleIncidentIds, setVisibleIncidentIds] = useState<Set<string>>(() => new Set());
  const [loadingIncidentHistoryIds, setLoadingIncidentHistoryIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [incidentHistoryErrors, setIncidentHistoryErrors] = useState<Record<string, string>>({});
  const [responseTimeOverview, setResponseTimeOverview] = useState<ResponseTimeOverview>();
  const [isOverviewAnalyticsLoading, setIsOverviewAnalyticsLoading] = useState(false);
  const [overviewAnalyticsError, setOverviewAnalyticsError] = useState<string>();
  const pollTimeouts = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const incidentHistoryRequests = useRef(new Set<string>());
  const probeLocationsRequest = useRef(false);

  useEffect(() => {
    void loadMonitors();

    const timeouts = pollTimeouts.current;
    return () => {
      for (const timeout of timeouts.values()) clearTimeout(timeout);
      timeouts.clear();
    };
  }, []);

  useEffect(() => {
    if (view === 'overview') void loadOverviewAnalytics();
  }, [view]);

  async function loadOverviewAnalytics(): Promise<void> {
    setIsOverviewAnalyticsLoading(true);
    setOverviewAnalyticsError(undefined);
    try {
      const response = await fetch('/api/overview/response-times', {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error('Could not load overview analytics.');
      const body = (await response.json()) as { data?: ResponseTimeOverview };
      if (!body.data) throw new Error('The API returned no overview analytics.');
      setResponseTimeOverview(body.data);
    } catch {
      setOverviewAnalyticsError('Response-time history is temporarily unavailable.');
    } finally {
      setIsOverviewAnalyticsLoading(false);
    }
  }

  async function loadMonitors(): Promise<void> {
    setIsLoading(true);
    setLoadError(undefined);

    try {
      const response = await fetch('/api/monitors', { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('Could not load monitors.');
      const body = (await response.json()) as { data: Monitor[] };
      setMonitors(body.data);
    } catch {
      setLoadError(
        'Watchrail could not load your monitors. Check that the API and database are running.',
      );
    } finally {
      setIsLoading(false);
    }
  }

  async function deleteMonitor(monitor: Monitor): Promise<void> {
    if (!window.confirm(`Delete ${monitor.name}? This cannot be undone.`)) return;
    setActionError(undefined);
    try {
      const response = await fetch(`/api/monitors/${monitor.id}/lifecycle`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ lifecycleState: 'ARCHIVED' }),
      });
      if (!response.ok) throw new Error('Could not delete monitor.');
      setMonitors((current) => current.filter((item) => item.id !== monitor.id));
      if (view === 'overview') void loadOverviewAnalytics();
    } catch {
      setActionError(`Watchrail could not delete ${monitor.name}. Try again.`);
    }
  }

  async function createMonitor(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setIsSubmitting(true);
    setActionError(undefined);
    setFieldErrors({});

    const form = event.currentTarget;
    const formData = new FormData(form);
    const statusPolicy = statusPolicyFromForm(formData);

    try {
      const response = await fetch('/api/monitors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          name: formData.get('name'),
          url: formData.get('url'),
          statusPolicy,
        }),
      });

      const body = (await response.json()) as { data?: Monitor } & ApiError;
      if (!response.ok) {
        if (response.status === 400 && body.fields) setFieldErrors(body.fields);
        else setActionError('Watchrail could not save this monitor. Try again.');
        return;
      }

      if (!body.data) throw new Error('The API returned no monitor.');
      setMonitors((current) => [body.data as Monitor, ...current]);
      setCreatedMonitor(body.data);
      form.reset();
    } catch {
      setActionError('Watchrail could not reach the API. Check the local services and try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function runNow(monitorId: string): Promise<void> {
    setMonitorRunning(monitorId, true);
    setRunErrors((current) => omitKey(current, monitorId));

    try {
      const response = await fetch(`/api/monitors/${monitorId}/check-rounds`, {
        method: 'POST',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error('Could not start the manual check.');

      const body = (await response.json()) as { data?: ManualRound };
      if (!body.data) throw new Error('The API returned no check round.');

      setManualRounds((current) => ({ ...current, [monitorId]: body.data as ManualRound }));
      schedulePoll(monitorId, body.data.id);
    } catch {
      setMonitorRunning(monitorId, false);
      setRunErrors((current) => ({
        ...current,
        [monitorId]: 'Watchrail could not start this diagnostic check. Try again.',
      }));
    }
  }

  async function updateStatusPolicy(
    monitorId: string,
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const statusPolicy = statusPolicyFromForm(formData);

    setUpdatingPolicyIds((current) => new Set(current).add(monitorId));
    setActionError(undefined);

    try {
      const response = await fetch(`/api/monitors/${monitorId}/status-policy`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ statusPolicy }),
      });
      const body = (await response.json()) as { data?: Monitor } & ApiError;
      if (!response.ok || !body.data) {
        throw new Error(body.fields?.statusPolicy?.[0] ?? 'Could not update status policy.');
      }
      setMonitors((current) =>
        current.map((monitor) => (monitor.id === monitorId ? (body.data as Monitor) : monitor)),
      );
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not update status policy.');
    } finally {
      setUpdatingPolicyIds((current) => {
        const next = new Set(current);
        next.delete(monitorId);
        return next;
      });
    }
  }

  async function updateHttpSettings(
    monitorId: string,
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const timeoutSeconds = Number(formData.get('timeoutSeconds'));

    setUpdatingSettingsIds((current) => new Set(current).add(monitorId));
    setActionError(undefined);

    try {
      const response = await fetch(`/api/monitors/${monitorId}/http-settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          url: formData.get('url'),
          method: formData.get('method'),
          timeoutMs: timeoutSeconds * 1_000,
          followRedirects: formData.get('followRedirects') === 'on',
        }),
      });
      const body = (await response.json()) as { data?: Monitor } & ApiError;
      if (!response.ok || !body.data) {
        throw new Error('Could not update HTTP settings.');
      }
      setMonitors((current) =>
        current.map((monitor) => (monitor.id === monitorId ? (body.data as Monitor) : monitor)),
      );
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not update HTTP settings.');
    } finally {
      setUpdatingSettingsIds((current) => {
        const next = new Set(current);
        next.delete(monitorId);
        return next;
      });
    }
  }

  async function updateLocation(
    monitorId: string,
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    const locations = new FormData(event.currentTarget)
      .getAll('location')
      .filter((value): value is string => typeof value === 'string');
    if (locations.length === 0 || (locations.includes('local') && locations.length > 1)) {
      setActionError('Select local only, or one or more remote locations.');
      return;
    }
    setActionError(undefined);
    setUpdatingSettingsIds((current) => new Set(current).add(monitorId));
    try {
      const response = await fetch(`/api/monitors/${monitorId}/locations`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ locations }),
      });
      const body = (await response.json()) as { data?: Monitor } & ApiError;
      if (!response.ok || !body.data) throw new Error('Could not update execution location.');
      setMonitors((current) =>
        current.map((monitor) => (monitor.id === monitorId ? (body.data as Monitor) : monitor)),
      );
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : 'Could not update execution location.',
      );
    } finally {
      setUpdatingSettingsIds((current) => {
        const next = new Set(current);
        next.delete(monitorId);
        return next;
      });
    }
  }

  async function loadProbeLocations(): Promise<void> {
    if (probeLocationsRequest.current) return;
    probeLocationsRequest.current = true;
    try {
      const response = await fetch('/api/probe-locations', {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) return;
      const body = (await response.json()) as { data?: ProbeLocation[] };
      if (Array.isArray(body.data)) setProbeLocations(body.data);
    } catch {
      // Local execution remains available when probe discovery is temporarily unavailable.
    } finally {
      probeLocationsRequest.current = false;
    }
  }

  function schedulePoll(monitorId: string, roundId: string): void {
    const existing = pollTimeouts.current.get(monitorId);
    if (existing) clearTimeout(existing);

    pollTimeouts.current.set(
      monitorId,
      setTimeout(() => void pollManualRound(monitorId, roundId), 750),
    );
  }

  async function pollManualRound(monitorId: string, roundId: string): Promise<void> {
    try {
      const response = await fetch(`/api/monitors/${monitorId}/check-rounds/${roundId}`, {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error('Could not load the manual check.');

      const body = (await response.json()) as { data?: ManualRound };
      if (!body.data) throw new Error('The API returned no check round.');

      setManualRounds((current) => ({ ...current, [monitorId]: body.data as ManualRound }));

      if (body.data.status === 'COMPLETED') {
        pollTimeouts.current.delete(monitorId);
        setMonitorRunning(monitorId, false);
        await loadMonitors();
        if (visibleHistoryIds.has(monitorId)) await loadHistory(monitorId);
        return;
      }

      schedulePoll(monitorId, roundId);
    } catch {
      pollTimeouts.current.delete(monitorId);
      setMonitorRunning(monitorId, false);
      setRunErrors((current) => ({
        ...current,
        [monitorId]: 'Watchrail lost contact while waiting for this diagnostic result.',
      }));
    }
  }

  async function toggleHistory(monitorId: string): Promise<void> {
    if (visibleHistoryIds.has(monitorId)) {
      setVisibleHistoryIds((current) => {
        const next = new Set(current);
        next.delete(monitorId);
        return next;
      });
      return;
    }
    setVisibleHistoryIds((current) => new Set(current).add(monitorId));
    if (!history[monitorId]) await loadHistory(monitorId);
  }

  async function loadHistory(monitorId: string, append = false): Promise<void> {
    setLoadingHistoryIds((current) => new Set(current).add(monitorId));
    try {
      const cursor = append ? history[monitorId]?.nextCursor : null;
      const query = cursor ? `?limit=10&cursor=${encodeURIComponent(cursor)}` : '?limit=10';
      const response = await fetch(`/api/monitors/${monitorId}/check-rounds${query}`, {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error('Could not load check history.');
      const body = (await response.json()) as {
        data: ManualRound[];
        page: { nextCursor: string | null };
      };
      setHistory((current) => ({
        ...current,
        [monitorId]: {
          items: append ? [...(current[monitorId]?.items ?? []), ...body.data] : body.data,
          nextCursor: body.page.nextCursor,
        },
      }));
    } catch {
      setRunErrors((current) => ({
        ...current,
        [monitorId]: 'Watchrail could not load this monitor history.',
      }));
    } finally {
      setLoadingHistoryIds((current) => {
        const next = new Set(current);
        next.delete(monitorId);
        return next;
      });
    }
  }

  async function toggleHistoryRound(monitorId: string, roundId: string): Promise<void> {
    if (expandedHistoryRoundIds.has(roundId)) {
      setExpandedHistoryRoundIds((current) => {
        const next = new Set(current);
        next.delete(roundId);
        return next;
      });
      return;
    }
    setExpandedHistoryRoundIds((current) => new Set(current).add(roundId));
    if (historyDetails[roundId] || loadingHistoryRoundIds.has(roundId)) return;
    setLoadingHistoryRoundIds((current) => new Set(current).add(roundId));
    try {
      const response = await fetch(`/api/monitors/${monitorId}/check-rounds/${roundId}`, {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error('Could not load regional evidence.');
      const body = (await response.json()) as { data: ManualRound };
      setHistoryDetails((current) => ({ ...current, [roundId]: body.data }));
    } catch {
      setRunErrors((current) => ({
        ...current,
        [monitorId]: 'Watchrail could not load this round’s regional evidence.',
      }));
    } finally {
      setLoadingHistoryRoundIds((current) => {
        const next = new Set(current);
        next.delete(roundId);
        return next;
      });
    }
  }

  async function toggleIncidentHistory(monitorId: string): Promise<void> {
    if (visibleIncidentIds.has(monitorId)) {
      setVisibleIncidentIds((current) => {
        const next = new Set(current);
        next.delete(monitorId);
        return next;
      });
      return;
    }
    setVisibleIncidentIds((current) => new Set(current).add(monitorId));
    if (!incidentHistory[monitorId]) await loadIncidentHistory(monitorId);
  }

  async function loadIncidentHistory(monitorId: string, append = false): Promise<void> {
    if (incidentHistoryRequests.current.has(monitorId)) return;
    incidentHistoryRequests.current.add(monitorId);
    setLoadingIncidentHistoryIds((current) => new Set(current).add(monitorId));
    setIncidentHistoryErrors((current) => omitKey(current, monitorId));
    try {
      const cursor = append ? incidentHistory[monitorId]?.nextCursor : null;
      const query = cursor ? `?limit=10&cursor=${encodeURIComponent(cursor)}` : '?limit=10';
      const response = await fetch(`/api/monitors/${monitorId}/incidents${query}`, {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error('Could not load incident history.');
      const body = (await response.json()) as {
        data: IncidentHistoryPage['items'];
        page: { nextCursor: string | null };
      };
      setIncidentHistory((current) => ({
        ...current,
        [monitorId]: {
          items: append ? [...(current[monitorId]?.items ?? []), ...body.data] : body.data,
          nextCursor: body.page.nextCursor,
        },
      }));
    } catch {
      setIncidentHistoryErrors((current) => ({
        ...current,
        [monitorId]: 'Watchrail could not load this incident history. Try again.',
      }));
    } finally {
      incidentHistoryRequests.current.delete(monitorId);
      setLoadingIncidentHistoryIds((current) => {
        const next = new Set(current);
        next.delete(monitorId);
        return next;
      });
    }
  }

  function setMonitorRunning(monitorId: string, running: boolean): void {
    setRunningMonitorIds((current) => {
      const next = new Set(current);
      if (running) next.add(monitorId);
      else next.delete(monitorId);
      return next;
    });
  }

  const visibleMonitors =
    view === 'detail'
      ? monitors.filter((monitor) => monitor.id === monitorId)
      : filterMonitors(monitors, monitorQuery, monitorFilter);
  const shellPage =
    view === 'overview'
      ? 'overview'
      : view === 'create'
        ? 'new-monitor'
        : view === 'detail'
          ? 'monitor-detail'
          : view === 'legacy'
            ? 'overview'
            : 'monitors';

  return (
    <AppShell page={shellPage}>
      <main id="main-content" data-watchrail-dashboard className="w-full min-w-0 pb-16">
        {view !== 'detail' ? (
          <DashboardHeader
            view={view === 'create' ? 'create' : view === 'monitors' ? 'monitors' : 'overview'}
          />
        ) : null}

        {!isLoading && !loadError && view === 'legacy' ? (
          <MonitorOverview monitors={monitors} />
        ) : null}

        {loadError ? (
          <div className="alert" role="alert">
            <span>{loadError}</span>
            <button type="button" onClick={() => void loadMonitors()}>
              Retry
            </button>
          </div>
        ) : null}

        {actionError ? (
          <div className="alert" role="alert">
            <span>{actionError}</span>
            <button type="button" onClick={() => setActionError(undefined)}>
              Dismiss
            </button>
          </div>
        ) : null}

        {view === 'create' && createdMonitor ? (
          <div
            className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-rail-panel border border-rail-success/30 bg-rail-success/5 px-4 py-3 text-sm text-rail-success"
            role="status"
          >
            <span>{createdMonitor.name} is ready for its first check.</span>
            <Link
              href={`/monitors/${createdMonitor.id}`}
              className="inline-flex min-h-9 items-center rounded-rail-control px-3 font-medium text-rail-success no-underline hover:bg-rail-hover"
            >
              View monitor
            </Link>
          </div>
        ) : null}

        {view === 'overview' && !isLoading && !loadError ? (
          <OverviewDashboard
            monitors={monitors}
            responseTimes={responseTimeOverview}
            responseTimesLoading={isOverviewAnalyticsLoading}
            responseTimesError={overviewAnalyticsError}
            onRetryResponseTimes={() => void loadOverviewAnalytics()}
            onDeleteMonitor={deleteMonitor}
          />
        ) : null}

        <div
          className={`mt-6 grid min-w-0 items-start gap-6 ${view === 'legacy' ? 'xl:grid-cols-[minmax(0,1.75fr)_minmax(320px,0.75fr)]' : ''}`}
        >
          {view === 'legacy' || view === 'monitors' || view === 'detail' ? (
            <section
              id="monitor-inventory"
              className="min-w-0 overflow-hidden rounded-rail-panel border border-rail-border bg-rail-header"
              aria-labelledby="monitors-heading"
            >
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rail-border p-5 sm:px-6">
                <div>
                  <h2
                    id="monitors-heading"
                    className="m-0 text-lg font-semibold tracking-tight text-rail-text"
                  >
                    {view === 'detail' ? (visibleMonitors[0]?.name ?? 'Monitor') : 'Monitors'}
                  </h2>
                  <p className="mt-1 mb-0 text-xs text-rail-muted">
                    {view === 'detail'
                      ? 'Authoritative health, incidents, evidence, and configuration.'
                      : 'Latest reported state for every configured endpoint.'}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {view === 'detail' ? (
                    <Link
                      href="/monitors"
                      className="inline-flex min-h-9 items-center rounded-rail-control px-3 text-sm text-rail-subtle no-underline hover:bg-rail-hover hover:text-rail-text"
                    >
                      Back to monitors
                    </Link>
                  ) : null}
                  <button
                    className="min-h-9 rounded-rail-control border border-rail-border px-3 text-sm text-rail-text hover:bg-rail-hover"
                    type="button"
                    onClick={() => void loadMonitors()}
                  >
                    Refresh
                  </button>
                </div>
              </div>

              {view === 'monitors' && monitors.length > 0 ? (
                <div className="flex flex-col gap-3 border-b border-rail-border px-5 py-4 sm:flex-row sm:px-6">
                  <label className="flex flex-1 flex-col gap-1.5 text-xs text-rail-subtle">
                    Search monitors
                    <input
                      type="search"
                      placeholder="Name or URL"
                      value={monitorQuery}
                      onChange={(event) => setMonitorQuery(event.target.value)}
                      className="min-h-9 w-full rounded-rail-control border border-rail-border bg-rail-input px-3 text-sm text-rail-text placeholder:text-rail-muted"
                    />
                  </label>
                  <label className="flex flex-col gap-1.5 text-xs text-rail-subtle">
                    Health
                    <select
                      value={monitorFilter}
                      onChange={(event) => setMonitorFilter(event.target.value as MonitorFilter)}
                      className="min-h-9 rounded-rail-control border border-rail-border bg-rail-input px-3 text-sm text-rail-text"
                    >
                      <option value="all">All monitors</option>
                      <option value="operational">Operational</option>
                      <option value="attention">Needs attention</option>
                      <option value="paused">Paused</option>
                      <option value="pending">Awaiting evidence</option>
                    </select>
                  </label>
                </div>
              ) : null}

              {isLoading ? (
                <div className="state" role="status">
                  <span className="spinner" aria-hidden="true" />
                  Loading monitors…
                </div>
              ) : loadError ? (
                <div className="flex min-h-40 items-center p-6 text-sm text-rail-muted sm:px-8">
                  Monitor inventory is unavailable.
                </div>
              ) : monitors.length === 0 ? (
                <div className="flex min-h-56 flex-col items-start justify-center p-6 sm:p-8">
                  <div className="mb-4 grid size-10 place-items-center rounded-lg border border-rail-border bg-rail-surface text-rail-muted">
                    <svg
                      viewBox="0 0 20 20"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      aria-hidden="true"
                      className="size-5"
                    >
                      <path d="M3 10h3l2-5 4 10 2-5h3" />
                    </svg>
                  </div>
                  <h3 className="m-0 text-base font-semibold text-rail-text">No monitors yet</h3>
                  <p className="mt-1 mb-0 max-w-sm text-sm leading-6 text-rail-subtle">
                    Add an HTTP endpoint to begin collecting availability and diagnostic evidence.
                  </p>
                </div>
              ) : visibleMonitors.length === 0 ? (
                <div className="flex min-h-40 flex-col items-center justify-center gap-3 p-6 text-center">
                  <p className="text-sm text-rail-subtle">
                    {view === 'detail'
                      ? 'This monitor could not be found.'
                      : 'No monitors match your filters.'}
                  </p>
                  {view === 'monitors' ? (
                    <Button
                      onClick={() => {
                        setMonitorQuery('');
                        setMonitorFilter('all');
                      }}
                      size="compact"
                    >
                      Clear filters
                    </Button>
                  ) : null}
                </div>
              ) : (
                <ul className="m-0 grid list-none gap-3 p-3 sm:p-4">
                  {visibleMonitors.map((monitor) => (
                    <li
                      key={monitor.id}
                      className="overflow-hidden rounded-rail-panel border border-rail-border bg-rail-raised"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-rail-border px-5 py-4">
                          <div className="min-w-0">
                            <div className="mb-1.5 flex flex-wrap items-center gap-2.5">
                              <h3 className="m-0 text-base font-semibold text-rail-text">
                                {monitor.name}
                              </h3>
                              <StatusBadge
                                status={monitorStatus(monitor.lifecycleState, monitor.currentCheck)}
                                label={monitorStateLabel(
                                  monitor.lifecycleState,
                                  monitor.currentCheck,
                                )}
                              />
                            </div>
                            <a
                              href={monitor.url}
                              target="_blank"
                              rel="noreferrer"
                              className="block max-w-full truncate text-sm text-rail-subtle underline decoration-rail-border-strong underline-offset-4 hover:text-rail-text"
                            >
                              {monitor.url}
                            </a>
                          </div>
                          <Button
                            variant="secondary"
                            size="compact"
                            disabled={runningMonitorIds.has(monitor.id)}
                            onClick={() => void runNow(monitor.id)}
                          >
                            {runningMonitorIds.has(monitor.id) ? 'Checking…' : 'Run now'}
                          </Button>
                          {view === 'monitors' ? (
                            <Link
                              href={`/monitors/${monitor.id}`}
                              className="inline-flex min-h-9 items-center rounded-rail-control px-3 text-xs font-medium text-rail-accent no-underline hover:bg-rail-hover"
                            >
                              View monitor
                            </Link>
                          ) : null}
                        </div>
                        <div className="flex flex-wrap gap-x-4 gap-y-2 border-b border-rail-border px-5 py-3 text-xs text-rail-muted">
                          <span className="font-medium text-rail-subtle">{monitor.method}</span>
                          <span>{monitor.timeoutMs / 1000}s timeout</span>
                          <span>
                            {monitor.followRedirects ? 'follow redirects' : 'redirects final'}
                          </span>
                          <span>{statusPolicyLabel(monitor.statusPolicy)}</span>
                          <span>{monitor.locations.join(', ')}</span>
                        </div>
                        {view !== 'monitors' ? (
                          <div className="p-5">
                            {monitor.currentCheck?.kind === 'MULTI_LOCATION' ? (
                              <dl
                                className="mb-4 grid grid-cols-2 gap-px overflow-hidden rounded-rail-panel border border-rail-border bg-rail-border sm:grid-cols-3"
                                aria-label={`Latest regional aggregate for ${monitor.name}`}
                              >
                                <div className="bg-rail-sidebar/60 px-4 py-3">
                                  <dt className="text-xs text-rail-muted">Aggregate</dt>
                                  <dd className="mt-1 mb-0 text-base font-semibold text-rail-text">
                                    {monitor.currentCheck.aggregateOutcome}
                                  </dd>
                                </div>
                                <div className="bg-rail-sidebar/60 px-4 py-3">
                                  <dt className="text-xs text-rail-muted">Evidence coverage</dt>
                                  <dd className="mt-1 mb-0 text-base font-semibold text-rail-text tabular-nums">
                                    {formatRatio(monitor.currentCheck.coverage)}
                                  </dd>
                                </div>
                                <div className="bg-rail-sidebar/60 px-4 py-3">
                                  <dt className="text-xs text-rail-muted">Reachability</dt>
                                  <dd className="mt-1 mb-0 text-base font-semibold text-rail-text tabular-nums">
                                    {formatRatio(monitor.currentCheck.reachability)}
                                  </dd>
                                </div>
                              </dl>
                            ) : null}
                            <ManualDiagnostic
                              round={manualRounds[monitor.id]}
                              error={runErrors[monitor.id]}
                            />
                            <IncidentSummary state={monitor.incidentState} />
                            <dl
                              className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-rail-panel border border-rail-border bg-rail-border"
                              aria-label={`Uptime metrics for ${monitor.name}`}
                              title="Today and the previous six UTC calendar days, starting no earlier than availability tracking."
                            >
                              <div className="bg-rail-sidebar/60 px-4 py-3">
                                <dt className="text-xs text-rail-muted">7-day uptime</dt>
                                <dd className="mt-1 mb-0 text-lg font-semibold text-rail-text tabular-nums">
                                  {formatPercent(monitor.uptime?.uptimePercent)}
                                </dd>
                              </div>
                              <div className="bg-rail-sidebar/60 px-4 py-3">
                                <dt className="text-xs text-rail-muted">Evidence coverage</dt>
                                <dd className="mt-1 mb-0 text-lg font-semibold text-rail-text tabular-nums">
                                  {formatPercent(monitor.uptime?.coveragePercent)}
                                </dd>
                              </div>
                            </dl>
                            <div className="mt-4 flex flex-wrap items-center gap-1 border-t border-rail-border pt-3">
                              <Button
                                variant="quiet"
                                size="compact"
                                onClick={() => void toggleIncidentHistory(monitor.id)}
                              >
                                {visibleIncidentIds.has(monitor.id)
                                  ? 'Hide incident history'
                                  : 'Show incident history'}
                              </Button>
                              <Button
                                variant="quiet"
                                size="compact"
                                onClick={() => void toggleHistory(monitor.id)}
                              >
                                {visibleHistoryIds.has(monitor.id)
                                  ? 'Hide history'
                                  : 'Show history'}
                              </Button>
                            </div>
                            {visibleIncidentIds.has(monitor.id) ? (
                              <IncidentHistory
                                page={incidentHistory[monitor.id]}
                                loading={loadingIncidentHistoryIds.has(monitor.id)}
                                error={incidentHistoryErrors[monitor.id]}
                                onRetry={() => void loadIncidentHistory(monitor.id)}
                                onLoadMore={() => void loadIncidentHistory(monitor.id, true)}
                              />
                            ) : null}
                            {visibleHistoryIds.has(monitor.id) ? (
                              <CheckHistory
                                page={history[monitor.id]}
                                loading={loadingHistoryIds.has(monitor.id)}
                                onLoadMore={() => void loadHistory(monitor.id, true)}
                                details={historyDetails}
                                expandedRoundIds={expandedHistoryRoundIds}
                                loadingRoundIds={loadingHistoryRoundIds}
                                onToggleRound={(roundId) =>
                                  void toggleHistoryRound(monitor.id, roundId)
                                }
                              />
                            ) : null}
                            <MonitorConfiguration
                              monitor={monitor}
                              probeLocations={probeLocations}
                              updatingSettings={updatingSettingsIds.has(monitor.id)}
                              updatingPolicy={updatingPolicyIds.has(monitor.id)}
                              onLoadProbeLocations={() => void loadProbeLocations()}
                              onUpdateLocation={(event) => void updateLocation(monitor.id, event)}
                              onUpdateHttpSettings={(event) =>
                                void updateHttpSettings(monitor.id, event)
                              }
                              onUpdateStatusPolicy={(event) =>
                                void updateStatusPolicy(monitor.id, event)
                              }
                            />
                          </div>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}
          {view === 'legacy' || view === 'create' ? (
            <section
              id="create-monitor"
              className="panel form-panel overflow-hidden rounded-rail-panel xl:sticky xl:top-20"
              aria-labelledby="create-heading"
            >
              <div className="panel-heading">
                <div>
                  <h2 id="create-heading">Add an endpoint</h2>
                  <p className="mt-1 mb-0 text-xs text-rail-muted">Create a local HTTP monitor.</p>
                </div>
              </div>

              <form onSubmit={(event) => void createMonitor(event)} noValidate>
                <fieldset className="field">
                  <legend>Expected status</legend>
                  <label>
                    <input name="statusPolicyMode" type="radio" value="ANY_2XX" defaultChecked />
                    Any 2xx response
                  </label>
                  <label>
                    <input name="statusPolicyMode" type="radio" value="EXACT" />
                    Specific status codes
                  </label>
                  <input
                    name="statusCodes"
                    type="text"
                    inputMode="numeric"
                    placeholder="200, 204"
                    aria-describedby={fieldErrors.statusPolicy ? 'status-policy-error' : undefined}
                    aria-invalid={Boolean(fieldErrors.statusPolicy)}
                  />
                  {fieldErrors.statusPolicy ? (
                    <p className="field-error" id="status-policy-error">
                      {fieldErrors.statusPolicy[0]}
                    </p>
                  ) : null}
                </fieldset>
                <div className="field">
                  <label htmlFor="name">Monitor name</label>
                  <input
                    id="name"
                    name="name"
                    type="text"
                    placeholder="Production API"
                    maxLength={120}
                    aria-describedby={fieldErrors.name ? 'name-error' : undefined}
                    aria-invalid={Boolean(fieldErrors.name)}
                  />
                  {fieldErrors.name ? (
                    <p className="field-error" id="name-error">
                      {fieldErrors.name[0]}
                    </p>
                  ) : null}
                </div>

                <div className="field">
                  <label htmlFor="url">HTTP(S) URL</label>
                  <input
                    id="url"
                    name="url"
                    type="url"
                    placeholder="https://api.example.com/health"
                    aria-describedby={fieldErrors.url ? 'url-error' : 'url-help'}
                    aria-invalid={Boolean(fieldErrors.url)}
                  />
                  {fieldErrors.url ? (
                    <p className="field-error" id="url-error">
                      {fieldErrors.url[0]}
                    </p>
                  ) : (
                    <p className="field-help" id="url-help">
                      Watchrail stores this configuration but does not call it during creation.
                    </p>
                  )}
                </div>

                <div className="defaults" aria-label="Initial monitor defaults">
                  <Default label="Method" value="GET" />
                  <Default label="Timeout" value="10 seconds" />
                  <Default label="Location" value="Local" />
                  <Default label="Lifecycle" value="Enabled" />
                </div>

                <button className="primary-button" type="submit" disabled={isSubmitting}>
                  {isSubmitting ? 'Creating…' : 'Create monitor'}
                </button>
              </form>
            </section>
          ) : null}
        </div>
      </main>
    </AppShell>
  );
}

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

function MonitorConfiguration({
  monitor,
  probeLocations,
  updatingSettings,
  updatingPolicy,
  onLoadProbeLocations,
  onUpdateLocation,
  onUpdateHttpSettings,
  onUpdateStatusPolicy,
}: {
  monitor: Monitor;
  probeLocations: ProbeLocation[];
  updatingSettings: boolean;
  updatingPolicy: boolean;
  onLoadProbeLocations: () => void;
  onUpdateLocation: (event: FormEvent<HTMLFormElement>) => void;
  onUpdateHttpSettings: (event: FormEvent<HTMLFormElement>) => void;
  onUpdateStatusPolicy: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const configurationRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    if (window.location.hash === '#configuration')
      configurationRef.current?.setAttribute('open', '');
  }, []);

  return (
    <details
      id="configuration"
      ref={configurationRef}
      className="mt-4 scroll-mt-20 rounded-rail-panel border border-rail-border bg-rail-sidebar/50"
    >
      <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-rail-text">
        Configure monitor
      </summary>
      <div className="border-t border-rail-border p-4">
        <form className="status-policy-form" onSubmit={onUpdateLocation}>
          <label>
            Execution {multiLocationUiEnabled ? 'locations' : 'location'}
            <select
              name="location"
              multiple={multiLocationUiEnabled}
              defaultValue={
                multiLocationUiEnabled ? monitor.locations : (monitor.locations[0] ?? 'local')
              }
              onFocus={onLoadProbeLocations}
            >
              <option value="local">Local</option>
              {probeLocations.map((location) => (
                <option
                  key={location.id}
                  value={location.id}
                  disabled={location.status !== 'ACTIVE'}
                >
                  {location.name} — {location.health.toLowerCase()}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={updatingSettings}>
            Save location
          </button>
        </form>
        <form className="status-policy-form" onSubmit={onUpdateHttpSettings}>
          <label>
            URL
            <input name="url" type="url" defaultValue={monitor.url} required />
          </label>
          <label>
            Method
            <select name="method" defaultValue={monitor.method}>
              <option value="GET">GET</option>
              <option value="HEAD">HEAD</option>
            </select>
          </label>
          <label>
            Timeout (seconds)
            <input
              name="timeoutSeconds"
              type="number"
              min="1"
              max="30"
              step="1"
              defaultValue={monitor.timeoutMs / 1_000}
            />
          </label>
          <label>
            <input
              name="followRedirects"
              type="checkbox"
              defaultChecked={monitor.followRedirects}
            />
            Follow redirects
          </label>
          <button className="quiet-button" type="submit" disabled={updatingSettings}>
            {updatingSettings ? 'Saving…' : 'Save HTTP settings'}
          </button>
        </form>
        <form className="status-policy-form" onSubmit={onUpdateStatusPolicy}>
          <label>
            Expected status
            <select name="statusPolicyMode" defaultValue={monitor.statusPolicy.type}>
              <option value="ANY_2XX">Any 2xx response</option>
              <option value="EXACT">Specific status codes</option>
            </select>
          </label>
          <input
            name="statusCodes"
            type="text"
            inputMode="numeric"
            placeholder="200, 204"
            defaultValue={
              monitor.statusPolicy.type === 'EXACT'
                ? monitor.statusPolicy.statusCodes.join(', ')
                : ''
            }
            aria-label={`Specific status codes for ${monitor.name}`}
          />
          <button className="quiet-button" type="submit" disabled={updatingPolicy}>
            {updatingPolicy ? 'Saving…' : 'Save policy'}
          </button>
        </form>
      </div>
    </details>
  );
}

function Default({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
