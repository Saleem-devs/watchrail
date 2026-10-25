import { actionClassName } from '../../components/ui/button';

export function DashboardHeader() {
  return (
    <section className="relative mt-8 overflow-hidden rounded-2xl border border-rail-border bg-rail-header px-6 py-9 sm:px-10 sm:py-11">
      <div
        className="pointer-events-none absolute -top-24 right-0 size-64 rounded-full bg-rail-accent/5 blur-3xl"
        aria-hidden="true"
      />
      <p className="mb-4 text-[11px] font-bold tracking-widest text-rail-accent uppercase">
        Monitoring workspace
      </p>
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div className="max-w-2xl">
          <h1 className="mb-3 text-3xl font-semibold tracking-tight text-rail-text sm:text-4xl">
            Your services. Clearly in view.
          </h1>
          <p className="m-0 max-w-xl text-sm leading-6 text-rail-subtle sm:text-base">
            Track current health, investigate incidents, and run on-demand checks.
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
      </div>
    </section>
  );
}
