import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { loadPublicStatusPage } from '../../../../lib/public-status-page';
import { StatusSubscriptionForm } from '../../../../features/status-pages/status-subscription-form';

export const metadata: Metadata = {
  title: 'Subscribe to status updates · Watchrail',
  robots: { index: false },
  referrer: 'no-referrer',
};
export const dynamic = 'force-dynamic';

export default async function SubscribePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = await loadPublicStatusPage(slug);
  if (!page) notFound();
  return (
    <main
      data-watchrail-workspace
      className="mx-auto flex min-h-dvh w-full max-w-lg flex-col justify-center px-6 py-12"
    >
      <Link
        href={`/status/${encodeURIComponent(slug)}`}
        className="mb-8 text-sm text-rail-subtle underline underline-offset-4"
      >
        Back to {page.name}
      </Link>
      <h1 className="text-2xl font-semibold text-rail-text">Subscribe to updates</h1>
      <p className="mb-7 mt-2 text-sm text-rail-subtle">
        Get incident openings, updates, resolutions, and published maintenance changes for{' '}
        {page.name}.
      </p>
      <StatusSubscriptionForm slug={slug} />
    </main>
  );
}
