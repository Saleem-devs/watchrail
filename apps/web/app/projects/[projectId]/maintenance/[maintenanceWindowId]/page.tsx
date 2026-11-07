import { MaintenanceWindowDetailPage } from '../../../../../features/maintenance-windows/maintenance-window-detail-page';

export default async function MaintenanceWindowDetailRoute({
  params,
}: {
  params: Promise<{ projectId: string; maintenanceWindowId: string }>;
}) {
  const { projectId, maintenanceWindowId } = await params;
  return (
    <MaintenanceWindowDetailPage projectId={projectId} maintenanceWindowId={maintenanceWindowId} />
  );
}
