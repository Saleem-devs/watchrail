'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AppShell } from '../components/app-shell';
import { MonitorOverview } from '../components/monitor-overview';
import { actionClassName, Button } from '../components/ui/button';
import { Checkbox, Select } from '../components/ui/form-control';
import { Form } from '../components/ui/form';
import { PageHeader } from '../components/ui/page-header';
import { ConfirmationDialog } from '../components/ui/confirmation-dialog';
import { TablePagination, type PaginationState } from '../components/ui/table-pagination';
import { monitorDetailHref, monitorEditHref } from '../lib/navigation-origin';
import { StatusBadge } from '../components/ui/status-badge';
import { OverviewDashboard } from '../features/overview/overview-dashboard';
import { DashboardHeader } from '../features/monitors/dashboard-header';
import { MonitorFiltersDialog } from '../features/monitors/monitor-filters-dialog';
import {
  EMPTY_MONITOR_FILTERS,
  monitorFiltersFromSearchParams,
  monitorListSearchParams,
  monitorPaginationFromSearchParams,
  DEFAULT_MONITOR_PAGINATION,
  type MonitorListFilters,
  type MonitorListPagination,
} from '../features/monitors/filter-monitors';
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
import { MonitorForm } from '../features/monitors/monitor-form';
import { responseAssertionsFromForm } from '../features/monitors/response-assertions';
import {
  httpConfigurationTestFromForm,
  requiresStateChangingMethodConfirmation,
  requestBodyFromForm,
  requestHeadersFromForm,
  tlsPolicyFromForm,
  urlFromMonitorForm,
} from '../features/monitors/monitor-form-serialization';
import { HTTP_METHODS } from '../features/monitors/http-method-options';
import { MonitorAvailabilityHistory } from '../features/monitors/monitor-availability-history';
import { MonitorResponseTimeChart } from '../features/monitors/monitor-response-time-chart';
import { MonitorTable } from '../features/monitors/monitor-table';
import type {
  ApiError,
  FieldErrors,
  Monitor,
  ProbeLocation,
  ManualRound,
  HistoryPage,
  IncidentHistoryPage,
  ResponseTimeOverview,
  ConfigurationTestResult,
} from '../features/monitors/types';

const multiLocationUiEnabled = process.env.NEXT_PUBLIC_MULTI_LOCATION_EXECUTION_ENABLED === 'true';

type DashboardView = 'legacy' | 'overview' | 'monitors' | 'create' | 'detail' | 'edit';

