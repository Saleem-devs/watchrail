'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { createMonitorTypePath, MONITOR_TYPES } from './monitor-types';

function MonitorTypeIcon({ type }: { type: (typeof MONITOR_TYPES)[number]['type'] }) {
  const path =
    type === 'HTTP' ? (
      <>
        <circle cx="10" cy="10" r="7" />
        <path d="M3 10h14M10 3c2 2 3 4.3 3 7s-1 5-3 7c-2-2-3-4.3-3-7s1-5 3-7Z" />
      </>
    ) : type === 'TCP' ? (
      <>
        <path d="M6.5 7V3M13.5 7V3M5 7h10v2a5 5 0 0 1-5 5 5 5 0 0 1-5-5V7ZM10 14v3" />
      </>
    ) : type === 'DNS' ? (
      <>
        <rect x="3" y="3.5" width="14" height="5" rx="1.5" />
        <rect x="3" y="11.5" width="14" height="5" rx="1.5" />
        <path d="M6 6h.01M6 14h.01M9 6h5M9 14h5" />
      </>
    ) : type === 'API_WORKFLOW' ? (
      <>
        <circle cx="5" cy="5" r="2" />
        <circle cx="15" cy="10" r="2" />
        <circle cx="5" cy="15" r="2" />
        <path d="M7 5h2a3 3 0 0 1 3 3v.5M7 15h2a3 3 0 0 0 3-3v-.5" />
      </>
    ) : (
      <path d="M2.5 10h3l2-4 3.2 8 2.2-5 1.4 3h3.2" />
    );

  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4"
      aria-hidden="true"
    >
      {path}
    </svg>
  );
}

export function CreateMonitorMenu({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={wrapperRef} className="relative inline-flex">
      <button
        ref={triggerRef}
        type="button"
        className="inline-flex min-h-9 cursor-pointer items-center rounded-rail-control border-0 bg-rail-accent p-0 pl-4 text-sm font-medium text-rail-on-accent transition-colors hover:bg-rail-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rail-accent"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((current) => !current)}
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          className="size-4"
          aria-hidden="true"
        >
          <path d="M8 3v10M3 8h10" />
        </svg>
        <span className="ml-2">Add monitor</span>
        <span className="ml-3 grid min-h-9 w-9 place-items-center border-l border-rail-on-accent/20">
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`size-4 transition-transform ${open ? 'rotate-180' : ''}`}
            aria-hidden="true"
          >
            <path d="m4 6 4 4 4-4" />
          </svg>
        </span>
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label="Create monitor"
          className="absolute top-[calc(100%+0.5rem)] right-0 z-40 w-56 overflow-hidden rounded-rail-panel border border-rail-border bg-rail-overlay p-1.5 shadow-[0_18px_50px_var(--color-rail-shadow)]"
        >
          {MONITOR_TYPES.map((definition) => (
            <Link
              key={definition.type}
              role="menuitem"
              href={createMonitorTypePath(projectId, definition.type)}
              className="group flex min-h-10 items-center gap-3 rounded-rail-control px-3 py-2 text-left no-underline transition-colors hover:bg-rail-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-rail-accent"
              onClick={() => setOpen(false)}
            >
              <span className="grid size-7 shrink-0 place-items-center rounded-rail-control border border-rail-border bg-rail-surface text-rail-muted transition-colors group-hover:border-rail-border-strong group-hover:text-rail-text">
                <MonitorTypeIcon type={definition.type} />
              </span>
              <span className="text-sm font-medium text-rail-text">{definition.singular}</span>
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}
