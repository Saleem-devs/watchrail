'use client';

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { Button } from '../../components/ui/button';
import { Select } from '../../components/ui/form-control';
import { Form } from '../../components/ui/form';
import type { IncidentStatusFilter } from './types';

export function IncidentFiltersDialog({
  status,
  onApply,
}: {
  status: IncidentStatusFilter;
  onApply: (status: IncidentStatusFilter) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(status);
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const trigger = triggerRef.current;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', close);
    window.requestAnimationFrame(() =>
      dialogRef.current?.querySelector<HTMLElement>('select')?.focus(),
    );
    return () => {
      document.removeEventListener('keydown', close);
      (previous ?? trigger)?.focus();
    };
  }, [open]);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onApply(draft);
    setOpen(false);
  }
  function trapFocus(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Tab') return;
    const controls = dialogRef.current?.querySelectorAll<HTMLElement>('button, select');
    if (!controls?.length) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }
  return (
    <>
      <Button
        ref={triggerRef}
        variant="secondary"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setDraft(status);
          setOpen(true);
        }}
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          className="size-4"
          aria-hidden="true"
        >
          <path d="M2.5 4h11M4.5 8h7M6.5 12h3" />
        </svg>
        Filter
        {status !== 'all' ? (
          <span className="size-1.5 rounded-full bg-rail-accent" aria-hidden="true" />
        ) : null}
      </Button>
      {open ? (
        <div
          className="fixed inset-0 z-[90] flex items-start justify-center bg-black/60 px-4 pt-[14vh]"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="incident-filter-title"
            className="w-full max-w-sm overflow-hidden rounded-rail-panel border border-rail-border bg-rail-overlay shadow-[0_24px_80px_var(--color-rail-shadow)]"
            onKeyDown={trapFocus}
          >
            <div className="border-b border-rail-border px-5 py-4">
              <h2 id="incident-filter-title" className="m-0 text-sm font-medium text-rail-text">
                Filter incidents
              </h2>
              <p className="mt-1 mb-0 text-xs text-rail-muted">
                Choose which incident state is shown.
              </p>
            </div>
            <Form onSubmit={submit}>
              <div className="p-5">
                <label className="grid gap-1.5 text-xs text-rail-subtle">
                  State
                  <Select
                    value={draft}
                    controlSize="compact"
                    onChange={(event) => setDraft(event.target.value as IncidentStatusFilter)}
                  >
                    <option value="all">All incidents</option>
                    <option value="open">Open</option>
                    <option value="resolved">Resolved</option>
                  </Select>
                </label>
              </div>
              <div className="flex justify-end gap-2 border-t border-rail-border px-5 py-4">
                <Button variant="secondary" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary">
                  Apply filter
                </Button>
              </div>
            </Form>
          </div>
        </div>
      ) : null}
    </>
  );
}
