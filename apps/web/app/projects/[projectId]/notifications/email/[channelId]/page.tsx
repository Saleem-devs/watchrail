import { NotificationChannelDetailPage } from '../../../../../../features/notifications/notification-channel-detail-page';

export default async function EmailChannelDetailRoute({
  params,
}: {
  params: Promise<{ projectId: string; channelId: string }>;
}) {
  const { projectId, channelId } = await params;
  return (
    <NotificationChannelDetailPage
      projectId={projectId}
      channelId={channelId}
      channelType="EMAIL"
    />
  );
}
