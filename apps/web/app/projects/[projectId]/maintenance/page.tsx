import { MaintenanceWindowsPage } from '../../../../features/maintenance-windows/maintenance-windows-page';

export default async function ProjectMaintenanceRoute({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <MaintenanceWindowsPage projectId={projectId} />;
}
