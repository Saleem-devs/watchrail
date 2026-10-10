import type {
  PublicStatusPageIncidentV1,
  PublicStatusPageProjectionV1,
  PublicStatusState,
} from '@watchrail/domain';
import styles from './status-page.module.css';

const labels: Record<PublicStatusState, string> = {
  OPERATIONAL: 'Operational',
  PARTIAL_OUTAGE: 'Partial outage',
  MAJOR_OUTAGE: 'Major outage',
  MONITORING_IMPAIRED: 'Monitoring impaired',
};

export function publicStatusLabel(status: PublicStatusState): string {
  return status === 'OPERATIONAL' ? 'All systems operational' : labels[status];
}

export function StatusPageView({ page }: { page: PublicStatusPageProjectionV1 }) {
  const names = new Map(page.components.map((component) => [component.id, component.displayName]));
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <a className={styles.brand} href="/" aria-label="Watchrail home">
          <span className={styles.brandMark} aria-hidden="true">
            W
          </span>
          Watchrail
        </a>
        <p className={styles.serviceName}>{page.name}</p>
      </header>
      <section className={`${styles.banner} ${styles[stateClass(page.status)]}`} aria-live="polite">
        <span className={styles.statusDot} aria-hidden="true" />
        <div>
          <p className={styles.eyebrow}>Current status</p>
          <h1>{publicStatusLabel(page.status)}</h1>
        </div>
      </section>
      <section className={styles.section} aria-labelledby="components-heading">
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>Services</p>
            <h2 id="components-heading">Components</h2>
          </div>
          <span>{page.components.length}</span>
        </div>
        {page.components.length === 0 ? (
          <p className={styles.empty}>No public components are configured.</p>
        ) : (
          <ul className={styles.componentList}>
            {page.components.map((component) => (
              <li key={component.id}>
                <span>{component.displayName}</span>
                <strong className={styles[stateClass(component.status)]}>
                  <span className={styles.smallDot} aria-hidden="true" />
                  {labels[component.status]}
                </strong>
              </li>
            ))}
          </ul>
        )}
      </section>
      {page.activeIncidents.length > 0 && (
        <IncidentSection
          title="Active incidents"
          eyebrow="Ongoing"
          incidents={page.activeIncidents}
          names={names}
          active
        />
      )}
      <IncidentSection
        title="Incident history"
        eyebrow="Past 90 days"
        incidents={page.resolvedIncidents}
        names={names}
      />
      <footer className={styles.footer}>
        <span>Last updated</span>{' '}
        <time dateTime={page.generatedAt}>{formatUtc(page.generatedAt)}</time>
      </footer>
    </main>
  );
}

function IncidentSection({
  title,
  eyebrow,
  incidents,
  names,
  active = false,
}: {
  title: string;
  eyebrow: string;
  incidents: PublicStatusPageIncidentV1[];
  names: Map<string, string>;
  active?: boolean;
}) {
  const id = title.toLowerCase().replaceAll(' ', '-');
  return (
    <section className={styles.section} aria-labelledby={id}>
      <div className={styles.sectionHeading}>
        <div>
          <p className={styles.eyebrow}>{eyebrow}</p>
          <h2 id={id}>{title}</h2>
        </div>
      </div>
      {incidents.length === 0 ? (
        <p className={styles.empty}>No incidents reported.</p>
      ) : (
        <ol className={styles.incidentList}>
          {incidents.map((incident) => (
            <li key={incident.id}>
              <div>
                <h3>{names.get(incident.componentId) ?? 'Component'}</h3>
                <strong>{active ? 'Active incident' : 'Recovered'}</strong>
              </div>
              <p>
                {active && 'Started '}
                <time dateTime={incident.startedAt}>{formatUtc(incident.startedAt)}</time>
                {!active && incident.resolvedAt && (
                  <>
                    {' '}
                    — <time dateTime={incident.resolvedAt}>{formatUtc(incident.resolvedAt)}</time>
                  </>
                )}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function stateClass(status: PublicStatusState): 'operational' | 'partial' | 'major' | 'impaired' {
  if (status === 'OPERATIONAL') return 'operational';
  if (status === 'PARTIAL_OUTAGE') return 'partial';
  if (status === 'MAJOR_OUTAGE') return 'major';
  return 'impaired';
}

function formatUtc(value: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(new Date(value));
}
