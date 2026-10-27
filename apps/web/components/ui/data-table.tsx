'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  useEffect,
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
              <th className="px-4 py-2.5 text-right font-medium" scope="col">
                Actions
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
                  <td className="px-4 py-2 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {actions.map((action) => {
                        const actionKey = `${rowKey}:${action.id}`;
                        const className = `inline-flex min-h-8 items-center rounded-rail-control border-0 bg-transparent px-2.5 text-xs font-medium no-underline hover:bg-rail-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-rail-accent disabled:cursor-wait disabled:opacity-60 ${
                          action.tone === 'danger'
                            ? 'text-rail-danger'
                            : 'text-rail-subtle hover:text-rail-text'
                        }`;
                        const href = action.href?.(row);
                        return href ? (
                          <Link
                            key={action.id}
                            href={href}
                            className={className}
                            aria-label={`${action.label} ${rowLabel}`}
                          >
                            {action.label}
                          </Link>
                        ) : (
                          <button
                            key={action.id}
                            type="button"
                            className={className}
                            disabled={pendingAction === actionKey}
                            aria-label={`${action.label} ${rowLabel}`}
                            onClick={() => void runAction(action, row)}
                          >
                            {pendingAction === actionKey
                              ? (action.pendingLabel ?? `${action.label}…`)
                              : action.label}
                          </button>
                        );
                      })}
                    </div>
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

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('a, button, input, select, textarea'));
}
