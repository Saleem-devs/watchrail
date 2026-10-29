'use client';

import { Button } from './button';

export interface PaginationState {
  number: number;
  limit: number;
  total: number;
  totalPages: number;
}

export function TablePagination({
  page,
  onPageChange,
  onLimitChange,
  label = 'items',
}: {
  page: PaginationState;
  onPageChange: (page: number) => void;
  onLimitChange: (limit: number) => void;
  label?: string;
}) {
  const first = page.total === 0 ? 0 : (page.number - 1) * page.limit + 1;
  const last = Math.min(page.number * page.limit, page.total);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-rail-border px-4 py-3 text-xs text-rail-muted">
      <p className="m-0 tabular-nums" aria-live="polite">
        {first}–{last} of {page.total} {label}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2">
          Rows per page
          <select
            value={page.limit}
            className="min-h-8 rounded-rail-control border border-rail-border bg-rail-input px-2 text-xs text-rail-text"
            onChange={(event) => onLimitChange(Number(event.target.value))}
          >
            {[10, 25, 50, 100].map((limit) => (
              <option key={limit} value={limit}>
                {limit}
              </option>
            ))}
          </select>
        </label>
        <span className="min-w-20 text-center tabular-nums">
          Page {page.number} of {page.totalPages}
        </span>
        <div className="flex items-center gap-1">
          <Button
            size="compact"
            variant="quiet"
            disabled={page.number <= 1}
            aria-label="Previous page"
            onClick={() => onPageChange(page.number - 1)}
          >
            Previous
          </Button>
          <Button
            size="compact"
            variant="quiet"
            disabled={page.number >= page.totalPages}
            aria-label="Next page"
            onClick={() => onPageChange(page.number + 1)}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
