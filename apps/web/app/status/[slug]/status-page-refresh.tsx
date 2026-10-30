'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

export const STATUS_PAGE_REFRESH_INTERVAL_MS = 30_000;

export function StatusPageRefresh() {
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(() => {
    setRefreshing(true);
    router.refresh();
    window.setTimeout(() => setRefreshing(false), 500);
  }, [router]);

  useEffect(() => {
    let interval: number | undefined;
    const stop = () => {
      if (interval !== undefined) window.clearInterval(interval);
      interval = undefined;
    };
    const start = () => {
      if (interval === undefined && !document.hidden)
        interval = window.setInterval(refresh, STATUS_PAGE_REFRESH_INTERVAL_MS);
    };
    const visibilityChanged = () => {
      if (document.hidden) stop();
      else {
        refresh();
        start();
      }
    };
    start();
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [refresh]);

  return (
    <button
      className="fixed right-4 bottom-4 z-20 inline-flex min-h-10 items-center rounded-rail-control border border-rail-border-strong bg-rail-overlay px-3 text-xs font-medium text-rail-subtle transition-colors hover:bg-rail-hover hover:text-rail-text disabled:cursor-wait disabled:opacity-60 sm:right-6 sm:bottom-6"
      type="button"
      onClick={refresh}
      disabled={refreshing}
      aria-live="polite"
    >
      {refreshing ? 'Refreshing…' : 'Refresh status'}
    </button>
  );
}
