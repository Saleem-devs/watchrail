import { redirect } from 'next/navigation';

export default async function NewProjectMonitorPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  redirect(`/projects/${projectId}/monitors/new/http`);
}
