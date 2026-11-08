'use client';

import { Fragment, useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import type { DnsRecordHistoryPage } from './types';

export function DnsRecordHistory({ monitorId }: { monitorId: string }) {
  const [page, setPage] = useState<DnsRecordHistoryPage>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>();
  const [expandedChanges, setExpandedChanges] = useState<Set<string>>(() => new Set());

  const toggleChange = (changeId: string) => {
    setExpandedChanges((current) => {
      const next = new Set(current);
      if (next.has(changeId)) next.delete(changeId);
      else next.add(changeId);
      return next;
    });
  };

  useEffect(() => {
    let active = true;
    void fetchDnsRecordHistory(monitorId)
      .then((next) => {
        if (active) setPage(next);
      })
      .catch(() => {
        if (active) setError('DNS record history is temporarily unavailable.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [monitorId]);

  if (loading && !page) return <DnsHistorySkeleton />;
  if (error && !page) {
    return (
      <div className="flex min-h-28 flex-col items-start justify-center gap-3" role="alert">
        <p className="m-0 text-sm text-rail-danger">{error}</p>
        <Button
          variant="quiet"
          size="compact"
          onClick={() => {
            setLoading(true);
            setError(undefined);
            void fetchDnsRecordHistory(monitorId)
              .then(setPage)
              .catch(() => setError('DNS record history is temporarily unavailable.'))
              .finally(() => setLoading(false));
          }}
        >
          Try again
        </Button>
      </div>
    );
  }
  if (!page) return null;

  return (
    <div aria-live="polite">
      {page.current ? (
        <dl className="m-0 grid gap-px overflow-hidden rounded-rail-control border border-rail-border bg-rail-border md:grid-cols-[13rem_minmax(0,1fr)_12rem]">
          <CurrentMetric
            label="Record"
            value={`${page.current.recordType} ${page.current.dnsName}`}
          />
          <div className="min-w-0 bg-rail-raised px-4 py-3">
            <dt className="text-xs text-rail-muted">Current confirmed answers</dt>
            <dd className="mt-2 mb-0 flex min-w-0 flex-wrap gap-2">
              <AnswerList answers={page.current.answers} />
            </dd>
          </div>
          <CurrentMetric
            label="Confirmed"
            value={formatDateTime(page.current.observedAt)}
            subline={`${page.current.locationEvidence.length} ${page.current.locationEvidence.length === 1 ? 'location' : 'locations'}`}
          />
        </dl>
      ) : (
        <div className="rounded-rail-control border border-dashed border-rail-border px-4 py-5">
          <p className="m-0 text-sm font-medium text-rail-text">Waiting for a DNS baseline</p>
          <p className="mt-1 mb-0 text-xs text-rail-muted">
            The first completed scheduled DNS check will establish the confirmed record set.
          </p>
        </div>
      )}

      {page.candidate ? (
        <div className="mt-3 rounded-rail-control border border-rail-warning/40 bg-rail-warning/5 px-4 py-3">
          <p className="m-0 text-xs font-medium text-rail-text">
            Possible change awaiting confirmation
          </p>
          <p className="mt-1 mb-0 text-xs text-rail-muted">
            First observed {formatDateTime(page.candidate.firstObservedAt)}. A matching scheduled
            check is required before this appears in history.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <AnswerList answers={page.candidate.answers} />
          </div>
        </div>
      ) : null}

      <div className="mt-6 border-t border-rail-border pt-5">
        <div className="mb-3">
          <h3 className="m-0 text-sm font-semibold text-rail-text">Confirmed changes</h3>
          <p className="mt-1 mb-0 text-xs text-rail-muted">
            Before-and-after snapshots retained from authoritative scheduled checks.
          </p>
        </div>
        {page.items.length === 0 ? (
          <div className="rounded-rail-control border border-dashed border-rail-border px-4 py-5">
            <p className="m-0 text-sm text-rail-text">No confirmed DNS changes yet.</p>
            <p className="mt-1 mb-0 text-xs text-rail-muted">
              A change is recorded only after the new answer set is observed twice in succession.
            </p>
          </div>
        ) : (
          <>
            <div className="hidden overflow-hidden rounded-rail-control border border-rail-border md:block">
              <table className="w-full table-fixed border-collapse text-left text-xs">
                <thead className="text-rail-muted">
                  <tr className="border-b border-rail-border">
                    <th className="w-44 px-4 py-3 font-medium">Confirmed</th>
                    <th className="px-4 py-3 font-medium">Before</th>
                    <th className="px-4 py-3 font-medium">After</th>
                    <th className="w-28 px-4 py-3 text-right font-medium">Evidence</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-rail-border">
                  {page.items.map((item) => {
                    const expanded = expandedChanges.has(item.id);
                    return (
                      <Fragment key={item.id}>
                        <tr>
                          <td className="px-4 py-4 align-top text-rail-muted">
                            <time dateTime={item.confirmedAt} className="block text-rail-text">
                              {formatDateTime(item.confirmedAt)}
                            </time>
                            <span className="mt-1 block">
                              {item.recordType} {item.dnsName}
                            </span>
                            <span className="mt-1 block">
                              Detected {formatDateTime(item.detectedAt)}
                            </span>
                          </td>
                          <td className="px-4 py-4 align-top">
                            <AnswerList answers={item.beforeAnswers} />
                          </td>
                          <td className="px-4 py-4 align-top">
                            <AnswerList answers={item.afterAnswers} />
                          </td>
                          <td className="px-4 py-4 text-right align-top text-rail-muted">
                            <button
                              type="button"
                              className="min-h-8 whitespace-nowrap text-xs font-medium text-rail-text underline decoration-rail-border underline-offset-4 hover:decoration-rail-text"
                              aria-expanded={expanded}
                              aria-controls={`dns-change-locations-${item.id}`}
                              onClick={() => toggleChange(item.id)}
                            >
                              {expanded ? 'Hide' : 'View'} {item.afterLocationEvidence.length}{' '}
                              {item.afterLocationEvidence.length === 1 ? 'location' : 'locations'}
                            </button>
                          </td>
                        </tr>
                        {expanded ? (
                          <tr id={`dns-change-locations-${item.id}`}>
                            <td colSpan={4} className="bg-rail-surface px-4 py-4">
                              <LocationEvidenceComparison
                                before={item.beforeLocationEvidence}
                                after={item.afterLocationEvidence}
                              />
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="grid gap-3 md:hidden">
              {page.items.map((item) => (
                <article
                  key={item.id}
                  className="rounded-rail-control border border-rail-border px-4 py-4"
                >
                  <time dateTime={item.confirmedAt} className="text-xs font-medium text-rail-text">
                    Confirmed {formatDateTime(item.confirmedAt)}
                  </time>
                  <p className="mt-1 mb-0 text-xs text-rail-muted">
                    {item.recordType} {item.dnsName}
                  </p>
                  <dl className="mt-4 grid gap-4">
                    <ChangeAnswers label="Before" answers={item.beforeAnswers} />
                    <ChangeAnswers label="After" answers={item.afterAnswers} />
                  </dl>
                  <div className="mt-4 border-t border-rail-border pt-3">
                    <button
                      type="button"
                      className="min-h-8 text-xs font-medium text-rail-text underline decoration-rail-border underline-offset-4"
                      aria-expanded={expandedChanges.has(item.id)}
                      aria-controls={`dns-change-mobile-locations-${item.id}`}
                      onClick={() => toggleChange(item.id)}
                    >
                      {expandedChanges.has(item.id) ? 'Hide' : 'View'} per-location evidence
                    </button>
                    {expandedChanges.has(item.id) ? (
                      <div id={`dns-change-mobile-locations-${item.id}`} className="mt-3">
                        <LocationEvidenceComparison
                          before={item.beforeLocationEvidence}
                          after={item.afterLocationEvidence}
                        />
                      </div>
                    ) : null}
                    <p className="mt-2 mb-0 text-xs text-rail-muted">
                      Detected {formatDateTime(item.detectedAt)}
                    </p>
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
        {page.nextCursor ? (
          <div className="mt-4 flex justify-center">
            <Button
              variant="quiet"
              size="compact"
              disabled={loadingMore}
              onClick={() => {
                setLoadingMore(true);
                setError(undefined);
                void fetchDnsRecordHistory(monitorId, page.nextCursor ?? undefined)
                  .then((next) =>
                    setPage((current) =>
                      current ? { ...next, items: [...current.items, ...next.items] } : next,
                    ),
                  )
                  .catch(() => setError('Older DNS changes could not be loaded.'))
                  .finally(() => setLoadingMore(false));
              }}
            >
              {loadingMore ? 'Loading…' : 'Load older changes'}
            </Button>
          </div>
        ) : null}
        {error ? <p className="mt-3 mb-0 text-center text-xs text-rail-danger">{error}</p> : null}
      </div>
    </div>
  );
}

function LocationEvidenceComparison({
  before,
  after,
}: {
  before: Array<{ location: string; answers: string[] }>;
  after: Array<{ location: string; answers: string[] }>;
}) {
  const locations = [...new Set([...before, ...after].map((item) => item.location))].sort();
  const beforeByLocation = new Map(before.map((item) => [item.location, item.answers]));
  const afterByLocation = new Map(after.map((item) => [item.location, item.answers]));
  return (
    <div className="grid gap-4" aria-label="Per-location DNS evidence">
      {locations.map((location) => (
        <div
          key={location}
          className="grid gap-3 border-b border-rail-border pb-4 last:border-b-0 last:pb-0 sm:grid-cols-[minmax(8rem,0.35fr)_1fr_1fr]"
        >
          <p className="m-0 text-xs font-medium text-rail-text">{formatLocation(location)}</p>
          <div>
            <p className="m-0 text-xs text-rail-muted">Before</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <AnswerList answers={beforeByLocation.get(location) ?? []} />
            </div>
          </div>
          <div>
            <p className="m-0 text-xs text-rail-muted">After</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <AnswerList answers={afterByLocation.get(location) ?? []} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function formatLocation(location: string): string {
  if (location === 'local') return 'Local runner';
  return `Probe ${location.slice(0, 8)}`;
}

function CurrentMetric({
  label,
  value,
  subline,
}: {
  label: string;
  value: string;
  subline?: string;
}) {
  return (
    <div className="min-w-0 bg-rail-raised px-4 py-3">
      <dt className="text-xs text-rail-muted">{label}</dt>
      <dd className="mt-1 mb-0 truncate text-sm font-medium text-rail-text" title={value}>
        {value}
      </dd>
      {subline ? <span className="mt-1 block text-xs text-rail-muted">{subline}</span> : null}
    </div>
  );
}

function ChangeAnswers({ label, answers }: { label: string; answers: string[] }) {
  return (
    <div>
      <dt className="text-xs text-rail-muted">{label}</dt>
      <dd className="mt-2 mb-0 flex flex-wrap gap-2">
        <AnswerList answers={answers} />
      </dd>
    </div>
  );
}

function AnswerList({ answers }: { answers: string[] }) {
  if (answers.length === 0) return <span className="text-xs text-rail-muted">No records</span>;
  return answers.map((answer) => (
    <code
      key={answer}
      className="inline-block min-w-0 max-w-full wrap-anywhere rounded-rail-control border border-rail-border bg-rail-surface px-2 py-1 text-xs whitespace-normal text-rail-text"
    >
      {answer}
    </code>
  ));
}

function DnsHistorySkeleton() {
  return (
    <div
      className="animate-pulse motion-reduce:animate-none"
      role="status"
      aria-label="Loading DNS record history"
    >
      <div className="h-20 rounded-rail-control bg-rail-surface" />
      <div className="mt-6 h-32 rounded-rail-control bg-rail-surface" />
    </div>
  );
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

async function fetchDnsRecordHistory(
  monitorId: string,
  cursor?: string,
): Promise<DnsRecordHistoryPage> {
  const response = await fetch(
    `/api/monitors/${monitorId}/dns-record-history?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    { headers: { Accept: 'application/json' } },
  );
  if (!response.ok) throw new Error('Could not load DNS record history.');
  const body = (await response.json()) as {
    data?: Omit<DnsRecordHistoryPage, 'nextCursor'>;
    page?: { nextCursor?: string | null };
  };
  if (!body.data) throw new Error('The API returned no DNS record history.');
  return { ...body.data, nextCursor: body.page?.nextCursor ?? null };
}
