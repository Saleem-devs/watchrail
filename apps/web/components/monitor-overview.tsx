import { summarizeMonitors, type MonitorSummaryInput } from '../lib/monitor-summary';
import styles from './monitor-overview.module.css';

export function MonitorOverview({ monitors }: { monitors: readonly MonitorSummaryInput[] }) {
  const summary = summarizeMonitors(monitors);
  const stats = [
    { label: 'Total monitors', value: summary.total, tone: 'neutral' },
    { label: 'Operational', value: summary.operational, tone: 'positive' },
    { label: 'Needs attention', value: summary.needsAttention, tone: 'negative' },
    { label: 'Awaiting evidence', value: summary.pending, tone: 'neutral' },
  ] as const;
  return (
    <section className={styles.overview} aria-label="Monitor overview">
      <div className={styles.heading}>
        <h2>At a glance</h2>
        <span>Based on the latest reported checks</span>
      </div>
      <div className={styles.stats}>
        {stats.map((stat) => (
          <div className={styles.stat} key={stat.label}>
            <div className={styles.statLabel}>
              <span
                className={styles.indicator}
                data-tone={stat.tone}
                aria-hidden="true"
              />
              <span>{stat.label}</span>
            </div>
            <strong>{stat.value}</strong>
          </div>
        ))}
      </div>
      {summary.openIncidents > 0 && (
        <p className={styles.incidentNotice} role="status">
          {summary.openIncidents} {summary.openIncidents === 1 ? 'monitor has' : 'monitors have'} an open incident.
        </p>
      )}
    </section>
  );
}
