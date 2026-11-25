import type { Metadata } from 'next';
import { StatusSubscriptionAction } from '../../../../features/status-pages/status-subscription-form';
export const metadata: Metadata = {
  title: 'Status subscription · Watchrail',
  robots: { index: false },
  referrer: 'no-referrer',
};
export default function SubscriptionActionPage() {
  return <StatusSubscriptionAction />;
}
