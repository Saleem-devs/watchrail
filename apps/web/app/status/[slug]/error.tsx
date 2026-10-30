'use client';

import Image from 'next/image';

export default function StatusPageError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main
      data-watchrail-workspace
      className="grid min-h-svh w-full place-items-center bg-rail-canvas px-5 text-rail-text"
    >
      <div className="w-full max-w-md text-center">
        <Image
          src="/watchrail-mark.svg"
          width={36}
          height={36}
          alt=""
          aria-hidden="true"
          className="mx-auto"
        />
        <h1 className="mt-5 mb-0 text-2xl font-semibold tracking-[-0.025em]">
          Status temporarily unavailable
        </h1>
        <p className="mt-2 mb-0 text-sm text-rail-subtle">
          We couldn&apos;t load this status page. Please try again shortly.
        </p>
        <button
          type="button"
          onClick={reset}
          className="mt-6 inline-flex min-h-9 items-center justify-center rounded-rail-control border border-rail-border bg-rail-surface px-3.5 text-sm font-medium text-rail-text hover:bg-rail-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rail-accent"
        >
          Try again
        </button>
      </div>
    </main>
  );
}
