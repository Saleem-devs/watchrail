'use client';

import { BellRing, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../components/ui/button';
import { getIncidentReminderPolicy, updateIncidentReminderPolicy } from './notification-api';

const DEFAULT_DELAYS = [15, 60, 240];
const MIN_DELAY_MINUTES = 5;
const MAX_DELAY_MINUTES = 10_080;

export function IncidentReminderPolicySection({ projectId }: { projectId: string }) {
  const [draft, setDraft] = useState<string[]>([]);
  const [saved, setSaved] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getIncidentReminderPolicy(projectId)
      .then((policy) => {
        if (!active) return;
        setSaved(policy.delaysMinutes);
        setDraft(policy.delaysMinutes.map(String));
      })
      .catch(() => {
        if (active) setMessage('Could not load the reminder policy.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  const parsed = useMemo(() => draft.map((value) => Number(value)), [draft]);
  const error = validationMessage(parsed);
  const changed = JSON.stringify(parsed) !== JSON.stringify(saved);
  const enabled = draft.length > 0;

  async function save() {
    if (error) return;
    setSaving(true);
    setMessage(null);
    try {
      const policy = await updateIncidentReminderPolicy(projectId, parsed);
      setSaved(policy.delaysMinutes);
      setDraft(policy.delaysMinutes.map(String));
      setMessage(
        policy.delaysMinutes.length > 0 ? 'Reminder schedule saved.' : 'Reminders disabled.',
      );
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Could not save the reminder policy.');
    } finally {
      setSaving(false);
    }
  }

  function setEnabled(nextEnabled: boolean) {
    setMessage(null);
    setDraft(nextEnabled ? [String(DEFAULT_DELAYS[0])] : []);
  }

  function addReminder() {
    setDraft((current) => [
      ...current,
      String(DEFAULT_DELAYS[current.length] ?? Math.min(Number(current.at(-1) ?? 15) * 2, 10_080)),
    ]);
  }

  return (
    <section className="mt-8" aria-labelledby="incident-reminders-title">
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
                id="incident-reminders-title"
                className="m-0 text-base font-semibold text-rail-text"
              >
                Incident reminders
              </h2>
              <p className="mt-1 mb-0 max-w-2xl text-sm leading-6 text-rail-muted">
                Repeat the opening alert while an incident remains open. Each incident keeps the
                schedule that was active when it opened.
              </p>
            </div>
          </div>
          <label className="flex min-h-11 shrink-0 cursor-pointer items-center gap-3 rounded-rail-control border border-rail-border px-3 text-sm text-rail-text">
            <input
              type="checkbox"
              className="size-4 accent-rail-accent"
              checked={enabled}
              disabled={loading || saving}
              onChange={(event) => setEnabled(event.currentTarget.checked)}
            />
            Send reminders
          </label>
        </div>

        {enabled ? (
          <div className="border-t border-rail-border px-5 py-5">
            <div className="grid gap-3 lg:grid-cols-3">
              {draft.map((value, index) => (
                <div
                  key={index}
                  className="rounded-rail-control border border-rail-border bg-rail-raised p-3"
                >
                  <div className="flex items-end gap-2">
                    <label className="min-w-0 flex-1 text-xs font-medium text-rail-subtle">
                      Remind after
                      <span className="mt-2 flex min-h-10 items-center rounded-rail-control border border-rail-border-strong bg-rail-surface focus-within:border-rail-accent">
                        <input
                          type="number"
                          min={MIN_DELAY_MINUTES}
                          max={MAX_DELAY_MINUTES}
                          step={1}
                          value={value}
                          aria-label={`Reminder ${index + 1} delay in minutes`}
                          onChange={(event) =>
                            setDraft((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index ? event.currentTarget.value : item,
                              ),
                            )
                          }
                          className="min-w-0 flex-1 border-0 bg-transparent px-3 text-sm tabular-nums text-rail-text outline-none"
                          aria-describedby={
                            error
                              ? 'incident-reminder-help incident-reminder-error'
                              : 'incident-reminder-help'
                          }
                        />
                        <span className="pr-3 text-xs text-rail-muted">minutes</span>
                      </span>
                    </label>
                    <button
                      type="button"
                      onClick={() => setDraft((current) => current.filter((_, i) => i !== index))}
                      className="grid size-10 shrink-0 cursor-pointer place-items-center rounded-rail-control border border-rail-border bg-rail-surface text-rail-muted hover:border-rail-selected-border hover:text-rail-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rail-accent"
                      aria-label={`Remove reminder after ${value || 'this number of'} minutes`}
                    >
                      <Trash2 className="size-4" strokeWidth={1.75} aria-hidden="true" />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p id="incident-reminder-help" className="m-0 text-xs leading-5 text-rail-muted">
                  Add up to three increasing delays, from 5 minutes to 7 days.
                </p>
                {error ? (
                  <p
                    id="incident-reminder-error"
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
                  disabled={!changed || Boolean(error) || saving}
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
                  ? 'Loading reminder policy…'
                  : 'Opening alerts are sent once. No reminders are scheduled.'}
              </span>
              {message ? (
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

function validationMessage(delays: number[]): string | null {
  if (
    delays.some(
      (delay) =>
        !Number.isSafeInteger(delay) || delay < MIN_DELAY_MINUTES || delay > MAX_DELAY_MINUTES,
    )
  )
    return 'Use whole minutes from 5 to 10,080.';
  if (delays.some((delay, index) => index > 0 && delay <= (delays[index - 1] ?? 0)))
    return 'Each reminder must occur later than the previous reminder.';
  return null;
}
