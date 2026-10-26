import Link from 'next/link';
import { actionClassName } from '../../components/ui/button';

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

export function DashboardHeader({ view = 'overview' }: { view?: keyof typeof copy }) {
  const content = copy[view];
  return (
    <header className="mt-12 flex flex-wrap items-end justify-between gap-5 border-b border-rail-border pb-6">
      <div className="max-w-2xl">
        <h1 className="m-0 text-2xl font-medium tracking-[-0.025em] text-rail-text">
          {content.title}
        </h1>
        <p className="mt-2 mb-0 max-w-xl text-sm leading-6 text-rail-subtle">
          {content.description}
        </p>
      </div>
      {view !== 'create' ? (
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
      ) : null}
    </header>
  );
}
