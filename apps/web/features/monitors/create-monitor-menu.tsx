'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import {
  Activity,
  ChevronDown,
  Database,
  GitBranch,
  Globe,
  Plug,
  Plus,
  type LucideIcon,
} from 'lucide-react';
import { createMonitorTypePath, MONITOR_TYPES } from './monitor-types';

function MonitorTypeIcon({ type }: { type: (typeof MONITOR_TYPES)[number]['type'] }) {
  const icons: Record<(typeof MONITOR_TYPES)[number]['type'], LucideIcon> = {
    HTTP: Globe,
    TCP: Plug,
    DNS: Database,
    API_WORKFLOW: GitBranch,
    HEARTBEAT: Activity,
  };
  const Icon = icons[type];
  return <Icon className="size-4" strokeWidth={1.75} aria-hidden="true" />;
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
        <Plus className="size-4" strokeWidth={1.75} aria-hidden="true" />
        <span className="ml-2">Add monitor</span>
        <span className="ml-3 grid min-h-9 w-9 place-items-center border-l border-rail-on-accent/20">
          <ChevronDown
            className={`size-4 transition-transform ${open ? 'rotate-180' : ''}`}
            strokeWidth={1.75}
            aria-hidden="true"
          />
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
