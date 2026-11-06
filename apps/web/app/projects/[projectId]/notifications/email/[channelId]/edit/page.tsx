import { EmailChannelFormPage } from '../../../../../../../features/notifications/email-channel-form';

export default async function EditEmailChannelPage({
  params,
}: {
  params: Promise<{ projectId: string; channelId: string }>;
}) {
  const { projectId, channelId } = await params;
  return <EmailChannelFormPage projectId={projectId} channelId={channelId} />;
}
