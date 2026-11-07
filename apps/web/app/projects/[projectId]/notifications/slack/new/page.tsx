import { SlackChannelFormPage } from '../../../../../../features/notifications/slack-channel-form';

export default async function NewSlackChannelPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <SlackChannelFormPage projectId={projectId} />;
}
