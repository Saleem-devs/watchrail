import { WebhookChannelFormPage } from '../../../../../features/notifications/webhook-channel-form';

export default async function NewWebhookChannelPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <WebhookChannelFormPage projectId={projectId} />;
}
