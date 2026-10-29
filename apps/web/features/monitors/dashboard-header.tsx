import Link from 'next/link';
import type { ReactNode } from 'react';
import { actionClassName } from '../../components/ui/button';
import { PageHeader } from '../../components/ui/page-header';

const copy = {
  overview: {
    title: 'Monitoring overview',
    description: 'Review workspace health and the services that need attention.',
  },
  monitors: {
    title: 'Monitors',
    description: 'Search and manage every endpoint in this workspace.',
  },
  create: {
    title: 'Create monitor',
    description: 'Add an HTTP endpoint and define its initial availability policy.',
  },
} as const;

export function DashboardHeader({
  view = 'overview',
  actions,
}: {
  view?: keyof typeof copy;
  actions?: ReactNode;
}) {
  const content = copy[view];
  const defaultActions =
    view !== 'create' ? (
      <Link
        href="/monitors/new"
        className={actionClassName({ variant: 'primary', className: 'px-5' })}
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          className="size-4"
          aria-hidden="true"
        >
          <path d="M8 3v10M3 8h10" />
        </svg>
        Add monitor
      </Link>
    ) : null;
  return (
    <PageHeader
      title={content.title}
      description={content.description}
      backLink={view === 'create' ? { href: '/monitors', label: 'Back to monitors' } : undefined}
      actions={actions ?? defaultActions}
    />
  );
}
