import styles from './status-page.module.css';

export default function StatusPageNotFound() {
  return (
    <main className={styles.message}>
      <p className={styles.eyebrow}>Watchrail</p>
      <h1>Status page not found</h1>
      <p>The status page you&apos;re looking for isn&apos;t available.</p>
    </main>
  );
}
