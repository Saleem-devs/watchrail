import { NotificationChannelDetailPage } from '../../../../../features/notifications/notification-channel-detail-page';

export default async function WebhookChannelDetailRoute({
  params,
}: {
  params: Promise<{ projectId: string; endpointId: string }>;
}) {
  const { projectId, endpointId } = await params;
  return (
    <NotificationChannelDetailPage
      projectId={projectId}
      channelId={endpointId}
      channelType="WEBHOOK"
    />
  );
}
