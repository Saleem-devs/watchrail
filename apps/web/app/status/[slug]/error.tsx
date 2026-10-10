'use client';

import styles from './status-page.module.css';

export default function StatusPageError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className={styles.message}>
      <p className={styles.eyebrow}>Watchrail</p>
      <h1>Status temporarily unavailable</h1>
      <p>We couldn&apos;t load this status page. Please try again shortly.</p>
      <button type="button" onClick={reset}>
        Try again
      </button>
    </main>
  );
}
