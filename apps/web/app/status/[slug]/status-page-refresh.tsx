'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import styles from './status-page.module.css';

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
    <button className={styles.refresh} type="button" onClick={refresh} disabled={refreshing}>
      {refreshing ? 'Refreshing…' : 'Refresh status'}
    </button>
  );
}
