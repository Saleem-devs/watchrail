'use client';

import { BellRing, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../components/ui/button';
import { getIncidentEscalationPolicy, updateIncidentEscalationPolicy } from './notification-api';
import type {
  IncidentEscalationPolicy,
  IncidentEscalationStep,
  NotificationChannel,
} from './types';

const DEFAULT_DELAYS = [15, 60, 240];
const MIN_DELAY_MINUTES = 5;
const MAX_DELAY_MINUTES = 10_080;

type DraftStep = Omit<IncidentEscalationStep, 'delayMinutes'> & { delayMinutes: string };

export function IncidentEscalationPolicySection({
  projectId,
  channels,
  channelsReady,
}: {
  projectId: string;
  channels: NotificationChannel[];
  channelsReady: boolean;
}) {
  const [draft, setDraft] = useState<DraftStep[]>([]);
  const [saved, setSaved] = useState<IncidentEscalationStep[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadResultProjectId, setLoadResultProjectId] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getIncidentEscalationPolicy(projectId)
      .then((policy) => {
        if (!active) return;
        setSaved(policy.steps);
        setDraft(toDraft(policy.steps));
        setLoadResultProjectId(projectId);
        setLoadState('ready');
      })
      .catch(() => {
        if (active) {
          setLoadResultProjectId(projectId);
          setLoadState('error');
        }
      });
    return () => {
      active = false;
    };
  }, [loadAttempt, projectId]);

  const policy = useMemo<IncidentEscalationPolicy>(
    () => ({
      steps: draft.map((step) => ({
        delayMinutes: Number(step.delayMinutes),
        channelIds: step.channelIds,
      })),
    }),
    [draft],
  );
  const error = validationMessage(policy.steps);
  const changed = JSON.stringify(policy.steps) !== JSON.stringify(saved);
  const ready = loadState === 'ready' && loadResultProjectId === projectId;
  const unavailable = loadState === 'error' && loadResultProjectId === projectId;
  const loading = !ready && !unavailable;
  const enabled = ready && draft.length > 0;
  const incidentChannels = channels.filter((channel) => channel.routing.notifyOnIncident);
  const targetedRoutingUnavailable =
    !channelsReady && policy.steps.some((step) => step.channelIds !== null);

  async function save() {
    if (error) return;
    setSaving(true);
    setMessage(null);
    try {
      const updated = await updateIncidentEscalationPolicy(projectId, policy);
      setSaved(updated.steps);
      setDraft(toDraft(updated.steps));
      setMessage(updated.steps.length > 0 ? 'Escalation policy saved.' : 'Reminders disabled.');
    } catch (caught) {
      setMessage(
        caught instanceof Error ? caught.message : 'Could not save the escalation policy.',
      );
    } finally {
      setSaving(false);
    }
  }

  function setEnabled(nextEnabled: boolean) {
    setMessage(null);
    setDraft(nextEnabled ? [{ delayMinutes: String(DEFAULT_DELAYS[0]), channelIds: null }] : []);
  }

  function updateStep(index: number, update: Partial<DraftStep>) {
    setMessage(null);
    setDraft((current) =>
      current.map((step, stepIndex) => (stepIndex === index ? { ...step, ...update } : step)),
    );
  }

  function setTargetMode(index: number, mode: 'all' | 'selected') {
    updateStep(index, {
      channelIds: mode === 'all' ? null : incidentChannels[0] ? [incidentChannels[0].id] : [],
    });
  }

  function toggleChannel(index: number, channelId: string) {
    const current = draft[index]?.channelIds ?? [];
    updateStep(index, {
      channelIds: current.includes(channelId)
        ? current.filter((id) => id !== channelId)
        : [...current, channelId],
    });
  }

  function retryLoad() {
    setLoadState('loading');
    setMessage(null);
    setLoadAttempt((attempt) => attempt + 1);
  }

  function addReminder() {
    setDraft((current) => [
      ...current,
      {
        delayMinutes: String(
          DEFAULT_DELAYS[current.length] ??
            Math.min(Number(current.at(-1)?.delayMinutes ?? 15) * 2, MAX_DELAY_MINUTES),
        ),
        channelIds: null,
      },
    ]);
  }

  return (
    <section className="mt-8" aria-labelledby="incident-escalation-title">
      <div className="overflow-hidden rounded-rail-panel border border-rail-border bg-rail-surface">
        <div className="flex flex-col gap-5 px-5 py-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 gap-3">
            <BellRing
              className="mt-0.5 size-5 shrink-0 text-rail-muted"
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <div>
              <h2
                id="incident-escalation-title"
                className="m-0 text-base font-semibold text-rail-text"
              >
                Incident escalation
              </h2>
              <p className="mt-1 mb-0 max-w-2xl text-sm leading-6 text-rail-muted">
                Repeat an opening alert through the right channels while an incident remains open.
                Each incident keeps the policy that was active when it opened.
              </p>
            </div>
          </div>
          <label className="flex min-h-11 shrink-0 cursor-pointer items-center gap-3 rounded-rail-control border border-rail-border px-3 text-sm text-rail-text">
            <input
              type="checkbox"
              className="size-4 accent-rail-accent"
              checked={enabled}
              disabled={!ready || saving}
              onChange={(event) => setEnabled(event.currentTarget.checked)}
            />
            Send reminders
          </label>
        </div>

        {unavailable ? (
          <div className="flex flex-col gap-3 border-t border-rail-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div role="alert">
              <p className="m-0 text-sm font-medium text-rail-text">
                Escalation policy unavailable
              </p>
              <p className="mt-1 mb-0 text-xs leading-5 text-rail-muted">
                The saved policy could not be loaded. No escalation settings were changed.
              </p>
            </div>
            <Button size="compact" onClick={retryLoad}>
              Retry
            </Button>
          </div>
        ) : enabled ? (
          <div className="border-t border-rail-border px-5 py-5">
            <ol className="m-0 grid list-none gap-3 p-0">
              {draft.map((step, index) => (
                <li
                  key={index}
                  className="rounded-rail-control border border-rail-border bg-rail-raised p-4"
                >
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
                    <label className="w-full text-xs font-medium text-rail-subtle lg:w-52">
                      Reminder {index + 1} after
                      <span className="mt-2 flex min-h-11 items-center rounded-rail-control border border-rail-border-strong bg-rail-surface focus-within:border-rail-accent">
                        <input
                          type="number"
                          min={MIN_DELAY_MINUTES}
                          max={MAX_DELAY_MINUTES}
                          step={1}
                          value={step.delayMinutes}
                          aria-label={`Reminder ${index + 1} delay in minutes`}
                          onChange={(event) =>
                            updateStep(index, { delayMinutes: event.currentTarget.value })
                          }
                          className="min-w-0 flex-1 border-0 bg-transparent px-3 text-sm tabular-nums text-rail-text outline-none"
                          aria-describedby={
                            error ? 'escalation-help escalation-error' : 'escalation-help'
                          }
                        />
                        <span className="pr-3 text-xs text-rail-muted">minutes</span>
                      </span>
                    </label>

                    <fieldset className="min-w-0 flex-1 border-0 p-0">
                      <legend className="text-xs font-medium text-rail-subtle">Send through</legend>
                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
                        <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-rail-control border border-rail-border bg-rail-surface px-3 text-sm text-rail-text">
                          <input
                            type="radio"
                            name={`reminder-${index}-routing`}
                            checked={step.channelIds === null}
                            onChange={() => setTargetMode(index, 'all')}
                            className="size-4 accent-rail-accent"
                          />
                          All opening-alert channels
                        </label>
                        <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-rail-control border border-rail-border bg-rail-surface px-3 text-sm text-rail-text">
                          <input
                            type="radio"
                            name={`reminder-${index}-routing`}
                            checked={step.channelIds !== null}
                            disabled={!channelsReady || incidentChannels.length === 0}
                            onChange={() => setTargetMode(index, 'selected')}
                            className="size-4 accent-rail-accent"
                          />
                          Selected channels
                        </label>
                      </div>
                      {step.channelIds !== null && !channelsReady ? (
                        <p className="mt-2 mb-0 text-xs text-rail-muted">
                          Loading configured incident channels…
                        </p>
                      ) : step.channelIds !== null ? (
                        <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                          {incidentChannels.map((channel) => (
                            <label
                              key={channel.id}
                              className="flex min-h-11 cursor-pointer items-center gap-3 rounded-rail-control border border-rail-border px-3 text-sm text-rail-subtle"
                            >
                              <input
                                type="checkbox"
                                checked={step.channelIds?.includes(channel.id) ?? false}
                                onChange={() => toggleChannel(index, channel.id)}
                                className="size-4 accent-rail-accent"
                              />
                              <span className="min-w-0 truncate">{channel.name}</span>
                              {!channel.enabled ? (
                                <span className="ml-auto text-xs text-rail-muted">Paused</span>
                              ) : null}
                            </label>
                          ))}
                          {step.channelIds
                            .filter((id) => !incidentChannels.some((channel) => channel.id === id))
                            .map((id) => (
                              <label
                                key={id}
                                className="flex min-h-11 cursor-pointer items-center gap-3 rounded-rail-control border border-rail-danger/45 px-3 text-sm text-rail-danger"
                              >
                                <input
                                  type="checkbox"
                                  checked
                                  onChange={() => toggleChannel(index, id)}
                                  className="size-4 accent-rail-accent"
                                />
                                No longer receives incidents
                              </label>
                            ))}
                        </div>
                      ) : null}
                    </fieldset>

                    <button
                      type="button"
                      onClick={() => setDraft((current) => current.filter((_, i) => i !== index))}
                      className="grid size-11 shrink-0 cursor-pointer place-items-center self-end rounded-rail-control border border-rail-border bg-rail-surface text-rail-muted hover:border-rail-selected-border hover:text-rail-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rail-accent lg:mt-6"
                      aria-label={`Remove reminder ${index + 1}`}
                    >
                      <Trash2 className="size-4" strokeWidth={1.75} aria-hidden="true" />
                    </button>
                  </div>
                </li>
              ))}
            </ol>

            <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p id="escalation-help" className="m-0 text-xs leading-5 text-rail-muted">
                  Add up to three increasing reminders from 5 minutes to 7 days. Delivery retries do
                  not create extra reminders.
                </p>
                {error ? (
                  <p
                    id="escalation-error"
                    className="mt-1 mb-0 text-xs text-rail-danger"
                    role="alert"
                  >
                    {error}
                  </p>
                ) : null}
                {message ? (
                  <p className="mt-1 mb-0 text-xs text-rail-subtle" role="status">
                    {message}
                  </p>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                {draft.length < 3 ? (
                  <Button size="compact" onClick={addReminder} disabled={saving}>
                    <Plus className="size-4" strokeWidth={1.75} aria-hidden="true" />
                    Add reminder
                  </Button>
                ) : null}
                <Button
                  variant="primary"
                  size="compact"
                  onClick={() => void save()}
                  disabled={!changed || Boolean(error) || targetedRoutingUnavailable || saving}
                >
                  {saving ? 'Saving…' : 'Save changes'}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3 border-t border-rail-border px-5 py-4 text-sm text-rail-muted sm:flex-row sm:items-center sm:justify-between">
            <div>
              <span>
                {loading
                  ? 'Loading escalation policy…'
                  : 'Opening alerts are sent once. No reminders are scheduled.'}
              </span>
              {message && ready ? (
                <p className="mt-1 mb-0 text-xs text-rail-subtle" role="status">
                  {message}
                </p>
              ) : null}
            </div>
            {!loading && changed ? (
              <Button
                variant="primary"
                size="compact"
                onClick={() => void save()}
                disabled={saving}
              >
                {saving ? 'Saving…' : 'Save changes'}
              </Button>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}

function toDraft(steps: IncidentEscalationStep[]): DraftStep[] {
  return steps.map((step) => ({ ...step, delayMinutes: String(step.delayMinutes) }));
}

function validationMessage(steps: IncidentEscalationStep[]): string | null {
  if (
    steps.some(
      (step) =>
        !Number.isSafeInteger(step.delayMinutes) ||
        step.delayMinutes < MIN_DELAY_MINUTES ||
        step.delayMinutes > MAX_DELAY_MINUTES,
    )
  )
    return 'Use whole minutes from 5 to 10,080.';
  if (
    steps.some(
      (step, index) => index > 0 && step.delayMinutes <= (steps[index - 1]?.delayMinutes ?? 0),
    )
  )
    return 'Each reminder must occur later than the previous reminder.';
  if (steps.some((step) => step.channelIds !== null && step.channelIds.length === 0))
    return 'Choose at least one channel for each targeted reminder.';
  return null;
}
