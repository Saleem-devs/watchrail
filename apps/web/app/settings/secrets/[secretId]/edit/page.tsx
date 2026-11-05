import { WorkspaceSecretFormPage } from '../../../../../features/workspace-secrets/workspace-secret-form';

export default async function EditWorkspaceSecretPage({
  params,
}: {
  params: Promise<{ secretId: string }>;
}) {
  const { secretId } = await params;
  return <WorkspaceSecretFormPage secretId={secretId} />;
}
