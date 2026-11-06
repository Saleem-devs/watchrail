import { EmailChannelFormPage } from '../../../../../../features/notifications/email-channel-form';

export default async function NewEmailChannelPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <EmailChannelFormPage projectId={projectId} />;
}