export function Dashboard({
  view = 'legacy',
  projectId,
  monitorId,
  initialMonitorFilters,
  initialMonitorPagination,
  backPath = '/monitors',
}: {
  view?: DashboardView;
  projectId?: string;
  monitorId?: string;
  initialMonitorFilters?: MonitorListFilters;
  initialMonitorPagination?: MonitorListPagination;
  backPath?: string;
}) {
  const router = useRouter();
  const projectBase = projectId ? `/projects/${projectId}` : '';
  const initialMonitorFiltersRef = useRef(initialMonitorFilters ?? EMPTY_MONITOR_FILTERS);
  const initialMonitorPaginationRef = useRef(
    initialMonitorPagination ?? DEFAULT_MONITOR_PAGINATION,
  );
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [monitorFilters, setMonitorFilters] = useState<MonitorListFilters>(
    initialMonitorFiltersRef.current,
  );
  const [monitorPagination, setMonitorPagination] = useState<MonitorListPagination>(
    initialMonitorPaginationRef.current,
  );
  const [monitorPage, setMonitorPage] = useState<PaginationState>({
    number: initialMonitorPaginationRef.current.page,
    limit: initialMonitorPaginationRef.current.limit,
    total: 0,
    totalPages: 1,
  });
  const [knownMonitorLocations, setKnownMonitorLocations] = useState<string[]>([]);
  const [probeLocations, setProbeLocations] = useState<ProbeLocation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [updatingPolicyIds, setUpdatingPolicyIds] = useState<Set<string>>(() => new Set());
  const [updatingSettingsIds, setUpdatingSettingsIds] = useState<Set<string>>(() => new Set());
  const [loadError, setLoadError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [createdMonitor, setCreatedMonitor] = useState<Monitor>();
  const [configurationTest, setConfigurationTest] = useState<ConfigurationTestResult>();
  const [configurationTestError, setConfigurationTestError] = useState<string>();
  const [isTestingConfiguration, setIsTestingConfiguration] = useState(false);
  const [stateChangingTestMethod, setStateChangingTestMethod] = useState<string>();
  const [manualRounds, setManualRounds] = useState<Record<string, ManualRound>>({});
  const [runningMonitorIds, setRunningMonitorIds] = useState<Set<string>>(() => new Set());
  const [runErrors, setRunErrors] = useState<Record<string, string>>({});
  const [history, setHistory] = useState<Record<string, HistoryPage>>({});
  const [visibleHistoryIds, setVisibleHistoryIds] = useState<Set<string>>(() => new Set());
  const [loadingHistoryIds, setLoadingHistoryIds] = useState<Set<string>>(
    () => new Set(view === 'detail' && monitorId ? [monitorId] : []),
  );
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
  const configurationTestRequest = useRef<{ id: number; controller: AbortController } | undefined>(
    undefined,
  );
  const configurationTestRequestId = useRef(0);

  useEffect(() => {
    void loadMonitors(
      initialMonitorFiltersRef.current,
      view === 'monitors' ? initialMonitorPaginationRef.current : undefined,
    );

    const timeouts = pollTimeouts.current;
    return () => {
      for (const timeout of timeouts.values()) clearTimeout(timeout);
      timeouts.clear();
      configurationTestRequest.current?.controller.abort();
    };
    // loadMonitors is intentionally scoped to the route's initial filter snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  useEffect(() => {
    if (view !== 'monitors') return;
    const restoreFiltersFromUrl = () => {
      const filters = monitorFiltersFromSearchParams(new URLSearchParams(window.location.search));
      const pagination = monitorPaginationFromSearchParams(
        new URLSearchParams(window.location.search),
      );
      setMonitorFilters(filters);
      setMonitorPagination(pagination);
      void loadMonitors(filters, pagination);
    };
    window.addEventListener('popstate', restoreFiltersFromUrl);
    return () => window.removeEventListener('popstate', restoreFiltersFromUrl);
    // The popstate subscription is replaced only when the route mode changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  useEffect(() => {
    if (view === 'overview') void loadOverviewAnalytics();
    // Overview analytics reloads when entering the overview route.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  useEffect(() => {
    if (view !== 'detail' || !monitorId) return;
    const controller = new AbortController();
    void fetch(`/api/monitors/${monitorId}/check-rounds?limit=10`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not load response-time history.');
        const body = (await response.json()) as {
          data: ManualRound[];
          page: { nextCursor: string | null };
        };
        setHistory((current) => ({
          ...current,
          [monitorId]: { items: body.data, nextCursor: body.page.nextCursor },
        }));
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setRunErrors((current) => ({
          ...current,
          [monitorId]: 'Watchrail could not load this monitor history.',
        }));
      })
      .finally(() => {
        if (controller.signal.aborted) return;
        setLoadingHistoryIds((current) => {
          const next = new Set(current);
          next.delete(monitorId);
          return next;
        });
      });
    return () => controller.abort();
  }, [view, monitorId]);

  async function loadOverviewAnalytics(): Promise<void> {
    setIsOverviewAnalyticsLoading(true);
    setOverviewAnalyticsError(undefined);
    try {
      const response = await fetch(
        `/api/overview/response-times${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
        {
          headers: { Accept: 'application/json' },
        },
      );
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

  async function loadMonitors(
    filters: MonitorListFilters = EMPTY_MONITOR_FILTERS,
    pagination?: MonitorListPagination,
  ): Promise<void> {
    setIsLoading(true);
    setLoadError(undefined);

    try {
      const query = new URLSearchParams();
      if (projectId) query.set('projectId', projectId);
      if (filters.name.trim()) query.set('name', filters.name.trim());
      if (filters.state !== 'all') query.set('state', filters.state);
      if (filters.location) query.set('location', filters.location);
      if (pagination) {
        query.set('page', String(pagination.page));
        query.set('limit', String(pagination.limit));
      }
      const response = await fetch(`/api/monitors${query.size > 0 ? `?${query}` : ''}`, {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error('Could not load monitors.');
      const body = (await response.json()) as { data: Monitor[]; page?: PaginationState };
      setMonitors(body.data);
      if (pagination && body.page) setMonitorPage(body.page);
      setKnownMonitorLocations((current) =>
        [...new Set([...current, ...body.data.flatMap((monitor) => monitor.locations)])].sort(),
      );
    } catch {
      setLoadError(
        'Watchrail could not load your monitors. Check that the API and database are running.',
      );
    } finally {
      setIsLoading(false);
    }
  }

  function applyMonitorFilters(filters: MonitorListFilters): void {
    setMonitorFilters(filters);
    const pagination = { ...monitorPagination, page: 1 };
    setMonitorPagination(pagination);
    const query = monitorListSearchParams(filters, pagination).toString();
    window.history.pushState(null, '', `${projectBase}/monitors?${query}`);
    void loadMonitors(filters, pagination);
  }

  function changeMonitorPage(pagination: MonitorListPagination): void {
    setMonitorPagination(pagination);
    const query = monitorListSearchParams(monitorFilters, pagination).toString();
    window.history.pushState(null, '', `${projectBase}/monitors?${query}`);
    void loadMonitors(monitorFilters, pagination);
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
      if (view === 'monitors') {
        void loadMonitors(monitorFilters, monitorPagination);
      } else {
        setMonitors((current) => current.filter((item) => item.id !== monitor.id));
        if (view === 'detail') router.push(backPath);
        else if (view === 'overview') void loadOverviewAnalytics();
      }
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
      const response = await fetch(
        `/api/monitors${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            name: formData.get('name'),
            url: urlFromMonitorForm(formData),
            statusPolicy,
            tlsPolicy: tlsPolicyFromForm(formData),
            method: formData.get('method'),
            timeoutMs: Number(formData.get('timeoutSeconds')) * 1_000,
            followRedirects: formData.get('followRedirects') === 'on',
            locations: [formData.get('location')],
            lifecycleState: formData.get('lifecycleState'),
            requestHeaders: requestHeadersFromForm(formData),
            requestBody: requestBodyFromForm(formData),
            assertions: responseAssertionsFromForm(formData),
          }),
        },
      );

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

  async function editMonitor(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!monitorId) return;

    setIsSubmitting(true);
    setActionError(undefined);
    setFieldErrors({});

    const formData = new FormData(event.currentTarget);
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [
      {
        path: 'configuration',
        body: {
          httpSettings: {
            url: urlFromMonitorForm(formData),
            method: formData.get('method'),
            timeoutMs: Number(formData.get('timeoutSeconds')) * 1_000,
            followRedirects: formData.get('followRedirects') === 'on',
            requestBody: requestBodyFromForm(formData),
            tlsPolicy: tlsPolicyFromForm(formData),
          },
          requestHeaders: requestHeadersFromForm(formData),
          assertions: responseAssertionsFromForm(formData),
        },
      },
      { path: 'name', body: { name: formData.get('name') } },
      { path: 'status-policy', body: { statusPolicy: statusPolicyFromForm(formData) } },
      { path: 'locations', body: { locations: [formData.get('location')] } },
      { path: 'lifecycle', body: { lifecycleState: formData.get('lifecycleState') } },
    ];

    try {
      let updatedMonitor: Monitor | undefined;
      for (const request of requests) {
        const response = await fetch(`/api/monitors/${monitorId}/${request.path}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(request.body),
        });
        const body = (await response.json()) as { data?: Monitor } & ApiError;
        if (!response.ok || !body.data) {
          if (response.status === 400 && body.fields) setFieldErrors(body.fields);
          throw new Error(body.message ?? 'Could not update monitor.');
        }
        updatedMonitor = body.data;
      }

      if (updatedMonitor) {
        setMonitors((current) =>
          current.map((monitor) => (monitor.id === monitorId ? updatedMonitor : monitor)),
        );
      }
      router.push(`${projectBase}/monitors/${monitorId}`);
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : 'Watchrail could not update this monitor.',
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  function beginConfigurationTest(): void {
    const form = document.getElementById('monitor-form');
    if (!(form instanceof HTMLFormElement) || !form.reportValidity()) return;
    const methodValue = new FormData(form).get('method');
    const method = typeof methodValue === 'string' ? methodValue : 'GET';
    if (requiresStateChangingMethodConfirmation(method)) {
      setStateChangingTestMethod(method);
      return;
    }
    void testConfiguration(form);
  }

  function invalidateConfigurationTest(): void {
    configurationTestRequestId.current += 1;
    configurationTestRequest.current?.controller.abort();
    configurationTestRequest.current = undefined;
    setConfigurationTest(undefined);
    setConfigurationTestError(undefined);
    setIsTestingConfiguration(false);
    setStateChangingTestMethod(undefined);
  }

  async function testConfiguration(form?: HTMLFormElement): Promise<void> {
    const monitorForm = form ?? document.getElementById('monitor-form');
    if (!(monitorForm instanceof HTMLFormElement) || !projectId) return;
    setStateChangingTestMethod(undefined);
    setIsTestingConfiguration(true);
    setConfigurationTest(undefined);
    setConfigurationTestError(undefined);
    setActionError(undefined);
    setFieldErrors({});
    configurationTestRequest.current?.controller.abort();
    const requestId = ++configurationTestRequestId.current;
    const controller = new AbortController();
    configurationTestRequest.current = { id: requestId, controller };

    try {
      const endpoint =
        view === 'edit' && monitorId
          ? `/api/monitors/${monitorId}/test-configuration`
          : '/api/monitors/test-configuration';
      const response = await fetch(`${endpoint}?projectId=${encodeURIComponent(projectId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(httpConfigurationTestFromForm(new FormData(monitorForm))),
        signal: controller.signal,
      });
      const body = (await response.json()) as { data?: ConfigurationTestResult } & ApiError;
      if (configurationTestRequest.current?.id !== requestId) return;
      if (!response.ok || !body.data) {
        if (response.status === 400 && body.fields) setFieldErrors(body.fields);
        setConfigurationTestError(
          body.message ??
            'Watchrail could not test this configuration. Review the fields and try again.',
        );
        return;
      }
      setConfigurationTest(body.data);
      window.requestAnimationFrame(() =>
        document.querySelector('[aria-label="Configuration test result"]')?.scrollIntoView({
          behavior: 'smooth',
          block: 'nearest',
        }),
      );
    } catch (error) {
      if (
        configurationTestRequest.current?.id !== requestId ||
        (error instanceof DOMException && error.name === 'AbortError')
      ) {
        return;
      }
      setConfigurationTestError('Watchrail could not reach the test service. Try again.');
    } finally {
      if (configurationTestRequest.current?.id === requestId) {
        configurationTestRequest.current = undefined;
        setIsTestingConfiguration(false);
      }
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
      if (!response.ok) throw new Error('Could not load diagnostic evidence.');
      const body = (await response.json()) as { data: ManualRound };
      setHistoryDetails((current) => ({ ...current, [roundId]: body.data }));
    } catch {
      setRunErrors((current) => ({
        ...current,
        [monitorId]: 'Watchrail could not load this round’s diagnostic evidence.',
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
    view === 'detail' || view === 'edit'
      ? monitors.filter((monitor) => monitor.id === monitorId)
      : monitors;
  const detailMonitor = visibleMonitors[0];
  const detailPath = monitorId ? monitorDetailHref(monitorId, backPath, projectId) : backPath;
  const monitorListQuery = monitorListSearchParams(monitorFilters, monitorPagination).toString();
  const monitorListOrigin = `${projectBase}/monitors?${monitorListQuery}`;
  const hasActiveMonitorFilters =
    Boolean(monitorFilters.name.trim()) ||
    monitorFilters.state !== 'all' ||
    Boolean(monitorFilters.location);
  const shellPage =
    view === 'overview'
      ? 'overview'
      : view === 'create'
        ? 'new-monitor'
        : view === 'detail' || view === 'edit'
          ? 'monitor-detail'
          : view === 'legacy'
            ? 'overview'
            : 'monitors';

  return (
    <AppShell page={shellPage} projectId={projectId}>
      <main id="main-content" data-watchrail-dashboard className="w-full min-w-0 pb-16">
        {view !== 'detail' && view !== 'edit' ? (
          <DashboardHeader
            view={view === 'create' ? 'create' : view === 'monitors' ? 'monitors' : 'overview'}
            basePath={projectBase}
            actions={
              view === 'monitors' ? (
                <>
                  <MonitorFiltersDialog
                    filters={monitorFilters}
                    locations={knownMonitorLocations}
                    onApply={applyMonitorFilters}
                  />
                  <Link
                    href={`${projectBase}/monitors/new`}
                    className={actionClassName({ variant: 'primary', className: 'px-5' })}
                  >
                    <svg
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      aria-hidden="true"
                      className="size-4"
                    >
                      <path d="M8 3v10M3 8h10" />
                    </svg>
                    Add monitor
                  </Link>
                </>
              ) : view === 'create' ? (
                <>
                  <Button
                    variant="secondary"
                    disabled={isTestingConfiguration || isSubmitting}
                    onClick={beginConfigurationTest}
                  >
                    {isTestingConfiguration ? 'Testing…' : 'Test configuration'}
                  </Button>
                  <Link
                    href={`${projectBase}/monitors`}
                    className={actionClassName({ variant: 'quiet' })}
                  >
                    Cancel
                  </Link>
                  <Button
                    form="monitor-form"
                    type="submit"
                    variant="primary"
                    disabled={isSubmitting}
                    className="px-5"
                  >
                    {isSubmitting ? 'Saving…' : 'Save monitor'}
                  </Button>
                </>
              ) : undefined
            }
          />
        ) : view === 'edit' ? (
          <PageHeader
            backLink={{ href: detailPath, label: 'Back to monitor' }}
            title={detailMonitor ? `Edit ${detailMonitor.name}` : 'Edit monitor'}
            description="Update the endpoint, response policy, and execution settings."
            actions={
              detailMonitor ? (
                <>
                  <Button
                    variant="secondary"
                    disabled={isTestingConfiguration || isSubmitting}
                    onClick={beginConfigurationTest}
                  >
                    {isTestingConfiguration ? 'Testing…' : 'Test configuration'}
                  </Button>
                  <Link href={detailPath} className={actionClassName({ variant: 'quiet' })}>
                    Cancel
                  </Link>
                  <Button
                    form="monitor-form"
                    type="submit"
                    variant="primary"
                    disabled={isSubmitting}
                    className="px-5"
                  >
                    {isSubmitting ? 'Saving…' : 'Save changes'}
                  </Button>
                </>
              ) : undefined
            }
          />
        ) : (
          <PageHeader
            backLink={{ href: backPath, label: 'Back' }}
            title={detailMonitor?.name ?? 'Monitor details'}
            description={detailMonitor?.url ?? 'Health, incidents, evidence, and configuration.'}
            actions={
              detailMonitor ? (
                <>
                  <Link
                    href={monitorEditHref(detailMonitor.id, backPath, projectId)}
                    className={actionClassName()}
                  >
                    Edit
                  </Link>
                  <Button variant="danger" onClick={() => void deleteMonitor(detailMonitor)}>
                    Delete
                  </Button>
                </>
              ) : undefined
            }
          />
        )}

        {!isLoading && !loadError && view === 'legacy' ? (
          <MonitorOverview monitors={monitors} />
        ) : null}

        {loadError ? (
          <div className="alert" role="alert">
            <span>{loadError}</span>
            <button type="button" onClick={() => void loadMonitors(monitorFilters)}>
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
              href={`${projectBase}/monitors/${createdMonitor.id}`}
              className="inline-flex min-h-9 items-center rounded-rail-control px-3 font-medium text-rail-success no-underline hover:bg-rail-hover"
            >
              View monitor
            </Link>
          </div>
        ) : null}

        {view === 'overview' && !isLoading && !loadError ? (
          <OverviewDashboard
            projectId={projectId}
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
              className={
                view === 'detail'
                  ? 'min-w-0'
                  : 'min-w-0 overflow-hidden rounded-rail-panel border border-rail-border bg-rail-header'
              }
              aria-labelledby={view === 'detail' ? undefined : 'monitors-heading'}
              aria-label={view === 'detail' ? 'Monitor details' : undefined}
            >
              {view !== 'detail' ? (
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rail-border p-5 sm:px-6">
                  <div>
                    <h2
                      id="monitors-heading"
                      className="m-0 text-lg font-semibold tracking-tight text-rail-text"
                    >
                      Monitors
                    </h2>
                    <p className="mt-1 mb-0 text-xs text-rail-muted">
                      Latest reported state for every configured endpoint.
                    </p>
                  </div>
                  <button
                    className="min-h-9 rounded-rail-control border border-rail-border px-3 text-sm text-rail-text hover:bg-rail-hover"
                    type="button"
                    onClick={() => void loadMonitors(monitorFilters, monitorPagination)}
                  >
                    Refresh
                  </button>
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
              ) : monitors.length === 0 && !(view === 'monitors' && hasActiveMonitorFilters) ? (
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
                        applyMonitorFilters(EMPTY_MONITOR_FILTERS);
                      }}
                      size="compact"
                    >
                      Clear filters
                    </Button>
                  ) : null}
                </div>
              ) : view === 'monitors' ? (
                <>
                  <MonitorTable
                    monitors={visibleMonitors}
                    onDeleteMonitor={deleteMonitor}
                    origin={monitorListOrigin}
                    projectId={projectId}
                  />
                  <TablePagination
                    page={monitorPage}
                    label="monitors"
                    onPageChange={(page) => changeMonitorPage({ ...monitorPagination, page })}
                    onLimitChange={(limit) => changeMonitorPage({ page: 1, limit })}
                  />
                </>
              ) : view === 'detail' ? (
                visibleMonitors.map((monitor) => (
                  <MonitorDetailView
                    key={monitor.id}
                    monitor={monitor}
                    manualRound={manualRounds[monitor.id]}
                    runError={runErrors[monitor.id]}
                    running={runningMonitorIds.has(monitor.id)}
                    onRun={() => void runNow(monitor.id)}
                    incidentHistory={incidentHistory[monitor.id]}
                    incidentHistoryVisible={visibleIncidentIds.has(monitor.id)}
                    incidentHistoryLoading={loadingIncidentHistoryIds.has(monitor.id)}
                    incidentHistoryError={incidentHistoryErrors[monitor.id]}
                    onToggleIncidentHistory={() => void toggleIncidentHistory(monitor.id)}
                    onRetryIncidentHistory={() => void loadIncidentHistory(monitor.id)}
                    onLoadMoreIncidents={() => void loadIncidentHistory(monitor.id, true)}
                    checkHistory={history[monitor.id]}
                    checkHistoryVisible={visibleHistoryIds.has(monitor.id)}
                    checkHistoryLoading={loadingHistoryIds.has(monitor.id)}
                    historyDetails={historyDetails}
                    expandedHistoryRoundIds={expandedHistoryRoundIds}
                    loadingHistoryRoundIds={loadingHistoryRoundIds}
                    onToggleCheckHistory={() => void toggleHistory(monitor.id)}
                    onLoadMoreChecks={() => void loadHistory(monitor.id, true)}
                    onToggleHistoryRound={(roundId) => void toggleHistoryRound(monitor.id, roundId)}
                  />
                ))
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
                              {visibleHistoryIds.has(monitor.id) ? 'Hide history' : 'Show history'}
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
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}
          {view === 'create' ? (
            <MonitorForm
              key={createdMonitor?.id ?? 'new-monitor'}
              mode="create"
              errors={fieldErrors}
              submitting={isSubmitting}
              formId="monitor-form"
              onSubmit={(event) => void createMonitor(event)}
              testResult={configurationTest}
              testError={configurationTestError}
              onDismissTest={() => {
                setConfigurationTest(undefined);
                setConfigurationTestError(undefined);
              }}
              onConfigurationChange={invalidateConfigurationTest}
            />
          ) : null}
          {view === 'edit' && detailMonitor ? (
            <MonitorForm
              key={detailMonitor.id}
              mode="edit"
              initialValues={detailMonitor}
              errors={fieldErrors}
              submitting={isSubmitting}
              formId="monitor-form"
              onSubmit={(event) => void editMonitor(event)}
              testResult={configurationTest}
              testError={configurationTestError}
              onDismissTest={() => {
                setConfigurationTest(undefined);
                setConfigurationTestError(undefined);
              }}
              onConfigurationChange={invalidateConfigurationTest}
            />
          ) : null}
          {view === 'edit' && !isLoading && !loadError && !detailMonitor ? (
            <div className="rounded-rail-panel border border-rail-border bg-rail-raised px-5 py-10 text-center text-sm text-rail-subtle">
              This monitor could not be found.
            </div>
          ) : null}
        </div>
      </main>
      <ConfirmationDialog
        open={Boolean(stateChangingTestMethod)}
        title={`Run ${stateChangingTestMethod ?? ''} request?`}
        description={
          <>
            This method can change data on the target service. Watchrail will send the unsaved
            request exactly once and will not create a check record.
          </>
        }
        confirmLabel="Run test"
        onCancel={() => setStateChangingTestMethod(undefined)}
        onConfirm={() => void testConfiguration()}
      />
    </AppShell>
  );
}

function MonitorDetailView({
  monitor,
  manualRound,
  runError,
  running,
  onRun,
  incidentHistory,
  incidentHistoryVisible,
  incidentHistoryLoading,
  incidentHistoryError,
  onToggleIncidentHistory,
  onRetryIncidentHistory,
  onLoadMoreIncidents,
  checkHistory,
  checkHistoryVisible,
  checkHistoryLoading,
  historyDetails,
  expandedHistoryRoundIds,
  loadingHistoryRoundIds,
  onToggleCheckHistory,
  onLoadMoreChecks,
  onToggleHistoryRound,
}: {
  monitor: Monitor;
  manualRound: ManualRound | undefined;
  runError: string | undefined;
  running: boolean;
  onRun: () => void;
  incidentHistory: IncidentHistoryPage | undefined;
  incidentHistoryVisible: boolean;
  incidentHistoryLoading: boolean;
  incidentHistoryError: string | undefined;
  onToggleIncidentHistory: () => void;
  onRetryIncidentHistory: () => void;
  onLoadMoreIncidents: () => void;
  checkHistory: HistoryPage | undefined;
  checkHistoryVisible: boolean;
  checkHistoryLoading: boolean;
  historyDetails: Record<string, ManualRound>;
  expandedHistoryRoundIds: Set<string>;
  loadingHistoryRoundIds: Set<string>;
  onToggleCheckHistory: () => void;
  onLoadMoreChecks: () => void;
  onToggleHistoryRound: (roundId: string) => void;
}) {
  const latestResponse =
    monitor.lifecycleState === 'PAUSED' || monitor.currentCheck?.responseTimeMs == null
      ? '—'
      : `${Math.round(monitor.currentCheck.responseTimeMs)} ms`;
  const incidentLabel = monitor.incidentState.currentIncident
    ? 'Open'
    : monitor.incidentState.failureStreak
      ? 'Watching'
      : 'None';
  const lastEvidence = monitor.currentCheck?.checkedAt
    ? new Date(monitor.currentCheck.checkedAt).toLocaleString()
    : 'No checks recorded';

  return (
    <article className="grid gap-6" aria-label={`${monitor.name} monitor details`}>
      <section className="overflow-hidden rounded-rail-panel border border-rail-border bg-rail-raised">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-rail-border px-5 py-4 sm:px-6">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
            <StatusBadge
              status={monitorStatus(monitor.lifecycleState, monitor.currentCheck)}
              label={monitorStateLabel(monitor.lifecycleState, monitor.currentCheck)}
            />
            <span className="text-xs text-rail-muted">
              {monitor.lifecycleState === 'PAUSED' ? 'Last evidence' : 'Checked'} {lastEvidence}
            </span>
          </div>
          <Button variant="secondary" disabled={running} onClick={onRun}>
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className={`size-4 ${running ? 'motion-safe:animate-spin' : ''}`}
            >
              <path d="M13 8a5 5 0 1 1-1.46-3.54M13 3v4H9" />
            </svg>
            {running ? 'Checking…' : 'Run check'}
          </Button>
        </div>
        <dl className="grid gap-px bg-rail-border sm:grid-cols-2 xl:grid-cols-4">
          <DetailMetric label="7-day uptime" value={formatPercent(monitor.uptime?.uptimePercent)} />
          <DetailMetric label="Latest response" value={latestResponse} />
          <DetailMetric
            label="Evidence coverage"
            value={formatPercent(monitor.uptime?.coveragePercent)}
          />
          <DetailMetric
            label="Incident state"
            value={incidentLabel}
            tone={
              monitor.incidentState.currentIncident
                ? 'danger'
                : monitor.incidentState.failureStreak
                  ? 'warning'
                  : 'default'
            }
          />
        </dl>
      </section>

      <MonitorResponseTimeChart page={checkHistory} loading={checkHistoryLoading} />

      <div className="grid min-w-0 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="grid min-w-0 gap-6">
          <section className="overflow-hidden rounded-rail-panel border border-rail-border bg-rail-raised">
            <div className="border-b border-rail-border px-5 py-4 sm:px-6">
              <h2 className="m-0 text-sm font-semibold text-rail-text">Latest diagnostic</h2>
              <p className="mt-1 mb-0 text-xs text-rail-muted">
                Authoritative HTTP and regional evidence from the latest manual check.
              </p>
            </div>
            <div className="p-5 sm:p-6 [&>.manual-diagnostic]:mt-0 [&>p]:mt-0 [&>p]:border-t-0 [&>p]:pt-0">
              {monitor.currentCheck?.kind === 'MULTI_LOCATION' ? (
                <dl
                  className="mb-5 grid gap-px overflow-hidden rounded-rail-control border border-rail-border bg-rail-border sm:grid-cols-3"
                  aria-label={`Latest regional aggregate for ${monitor.name}`}
                >
                  <DetailMetric
                    label="Aggregate"
                    value={monitor.currentCheck.aggregateOutcome ?? 'Unknown'}
                    compact
                  />
                  <DetailMetric
                    label="Evidence coverage"
                    value={formatRatio(monitor.currentCheck.coverage)}
                    compact
                  />
                  <DetailMetric
                    label="Reachability"
                    value={formatRatio(monitor.currentCheck.reachability)}
                    compact
                  />
                </dl>
              ) : null}
              <ManualDiagnostic round={manualRound} error={runError} />
            </div>
          </section>

          <section className="overflow-hidden rounded-rail-panel border border-rail-border bg-rail-raised">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rail-border px-5 py-4 sm:px-6">
              <div>
                <h2 className="m-0 text-sm font-semibold text-rail-text">Incidents</h2>
                <p className="mt-1 mb-0 text-xs text-rail-muted">
                  Current incident state and recorded outage history.
                </p>
              </div>
              <Button
                variant="quiet"
                size="compact"
                aria-expanded={incidentHistoryVisible}
                onClick={onToggleIncidentHistory}
              >
                {incidentHistoryVisible ? 'Hide history' : 'Show history'}
              </Button>
            </div>
            <div className="p-5 sm:p-6 [&>*]:mt-0">
              <IncidentSummary state={monitor.incidentState} />
              {incidentHistoryVisible ? (
                <IncidentHistory
                  page={incidentHistory}
                  loading={incidentHistoryLoading}
                  error={incidentHistoryError}
                  onRetry={onRetryIncidentHistory}
                  onLoadMore={onLoadMoreIncidents}
                />
              ) : null}
            </div>
          </section>

          <section className="overflow-hidden rounded-rail-panel border border-rail-border bg-rail-raised">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rail-border px-5 py-4 sm:px-6">
              <div>
                <h2 className="m-0 text-sm font-semibold text-rail-text">History</h2>
                <p className="mt-1 mb-0 text-xs text-rail-muted">
                  Availability over time and the underlying check evidence.
                </p>
              </div>
              <Button
                variant="quiet"
                size="compact"
                aria-expanded={checkHistoryVisible}
                onClick={onToggleCheckHistory}
              >
                {checkHistoryVisible ? 'Hide check log' : 'Show check log'}
              </Button>
            </div>
            <div className="p-5 sm:p-6">
              <MonitorAvailabilityHistory monitorId={monitor.id} />
              {checkHistoryVisible ? (
                <div className="mt-6 border-t border-rail-border pt-6 [&>section]:mt-0">
                  <CheckHistory
                    page={checkHistory}
                    loading={checkHistoryLoading}
                    onLoadMore={onLoadMoreChecks}
                    details={historyDetails}
                    expandedRoundIds={expandedHistoryRoundIds}
                    loadingRoundIds={loadingHistoryRoundIds}
                    onToggleRound={onToggleHistoryRound}
                  />
                </div>
              ) : null}
            </div>
          </section>
        </div>

        <aside className="grid min-w-0 gap-6" aria-label="Monitor configuration">
          <section className="overflow-hidden rounded-rail-panel border border-rail-border bg-rail-raised">
            <div className="border-b border-rail-border px-5 py-4">
              <h2 className="m-0 text-sm font-semibold text-rail-text">Monitor settings</h2>
            </div>
            <dl className="m-0 divide-y divide-rail-border px-5">
              <DetailRow label="Method" value={monitor.method} />
              <DetailRow label="Timeout" value={`${monitor.timeoutMs / 1000} seconds`} />
              <DetailRow
                label="Redirects"
                value={monitor.followRedirects ? 'Followed' : 'Final response only'}
              />
              <DetailRow label="Expected status" value={statusPolicyLabel(monitor.statusPolicy)} />
              <DetailRow
                label="Locations"
                value={monitor.locations.length > 0 ? monitor.locations.join(', ') : 'None'}
              />
              <DetailRow
                label="Lifecycle"
                value={monitor.lifecycleState.toLowerCase()}
                capitalize
              />
            </dl>
          </section>
        </aside>
      </div>
    </article>
  );
}

function DetailMetric({
  label,
  value,
  tone = 'default',
  compact = false,
}: {
  label: string;
  value: string;
  tone?: 'default' | 'danger' | 'warning';
  compact?: boolean;
}) {
  return (
    <div className={`min-w-0 bg-rail-raised ${compact ? 'px-4 py-3' : 'px-5 py-4'}`}>
      <dt className="text-xs text-rail-muted">{label}</dt>
      <dd
        className={`m-0 mt-1.5 truncate font-semibold tabular-nums ${compact ? 'text-sm' : 'text-xl'} ${tone === 'danger' ? 'text-rail-danger' : tone === 'warning' ? 'text-rail-warning' : 'text-rail-text'}`}
      >
        {value}
      </dd>
    </div>
  );
}

function DetailRow({
  label,
  value,
  capitalize = false,
}: {
  label: string;
  value: string;
  capitalize?: boolean;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] gap-4 py-3 text-xs">
      <dt className="text-rail-muted">{label}</dt>
      <dd
        className={`m-0 break-words text-right font-medium text-rail-text ${capitalize ? 'capitalize' : ''}`}
      >
        {value}
      </dd>
    </div>
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
    const revealConfiguration = () => {
      if (window.location.hash !== '#configuration') return;
      configurationRef.current?.setAttribute('open', '');
      configurationRef.current?.scrollIntoView({ block: 'start' });
    };
    revealConfiguration();
    window.addEventListener('hashchange', revealConfiguration);
    return () => window.removeEventListener('hashchange', revealConfiguration);
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
        <Form className="status-policy-form" onSubmit={onUpdateLocation}>
          <label>
            Execution {multiLocationUiEnabled ? 'locations' : 'location'}
            <div onFocusCapture={onLoadProbeLocations}>
              {multiLocationUiEnabled ? (
                <select name="location" multiple defaultValue={monitor.locations}>
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
              ) : (
                <Select name="location" defaultValue={monitor.locations[0] ?? 'local'}>
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
                </Select>
              )}
            </div>
          </label>
          <button type="submit" disabled={updatingSettings}>
            Save location
          </button>
        </Form>
        <Form className="status-policy-form" onSubmit={onUpdateHttpSettings}>
          <label>
            URL
            <input name="url" type="url" defaultValue={monitor.url} required />
          </label>
          <label>
            Method
            <Select name="method" defaultValue={monitor.method}>
              {HTTP_METHODS.map((method) => (
                <option key={method} value={method}>
                  {method}
                </option>
              ))}
            </Select>
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
            <Checkbox name="followRedirects" defaultChecked={monitor.followRedirects} />
            Follow redirects
          </label>
          <button className="quiet-button" type="submit" disabled={updatingSettings}>
            {updatingSettings ? 'Saving…' : 'Save HTTP settings'}
          </button>
        </Form>
        <Form className="status-policy-form" onSubmit={onUpdateStatusPolicy}>
          <label>
            Expected status
            <Select name="statusPolicyMode" defaultValue={monitor.statusPolicy.type}>
              <option value="ANY_2XX">Any 2xx response</option>
              <option value="EXACT">Specific status codes</option>
            </Select>
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
        </Form>
      </div>
    </details>
  );
}
