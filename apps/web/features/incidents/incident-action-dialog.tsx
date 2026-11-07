'use client';

import { createPortal } from 'react-dom';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/ui/button';
import type { WorkspaceIncident } from './types';

const silenceOptions = [
  { value: '1', label: '1 hour', description: 'Pause notifications during a short investigation.' },
  { value: '4', label: '4 hours', description: 'Cover an extended response or deployment window.' },
  {
    value: '24',
    label: '24 hours',
    description: 'Pause notifications until the same time tomorrow.',
  },
  { value: '168', label: '7 days', description: 'Use for a known issue with a planned follow-up.' },
] as const;

export type IncidentDialogAction = 'silence' | 'resolve';

export function IncidentActionDialog({
  action,
  incident,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  action: IncidentDialogAction | null;
  incident: WorkspaceIncident | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (value: { until?: Date; note?: string | null }) => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [hours, setHours] = useState('1');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!action) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const frame = window.requestAnimationFrame(() => cancelRef.current?.focus());
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !busy) onCancel();
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const controls = dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled)',
      );
      const first = controls.item(0);
      const last = controls.item(controls.length - 1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus();
    };
  }, [action, busy, onCancel]);

  if (!action || !incident) return null;
  const resolving = action === 'resolve';
  return createPortal(
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4"
      onMouseDown={() => {
        if (!busy) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="w-full max-w-lg overflow-hidden rounded-rail-panel border border-rail-border-strong bg-rail-overlay shadow-[0_24px_72px_var(--color-rail-shadow)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="border-b border-rail-border px-5 py-4">
          <h2 id={titleId} className="m-0 text-base font-semibold text-rail-text">
            {resolving ? `Resolve ${incident.monitorName} incident?` : 'Silence this incident'}
          </h2>
          <p id={descriptionId} className="mt-2 mb-0 text-sm leading-6 text-rail-subtle">
            {resolving
              ? 'This closes the current incident without marking the monitor healthy. A later confirmed failure can open a new incident.'
              : 'Checks and incident tracking continue. Only notifications for this incident are paused.'}
          </p>
        </div>
        <div className="px-5 py-4">
          {resolving ? (
            <label className="block text-sm font-medium text-rail-text">
              Resolution note <span className="font-normal text-rail-muted">(optional)</span>
              <textarea
                value={note}
                maxLength={500}
                rows={4}
                className="mt-2 block w-full resize-y rounded-rail-control border border-rail-border-strong bg-rail-input px-3 py-2 text-sm leading-6 text-rail-text outline-none placeholder:text-rail-muted focus:border-rail-accent focus:ring-1 focus:ring-rail-accent"
                placeholder="Record why this incident is being closed."
                onChange={(event) => setNote(event.target.value)}
              />
              <span className="mt-1 block text-xs font-normal text-rail-muted">
                {note.length}/500 characters
              </span>
            </label>
          ) : (
            <fieldset className="m-0 border-0 p-0">
              <legend className="mb-3 text-sm font-medium text-rail-text">Silence duration</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {silenceOptions.map((option) => (
                  <label
                    key={option.value}
                    className="flex min-h-20 cursor-pointer items-start gap-3 rounded-rail-control border border-rail-border bg-rail-input px-4 py-3 has-[:checked]:border-rail-selected-border has-[:checked]:bg-rail-selected"
                  >
                    <input
                      type="radio"
                      name="silence-duration"
                      value={option.value}
                      checked={hours === option.value}
                      className="mt-0.5 size-4 accent-rail-accent"
                      onChange={() => setHours(option.value)}
                    />
                    <span>
                      <span className="block text-sm font-medium text-rail-text">
                        {option.label}
                      </span>
                      <span className="mt-1 block text-xs leading-5 text-rail-muted">
                        {option.description}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {error ? (
            <p className="mt-3 mb-0 text-sm text-rail-danger" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-rail-border px-5 py-4">
          <Button ref={cancelRef} variant="quiet" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant={resolving ? 'danger' : 'primary'}
            disabled={busy}
            onClick={() =>
              onConfirm(
                resolving
                  ? { note: note.trim() || null }
                  : { until: new Date(Date.now() + Number(hours) * 60 * 60 * 1_000) },
              )
            }
          >
            {busy
              ? resolving
                ? 'Resolving…'
                : 'Silencing…'
              : resolving
                ? 'Resolve incident'
                : 'Silence incident'}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
