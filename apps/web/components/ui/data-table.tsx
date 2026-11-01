'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createPortal } from 'react-dom';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';

export type DataTableColumn<Row> = {
  id: string;
  header: ReactNode;
  cell: (row: Row) => ReactNode;
  className?: string;
  headerClassName?: string;
};

export type DataTableAction<Row> = {
  id: string;
  label: string;
  href?: (row: Row) => string;
  onSelect?: (row: Row) => void | Promise<void>;
  tone?: 'neutral' | 'danger';
  pendingLabel?: string;
};

export function DataTable<Row>({
  rows,
  columns,
  actions = [],
  getRowKey,
  getRowHref,
  getRowLabel,
  ariaLabel,
  minWidthClassName = 'min-w-[900px]',
}: {
  rows: Row[];
  columns: Array<DataTableColumn<Row>>;
  actions?: Array<DataTableAction<Row>>;
  getRowKey: (row: Row) => string;
  getRowHref?: (row: Row) => string;
  getRowLabel: (row: Row) => string;
  ariaLabel: string;
  minWidthClassName?: string;
}) {
  const router = useRouter();
  const navigationTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [highlightedRowKey, setHighlightedRowKey] = useState<string>();
  const [pendingAction, setPendingAction] = useState<string>();
  const [openActionRowKey, setOpenActionRowKey] = useState<string>();
  const closeActionMenu = useCallback(() => setOpenActionRowKey(undefined), []);

  useEffect(
    () => () => {
      if (navigationTimer.current) clearTimeout(navigationTimer.current);
    },
    [],
  );

  function clearPendingNavigation(): void {
    if (!navigationTimer.current) return;
    clearTimeout(navigationTimer.current);
    navigationTimer.current = undefined;
  }

  function highlight(row: Row): void {
    clearPendingNavigation();
    setHighlightedRowKey(getRowKey(row));
  }

  function handleRowClick(event: MouseEvent<HTMLTableRowElement>, row: Row): void {
    if (!getRowHref || isInteractiveTarget(event.target)) return;
    if (event.detail > 1) {
      highlight(row);
      return;
    }
    clearPendingNavigation();
    navigationTimer.current = setTimeout(() => router.push(getRowHref(row)), 220);
  }

  function handleRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, row: Row): void {
    if (!getRowHref || isInteractiveTarget(event.target)) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      clearPendingNavigation();
      router.push(getRowHref(row));
    }
    if (event.key === ' ') {
      event.preventDefault();
      highlight(row);
    }
  }

  async function runAction(action: DataTableAction<Row>, row: Row): Promise<void> {
    if (!action.onSelect) return;
    const actionKey = `${getRowKey(row)}:${action.id}`;
    setPendingAction(actionKey);
    try {
      await action.onSelect(row);
    } finally {
      setPendingAction(undefined);
    }
  }

  return (
    <div className="overflow-x-auto">
      <table
        className={`w-full border-collapse text-left text-sm ${minWidthClassName}`}
        aria-label={ariaLabel}
      >
        <thead className="bg-rail-sidebar/45 text-xs text-rail-muted">
          <tr>
            {columns.map((column) => (
              <th
                key={column.id}
                className={`px-4 py-2.5 font-medium ${column.headerClassName ?? ''}`}
                scope="col"
              >
                {column.header}
              </th>
            ))}
            {actions.length > 0 ? (
              <th className="w-12 px-3 py-2.5 text-right font-medium" scope="col">
                <span className="sr-only">Actions</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody className="divide-y divide-rail-border">
          {rows.map((row) => {
            const rowKey = getRowKey(row);
            const highlighted = highlightedRowKey === rowKey;
            const rowLabel = getRowLabel(row);
            return (
              <tr
                key={rowKey}
                tabIndex={getRowHref ? 0 : undefined}
                data-highlighted={highlighted ? 'true' : undefined}
                aria-label={
                  getRowHref ? `Open ${rowLabel}${highlighted ? ', highlighted' : ''}` : undefined
                }
                className={`outline-none transition-colors focus-visible:bg-rail-hover focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-rail-accent ${
                  getRowHref ? 'cursor-pointer' : ''
                } ${highlighted ? 'bg-rail-accent/8' : 'hover:bg-rail-hover/50'}`}
                onClick={(event) => handleRowClick(event, row)}
                onDoubleClick={() => highlight(row)}
                onKeyDown={(event) => handleRowKeyDown(event, row)}
              >
                {columns.map((column) => (
                  <td key={column.id} className={`px-4 py-3 ${column.className ?? ''}`}>
                    {column.cell(row)}
                  </td>
                ))}
                {actions.length > 0 ? (
                  <td className="w-12 px-3 py-2 text-right">
                    <ActionMenu
                      row={row}
                      rowKey={rowKey}
                      rowLabel={rowLabel}
                      actions={actions}
                      open={openActionRowKey === rowKey}
                      pendingAction={pendingAction}
                      onToggle={() =>
                        setOpenActionRowKey((current) => (current === rowKey ? undefined : rowKey))
                      }
                      onClose={closeActionMenu}
                      onRunAction={runAction}
                    />
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ActionMenu<Row>({
  row,
  rowKey,
  rowLabel,
  actions,
  open,
  pendingAction,
  onToggle,
  onClose,
  onRunAction,
}: {
  row: Row;
  rowKey: string;
  rowLabel: string;
  actions: Array<DataTableAction<Row>>;
  open: boolean;
  pendingAction?: string | undefined;
  onToggle: () => void;
  onClose: () => void;
  onRunAction: (action: DataTableAction<Row>, row: Row) => Promise<void>;
}) {
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const menuWidth = 152;
    setPosition({
      top: rect.bottom + 6,
      left: Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8)),
    });

    const focusFrame = window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLElement>('a, button')?.focus();
    });
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !trigger.contains(target)) onClose();
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        trigger.focus();
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const items = [
        ...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
      ];
      if (items.length === 0) return;
      event.preventDefault();
      const currentIndex = items.indexOf(document.activeElement as HTMLElement);
      const nextIndex =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : event.key === 'ArrowDown'
              ? (currentIndex + 1) % items.length
              : (currentIndex - 1 + items.length) % items.length;
      items[nextIndex]?.focus();
    };
    const handleViewportChange = () => onClose();
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [open, onClose]);

  const menu = open ? (
    <div
      ref={menuRef}
      id={menuId}
      role="menu"
      aria-label={`Actions for ${rowLabel}`}
      className="fixed z-50 min-w-38 overflow-hidden rounded-rail-control border border-rail-border bg-rail-header p-1 shadow-lg"
      style={position}
    >
      {actions.map((action) => {
        const actionKey = `${rowKey}:${action.id}`;
        const className = `flex min-h-9 w-full items-center rounded-rail-control px-3 text-left text-sm font-medium no-underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-rail-accent ${
          action.tone === 'danger'
            ? 'text-rail-danger hover:bg-rail-danger/10'
            : 'text-rail-subtle hover:bg-rail-hover hover:text-rail-text'
        }`;
        const href = action.href?.(row);
        return href ? (
          <Link key={action.id} href={href} role="menuitem" className={className} onClick={onClose}>
            {action.label}
          </Link>
        ) : (
          <button
            key={action.id}
            type="button"
            role="menuitem"
            className={`${className} border-0 bg-transparent`}
            disabled={pendingAction === actionKey}
            onClick={() => void onRunAction(action, row).finally(onClose)}
          >
            {pendingAction === actionKey
              ? (action.pendingLabel ?? `${action.label}…`)
              : action.label}
          </button>
        );
      })}
    </div>
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Actions for ${rowLabel}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        className="inline-flex size-8 items-center justify-center rounded-rail-control border-0 bg-transparent text-rail-muted hover:bg-rail-hover hover:text-rail-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-rail-accent"
        onClick={onToggle}
      >
        <svg aria-hidden="true" viewBox="0 0 20 20" className="size-4" fill="currentColor">
          <circle cx="10" cy="4" r="1.5" />
          <circle cx="10" cy="10" r="1.5" />
          <circle cx="10" cy="16" r="1.5" />
        </svg>
      </button>
      {menu ? createPortal(menu, document.body) : null}
    </>
  );
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('a, button, input, select, textarea'));
}
