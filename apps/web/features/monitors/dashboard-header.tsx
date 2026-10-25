import { actionClassName } from '../../components/ui/button';

export function DashboardHeader() {
  return (
    <header className="mt-8 flex flex-wrap items-end justify-between gap-5 border-b border-rail-border pb-6">
      <div className="max-w-2xl">
        <h1 className="m-0 text-2xl font-semibold tracking-tight text-rail-text sm:text-3xl">
          Monitoring overview
        </h1>
        <p className="mt-2 mb-0 max-w-xl text-sm leading-6 text-rail-subtle">
          Review service health, investigate incidents, and run diagnostic checks.
        </p>
      </div>
      <a
        href="#create-monitor"
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
      </a>
    </header>
  );
}
