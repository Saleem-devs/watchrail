import Link from 'next/link';
import type { ReactNode } from 'react';

export function PageHeader({
  title,
  description,
  actions,
  backLink,
}: {
  title: string;
  description?: string | undefined;
  actions?: ReactNode;
  backLink?: { href: string; label: string } | undefined;
}) {
  return (
    <header className="mt-12 flex flex-wrap items-end justify-between gap-5 border-b border-rail-border pb-6">
      <div className="max-w-2xl">
        {backLink ? (
          <Link
            href={backLink.href}
            className="mb-4 inline-flex min-h-8 items-center gap-1.5 rounded-rail-control text-xs font-medium text-rail-subtle no-underline hover:text-rail-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rail-accent"
          >
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className="size-3.5"
            >
              <path d="m10 3-5 5 5 5" />
            </svg>
            {backLink.label}
          </Link>
        ) : null}
        <h1 className="m-0 text-2xl font-medium tracking-[-0.025em] text-rail-text">{title}</h1>
        {description ? (
          <p className="mt-2 mb-0 max-w-xl text-sm leading-6 text-rail-subtle">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div>
      ) : null}
    </header>
  );
}
