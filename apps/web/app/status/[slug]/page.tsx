import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { loadPublicStatusPage } from '../../../lib/public-status-page';
import { StatusPageRefresh } from './status-page-refresh';
import { StatusPageView, publicStatusLabel } from './status-page-view';

export const dynamic = 'force-dynamic';
type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const page = await loadPublicStatusPage(slug);
  if (!page) return { title: 'Status page not found — Watchrail', robots: { index: false } };
  return {
    title: `${page.name} — Watchrail`,
    description: `${publicStatusLabel(page.status)} — ${page.name}`,
  };
}

export default async function PublicStatusPage({ params }: Props) {
  const { slug } = await params;
  const page = await loadPublicStatusPage(slug);
  if (!page) notFound();
  return (
    <>
      <StatusPageView page={page} />
      <StatusPageRefresh />
    </>
  );
}
