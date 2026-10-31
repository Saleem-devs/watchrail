'use client';

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Button } from '../../components/ui/button';
import { Input, Select } from '../../components/ui/form-control';
import type { MonitorFilter, MonitorListFilters } from './filter-monitors';

export function MonitorFiltersDialog({
  filters,
  locations,
  onApply,
}: {
  filters: MonitorListFilters;
  locations: string[];
  onApply: (filters: MonitorListFilters) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(filters);
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const activeCount =
    Number(Boolean(filters.name)) +
    Number(filters.state !== 'all') +
    Number(Boolean(filters.location));

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const trigger = triggerRef.current;
    window.requestAnimationFrame(() =>
      dialogRef.current?.querySelector<HTMLElement>('input, select')?.focus(),
    );
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('keydown', handleEscape);
      (previous ?? trigger)?.focus();
    };
  }, [open]);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    onApply(draft);
    setOpen(false);
  }

  function trapFocus(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'Tab') return;
    const controls = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button, input, select, [href], [tabindex]:not([tabindex="-1"])',
    );
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
          setDraft(filters);
          setOpen(true);
        }}
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          aria-hidden="true"
          className="size-4"
        >
          <path d="M2.5 4h11M4.5 8h7M6.5 12h3" />
        </svg>
        Filter
        {activeCount > 0 ? (
          <span className="grid min-w-5 place-items-center rounded-full bg-rail-accent px-1 text-[10px] leading-5 text-rail-on-accent">
            {activeCount}
          </span>
        ) : null}
      </Button>
      {open ? (
        <div
          className="fixed inset-0 z-[90] flex items-start justify-center bg-black/60 px-4 pt-[14vh] backdrop-blur-sm"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="monitor-filters-title"
            tabIndex={-1}
            className="w-full max-w-md overflow-hidden rounded-rail-panel border border-rail-border bg-rail-overlay shadow-[0_24px_80px_var(--color-rail-shadow)] outline-none"
            onKeyDown={trapFocus}
          >
            <div className="flex items-start justify-between gap-4 border-b border-rail-border px-5 py-4">
              <div>
                <h2 id="monitor-filters-title" className="m-0 text-sm font-medium text-rail-text">
                  Filter monitors
                </h2>
                <p className="mt-1 mb-0 text-xs text-rail-muted">
                  Narrow the organization-scoped monitor inventory.
                </p>
              </div>
              <button
                type="button"
                aria-label="Close monitor filters"
                className="grid size-8 shrink-0 place-items-center rounded-rail-control border-0 bg-transparent text-rail-muted hover:bg-rail-hover hover:text-rail-text"
                onClick={() => setOpen(false)}
              >
                <svg
                  viewBox="0 0 20 20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  aria-hidden="true"
                  className="size-4"
                >
                  <path d="m5 5 10 10M15 5 5 15" />
                </svg>
              </button>
            </div>
            <form onSubmit={submit}>
              <div className="grid gap-4 p-5">
                <label className="grid gap-1.5 text-xs text-rail-subtle">
                  Monitor name
                  <Input
                    type="search"
                    value={draft.name}
                    placeholder="Search by name"
                    controlSize="compact"
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, name: event.target.value }))
                    }
                  />
                </label>
                <label className="grid gap-1.5 text-xs text-rail-subtle">
                  State
                  <Select
                    value={draft.state}
                    controlSize="compact"
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        state: event.target.value as MonitorFilter,
                      }))
                    }
                  >
                    <option value="all">All states</option>
                    <option value="operational">Operational</option>
                    <option value="attention">Needs attention</option>
                    <option value="paused">Paused</option>
                    <option value="pending">Awaiting evidence</option>
                  </Select>
                </label>
                <label className="grid gap-1.5 text-xs text-rail-subtle">
                  Location
                  <Select
                    value={draft.location}
                    controlSize="compact"
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, location: event.target.value }))
                    }
                  >
                    <option value="">All locations</option>
                    {locations.map((location) => (
                      <option key={location} value={location}>
                        {location}
                      </option>
                    ))}
                  </Select>
                </label>
              </div>
              <div className="flex items-center justify-between gap-3 border-t border-rail-border px-5 py-4">
                <Button
                  variant="quiet"
                  onClick={() => setDraft({ name: '', state: 'all', location: '' })}
                >
                  Clear
                </Button>
                <div className="flex items-center gap-2">
                  <Button variant="secondary" onClick={() => setOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" variant="primary">
                    Apply filters
                  </Button>
                </div>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
