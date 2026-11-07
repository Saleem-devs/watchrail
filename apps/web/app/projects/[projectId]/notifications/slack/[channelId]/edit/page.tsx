import { SlackChannelFormPage } from '../../../../../../../features/notifications/slack-channel-form';

export default async function EditSlackChannelPage({
  params,
}: {
  params: Promise<{ projectId: string; channelId: string }>;
}) {
  const { projectId, channelId } = await params;
  return <SlackChannelFormPage projectId={projectId} channelId={channelId} />;
}
