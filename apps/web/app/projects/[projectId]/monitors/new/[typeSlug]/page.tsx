import { notFound } from 'next/navigation';
import { Dashboard } from '../../../../../dashboard';
import {
  monitorTypeFromSlug,
  monitorTypePath,
} from '../../../../../../features/monitors/monitor-types';

export default async function NewTypedMonitorPage({
  params,
}: {
  params: Promise<{ projectId: string; typeSlug: string }>;
}) {
  const { projectId, typeSlug } = await params;
  const definition = monitorTypeFromSlug(typeSlug);
  if (!definition) notFound();
  return (
    <Dashboard
      view="create"
      projectId={projectId}
      initialCreateMonitorType={definition.type}
      lockCreateMonitorType
      backPath={monitorTypePath(projectId, definition.type)}
    />
  );
}
