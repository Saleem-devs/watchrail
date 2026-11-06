import { MaintenanceWindowFormPage } from '../../../../../../features/maintenance-windows/maintenance-window-form';

export default async function EditMaintenanceWindowRoute({
  params,
}: {
  params: Promise<{ projectId: string; maintenanceWindowId: string }>;
}) {
  const { projectId, maintenanceWindowId } = await params;
  return (
    <MaintenanceWindowFormPage projectId={projectId} maintenanceWindowId={maintenanceWindowId} />
  );
}
