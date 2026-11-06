import { MaintenanceWindowFormPage } from '../../../../../features/maintenance-windows/maintenance-window-form';

export default async function NewMaintenanceWindowRoute({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <MaintenanceWindowFormPage projectId={projectId} />;
}
