import { NotificationChannelsPage } from '../../../../features/notifications/notification-channels-page';

export default async function ProjectNotificationsRoute({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <NotificationChannelsPage projectId={projectId} />;
}
