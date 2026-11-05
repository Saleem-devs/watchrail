import { NotificationsPage } from '../../../../features/notifications/notifications-page';

export default async function ProjectNotificationsRoute({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <NotificationsPage projectId={projectId} />;
}
